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
const nextIp = () => `10.16.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
let plateCounter = 0;
const newPlate = () => `GS ${String(6000 + ++plateCounter)}-26`;
let keyCounter = 0;
const newKey = () => `p16-sale-${++keyCounter}-${Date.now()}`;

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
let duster: number; // GH₵15.00
let shine: number; // GH₵40.00
let wash: number; // a service, GH₵50.00
let kofi: number;
const CASH = 1;

const item = (name: string, price: number) =>
  call(owner, 'POST', '/api/services', { name, kind: 'item', price, commissionKind: 'fixed', commissionValue: 0, active: true });
const stockOf = async (id: number) =>
  ((await call(owner, 'GET', '/api/services?includeInactive=1')).json().services as { id: number; stock: number }[]).find((s) => s.id === id)!.stock;
const deliver = (id: number, quantity: number) => call(owner, 'POST', `/api/services/${id}/stock`, { reason: 'delivery', quantity });
const sell = (lines: { serviceId: number; quantity: number }[], payments: { methodId: number; amount: number; reference?: string }[], idemKey = newKey()) =>
  call(cashier, 'POST', '/api/jobs/sales', { lines, payments, idemKey });

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p16.owner', 'owner');
  await makeUser('p16.cashier', 'cashier');
  owner = await signIn('p16.owner');
  cashier = await signIn('p16.cashier');
  duster = (await item('P16 Duster', 1500)).json().service.id;
  shine = (await item('P16 Car shine', 4000)).json().service.id;
  wash = (await call(owner, 'POST', '/api/services', { name: 'P16 Body wash', price: 5000, commissionKind: 'percent', commissionValue: 1000, active: true })).json().service.id;
  kofi = (await call(owner, 'POST', '/api/attendants', { name: 'P16 Kofi', phone: null })).json().attendant.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('items and stock', () => {
  it('makes items with no commission, starting at zero stock', async () => {
    const list = (await call(owner, 'GET', '/api/services?includeInactive=1')).json().services as { id: number; kind: string; stock: number }[];
    expect(list.find((s) => s.id === duster)).toMatchObject({ kind: 'item', stock: 0 });
    expect(list.find((s) => s.id === wash)).toMatchObject({ kind: 'service', stock: 0 });
    const paid = await call(owner, 'POST', '/api/services', { name: 'P16 Drink', kind: 'item', price: 500, commissionKind: 'fixed', commissionValue: 100, active: true });
    expect(paid.statusCode).toBe(400);
  });

  it('adds deliveries, corrects with a count that needs a reason, and keeps the history', async () => {
    expect((await deliver(duster, 10)).json().service.stock).toBe(10);
    expect((await call(owner, 'POST', `/api/services/${duster}/stock`, { reason: 'count', count: 8, note: '' })).statusCode).toBe(400);
    expect((await call(owner, 'POST', `/api/services/${duster}/stock`, { reason: 'count', count: 8, note: 'Two went missing' })).json().service.stock).toBe(8);
    const moves = (await call(owner, 'GET', `/api/services/${duster}/stock`)).json().moves;
    expect(moves.map((m: { reason: string; change: number; after: number }) => [m.reason, m.change, m.after])).toEqual([
      ['count', -2, 8],
      ['delivery', 10, 10],
    ]);
    expect((await call(owner, 'POST', `/api/services/${wash}/stock`, { reason: 'delivery', quantity: 5 })).statusCode).toBe(400);
    expect((await call(cashier, 'POST', `/api/services/${duster}/stock`, { reason: 'delivery', quantity: 5 })).statusCode).toBe(403);
  });
});

describe('opening stock', () => {
  it('starts an item with some on the shelf, as its first delivery', async () => {
    const res = await call(owner, 'POST', '/api/services', { name: 'P16 Opening', kind: 'item', price: 800, commissionKind: 'fixed', commissionValue: 0, active: true, openingStock: 12 });
    expect(res.statusCode).toBe(201);
    expect(res.json().service.stock).toBe(12);
    const moves = (await call(owner, 'GET', `/api/services/${res.json().service.id}/stock`)).json().moves;
    expect(moves.map((m: { reason: string; change: number; note: string }) => [m.reason, m.change, m.note])).toEqual([['delivery', 12, 'Opening stock']]);
  });

  it('refuses stock on a service and a negative count', async () => {
    const service = await call(owner, 'POST', '/api/services', { name: 'P16 Polish', price: 2000, commissionKind: 'percent', commissionValue: 1000, active: true, openingStock: 3 });
    expect(service.statusCode).toBe(400);
    const negative = await call(owner, 'POST', '/api/services', { name: 'P16 Negative', kind: 'item', price: 500, commissionKind: 'fixed', commissionValue: 0, active: true, openingStock: -1 });
    expect(negative.statusCode).toBe(400);
  });
});

describe('walk-in sales', () => {
  it('sells items with quantities to a walk-in, paid in full, and takes them off the shelf', async () => {
    await deliver(shine, 5);
    const res = await sell(
      [
        { serviceId: duster, quantity: 3 },
        { serviceId: shine, quantity: 1 },
      ],
      [{ methodId: CASH, amount: 3 * 1500 + 4000 }],
    );
    expect(res.statusCode).toBe(201);
    const job = res.json().job;
    expect(job).toMatchObject({ kind: 'sale', vehicle: null, customer: null, status: 'dispatched', total: 8500, paid: 8500, balance: 0 });
    expect(job.lines.map((l: { name: string; quantity: number; price: number; kind: string }) => [l.name, l.quantity, l.price, l.kind])).toEqual([
      ['P16 Duster', 3, 4500, 'item'],
      ['P16 Car shine', 1, 4000, 'item'],
    ]);
    expect(await stockOf(duster)).toBe(5);
    expect(await stockOf(shine)).toBe(4);
  });

  it('saves once when the same sale is sent twice', async () => {
    const key = newKey();
    const first = await sell([{ serviceId: duster, quantity: 1 }], [{ methodId: CASH, amount: 1500 }], key);
    const second = await sell([{ serviceId: duster, quantity: 1 }], [{ methodId: CASH, amount: 1500 }], key);
    expect(first.statusCode).toBe(201);
    expect(second.json().job.id).toBe(first.json().job.id);
    expect(await stockOf(duster)).toBe(4);
  });

  it('refuses a payment that does not match, more than is on the shelf, and services', async () => {
    const short = await sell([{ serviceId: duster, quantity: 1 }], [{ methodId: CASH, amount: 1000 }]);
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe('wrong_amount');
    const tooMany = await sell([{ serviceId: duster, quantity: 9 }], [{ methodId: CASH, amount: 9 * 1500 }]);
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().error.message).toBe('Only 4 P16 Duster left.');
    const service = await sell([{ serviceId: wash, quantity: 1 }], [{ methodId: CASH, amount: 5000 }]);
    expect(service.json().error.code).toBe('not_an_item');
    expect(await stockOf(duster)).toBe(4);
  });

  it('splits a payment across two methods', async () => {
    const res = await sell([{ serviceId: shine, quantity: 2 }], [
      { methodId: CASH, amount: 5000 },
      { methodId: 2, amount: 3000, reference: 'MP261114.0001' },
    ]);
    expect(res.statusCode).toBe(201);
    expect(res.json().job.payments).toHaveLength(2);
    expect(await stockOf(shine)).toBe(2);
  });

  it('keeps sales off the car board but in the job history', async () => {
    const board = (await call(cashier, 'GET', '/api/jobs/board')).json().jobs as { kind: string }[];
    expect(board.every((j) => j.kind === 'wash')).toBe(true);
    const history = (await call(cashier, 'GET', '/api/jobs?limit=100')).json().jobs as { kind: string; plate: string | null }[];
    const sales = history.filter((j) => j.kind === 'sale');
    expect(sales.length).toBeGreaterThanOrEqual(3);
    expect(sales.every((s) => s.plate === null)).toBe(true);
  });

  it('puts the items back on the shelf when a sale is voided', async () => {
    const job = (await sell([{ serviceId: duster, quantity: 2 }], [{ methodId: CASH, amount: 3000 }])).json().job;
    expect(await stockOf(duster)).toBe(2);
    await call(owner, 'POST', `/api/jobs/${job.id}/payments/${job.payments[0].id}/void`, { reason: 'Rang it up twice' });
    expect((await call(owner, 'POST', `/api/jobs/${job.id}/void`, { reason: 'Rang it up twice' })).statusCode).toBe(200);
    expect(await stockOf(duster)).toBe(4);
  });
});

describe('items on a wash', () => {
  it('adds an item to a car without an attendant, and the wash can still start', async () => {
    const res = await call(cashier, 'POST', '/api/jobs', {
      plate: newPlate(),
      lines: [
        { serviceId: wash, attendantIds: [kofi] },
        { serviceId: shine, quantity: 1 },
      ],
      start: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().job).toMatchObject({ kind: 'wash', status: 'in_progress', total: 9000 });
    expect(await stockOf(shine)).toBe(1);

    const board = (await call(cashier, 'GET', '/api/jobs/board')).json().jobs as { id: number; needsAttendant: boolean }[];
    expect(board.find((j) => j.id === res.json().job.id)?.needsAttendant).toBe(false);
  });

  it('will not put an attendant on an item', async () => {
    const res = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: shine, quantity: 1, attendantIds: [kofi] }] });
    expect(res.statusCode).toBe(400);
    expect(await stockOf(shine)).toBe(1);
  });

  it('gives an item back when the wash is voided', async () => {
    const job = (await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [kofi] }, { serviceId: shine, quantity: 1 }] })).json().job;
    expect(await stockOf(shine)).toBe(0);
    await call(owner, 'POST', `/api/jobs/${job.id}/void`, { reason: 'Customer left' });
    expect(await stockOf(shine)).toBe(1);
  });
});

describe('a wash for a walk-in customer', () => {
  it('books a wash with no number plate, starts it and puts it on the board', async () => {
    const hand = (await call(owner, 'POST', '/api/attendants', { name: 'P16 Hand', phone: null })).json().attendant.id as number;
    const res = await call(cashier, 'POST', '/api/jobs', { walkIn: true, lines: [{ serviceId: wash, attendantIds: [hand] }], start: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().job).toMatchObject({ kind: 'wash', vehicle: null, customer: null, status: 'in_progress', total: 5000 });
    const board = (await call(cashier, 'GET', '/api/jobs/board')).json().jobs as { id: number; plate: string | null }[];
    expect(board.find((j) => j.id === res.json().job.id)?.plate).toBeNull();
  });

  it('lets two walk-in washes be on the board at once', async () => {
    const a = await call(cashier, 'POST', '/api/jobs', { walkIn: true, lines: [{ serviceId: wash }] });
    const b = await call(cashier, 'POST', '/api/jobs', { walkIn: true, lines: [{ serviceId: wash }] });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
  });

  it('still needs a plate when the customer is not a walk-in', async () => {
    const res = await call(cashier, 'POST', '/api/jobs', { lines: [{ serviceId: wash }] });
    expect(res.statusCode).toBe(400);
  });
});
