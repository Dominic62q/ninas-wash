import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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
const nextIp = () => `10.12.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
let plateCounter = 0;
const newPlate = () => `GQ ${String(5000 + ++plateCounter)}-26`;

async function makeUser(username: string, role: 'owner' | 'cashier') {
  await db.insert(users).values({ name: username, username, roleId: await roleIdFor(db, role), passwordHash: await hashPassword(PASSWORD) });
}
async function signIn(username: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD }, remoteAddress: nextIp() });
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';
}
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
const call = (cookie: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as object | undefined });

let owner: string;
let cashier: string;
let seat: number; // GH₵20.00 each, 10%
let rug: number; // GH₵30.00 each, fixed GH₵4.00 each
let kofi: number;

type Job = { id: number; subtotal: number; total: number; lines: { id: number; quantity: number; price: number }[] };
const book = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines, start: true, ...extra });

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p12.owner', 'owner');
  await makeUser('p12.cashier', 'cashier');
  owner = await signIn('p12.owner');
  cashier = await signIn('p12.cashier');
  seat = (await call(owner, 'POST', '/api/services', { name: 'P12 Seat clean', price: 2000, commissionKind: 'percent', commissionValue: 1000, active: true })).json().service.id;
  rug = (await call(owner, 'POST', '/api/services', { name: 'P12 Rug wash', price: 3000, commissionKind: 'fixed', commissionValue: 400, active: true })).json().service.id;
  kofi = (await call(owner, 'POST', '/api/attendants', { name: 'P12 Kofi', phone: null })).json().attendant.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('quantity on a service', () => {
  it('defaults to one, and multiplies the price when more are asked for', async () => {
    const one = await book([{ serviceId: seat, attendantIds: [kofi] }]);
    expect(one.statusCode).toBe(201);
    expect((one.json().job as Job).lines[0]).toMatchObject({ quantity: 1, price: 2000 });

    const many = await book([{ serviceId: seat, quantity: 5, attendantIds: [kofi] }, { serviceId: rug, quantity: 2, attendantIds: [kofi] }]);
    expect(many.statusCode).toBe(201);
    const job = many.json().job as Job;
    expect(job.lines.map((l) => [l.quantity, l.price])).toEqual([[5, 10_000], [2, 6000]]);
    expect(job.subtotal).toBe(16_000);
    expect(job.total).toBe(16_000);
  });

  it('refuses nonsense quantities', async () => {
    for (const quantity of [0, -1, 51, 1.5, '3']) {
      const res = await book([{ serviceId: seat, quantity, attendantIds: [kofi] }]);
      expect(res.statusCode, String(quantity)).toBe(400);
    }
  });

  it('keeps the discount limit against the whole line', async () => {
    const tooMuch = await book([{ serviceId: seat, quantity: 3, attendantIds: [kofi] }], { discount: 6001 });
    expect(tooMuch.statusCode).toBe(400);
    const fine = await book([{ serviceId: seat, quantity: 3, attendantIds: [kofi] }], { discount: 6000 });
    expect(fine.statusCode).toBe(201);
    expect((fine.json().job as Job).total).toBe(0);
  });

  it('can be set when adding a service to a job already on the board', async () => {
    const made = await book([{ serviceId: seat, attendantIds: [kofi] }]);
    const id = (made.json().job as Job).id;
    const added = await call(cashier, 'POST', `/api/jobs/${id}/lines`, { serviceId: rug, quantity: 3, attendantIds: [kofi] });
    expect(added.statusCode).toBe(201);
    const job = added.json().job as Job;
    expect(job.lines[1]).toMatchObject({ quantity: 3, price: 9000 });
    expect(job.subtotal).toBe(11_000);
  });

  it('pays a percent commission on the whole line and a fixed one for each', async () => {
    const before = (await call(owner, 'GET', `/api/commissions/attendants/${kofi}`)).json().ledger.owed as number;
    const made = await book([{ serviceId: seat, quantity: 5, attendantIds: [kofi] }, { serviceId: rug, quantity: 2, attendantIds: [kofi] }]);
    const id = (made.json().job as Job).id;
    expect((await call(cashier, 'POST', `/api/jobs/${id}/status`, { to: 'completed' })).statusCode).toBe(200);
    const after = (await call(owner, 'GET', `/api/commissions/attendants/${kofi}`)).json().ledger.owed as number;
    // 10% of GH₵100.00 = GH₵10.00, plus 2 x GH₵4.00
    expect(after - before).toBe(1000 + 800);
  });

  it('counts how many were sold, not how many lines', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const res = await call(owner, 'GET', `/api/reports?from=${day}&to=${day}`);
    expect(res.statusCode).toBe(200);
    const row = (res.json().byService as { name: string; count: number; sales: number }[]).find((s) => s.name === 'P12 Seat clean');
    expect(row).toBeDefined();
    // Every seat-clean line in this file has a quantity above one, so the count must exceed the number of lines.
    expect(row!.count).toBeGreaterThan(5);
    expect(row!.sales).toBe(row!.count * 2000);
  });

  it('is written to the activity log', async () => {
    const made = await book([{ serviceId: seat, quantity: 4, attendantIds: [kofi] }]);
    const job = made.json().job as { history: { action: string; after: { services?: { quantity: number }[] } | null }[] };
    const created = job.history.find((h) => h.action === 'job.create');
    expect(created?.after?.services?.[0]?.quantity).toBe(4);
  });
});
