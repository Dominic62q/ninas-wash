import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { MAX_RECEIPT_PHOTOS } from '@niinas/shared';
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
let keyCounter = 0;
const nextIp = () => `10.11.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
const newKey = () => `p11-key-${++keyCounter}-${Date.now()}`;

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

/** The first bytes of a real JPEG, enough to be recognised as one. */
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const upload = (cookie: string, expenseId: number, body: Buffer, type = 'image/jpeg') =>
  app.inject({ method: 'POST', url: `/api/expenses/${expenseId}/receipt`, headers: { cookie, 'content-type': type }, payload: body });

type Category = { id: number; name: string; needsNote: boolean; active: boolean; used: boolean };
let owner: string;
let cashier: string;

const spend = (body: Record<string, unknown>) =>
  call(cashier, 'POST', '/api/expenses', { category: 'Water', amount: 1000, methodId: 1, idemKey: newKey(), ...body });

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p11.owner', 'owner');
  await makeUser('p11.cashier', 'cashier');
  owner = await signIn('p11.owner');
  cashier = await signIn('p11.cashier');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('expense categories', () => {
  it('starts with the usual twelve and anyone signed in can read them', async () => {
    const res = await call(cashier, 'GET', '/api/expense-categories');
    expect(res.statusCode).toBe(200);
    const list = res.json().categories as Category[];
    expect(list.map((c) => c.name).slice(0, 3)).toEqual(['Water', 'Electricity', 'Soap & chemicals']);
    expect(list.find((c) => c.name === 'Other')).toMatchObject({ needsNote: true, active: true });
  });

  it('can only be changed by someone who manages settings', async () => {
    expect((await call(cashier, 'POST', '/api/expense-categories', { name: 'Security' })).statusCode).toBe(403);
    expect((await call(cashier, 'PATCH', '/api/expense-categories/1', { active: false })).statusCode).toBe(403);
  });

  it('adds a category, refuses a duplicate in any case, and spends under it', async () => {
    const made = await call(owner, 'POST', '/api/expense-categories', { name: 'Security guard', needsNote: false });
    expect(made.statusCode).toBe(201);
    expect((await call(owner, 'POST', '/api/expense-categories', { name: 'security GUARD' })).statusCode).toBe(409);
    const res = await spend({ category: 'security guard' });
    expect(res.statusCode).toBe(201);
    expect(res.json().expense.category).toBe('Security guard'); // the stored spelling
    const list = (await call(owner, 'GET', '/api/expense-categories')).json().categories as Category[];
    expect(list.find((c) => c.name === 'Security guard')!.used).toBe(true);
  });

  it('refuses a category that is not on the list, or is switched off', async () => {
    expect((await spend({ category: 'Gold plating' })).statusCode).toBe(400);
    const made = (await call(owner, 'POST', '/api/expense-categories', { name: 'Old habit' })).json().category as Category;
    expect((await call(owner, 'PATCH', `/api/expense-categories/${made.id}`, { active: false })).statusCode).toBe(200);
    const off = await spend({ category: 'Old habit' });
    expect(off.statusCode).toBe(400);
  });

  it('asks what it was for when the category says so', async () => {
    const made = (await call(owner, 'POST', '/api/expense-categories', { name: 'Gifts', needsNote: true })).json().category as Category;
    expect(made.needsNote).toBe(true);
    expect((await spend({ category: 'Gifts' })).statusCode).toBe(400);
    expect((await spend({ category: 'Gifts', note: 'Customer thank-you' })).statusCode).toBe(201);
    expect((await call(owner, 'PATCH', `/api/expense-categories/${made.id}`, { needsNote: false })).statusCode).toBe(200);
    expect((await spend({ category: 'Gifts' })).statusCode).toBe(201);
  });

  it('is written to the activity log', async () => {
    const res = await call(owner, 'GET', '/api/audit?limit=100');
    const actions = (res.json().entries as { action: string }[]).map((e) => e.action);
    expect(actions).toContain('category.create');
    expect(actions).toContain('category.update');
  });
});

describe('receipt photos', () => {
  it('count as a receipt, can be read back, and are only for signed-in recorders', async () => {
    const made = await spend({ receipt: null });
    const id = made.json().expense.id as number;
    expect(made.json().expense).toMatchObject({ receipt: null, photos: [] });

    const before = (await call(owner, 'GET', '/api/expenses')).json().withoutReceipt as number;
    const up = await upload(cashier, id, jpeg());
    expect(up.statusCode).toBe(201);
    const photoId = up.json().photo as number;
    expect(up.json().expense.photos).toEqual([photoId]);
    const after = (await call(owner, 'GET', '/api/expenses')).json().withoutReceipt as number;
    expect(before - after).toBe(1);

    const got = await call(cashier, 'GET', `/api/expenses/photos/${photoId}`);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.rawPayload.equals(jpeg())).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/expenses/photos/${photoId}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/expenses/${id}/receipt`, headers: { 'content-type': 'image/jpeg' }, payload: jpeg() })).statusCode).toBe(401);
  });

  it('only takes real pictures', async () => {
    const id = (await spend({})).json().expense.id as number;
    const notAPicture = await upload(cashier, id, Buffer.from('<script>alert(1)</script> padding padding'), 'image/jpeg');
    expect(notAPicture.statusCode).toBe(400);
    const wrongType = await app.inject({ method: 'POST', url: `/api/expenses/${id}/receipt`, headers: { cookie: cashier, 'content-type': 'text/html' }, payload: '<b>hi</b>' });
    expect(wrongType.statusCode).toBeGreaterThanOrEqual(400);
    expect((await upload(cashier, 999999, jpeg())).statusCode).toBe(404);
  });

  it('keep at most five, and never go onto a voided expense', async () => {
    const id = (await spend({})).json().expense.id as number;
    for (let i = 0; i < MAX_RECEIPT_PHOTOS; i++) expect((await upload(cashier, id, jpeg())).statusCode).toBe(201);
    expect((await upload(cashier, id, jpeg())).statusCode).toBe(409);

    const other = (await spend({})).json().expense.id as number;
    expect((await call(owner, 'POST', `/api/expenses/${other}/void`, { reason: 'Entered twice' })).statusCode).toBe(200);
    expect((await upload(cashier, other, jpeg())).statusCode).toBe(409);
  });

  it('cannot be changed or removed in the database', async () => {
    const id = (await spend({})).json().expense.id as number;
    await upload(cashier, id, jpeg());
    // The driver wraps the database's message, so read the cause.
    const refusedWith = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (e) {
        return String((e as { cause?: { message?: string } }).cause?.message ?? e);
      }
      return 'was allowed';
    };
    expect(await refusedWith(() => db.execute(sql`delete from expense_receipts where expense_id = ${id}`))).toMatch(/cannot be changed or removed/);
    expect(await refusedWith(() => db.execute(sql`update expense_receipts set size = 1 where expense_id = ${id}`))).toMatch(/cannot be changed or removed/);
  });

  it('is written to the activity log', async () => {
    const res = await call(owner, 'GET', '/api/audit?limit=200');
    expect((res.json().entries as { action: string }[]).map((e) => e.action)).toContain('expense.receipt');
  });
});
