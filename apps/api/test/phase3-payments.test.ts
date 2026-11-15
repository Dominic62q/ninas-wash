import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { jobs, users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { roleIdFor } from './roles.js';

const PASSWORD = 'correct horse battery';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;
let ipCounter = 0;
const nextIp = () => `10.4.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

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
let wash: number; // GH₵50.00
let ama: number;
let kofi: number; // a second person, for a job left half done
let plateCounter = 0;
let keyCounter = 0;
const newPlate = () => `GP ${String(2000 + ++plateCounter)}-26`;
const newKey = () => `p3-test-key-${++keyCounter}-${Date.now()}`;

type Detail = {
  id: number;
  status: string;
  total: number;
  paid: number;
  balance: number;
  payments: { id: number; methodId: number; method: string; amount: number; reference: string | null; voided: unknown }[];
  dispatchedAt: string | null;
  dispatchOverride: { by: string; note: string } | null;
  history: { action: string; note: string | null }[];
};

/** A finished job (GH₵50) that nobody has paid yet. */
async function finishedJob(): Promise<Detail> {
  const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [ama] }], start: true });
  const id = made.json().job.id as number;
  const done = await call(cashier, 'POST', `/api/jobs/${id}/status`, { to: 'completed' });
  return done.json().job as Detail;
}

const pay = (who: string, id: number, body: Record<string, unknown>) => call(who, 'POST', `/api/jobs/${id}/payments`, { idemKey: newKey(), ...body });
const jobOf = async (id: number) => (await call(cashier, 'GET', `/api/jobs/${id}`)).json().job as Detail;

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p3.owner', 'owner');
  await makeUser('p3.manager', 'manager');
  await makeUser('p3.cashier', 'cashier');
  owner = await signIn('p3.owner');
  manager = await signIn('p3.manager');
  cashier = await signIn('p3.cashier');
  wash = (await call(owner, 'POST', '/api/services', { name: 'P3 Wash', price: 5000, commissionKind: 'percent', commissionValue: 1500, active: true })).json().service.id;
  ama = (await call(owner, 'POST', '/api/attendants', { name: 'P3 Ama', phone: null })).json().attendant.id;
  kofi = (await call(owner, 'POST', '/api/attendants', { name: 'P3 Kofi', phone: null })).json().attendant.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('taking payments', () => {
  it('needs a signed-in user', async () => {
    const job = await finishedJob();
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/payments`, payload: {} })).statusCode).toBe(401);
  });

  it('records cash, shows paid and balance, and logs who took it', async () => {
    const job = await finishedJob();
    expect(job).toMatchObject({ total: 5000, paid: 0, balance: 5000 });
    const res = await pay(cashier, job.id, { methodId: 1, amount: 2000 });
    expect(res.statusCode).toBe(201);
    const after = res.json().job as Detail;
    expect(after).toMatchObject({ paid: 2000, balance: 3000 });
    expect(after.payments).toHaveLength(1);
    expect(after.history.map((h) => h.action)).toContain('payment.record');
  });

  it('splits one job across cash and MoMo, and a reference is optional', async () => {
    const job = await finishedJob();
    // MoMo takes a reference but does not insist on one, so a payment with none is saved.
    const noRef = await pay(cashier, job.id, { methodId: 2, amount: 1000 });
    expect(noRef.statusCode).toBe(201);
    await pay(cashier, job.id, { methodId: 1, amount: 2000 });
    const momo = await pay(cashier, job.id, { methodId: 2, amount: 2000, reference: 'MP261030.0001' });
    expect(momo.json().job).toMatchObject({ paid: 5000, balance: 0 });
    expect(momo.json().job.payments.map((p: { method: string }) => p.method)).toEqual(['MoMo', 'Cash', 'MoMo']);
  });

  it('saves once when the same request arrives twice', async () => {
    const job = await finishedJob();
    const idemKey = newKey();
    const first = await call(cashier, 'POST', `/api/jobs/${job.id}/payments`, { methodId: 1, amount: 1000, idemKey });
    const second = await call(cashier, 'POST', `/api/jobs/${job.id}/payments`, { methodId: 1, amount: 1000, idemKey });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect((await jobOf(job.id)).payments).toHaveLength(1);
    const other = await finishedJob();
    expect((await call(cashier, 'POST', `/api/jobs/${other.id}/payments`, { methodId: 1, amount: 1000, idemKey })).statusCode).toBe(409);
  });

  it('refuses more than is owed, and nothing once it is paid', async () => {
    const job = await finishedJob();
    const over = await pay(cashier, job.id, { methodId: 1, amount: 5001 });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.message).toMatch(/Only .* is still owed/);
    await pay(cashier, job.id, { methodId: 1, amount: 5000 });
    expect((await pay(cashier, job.id, { methodId: 1, amount: 100 })).statusCode).toBe(409);
    expect((await pay(cashier, job.id, { methodId: 1, amount: 0 })).statusCode).toBe(400);
  });

  it('can be taken before the wash starts, but not on a voided job', async () => {
    const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [ama] }] });
    const id = made.json().job.id as number;
    expect((await pay(cashier, id, { methodId: 1, amount: 1000 })).statusCode).toBe(201);
    await call(manager, 'POST', `/api/jobs/${id}/payments/${(await jobOf(id)).payments[0]!.id}/void`, { reason: 'Customer changed mind' });
    await call(manager, 'POST', `/api/jobs/${id}/void`, { reason: 'Booked on the wrong car' });
    expect((await pay(cashier, id, { methodId: 1, amount: 1000 })).statusCode).toBe(409);
  });

  it('will not let a discount take the total below what was paid', async () => {
    const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [ama] }] });
    const id = made.json().job.id as number;
    await pay(cashier, id, { methodId: 1, amount: 4000 });
    const res = await call(cashier, 'PATCH', `/api/jobs/${id}`, { discount: 2000 }); // total would be 3000, 4000 paid
    expect(res.statusCode).toBe(400);
    expect((await call(cashier, 'PATCH', `/api/jobs/${id}`, { discount: 1000 })).statusCode).toBe(200);
  });
});

