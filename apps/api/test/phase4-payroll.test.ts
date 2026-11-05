import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { splitByShares } from '../src/lib/commissions.js';
import { roleIdFor } from './roles.js';

const PASSWORD = 'correct horse battery';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;
let ipCounter = 0;
const nextIp = () => `10.5.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

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
let plateCounter = 0;
let keyCounter = 0;
const newPlate = () => `GQ ${String(3000 + ++plateCounter)}-26`;
const newKey = () => `p4-test-key-${++keyCounter}-${Date.now()}`;

const makeService = async (name: string, price: number, commissionKind: 'percent' | 'fixed', commissionValue: number) =>
  (await call(owner, 'POST', '/api/services', { name, price, commissionKind, commissionValue, active: true })).json().service.id as number;
const makeAttendant = async (name: string) => (await call(owner, 'POST', '/api/attendants', { name, phone: null })).json().attendant.id as number;

type Ledger = {
  attendant: { id: number; name: string };
  owed: number;
  earned: number;
  paidOut: number;
  entries: { type: 'earned' | 'payout'; id: number; amount: number; reversed?: boolean; voided?: { reason: string } | null; plate?: string; sharePct?: number }[];
};
const ledger = async (attendantId: number) => (await call(manager, 'GET', `/api/commissions/attendants/${attendantId}`)).json().ledger as Ledger;
const owedTo = async (attendantId: number) => (await ledger(attendantId)).owed;

/** Book and finish a job. Returns its id. */
async function finishedJob(lines: { serviceId: number; attendantIds: number[] }[], discount = 0): Promise<number> {
  const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines, discount, start: true });
  expect(made.statusCode).toBe(201);
  const id = made.json().job.id as number;
  expect((await call(cashier, 'POST', `/api/jobs/${id}/status`, { to: 'completed' })).statusCode).toBe(200);
  return id;
}

const payout = (who: string, attendantId: number, body: Record<string, unknown>) =>
  call(who, 'POST', '/api/commissions/payouts', { attendantId, method: 'cash', idemKey: newKey(), ...body });
const tip = (who: string, attendantId: number, body: Record<string, unknown>) =>
  call(who, 'POST', '/api/tips', { attendantId, kind: 'held', amount: 500, idemKey: newKey(), ...body });

let wash: number; // GH₵50.00, 15%
let oddWash: number; // GH₵33.33, 10% -> 333 pesewas, which does not split in two
let detail: number; // GH₵80.00, fixed GH₵5.00 commission

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p4.owner', 'owner');
  await makeUser('p4.manager', 'manager');
  await makeUser('p4.cashier', 'cashier');
  owner = await signIn('p4.owner');
  manager = await signIn('p4.manager');
  cashier = await signIn('p4.cashier');
  wash = await makeService('P4 Wash', 5000, 'percent', 1500);
  oddWash = await makeService('P4 Odd wash', 3333, 'percent', 1000);
  detail = await makeService('P4 Detail', 8000, 'fixed', 500);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('splitting a commission', () => {
  it('always adds back up exactly', () => {
    expect(splitByShares(375, [10_000])).toEqual([375]);
    expect(splitByShares(333, [5000, 5000])).toEqual([167, 166]);
    expect(splitByShares(100, [3334, 3333, 3333])).toEqual([34, 33, 33]);
    expect(splitByShares(0, [5000, 5000])).toEqual([0, 0]);
  });
});

describe('earning commission', () => {
  it('is earned when the wash is marked complete, not before', async () => {
    const kofi = await makeAttendant('P4 Kofi');
    const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [kofi] }], start: true });
    expect(await owedTo(kofi)).toBe(0);
    await call(cashier, 'POST', `/api/jobs/${made.json().job.id}/status`, { to: 'completed' });
    expect(await owedTo(kofi)).toBe(750);
  });

  it('is shared between the people on a service, to the pesewa', async () => {
    const a = await makeAttendant('P4 Ama');
    const b = await makeAttendant('P4 Esi');
    await finishedJob([{ serviceId: oddWash, attendantIds: [a, b] }]);
    expect((await owedTo(a)) + (await owedTo(b))).toBe(333);
    expect(await owedTo(a)).toBe(167);
    const entry = (await ledger(a)).entries[0]!;
    expect(entry).toMatchObject({ type: 'earned', amount: 167, sharePct: 50, reversed: false });
  });

  it('can be a fixed amount, and a discount does not reduce it', async () => {
    const yaw = await makeAttendant('P4 Yaw');
    await finishedJob([{ serviceId: detail, attendantIds: [yaw] }], 1000);
    expect(await owedTo(yaw)).toBe(500);
  });

  it('adds up across jobs and services', async () => {
    const nana = await makeAttendant('P4 Nana');
    await finishedJob([{ serviceId: wash, attendantIds: [nana] }, { serviceId: detail, attendantIds: [nana] }]);
    await finishedJob([{ serviceId: wash, attendantIds: [nana] }]);
    const l = await ledger(nana);
    expect(l).toMatchObject({ owed: 750 + 500 + 750, earned: 2000, paidOut: 0 });
    expect(l.entries).toHaveLength(3);
  });

  it('is taken back when the job is voided', async () => {
    const abena = await makeAttendant('P4 Abena');
    const id = await finishedJob([{ serviceId: wash, attendantIds: [abena] }]);
    expect(await owedTo(abena)).toBe(750);
    expect((await call(manager, 'POST', `/api/jobs/${id}/void`, { reason: 'Booked on the wrong car' })).statusCode).toBe(200);
    const l = await ledger(abena);
    expect(l.owed).toBe(0);
    expect(l.entries[0]).toMatchObject({ type: 'earned', reversed: true });
  });
});

describe('who can see commissions', () => {
  it('is for managers and owners only', async () => {
    const id = await makeAttendant('P4 Private');
    expect((await call(cashier, 'GET', '/api/commissions')).statusCode).toBe(403);
    expect((await call(cashier, 'GET', `/api/commissions/attendants/${id}`)).statusCode).toBe(403);
    expect((await call(manager, 'GET', '/api/commissions')).statusCode).toBe(200);
    expect((await call(owner, 'GET', `/api/commissions/attendants/${id}`)).statusCode).toBe(200);
    expect((await call(manager, 'GET', '/api/commissions/attendants/999999')).statusCode).toBe(404);
  });

  it('lists what each attendant is owed, biggest first', async () => {
    const rich = await makeAttendant('P4 Rich');
    await finishedJob([{ serviceId: detail, attendantIds: [rich] }]);
    const res = (await call(manager, 'GET', '/api/commissions')).json() as { attendants: { attendantId: number; owed: number; earned7d: number }[]; totalOwed: number };
    const row = res.attendants.find((r) => r.attendantId === rich);
    expect(row).toMatchObject({ owed: 500, earned7d: 500 });
    const owed = res.attendants.map((r) => r.owed);
    expect(owed).toEqual([...owed].sort((x, y) => y - x));
    expect(res.totalOwed).toBe(owed.reduce((s, n) => s + n, 0));
  });
});

describe('paying commission out', () => {
  it('lets part be paid, then the rest', async () => {
    const kwame = await makeAttendant('P4 Kwame');
    await finishedJob([{ serviceId: wash, attendantIds: [kwame] }]);
    const first = await payout(manager, kwame, { amount: 300 });
    expect(first.statusCode).toBe(201);
    expect(first.json().ledger).toMatchObject({ owed: 450, paidOut: 300 });
    const second = await payout(owner, kwame, { amount: 450, method: 'momo', note: 'Sent to his MoMo' });
    expect(second.json().ledger).toMatchObject({ owed: 0, paidOut: 750 });
    expect(second.json().ledger.entries[0]).toMatchObject({ type: 'payout', amount: 450 });
  });

  it('is for managers and owners, and never more than is owed', async () => {
    const fiifi = await makeAttendant('P4 Fiifi');
    await finishedJob([{ serviceId: wash, attendantIds: [fiifi] }]);
    expect((await payout(cashier, fiifi, { amount: 100 })).statusCode).toBe(403);
    const over = await payout(manager, fiifi, { amount: 751 });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.message).toMatch(/Only GH₵7\.50 is owed/);
    expect((await payout(manager, fiifi, { amount: 0 })).statusCode).toBe(400);
    expect(await owedTo(fiifi)).toBe(750);
    expect((await payout(manager, 999999, { amount: 100 })).statusCode).toBe(404);
  });

  it('refuses a payout when nothing is owed', async () => {
    const nobody = await makeAttendant('P4 Nobody');
    const res = await payout(manager, nobody, { amount: 100 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('nothing_owed');
  });

  it('pays once when the same request arrives twice', async () => {
    const adwoa = await makeAttendant('P4 Adwoa');
    await finishedJob([{ serviceId: wash, attendantIds: [adwoa] }]);
    const idemKey = newKey();
    const first = await payout(manager, adwoa, { amount: 200, idemKey });
    const second = await payout(manager, adwoa, { amount: 200, idemKey });
    expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
    expect((await ledger(adwoa)).paidOut).toBe(200);
    const other = await makeAttendant('P4 Other');
    expect((await payout(manager, other, { amount: 200, idemKey })).statusCode).toBe(409);
  });

  it('can be voided with a reason, which gives the money back to the balance', async () => {
    const kojo = await makeAttendant('P4 Kojo');
    await finishedJob([{ serviceId: wash, attendantIds: [kojo] }]);
    const paid = await payout(manager, kojo, { amount: 750 });
    const payoutId = paid.json().ledger.entries[0].id as number;
    expect((await call(manager, 'POST', `/api/commissions/payouts/${payoutId}/void`, { reason: '' })).statusCode).toBe(400);
    const voided = await call(manager, 'POST', `/api/commissions/payouts/${payoutId}/void`, { reason: 'Paid the wrong person' });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().ledger).toMatchObject({ owed: 750, paidOut: 0 });
    expect(voided.json().ledger.entries[0].voided).toMatchObject({ reason: 'Paid the wrong person' });
    expect((await call(manager, 'POST', `/api/commissions/payouts/${payoutId}/void`, { reason: 'Again please' })).statusCode).toBe(409);
    expect((await call(cashier, 'POST', `/api/commissions/payouts/${payoutId}/void`, { reason: 'Not allowed' })).statusCode).toBe(403);
  });

  it('shows a negative balance when a job that was already paid out is voided', async () => {
    const efua = await makeAttendant('P4 Efua');
    const id = await finishedJob([{ serviceId: wash, attendantIds: [efua] }]);
    await payout(manager, efua, { amount: 750 });
    await call(manager, 'POST', `/api/jobs/${id}/void`, { reason: 'Booked twice by mistake' });
    expect(await owedTo(efua)).toBe(-750);
    expect((await payout(manager, efua, { amount: 100 })).json().error.code).toBe('nothing_owed');
  });
});

describe('recording tips', () => {
  it('lets a cashier write down a held tip and a direct one', async () => {
    const mary = await makeAttendant('P4 Mary');
    const held = await tip(cashier, mary, { amount: 1000 });
    expect(held.statusCode).toBe(201);
    expect(held.json().tip).toMatchObject({ attendant: 'P4 Mary', amount: 1000, kind: 'held', handedOut: false, voided: null });
    expect((await tip(cashier, mary, { amount: 500, kind: 'direct' })).statusCode).toBe(201);
  });

  it('can say which car it was for', async () => {
    const john = await makeAttendant('P4 John');
    const jobId = await finishedJob([{ serviceId: wash, attendantIds: [john] }]);
    const res = await tip(cashier, john, { jobId });
    expect(res.json().tip).toMatchObject({ jobId });
    expect(res.json().tip.plate).toMatch(/^GQ /);
    await call(manager, 'POST', `/api/jobs/${jobId}/void`, { reason: 'Booked on the wrong car' });
    expect((await tip(cashier, john, { jobId })).statusCode).toBe(409);
    expect((await tip(cashier, john, { jobId: 999999 })).statusCode).toBe(404);
  });

  it('refuses bad input and unknown or former attendants', async () => {
    const left = await makeAttendant('P4 Left');
    await call(owner, 'PATCH', `/api/attendants/${left}`, { active: false });
    expect((await tip(cashier, left, {})).statusCode).toBe(404);
    expect((await tip(cashier, 999999, {})).statusCode).toBe(404);
    const ok = await makeAttendant('P4 Ok');
    expect((await tip(cashier, ok, { amount: 0 })).statusCode).toBe(400);
    expect((await tip(cashier, ok, { amount: 12.5 })).statusCode).toBe(400);
    expect((await tip(cashier, ok, { kind: 'cash' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/tips', payload: {} })).statusCode).toBe(401);
  });

  it('saves once when the same request arrives twice', async () => {
    const ruth = await makeAttendant('P4 Ruth');
    const idemKey = newKey();
    const first = await tip(cashier, ruth, { idemKey });
    const second = await tip(cashier, ruth, { idemKey });
    expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
    expect(second.json().tip.id).toBe(first.json().tip.id);
    const heldFor = (await call(cashier, 'GET', '/api/tips')).json().held.find((h: { attendantId: number }) => h.attendantId === ruth);
    expect(heldFor).toMatchObject({ amount: 500, count: 1 });
  });
});

describe('holding and handing out tips', () => {
  it('counts only held tips as held, per attendant', async () => {
    const grace = await makeAttendant('P4 Grace');
    await tip(cashier, grace, { amount: 1000 });
    await tip(cashier, grace, { amount: 250 });
    await tip(cashier, grace, { amount: 4000, kind: 'direct' });
    const res = (await call(cashier, 'GET', '/api/tips')).json();
    expect(res.held.find((h: { attendantId: number }) => h.attendantId === grace)).toMatchObject({ amount: 1250, count: 2 });
    expect(res.totalHeld).toBe(res.held.reduce((s: number, h: { amount: number }) => s + h.amount, 0));
    expect(res.tips.filter((t: { attendantId: number }) => t.attendantId === grace)).toHaveLength(3);
  });

  it('is handed out in one go by a manager or owner, with one receipt', async () => {
    const paul = await makeAttendant('P4 Paul');
    await tip(cashier, paul, { amount: 700 });
    await tip(cashier, paul, { amount: 300 });
    expect((await call(cashier, 'POST', '/api/tips/handouts', { attendantId: paul })).statusCode).toBe(403);
    const res = await call(manager, 'POST', '/api/tips/handouts', { attendantId: paul });
    expect(res.statusCode).toBe(201);
    expect(res.json().handout).toMatchObject({ amount: 1000, count: 2, attendant: 'P4 Paul' });
    const after = (await call(cashier, 'GET', '/api/tips')).json();
    expect(after.held.find((h: { attendantId: number }) => h.attendantId === paul)).toBeUndefined();
    expect(after.tips.filter((t: { attendantId: number }) => t.attendantId === paul).every((t: { handedOut: boolean }) => t.handedOut)).toBe(true);
    const again = await call(owner, 'POST', '/api/tips/handouts', { attendantId: paul });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('nothing_held');
    expect((await call(owner, 'POST', '/api/tips/handouts', { attendantId: 999999 })).statusCode).toBe(404);
  });

  it('starts a new pile after a handout', async () => {
    const tom = await makeAttendant('P4 Tom');
    await tip(cashier, tom, { amount: 100 });
    await call(manager, 'POST', '/api/tips/handouts', { attendantId: tom });
    await tip(cashier, tom, { amount: 600 });
    const held = (await call(cashier, 'GET', '/api/tips')).json().held.find((h: { attendantId: number }) => h.attendantId === tom);
    expect(held).toMatchObject({ amount: 600, count: 1 });
  });

  it('can have a wrong tip voided while it is still held', async () => {
    const lydia = await makeAttendant('P4 Lydia');
    const wrong = (await tip(cashier, lydia, { amount: 9000 })).json().tip.id as number;
    await tip(cashier, lydia, { amount: 100 });
    expect((await call(cashier, 'POST', `/api/tips/${wrong}/void`, { reason: 'Typed too many zeros' })).statusCode).toBe(403);
    expect((await call(manager, 'POST', `/api/tips/${wrong}/void`, { reason: '' })).statusCode).toBe(400);
    const res = await call(manager, 'POST', `/api/tips/${wrong}/void`, { reason: 'Typed too many zeros' });
    expect(res.statusCode).toBe(200);
    expect(res.json().tip.voided).toMatchObject({ reason: 'Typed too many zeros' });
    expect((await call(manager, 'POST', `/api/tips/${wrong}/void`, { reason: 'Again please' })).statusCode).toBe(409);
    const held = (await call(cashier, 'GET', '/api/tips')).json().held.find((h: { attendantId: number }) => h.attendantId === lydia);
    expect(held).toMatchObject({ amount: 100, count: 1 });
    expect((await call(manager, 'POST', '/api/tips/999999/void', { reason: 'No such tip' })).statusCode).toBe(404);
  });

  it('cannot be voided once it has been handed out', async () => {
    const sam = await makeAttendant('P4 Sam');
    const id = (await tip(cashier, sam, {})).json().tip.id as number;
    await call(manager, 'POST', '/api/tips/handouts', { attendantId: sam });
    const res = await call(manager, 'POST', `/api/tips/${id}/void`, { reason: 'Too late for this' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('handed_out');
  });

  it('never changes the job or its payments', async () => {
    const dora = await makeAttendant('P4 Dora');
    const jobId = await finishedJob([{ serviceId: wash, attendantIds: [dora] }]);
    await tip(cashier, dora, { jobId, amount: 2000 });
    const job = (await call(cashier, 'GET', `/api/jobs/${jobId}`)).json().job;
    expect(job).toMatchObject({ total: 5000, paid: 0, balance: 5000 });
    expect(await owedTo(dora)).toBe(750);
  });
});

describe('the database rules', () => {
  const refusedWith = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
    } catch (e) {
      return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message;
    }
    throw new Error('the database accepted something it should have refused');
  };

  it('refuses payouts above what was earned, even straight at the database', async () => {
    const zed = await makeAttendant('P4 Zed');
    await finishedJob([{ serviceId: wash, attendantIds: [zed] }]);
    const manId = (await db.execute<{ id: number }>(sql`select id from users where username = 'p4.manager'`)).rows[0]!.id;
    const msg = await refusedWith(() =>
      db.execute(sql`insert into commission_payouts (attendant_id, amount, method, paid_by, idem_key) values (${zed}, 751, 'cash', ${manId}, 'direct-over')`),
    );
    expect(msg).toMatch(/more than has been earned/);
  });

  it('refuses edits to commissions, payouts, tips and handouts', async () => {
    const vera = await makeAttendant('P4 Vera');
    await finishedJob([{ serviceId: wash, attendantIds: [vera] }]);
    await payout(manager, vera, { amount: 100 });
    await tip(cashier, vera, {});
    await call(manager, 'POST', '/api/tips/handouts', { attendantId: vera });
    await tip(cashier, vera, { amount: 900 });
    expect(await refusedWith(() => db.execute(sql`update commissions set amount = amount + 1 where line_attendant_id in (select id from job_line_attendants where attendant_id = ${vera})`))).toMatch(/cannot be edited/);
    expect(await refusedWith(() => db.execute(sql`update commission_payouts set amount = 1 where attendant_id = ${vera}`))).toMatch(/cannot be edited/);
    expect(await refusedWith(() => db.execute(sql`update tips set amount = 1 where attendant_id = ${vera} and handout_id is null`))).toMatch(/cannot be edited/);
    expect(await refusedWith(() => db.execute(sql`update tips set voided_at = now() where attendant_id = ${vera} and handout_id is not null`))).toMatch(/handed out/);
    expect(await refusedWith(() => db.execute(sql`update tip_handouts set amount = 1 where attendant_id = ${vera}`))).toMatch(/cannot be edited/);
    expect(await refusedWith(() => db.execute(sql`delete from tips`))).toMatch(/voided, never deleted/);
    expect(await refusedWith(() => db.execute(sql`delete from commission_payouts`))).toMatch(/voided, never deleted/);
  });
});
