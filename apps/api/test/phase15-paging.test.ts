import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CommissionLedger, DailyCloseHistory, ExpensesOverview, TipsOverview } from '@niinas/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { roleIdFor } from './roles.js';

const PASSWORD = 'correct horse battery';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;
let ipCounter = 0;
const nextIp = () => `10.15.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
let plateCounter = 0;
const newPlate = () => `GQ ${String(9000 + ++plateCounter)}-26`;
let keyCounter = 0;
const newKey = () => `p15-key-${++keyCounter}-${Date.now()}`;

async function makeUser(username: string, role: 'owner' | 'cashier') {
  await db.insert(users).values({ name: username, username, roleId: await roleIdFor(db, role), passwordHash: await hashPassword(PASSWORD) });
}
async function signIn(username: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD }, remoteAddress: nextIp() });
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';
}
type Method = 'GET' | 'POST';
const call = (cookie: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as object | undefined, remoteAddress: nextIp() });

let owner: string;
let cashier: string;
let kofi: number;

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p15.owner', 'owner');
  await makeUser('p15.cashier', 'cashier');
  owner = await signIn('p15.owner');
  cashier = await signIn('p15.cashier');
  kofi = (await call(owner, 'POST', '/api/attendants', { name: 'P15 Kofi', phone: null })).json().attendant.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('long lists come in pages', () => {
  it('expenses: the page is cut at the limit, the total counts them all, and a bigger limit shows more', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await call(cashier, 'POST', '/api/expenses', { category: 'Water', amount: 1000 + i, methodId: 1, idemKey: newKey() });
      expect(res.statusCode).toBe(201);
    }
    const small = (await call(cashier, 'GET', '/api/expenses?limit=2')).json() as ExpensesOverview;
    expect(small.expenses).toHaveLength(2);
    expect(small.total).toBeGreaterThanOrEqual(5);
    // The sums cover every expense in the dates, not just the ones on the page.
    expect(small.sum).toBeGreaterThanOrEqual(5010);

    const big = (await call(cashier, 'GET', '/api/expenses?limit=1000')).json() as ExpensesOverview;
    expect(big.expenses).toHaveLength(big.total);
    expect(big.sum).toBe(small.sum);
    // Newest first, so the short page is the start of the long one.
    expect(small.expenses.map((e) => e.id)).toEqual(big.expenses.slice(0, 2).map((e) => e.id));
  });

  it('expenses: a voided one still counts in the total of rows, but not in the sums', async () => {
    const made = await call(cashier, 'POST', '/api/expenses', { category: 'Water', amount: 7777, methodId: 1, idemKey: newKey() });
    const before = (await call(cashier, 'GET', '/api/expenses?limit=1')).json() as ExpensesOverview;
    const voided = await call(owner, 'POST', `/api/expenses/${made.json().expense.id}/void`, { reason: 'Wrong amount entered' });
    expect(voided.statusCode).toBe(200);
    const after = (await call(cashier, 'GET', '/api/expenses?limit=1')).json() as ExpensesOverview;
    expect(after.total).toBe(before.total);
    expect(after.sum).toBe(before.sum - 7777);
  });

  it('rejects a limit that is nonsense', async () => {
    expect((await call(cashier, 'GET', '/api/expenses?limit=0')).statusCode).toBe(400);
    expect((await call(cashier, 'GET', '/api/expenses?limit=5000')).statusCode).toBe(400);
    expect((await call(cashier, 'GET', '/api/tips?limit=5000')).statusCode).toBe(400);
  });

  it('tips: cut at the limit, with the total of the window', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await call(cashier, 'POST', '/api/tips', { attendantId: kofi, kind: 'held', amount: 300, idemKey: newKey() });
      expect(res.statusCode).toBe(201);
    }
    const page = (await call(cashier, 'GET', '/api/tips?limit=3')).json() as TipsOverview;
    expect(page.tips).toHaveLength(3);
    expect(page.total).toBeGreaterThanOrEqual(4);
    // What is held is the whole amount, not the page's.
    expect(page.held.find((h) => h.attendantId === kofi)?.amount).toBe(1200);
  });

  it('commission ledger: the newest lines first, cut at the limit, total of all lines', async () => {
    const wash = (await call(owner, 'POST', '/api/services', { name: 'P15 Wash', price: 5000, commissionKind: 'percent', commissionValue: 1000, active: true })).json().service.id as number;
    for (let i = 0; i < 4; i++) {
      const job = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [kofi] }], start: true });
      expect(job.statusCode).toBe(201);
      await call(cashier, 'POST', `/api/jobs/${job.json().job.id}/status`, { to: 'completed' });
    }
    const page = (await call(owner, 'GET', `/api/commissions/attendants/${kofi}?limit=3`)).json().ledger as CommissionLedger;
    expect(page.entries).toHaveLength(3);
    expect(page.total).toBe(4);
    // The money is for all four, whatever the page shows.
    expect(page.owed).toBe(2000);

    const all = (await call(owner, 'GET', `/api/commissions/attendants/${kofi}`)).json().ledger as CommissionLedger;
    expect(all.entries).toHaveLength(4);
    expect(page.entries.map((e) => e.id)).toEqual(all.entries.slice(0, 3).map((e) => e.id));
  });

  it('commission ledger: earned and paid lines are cut together, not each', async () => {
    const wash = (await call(owner, 'POST', '/api/services', { name: 'P15 Polish', price: 4000, commissionKind: 'percent', commissionValue: 1000, active: true })).json().service.id as number;
    const ama = (await call(owner, 'POST', '/api/attendants', { name: 'P15 Ama', phone: null })).json().attendant.id as number;
    for (let i = 0; i < 3; i++) {
      const job = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [ama] }], start: true });
      await call(cashier, 'POST', `/api/jobs/${job.json().job.id}/status`, { to: 'completed' });
    }
    const pay = await call(owner, 'POST', '/api/commissions/payouts', { attendantId: ama, amount: 400, methodId: 1, idemKey: newKey() });
    expect([200, 201]).toContain(pay.statusCode);
    const page = (await call(owner, 'GET', `/api/commissions/attendants/${ama}?limit=2`)).json().ledger as CommissionLedger;
    expect(page.entries).toHaveLength(2);
    expect(page.total).toBe(4);
    const all = (await call(owner, 'GET', `/api/commissions/attendants/${ama}?limit=10`)).json().ledger as CommissionLedger;
    expect(all.entries).toHaveLength(4);
    expect(page.entries.map((e) => `${e.type}-${e.id}`)).toEqual(all.entries.slice(0, 2).map((e) => `${e.type}-${e.id}`));
  });

  it('daily close history: cut at the limit, with how many closes there are', async () => {
    const history = (await call(owner, 'GET', '/api/daily-close/history?limit=1')).json() as DailyCloseHistory;
    expect(history.closes.length).toBeLessThanOrEqual(1);
    expect(history.total).toBeGreaterThanOrEqual(history.closes.length);
  });
});
