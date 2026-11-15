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
const nextIp = () => `10.17.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function makeUser(username: string, role: 'cashier' | 'manager' | 'owner') {
  await db.insert(users).values({ name: `${role} ${username}`, username, roleId: await roleIdFor(db, role), passwordHash: await hashPassword(PASSWORD) });
}

async function signIn(username: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD }, remoteAddress: nextIp() });
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
const call = (cookie: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as object | undefined });

let owner: string;
let manager: string;
let cashier: string;
let wash: number; // GH₵50.00, 15% commission
let seats: number; // GH₵10.00 each, fixed GH₵2.00 commission
let duster: number; // item, GH₵15.00
let plateCounter = 0;
let crew = 0;
let keyCounter = 0;
const newPlate = () => `GR ${String(1700 + ++plateCounter)}-26`;
const newKey = () => `p17-key-${++keyCounter}-${Date.now()}`;

type Line = { id: number; name: string; quantity: number; price: number; attendants: { id: number; name: string }[] };
type Detail = { id: number; status: string; total: number; paid: number; balance: number; discount: number; lines: Line[]; history: { action: string; note: string | null }[] };

/** A new person for every service: one person does one service at a time, and these jobs stay open. */
const who = async () => (await call(owner, 'POST', '/api/attendants', { name: `P17 Hand ${++crew}`, phone: null })).json().attendant.id as number;
const stockOf = async (id: number) =>
  ((await call(owner, 'GET', '/api/services?includeInactive=1')).json().services as { id: number; stock: number }[]).find((s) => s.id === id)!.stock;
const owed = async (a: number) => (await call(owner, 'GET', `/api/commissions/attendants/${a}`)).json().ledger.owed as number;
const jobOf = async (id: number) => (await call(cashier, 'GET', `/api/jobs/${id}`)).json().job as Detail;

type Wanted = { serviceId: number; quantity?: number; attendantIds?: number[] };
async function book(lines: Wanted[], extra: Record<string, unknown> = {}): Promise<Detail> {
  const res = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: lines.map((l) => ({ quantity: 1, attendantIds: [] as number[], ...l })), ...extra });
  expect(res.statusCode).toBe(201);
  return res.json().job as Detail;
}
const advance = (id: number, to: 'in_progress' | 'completed') => call(cashier, 'POST', `/api/jobs/${id}/status`, { to });
const remove = (who: string, job: number, line: number, reason = 'Entered by mistake') => call(who, 'POST', `/api/jobs/${job}/lines/${line}/remove`, { reason });
const edit = (who: string, job: number, line: number, body: Record<string, unknown>) =>
  call(who, 'PATCH', `/api/jobs/${job}/lines/${line}`, { reason: 'Counted wrong', ...body });

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p17.owner', 'owner');
  await makeUser('p17.manager', 'manager');
  await makeUser('p17.cashier', 'cashier');
  owner = await signIn('p17.owner');
  manager = await signIn('p17.manager');
  cashier = await signIn('p17.cashier');
  wash = (await call(owner, 'POST', '/api/services', { name: 'P17 Wash', price: 5000, commissionKind: 'percent', commissionValue: 1500, active: true })).json().service.id;
  seats = (await call(owner, 'POST', '/api/services', { name: 'P17 Seats', price: 1000, commissionKind: 'fixed', commissionValue: 200, active: true })).json().service.id;
  duster = (await call(owner, 'POST', '/api/services', { name: 'P17 Duster', kind: 'item', price: 1500, commissionKind: 'fixed', commissionValue: 0, active: true })).json().service.id;
  await call(owner, 'POST', `/api/services/${duster}/stock`, { reason: 'delivery', quantity: 50 });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('taking a service off a job', () => {
  it('lowers the total, keeps the record, and the line leaves the job', async () => {
    const job = await book([{ serviceId: wash, attendantIds: [await who()] }, { serviceId: seats, quantity: 3, attendantIds: [await who()] }]);
    expect(job.total).toBe(8000);
    const seatsLine = job.lines.find((l) => l.name === 'P17 Seats')!;
    const res = await remove(manager, job.id, seatsLine.id, 'Customer changed their mind');
    expect(res.statusCode).toBe(200);
    const after = res.json().job as Detail;
    expect(after.total).toBe(5000);
    expect(after.lines.map((l) => l.name)).toEqual(['P17 Wash']);
    const logged = after.history.find((h) => h.action === 'job.remove_line');
    expect(logged?.note).toBe('Customer changed their mind');
  });

  it('needs a reason, and the permission', async () => {
    const job = await book([{ serviceId: wash, attendantIds: [await who()] }, { serviceId: seats, attendantIds: [await who()] }]);
    const line = job.lines[1]!;
    expect((await call(manager, 'POST', `/api/jobs/${job.id}/lines/${line.id}/remove`, { reason: '' })).statusCode).toBe(400);
    expect((await remove(cashier, job.id, line.id)).statusCode).toBe(403);
    expect((await jobOf(job.id)).lines).toHaveLength(2);
  });

  it('never takes the last service: void the job instead', async () => {
    const job = await book([{ serviceId: wash, attendantIds: [await who()] }]);
    const res = await remove(manager, job.id, job.lines[0]!.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('last_line');
  });

  it('puts an item back on the shelf, and lets it be added again', async () => {
    const before = await stockOf(duster);
    const job = await book([{ serviceId: wash, attendantIds: [await who()] }, { serviceId: duster, quantity: 4 }]);
    expect(await stockOf(duster)).toBe(before - 4);
    const dusterLine = job.lines.find((l) => l.name === 'P17 Duster')!;
    { const r = await remove(manager, job.id, dusterLine.id); if (r.statusCode !== 200) console.log('BODY', r.body); expect(r.statusCode).toBe(200); }
    expect(await stockOf(duster)).toBe(before);
    const again = await call(cashier, 'POST', `/api/jobs/${job.id}/lines`, { serviceId: duster, quantity: 1, attendantIds: [] });
    expect(again.statusCode).toBe(201);
    expect(await stockOf(duster)).toBe(before - 1);
    const moves = (await call(owner, 'GET', `/api/services/${duster}/stock`)).json().moves as { reason: string }[];
    expect(moves.map((m) => m.reason)).toContain('correction');
  });

  it('takes back what a finished wash had earned for that service only', async () => {
    const a = await who();
    const b = await who();
    const job = await book([{ serviceId: wash, attendantIds: [a] }, { serviceId: seats, quantity: 2, attendantIds: [b] }], { start: true });
    expect((await advance(job.id, 'completed')).statusCode).toBe(200);
    expect(await owed(a)).toBe(750); // 15% of GH₵50.00
    expect(await owed(b)).toBe(400); // 2 x GH₵2.00
    const seatsLine = job.lines.find((l) => l.name === 'P17 Seats')!;
    expect((await remove(manager, job.id, seatsLine.id)).statusCode).toBe(200);
    expect(await owed(a)).toBe(750);
    expect(await owed(b)).toBe(0);
  });

  it('is refused once money was taken, until the payment is voided', async () => {
    const job = await book([{ serviceId: wash, attendantIds: [await who()] }, { serviceId: seats, attendantIds: [await who()] }]);
    const paid = await call(cashier, 'POST', `/api/jobs/${job.id}/payments`, { methodId: 1, amount: 1000, idemKey: newKey() });
    expect(paid.statusCode).toBe(201);
    const paymentId = paid.json().job.payments[0].id as number;
    const seatsLine = job.lines.find((l) => l.name === 'P17 Seats')!;
    const refused = await remove(manager, job.id, seatsLine.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('has_payments');
    expect((await call(manager, 'POST', `/api/jobs/${job.id}/payments/${paymentId}/void`, { reason: 'Wrong amount' })).statusCode).toBe(200);
    expect((await remove(manager, job.id, seatsLine.id)).statusCode).toBe(200);
  });

  it('is refused on a voided job and a car that has gone', async () => {
    const voided = await book([{ serviceId: wash, attendantIds: [await who()] }, { serviceId: seats, attendantIds: [await who()] }]);
    expect((await call(manager, 'POST', `/api/jobs/${voided.id}/void`, { reason: 'Test void' })).statusCode).toBe(200);
    expect((await remove(manager, voided.id, voided.lines[1]!.id)).statusCode).toBe(409);

    const gone = await book([{ serviceId: wash, attendantIds: [await who()] }, { serviceId: seats, attendantIds: [await who()] }], { start: true });
    await advance(gone.id, 'completed');
    // Nothing was paid, so it can only leave with a note and the right to do so.
    expect((await call(manager, 'POST', `/api/jobs/${gone.id}/dispatch`, { note: 'Pays on Friday' })).statusCode).toBe(200);
    expect((await remove(manager, gone.id, gone.lines[1]!.id)).statusCode).toBe(409);
  });

  it('is refused when the discount would be more than what is left', async () => {
    const job = await book([{ serviceId: wash, attendantIds: [await who()] }, { serviceId: seats, attendantIds: [await who()] }], { discount: 3000 });
    const res = await remove(manager, job.id, job.lines.find((l) => l.name === 'P17 Wash')!.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('discount_too_high');
  });

  it('leaves the removed service out of the totals everywhere', async () => {
    const job = await book([{ serviceId: wash, attendantIds: [await who()] }, { serviceId: seats, quantity: 5, attendantIds: [await who()] }]);
    await remove(manager, job.id, job.lines.find((l) => l.name === 'P17 Seats')!.id);
    const list = (await call(cashier, 'GET', '/api/jobs?status=pending')).json().jobs as { id: number; total: number }[];
    expect(list.find((j) => j.id === job.id)?.total).toBe(5000);
    const board = (await call(cashier, 'GET', '/api/jobs/board')).json();
    expect(JSON.stringify(board)).not.toContain(`"id":${job.lines.find((l) => l.name === 'P17 Seats')!.id},`);
  });
});

describe('correcting a service', () => {
  it('changes how many, and the price follows', async () => {
    const job = await book([{ serviceId: seats, quantity: 2, attendantIds: [await who()] }]);
    const res = await edit(manager, job.id, job.lines[0]!.id, { quantity: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({ total: 5000 });
    expect(res.json().job.lines[0]).toMatchObject({ quantity: 5, price: 5000 });
    const logged = (res.json().job as Detail).history.find((h) => h.action === 'job.edit_line');
    expect(logged?.note).toBe('Counted wrong');
  });

  it('moves the shelf count when an item changes', async () => {
    const before = await stockOf(duster);
    const job = await book([{ serviceId: wash, attendantIds: [await who()] }, { serviceId: duster, quantity: 4 }]);
    const line = job.lines.find((l) => l.name === 'P17 Duster')!;
    expect((await edit(manager, job.id, line.id, { quantity: 6 })).statusCode).toBe(200);
    expect(await stockOf(duster)).toBe(before - 6);
    expect((await edit(manager, job.id, line.id, { quantity: 1 })).statusCode).toBe(200);
    expect(await stockOf(duster)).toBe(before - 1);
    // Asking for more than is on the shelf fails and changes nothing.
    const tooMany = await edit(manager, job.id, line.id, { quantity: 50 });
    expect(tooMany.statusCode).toBe(409);
    expect(await stockOf(duster)).toBe(before - 1);
    expect((await jobOf(job.id)).lines.find((l) => l.name === 'P17 Duster')?.quantity).toBe(1);
  });

  it('changes who does a service, and the busy rule still holds', async () => {
    const first = await who();
    const second = await who();
    const busy = await who();
    const job = await book([{ serviceId: wash, attendantIds: [first] }]);
    const swapped = await edit(manager, job.id, job.lines[0]!.id, { attendantIds: [second] });
    expect(swapped.statusCode).toBe(200);
    expect(swapped.json().job.lines[0].attendants.map((p: { id: number }) => p.id)).toEqual([second]);

    // Someone busy on another car cannot be put on this one without a manager's reason.
    const other = await book([{ serviceId: wash, attendantIds: [busy] }], { start: true });
    expect(other.status).toBe('in_progress');
    const started = await book([{ serviceId: wash, attendantIds: [await who()] }], { start: true });
    const blocked = await edit(manager, started.id, started.lines[0]!.id, { attendantIds: [busy] });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('attendant_busy');
    const forced = await edit(manager, started.id, started.lines[0]!.id, { attendantIds: [busy], busyNote: 'Other car is nearly done' });
    expect(forced.statusCode).toBe(200);
  });

  it('moves the earning when a finished wash changes hands or count', async () => {
    const a = await who();
    const b = await who();
    const job = await book([{ serviceId: seats, quantity: 2, attendantIds: [a] }], { start: true });
    await advance(job.id, 'completed');
    expect(await owed(a)).toBe(400);
    const first = await edit(manager, job.id, job.lines[0]!.id, { quantity: 3 });
    expect(first.statusCode).toBe(200);
    expect(first.json().job.lines).toHaveLength(1);
    expect(await owed(a)).toBe(600);
    // A finished wash is corrected by striking the line off and entering it again, so it has a new number.
    expect((await edit(manager, job.id, first.json().job.lines[0].id, { attendantIds: [b] })).statusCode).toBe(200);
    expect(await owed(a)).toBe(0);
    expect(await owed(b)).toBe(600);
  });

  it('needs a reason and a change, and the permission', async () => {
    const job = await book([{ serviceId: seats, attendantIds: [await who()] }]);
    const id = job.lines[0]!.id;
    expect((await call(manager, 'PATCH', `/api/jobs/${job.id}/lines/${id}`, { quantity: 2 })).statusCode).toBe(400);
    expect((await call(manager, 'PATCH', `/api/jobs/${job.id}/lines/${id}`, { reason: 'No change given' })).statusCode).toBe(400);
    expect((await edit(cashier, job.id, id, { quantity: 2 })).statusCode).toBe(403);
    expect((await jobOf(job.id)).lines[0]!.quantity).toBe(1);
  });

  it('is refused once money was taken', async () => {
    const job = await book([{ serviceId: seats, attendantIds: [await who()] }]);
    await call(cashier, 'POST', `/api/jobs/${job.id}/payments`, { methodId: 1, amount: 500, idemKey: newKey() });
    const res = await edit(manager, job.id, job.lines[0]!.id, { quantity: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('has_payments');
  });

  it('will not push the total under the discount', async () => {
    const job = await book([{ serviceId: seats, quantity: 4, attendantIds: [await who()] }], { discount: 3000 });
    const res = await edit(manager, job.id, job.lines[0]!.id, { quantity: 2 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('discount_too_high');
  });
});

describe('the discount on a finished, unpaid wash', () => {
  it('can be fixed by someone who can correct jobs, and not by a cashier', async () => {
    const job = await book([{ serviceId: wash, attendantIds: [await who()] }], { start: true });
    await advance(job.id, 'completed');
    expect((await call(cashier, 'PATCH', `/api/jobs/${job.id}`, { discount: 500 })).statusCode).toBe(409);
    const res = await call(manager, 'PATCH', `/api/jobs/${job.id}`, { discount: 500 });
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({ discount: 500, total: 4500 });
  });
});

describe('adding a forgotten service to a finished wash', () => {
  it('lets a manager add it before payment, earns its commission now, and keeps a note on record', async () => {
    const first = await who();
    const second = await who();
    const job = await book([{ serviceId: wash, attendantIds: [first] }], { start: true });
    expect((await advance(job.id, 'completed')).statusCode).toBe(200);
    expect(await owed(second)).toBe(0);

    const res = await call(manager, 'POST', `/api/jobs/${job.id}/lines`, { serviceId: seats, quantity: 2, attendantIds: [second] });
    expect(res.statusCode).toBe(201);
    const after = res.json().job as Detail;
    expect(after).toMatchObject({ status: 'completed', total: 7000 });
    expect(after.lines.map((l) => l.name).sort()).toEqual(['P17 Seats', 'P17 Wash']);
    expect(await owed(second)).toBe(400); // fixed GH₵2.00 each, two of them
    expect(after.history.find((h) => h.action === 'job.add_line')?.note).toBe('Added after the wash was finished');
  });

  it('is for people who may correct jobs, and stops once money has been taken', async () => {
    const job = await book([{ serviceId: wash, attendantIds: [await who()] }], { start: true });
    await advance(job.id, 'completed');
    expect((await call(cashier, 'POST', `/api/jobs/${job.id}/lines`, { serviceId: seats, quantity: 1, attendantIds: [await who()] })).statusCode).toBe(409);

    await call(cashier, 'POST', `/api/jobs/${job.id}/payments`, { methodId: 1, amount: 1000, idemKey: newKey() });
    const late = await call(manager, 'POST', `/api/jobs/${job.id}/lines`, { serviceId: seats, quantity: 1, attendantIds: [await who()] });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('has_payments');
    expect((await jobOf(job.id)).lines).toHaveLength(1);
  });
});
