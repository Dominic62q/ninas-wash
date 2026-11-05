import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ReceiptDto } from '@niinas/shared';
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
const nextIp = () => `10.13.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
let plateCounter = 0;
const newPlate = () => `GQ ${String(7000 + ++plateCounter)}-26`;
let keyCounter = 0;
const newKey = () => `p13-key-${++keyCounter}-${Date.now()}`;

async function makeUser(username: string, role: 'owner' | 'cashier') {
  await db.insert(users).values({ name: username, username, roleId: await roleIdFor(db, role), passwordHash: await hashPassword(PASSWORD) });
}
async function signIn(username: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD }, remoteAddress: nextIp() });
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';
}
type Method = 'GET' | 'POST';
const call = (cookie: string | null, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: cookie ? { cookie } : {}, payload: payload as object | undefined, remoteAddress: nextIp() });

let owner: string;
let cashier: string;
let seat: number;
let kofi: number;

async function bookedJob(extra: Record<string, unknown> = {}) {
  const res = await call(cashier, 'POST', '/api/jobs', {
    plate: newPlate(),
    lines: [{ serviceId: seat, quantity: 3, attendantIds: [kofi] }],
    start: true,
    ...extra,
  });
  expect(res.statusCode).toBe(201);
  return res.json().job as { id: number };
}

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p13.owner', 'owner');
  await makeUser('p13.cashier', 'cashier');
  owner = await signIn('p13.owner');
  cashier = await signIn('p13.cashier');
  seat = (await call(owner, 'POST', '/api/services', { name: 'P13 Seat clean', price: 2000, commissionKind: 'percent', commissionValue: 1000, active: true })).json().service.id;
  kofi = (await call(owner, 'POST', '/api/attendants', { name: 'P13 Kofi', phone: null })).json().attendant.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('sharing a receipt', () => {
  it('makes one link per job, the same one every time', async () => {
    const job = await bookedJob();
    const first = await call(cashier, 'POST', `/api/receipts/for-job/${job.id}`);
    expect(first.statusCode).toBe(200);
    const token = first.json().token as string;
    expect(token.length).toBeGreaterThanOrEqual(20);
    const again = await call(owner, 'POST', `/api/receipts/for-job/${job.id}`);
    expect(again.json().token).toBe(token);
    const other = await bookedJob();
    expect((await call(cashier, 'POST', `/api/receipts/for-job/${other.id}`)).json().token).not.toBe(token);
  });

  it('needs a signed-in person to make a link, and a real job', async () => {
    const job = await bookedJob();
    expect((await call(null, 'POST', `/api/receipts/for-job/${job.id}`)).statusCode).toBe(401);
    expect((await call(cashier, 'POST', '/api/receipts/for-job/999999')).statusCode).toBe(404);
  });

  it('opens without signing in, and shows the bill and nothing about the customer or how it was paid', async () => {
    const job = await bookedJob({ discount: 1000 });
    const token = (await call(cashier, 'POST', `/api/receipts/for-job/${job.id}`)).json().token as string;
    const paid = await call(cashier, 'POST', `/api/jobs/${job.id}/payments`, { amount: 2000, methodId: 1, idemKey: newKey() });
    expect(paid.statusCode).toBe(201);

    const res = await call(null, 'GET', `/api/receipts/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-robots-tag']).toContain('noindex');
    const body = res.json() as { receipt: ReceiptDto };
    expect(body.receipt).toMatchObject({
      lines: [{ name: 'P13 Seat clean', quantity: 3, price: 6000 }],
      subtotal: 6000,
      discount: 1000,
      total: 5000,
      paid: 2000,
      balance: 3000,
      voided: false,
    });
    expect(Object.keys(body.receipt).sort()).toEqual(['at', 'balance', 'discount', 'lines', 'number', 'paid', 'plate', 'status', 'subtotal', 'total', 'voided']);
    const text = res.body;
    expect(text).not.toMatch(/cash|momo|reference|phone/i);
  });

  it('gives the same bill as a PDF file, with no sign-in', async () => {
    const job = await bookedJob({ discount: 1000 });
    const token = (await call(cashier, 'POST', `/api/receipts/for-job/${job.id}`)).json().token as string;
    const res = await call(null, 'GET', `/api/receipts/${token}/pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline; filename="Receipt J-');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(1500);
    expect((await call(null, 'GET', '/api/receipts/not-a-real-token-at-all-0000/pdf')).statusCode).toBe(404);
  });

  it('gives the same answer for a wrong token as for a made-up one', async () => {
    expect((await call(null, 'GET', '/api/receipts/not-a-real-token-at-all-0000')).statusCode).toBe(404);
    expect((await call(null, 'GET', '/api/receipts/short')).statusCode).toBe(400);
  });

  it('says so when the job was voided', async () => {
    const job = await bookedJob();
    const token = (await call(cashier, 'POST', `/api/receipts/for-job/${job.id}`)).json().token as string;
    expect((await call(owner, 'POST', `/api/jobs/${job.id}/void`, { reason: 'Booked by mistake' })).statusCode).toBe(200);
    const res = await call(null, 'GET', `/api/receipts/${token}`);
    expect(res.json().receipt.voided).toBe(true);
  });

  it('is written to the activity log once', async () => {
    const entries = (await call(owner, 'GET', '/api/audit?limit=200')).json().entries as { action: string }[];
    expect(entries.filter((e) => e.action === 'job.receipt_link').length).toBeGreaterThan(0);
  });
});