describe('voiding a payment', () => {
  it('is for managers and owners, needs a reason, and gives the balance back', async () => {
    const job = await finishedJob();
    const paid = (await pay(cashier, job.id, { methodId: 1, amount: 5000 })).json().job as Detail;
    const paymentId = paid.payments[0]!.id;
    expect((await call(cashier, 'POST', `/api/jobs/${job.id}/payments/${paymentId}/void`, { reason: 'Typed it wrong' })).statusCode).toBe(403);
    expect((await call(manager, 'POST', `/api/jobs/${job.id}/payments/${paymentId}/void`, { reason: '' })).statusCode).toBe(400);

    const res = await call(manager, 'POST', `/api/jobs/${job.id}/payments/${paymentId}/void`, { reason: 'Typed it wrong' });
    expect(res.statusCode).toBe(200);
    const after = res.json().job as Detail;
    expect(after).toMatchObject({ paid: 0, balance: 5000 });
    expect(after.payments[0]!.voided).toMatchObject({ reason: 'Typed it wrong' });
    expect(after.history.find((h) => h.action === 'payment.void')?.note).toBe('Typed it wrong');

    expect((await call(manager, 'POST', `/api/jobs/${job.id}/payments/${paymentId}/void`, { reason: 'Again please' })).statusCode).toBe(409);
    expect((await call(manager, 'POST', `/api/jobs/${job.id}/payments/999999/void`, { reason: 'No such payment' })).statusCode).toBe(404);
  });
});

