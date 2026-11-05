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
let plateCounter = 0;
let keyCounter = 0;
const nextIp = () => `10.10.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
const newPlate = () => `GP ${String(7000 + ++plateCounter)}-26`;
const newKey = () => `p10-key-${++keyCounter}-${Date.now()}`;

async function makeUser(username: string, role: 'owner' | 'manager' | 'cashier') {
  await db.insert(users).values({ name: username, username, roleId: await roleIdFor(db, role), passwordHash: await hashPassword(PASSWORD) });
}
async function signIn(username: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD }, remoteAddress: nextIp() });
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';
}
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as object | undefined });

type Method = { id: number; name: string; inDrawer: boolean; requiresReference: boolean; active: boolean; used: boolean };
let owner: string;
let cashier: string;
let serviceId: number;
let attendantId: number;

async function finishedJob(): Promise<number> {
  const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId, attendantIds: [attendantId] }], start: true });
  const id = made.json().job.id as number;
  await call(cashier, 'POST', `/api/jobs/${id}/status`, { to: 'completed' });
  return id;
}
const pay = (jobId: number, body: Record<string, unknown>) =>
  call(cashier, 'POST', `/api/jobs/${jobId}/payments`, { idemKey: newKey(), ...body });
const addMethod = async (body: Record<string, unknown>) => {
  const res = await call(owner, 'POST', '/api/payment-methods', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().method as Method;
};

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p10.owner', 'owner');
  await makeUser('p10.cashier', 'cashier');
  owner = await signIn('p10.owner');
  cashier = await signIn('p10.cashier');
  serviceId = (await call(owner, 'POST', '/api/services', { name: 'P10 Wash', price: 5000, commissionKind: 'percent', commissionValue: 1500, active: true })).json().service.id;
  attendantId = (await call(owner, 'POST', '/api/attendants', { name: 'P10 Ama', phone: null })).json().attendant.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('payment methods', () => {
  it('starts with Cash and MoMo, and anyone signed in can read them', async () => {
    const res = await call(cashier, 'GET', '/api/payment-methods');
    expect(res.statusCode).toBe(200);
    const list = res.json().methods as Method[];
    expect(list.slice(0, 2)).toMatchObject([
      { id: 1, name: 'Cash', inDrawer: true, requiresReference: false },
      { id: 2, name: 'MoMo', inDrawer: false, requiresReference: true },
    ]);
  });

  it('can only be changed by someone who manages settings', async () => {
    expect((await call(cashier, 'POST', '/api/payment-methods', { name: 'Cheque', inDrawer: false, requiresReference: false })).statusCode).toBe(403);
    expect((await call(cashier, 'PATCH', '/api/payment-methods/1', { active: false })).statusCode).toBe(403);
  });

  it('adds a method, refuses a duplicate name in any case, and takes payments with it', async () => {
    const bank = await addMethod({ name: 'Bank transfer', inDrawer: false, requiresReference: true });
    expect(bank).toMatchObject({ active: true, used: false });
    expect((await call(owner, 'POST', '/api/payment-methods', { name: 'bank TRANSFER', inDrawer: false, requiresReference: false })).statusCode).toBe(409);

    const job = await finishedJob();
    const noRef = await pay(job, { methodId: bank.id, amount: 1000 });
    expect(noRef.statusCode).toBe(400);
    const ok = await pay(job, { methodId: bank.id, amount: 1000, reference: 'TRF-9981' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().job.payments[0]).toMatchObject({ method: 'Bank transfer', methodId: bank.id, reference: 'TRF-9981' });

    const after = (await call(owner, 'GET', '/api/payment-methods')).json().methods as Method[];
    expect(after.find((m) => m.id === bank.id)!.used).toBe(true);
  });

  it('counts a method that goes through the drawer as drawer takings', async () => {
    const till = await addMethod({ name: 'Till card', inDrawer: true, requiresReference: false });
    const before = (await call(owner, 'GET', '/api/dashboard')).json().takings;
    const job = await finishedJob();
    expect((await pay(job, { methodId: till.id, amount: 2000 })).statusCode).toBe(201);
    const after = (await call(owner, 'GET', '/api/dashboard')).json().takings;
    expect(after.drawer - before.drawer).toBe(2000);
    expect(after.other - before.other).toBe(0);
    expect(after.byMethod.find((m: { name: string }) => m.name === 'Till card').amount).toBeGreaterThanOrEqual(2000);
  });

  it('will not change drawer behaviour once a method has been used', async () => {
    const m = await addMethod({ name: 'Voucher', inDrawer: false, requiresReference: false });
    expect((await call(owner, 'PATCH', `/api/payment-methods/${m.id}`, { inDrawer: true })).statusCode).toBe(200); // not used yet
    const job = await finishedJob();
    expect((await pay(job, { methodId: m.id, amount: 500 })).statusCode).toBe(201);
    expect((await call(owner, 'PATCH', `/api/payment-methods/${m.id}`, { inDrawer: false })).statusCode).toBe(409);
    expect((await call(owner, 'PATCH', `/api/payment-methods/${m.id}`, { name: 'Gift voucher' })).statusCode).toBe(200);
  });

  it('switching a method off stops new use but keeps old records readable', async () => {
    const m = await addMethod({ name: 'Old coupon', inDrawer: false, requiresReference: false });
    const job = await finishedJob();
    expect((await pay(job, { methodId: m.id, amount: 500 })).statusCode).toBe(201);
    expect((await call(owner, 'PATCH', `/api/payment-methods/${m.id}`, { active: false })).statusCode).toBe(200);
    const again = await pay(job, { methodId: m.id, amount: 500 });
    expect(again.statusCode).toBe(400);
    const detail = (await call(cashier, 'GET', `/api/jobs/${job}`)).json().job;
    expect(detail.payments[0].method).toBe('Old coupon');
  });

  it('keeps at least one method switched on', async () => {
    const all = (await call(owner, 'GET', '/api/payment-methods')).json().methods as Method[];
    const active = all.filter((m) => m.active);
    const keep = active[0]!;
    for (const m of active.slice(1)) {
      expect((await call(owner, 'PATCH', `/api/payment-methods/${m.id}`, { active: false })).statusCode).toBe(200);
    }
    expect((await call(owner, 'PATCH', `/api/payment-methods/${keep.id}`, { active: false })).statusCode).toBe(409);
    for (const m of active.slice(1)) {
      await call(owner, 'PATCH', `/api/payment-methods/${m.id}`, { active: true });
    }
  });

  it('is written to the activity log', async () => {
    const res = await call(owner, 'GET', '/api/audit?limit=100');
    const actions = (res.json().entries as { action: string }[]).map((e) => e.action);
    expect(actions).toContain('paymethod.create');
    expect(actions).toContain('paymethod.update');
  });
});