describe('dispatching the car', () => {
  it('does not let an unpaid car go just because it is still being washed, and changes nothing when it refuses', async () => {
    const who = (await call(owner, 'POST', '/api/attendants', { name: `P3 Gate ${Date.now()}`, phone: null })).json().attendant.id as number;
    const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [who] }], start: true });
    const res = await call(cashier, 'POST', `/api/jobs/${made.json().job.id}/dispatch`, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('balance_owed');
    expect(await jobOf(made.json().job.id)).toMatchObject({ status: 'in_progress' });
  });

  it('finishes a paid car that was still marked as washing on its way out, and earns the commission then', async () => {
    const who = (await call(owner, 'POST', '/api/attendants', { name: `P3 Out ${Date.now()}`, phone: null })).json().attendant.id as number;
    const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [who] }], start: true });
    const id = made.json().job.id as number;
    await pay(cashier, id, { methodId: 1, amount: 5000 });
    expect(await jobOf(id)).toMatchObject({ status: 'in_progress', paid: 5000 });
    const res = await call(cashier, 'POST', `/api/jobs/${id}/dispatch`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({ status: 'dispatched', balance: 0 });
    const owedNow = (await call(manager, 'GET', `/api/commissions/attendants/${who}`)).json().ledger.owed as number;
    expect(owedNow).toBe(750);
    const actions = res.json().job.history.map((h: { action: string }) => h.action);
    expect(actions).toEqual(['job.create', 'job.status', 'payment.record', 'job.status', 'job.dispatch']);
  });

  it('lets a paid car go, once', async () => {
    const job = await finishedJob();
    await pay(cashier, job.id, { methodId: 1, amount: 5000 });
    const res = await call(cashier, 'POST', `/api/jobs/${job.id}/dispatch`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({ status: 'dispatched', dispatchOverride: null });
    expect(res.json().job.dispatchedAt).not.toBeNull();
    expect((await call(cashier, 'POST', `/api/jobs/${job.id}/dispatch`, {})).statusCode).toBe(409);
  });

  it('holds the car while money is owed, unless a manager releases it with a note', async () => {
    const job = await finishedJob();
    await pay(cashier, job.id, { methodId: 1, amount: 2000 });

    const cashierTry = await call(cashier, 'POST', `/api/jobs/${job.id}/dispatch`, { note: 'He will pay tomorrow' });
    expect(cashierTry.statusCode).toBe(403);
    expect(cashierTry.json().error.code).toBe('balance_owed');

    const noNote = await call(manager, 'POST', `/api/jobs/${job.id}/dispatch`, {});
    expect(noNote.statusCode).toBe(400);
    expect(noNote.json().error.code).toBe('note_needed');
    expect((await jobOf(job.id)).status).toBe('completed');

    const ok = await call(manager, 'POST', `/api/jobs/${job.id}/dispatch`, { note: 'Regular customer, pays on Friday' });
    expect(ok.statusCode).toBe(200);
    const done = ok.json().job as Detail;
    expect(done).toMatchObject({ status: 'dispatched', balance: 3000, dispatchOverride: { note: 'Regular customer, pays on Friday' } });
    expect(done.history.find((h) => h.action === 'job.dispatch')?.note).toBe('Regular customer, pays on Friday');
  });

  it('can still be paid after it left, and the debt shows in the owing filter', async () => {
    const job = await finishedJob();
    await call(manager, 'POST', `/api/jobs/${job.id}/dispatch`, { note: 'Pays on Friday' });
    const owing = (await call(cashier, 'GET', '/api/jobs?status=owing&limit=100')).json().jobs as { id: number; paid: number; total: number }[];
    expect(owing.find((j) => j.id === job.id)).toMatchObject({ paid: 0, total: 5000 });

    expect((await pay(cashier, job.id, { methodId: 1, amount: 5000 })).json().job).toMatchObject({ status: 'dispatched', balance: 0 });
    const after = (await call(cashier, 'GET', '/api/jobs?status=owing&limit=100')).json().jobs as { id: number }[];
    expect(after.find((j) => j.id === job.id)).toBeUndefined();
  });

  it('takes a dispatched job off the board, and the board carries what has been paid', async () => {
    const job = await finishedJob();
    await pay(cashier, job.id, { methodId: 1, amount: 1500 });
    const card = (await call(cashier, 'GET', '/api/jobs/board')).json().jobs.find((j: { id: number }) => j.id === job.id);
    expect(card).toMatchObject({ status: 'completed', total: 5000, paid: 1500 });
    await call(manager, 'POST', `/api/jobs/${job.id}/dispatch`, { note: 'Pays later' });
    const statuses = (await call(cashier, 'GET', '/api/jobs/board')).json().jobs.filter((j: { id: number }) => j.id === job.id).map((j: { status: string }) => j.status);
    expect(statuses).toEqual(['dispatched']); // still listed today, but in no column
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0]!.dispatchOverrideBy).not.toBeNull();
  });

  it('cannot void a job that has payments', async () => {
    const job = await finishedJob();
    await pay(cashier, job.id, { methodId: 1, amount: 1000 });
    expect((await call(manager, 'POST', `/api/jobs/${job.id}/void`, { reason: 'Trying to hide it' })).statusCode).toBe(409);
  });
});

describe('paying and finishing in one step', () => {
  let hands = 0;
  /** A wash that is running, with its own person on it, priced GH₵50.00. */
  async function runningJob(): Promise<{ id: number; who: number }> {
    const who = (await call(owner, 'POST', '/api/attendants', { name: `P3 Quick ${++hands}`, phone: null })).json().attendant.id as number;
    const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [who] }], start: true });
    return { id: made.json().job.id as number, who };
  }
  const owedTo = async (attendantId: number) => (await call(manager, 'GET', `/api/commissions/attendants/${attendantId}`)).json().ledger.owed as number;

  it('finishes the wash when the payment says so, and the car waits for dispatch', async () => {
    const { id, who } = await runningJob();
    expect(await owedTo(who)).toBe(0);
    const res = await pay(cashier, id, { methodId: 1, amount: 5000, finish: 'wait' });
    expect(res.statusCode).toBe(201);
    expect(res.json().job).toMatchObject({ status: 'completed', paid: 5000, balance: 0 });
    expect(await owedTo(who)).toBe(750); // 15%, earned now exactly as if Mark complete had been pressed
    expect((await call(cashier, 'POST', `/api/jobs/${id}/dispatch`, {})).statusCode).toBe(200);
  });

  it('hands the car over in the same step when the whole balance is paid', async () => {
    const { id, who } = await runningJob();
    const res = await pay(cashier, id, { methodId: 1, amount: 5000, finish: 'dispatch' });
    expect(res.statusCode).toBe(201);
    expect(res.json().job).toMatchObject({ status: 'dispatched', paid: 5000, balance: 0 });
    expect(res.json().job.dispatchedAt).not.toBeNull();
    expect(await owedTo(who)).toBe(750);
    const actions = res.json().job.history.map((h: { action: string }) => h.action);
    expect(actions).toEqual(['job.create', 'job.status', 'payment.record', 'job.status', 'job.dispatch']);
  });

  it('will not dispatch on a part payment, and saves nothing when it refuses', async () => {
    const { id, who } = await runningJob();
    const res = await pay(cashier, id, { methodId: 1, amount: 2000, finish: 'dispatch' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_fully_paid');
    const after = await jobOf(id);
    expect(after).toMatchObject({ status: 'in_progress', paid: 0 });
    expect(await owedTo(who)).toBe(0);
    // A part payment can still finish the wash and leave the car waiting.
    const part = await pay(cashier, id, { methodId: 1, amount: 2000, finish: 'wait' });
    expect(part.json().job).toMatchObject({ status: 'completed', paid: 2000, balance: 3000 });
  });

  it('jumps a booked car straight to the end: started, finished and handed over with the payment', async () => {
    const who = (await call(owner, 'POST', '/api/attendants', { name: `P3 Quick ${++hands}`, phone: null })).json().attendant.id as number;
    const booked = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [who] }] });
    expect(booked.json().job.status).toBe('pending');
    const res = await pay(cashier, booked.json().job.id, { methodId: 1, amount: 5000, finish: 'dispatch' });
    expect(res.statusCode).toBe(201);
    expect(res.json().job).toMatchObject({ status: 'dispatched', paid: 5000, balance: 0 });
    expect(res.json().job.startedAt).not.toBeNull();
    expect(await owedTo(who)).toBe(750);
    const actions = res.json().job.history.map((h: { action: string }) => h.action);
    expect(actions).toEqual(['job.create', 'payment.record', 'job.status', 'job.dispatch']);
  });

  it('will not start a booked car with the payment when nobody is on it or the person is busy, and saves nothing', async () => {
    const nobody = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [] }] });
    const noOne = await pay(cashier, nobody.json().job.id, { methodId: 1, amount: 5000, finish: 'wait' });
    expect(noOne.statusCode).toBe(409);
    expect(noOne.json().error.code).toBe('needs_attendant');
    expect((await jobOf(nobody.json().job.id)).paid).toBe(0);

    const busy = await runningJob();
    const second = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [busy.who] }] });
    const clash = await pay(cashier, second.json().job.id, { methodId: 1, amount: 5000, finish: 'wait' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('attendant_busy');
    expect(await jobOf(second.json().job.id)).toMatchObject({ status: 'pending', paid: 0 });
  });

  it('saves once when the same request arrives twice', async () => {
    const { id } = await runningJob();
    const key = newKey();
    const first = await call(cashier, 'POST', `/api/jobs/${id}/payments`, { methodId: 1, amount: 5000, finish: 'dispatch', idemKey: key });
    const again = await call(cashier, 'POST', `/api/jobs/${id}/payments`, { methodId: 1, amount: 5000, finish: 'dispatch', idemKey: key });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().job).toMatchObject({ status: 'dispatched', paid: 5000 });
  });

  it('dispatches a finished car the same way when the last payment comes in', async () => {
    const job = await finishedJob();
    const res = await pay(cashier, job.id, { methodId: 1, amount: 5000, finish: 'dispatch' });
    expect(res.json().job).toMatchObject({ status: 'dispatched', paid: 5000 });
  });
});

describe('items at the till', () => {
  it('goes on a finished bill that is not settled, and not after it is paid or the car has gone', async () => {
    const duster = (await call(owner, 'POST', '/api/services', { name: 'P3 Duster', kind: 'item', price: 1500, commissionKind: 'fixed', commissionValue: 0, active: true })).json().service.id as number;
    await call(owner, 'POST', `/api/services/${duster}/stock`, { reason: 'delivery', quantity: 5 });

    const job = await finishedJob();
    const added = await call(cashier, 'POST', `/api/jobs/${job.id}/lines`, { serviceId: duster, quantity: 2, attendantIds: [] });
    expect(added.statusCode).toBe(201);
    expect(added.json().job).toMatchObject({ total: 8000, balance: 8000, status: 'completed' });

    await pay(cashier, job.id, { methodId: 1, amount: 8000 });
    const settled = await finishedJob();
    await pay(cashier, settled.id, { methodId: 1, amount: 5000 });
    expect((await call(cashier, 'POST', `/api/jobs/${settled.id}/lines`, { serviceId: duster, quantity: 1, attendantIds: [] })).statusCode).toBe(409);

    // A service still cannot be added once the wash is finished.
    const another = await finishedJob();
    const svc = (await call(owner, 'POST', '/api/services', { name: 'P3 Polish', price: 3000, commissionKind: 'percent', commissionValue: 1000, active: true })).json().service.id as number;
    expect((await call(cashier, 'POST', `/api/jobs/${another.id}/lines`, { serviceId: svc, quantity: 1, attendantIds: [ama] })).statusCode).toBe(409);
  });
});
