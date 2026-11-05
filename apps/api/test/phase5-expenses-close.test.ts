import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { dayOf } from '../src/lib/dayLock.js';
import { hashPassword } from '../src/lib/password.js';
import { roleIdFor } from './roles.js';

const PASSWORD = 'correct horse battery';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;
let ipCounter = 0;
const nextIp = () => `10.6.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

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
const newPlate = () => `GQ ${String(5000 + ++plateCounter)}-26`;
const newKey = () => `p5-test-key-${++keyCounter}-${Date.now()}`;

/** A day some days ago. Nothing is sold on past days in the tests, so their drawer is exactly what the test puts in it. */
const daysAgo = (n: number) => dayOf(new Date(Date.now() - n * 86_400_000));
const TODAY = () => dayOf();

const expense = (who: string, body: Record<string, unknown> = {}) =>
  call(who, 'POST', '/api/expenses', { category: 'Water', amount: 1000, methodId: 1, idemKey: newKey(), ...body });
const summary = async (who: string, day?: string) =>
  (await call(who, 'GET', `/api/daily-close${day ? `?day=${day}` : ''}`)).json().summary as {
    day: string;
    locked: boolean;
    close: { status: string; expectedCash: number; countedCash: number; difference: number; note: string | null; openingFloat: number; reopened: { reason: string } | null } | null;
    takings: { drawer: number; other: number; total: number };
    cash: { paymentsIn: number; heldTipsIn: number; expensesOut: number; payoutsOut: number; handoutsOut: number; expectedBeforeFloat: number } | null;
    otherOut: { expenses: number; payouts: number };
    unpaid: { count: number; amount: number };
    suggestedFloat: number | null;
  };
const closeDay = (who: string, body: Record<string, unknown>) => call(who, 'POST', '/api/daily-close', body);

let serviceId: number;
let attendantId: number;

/** A job that is booked, finished and priced GH₵50.00. Returns its id. */
async function finishedJob(): Promise<number> {
  const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId, attendantIds: [attendantId] }], start: true });
  expect(made.statusCode).toBe(201);
  const id = made.json().job.id as number;
  expect((await call(cashier, 'POST', `/api/jobs/${id}/status`, { to: 'completed' })).statusCode).toBe(200);
  return id;
}
const pay = (jobId: number, body: Record<string, unknown> = {}) =>
  call(cashier, 'POST', `/api/jobs/${jobId}/payments`, { methodId: 1, amount: 1000, idemKey: newKey(), ...body });

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p5.owner', 'owner');
  await makeUser('p5.manager', 'manager');
  await makeUser('p5.cashier', 'cashier');
  owner = await signIn('p5.owner');
  manager = await signIn('p5.manager');
  cashier = await signIn('p5.cashier');
  serviceId = (await call(owner, 'POST', '/api/services', { name: 'P5 Wash', price: 5000, commissionKind: 'percent', commissionValue: 1000, active: true })).json().service.id;
  attendantId = (await call(owner, 'POST', '/api/attendants', { name: 'P5 Kojo', phone: null })).json().attendant.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('writing down an expense', () => {
  it('lets a cashier add one, and saves it once however many times the form is sent', async () => {
    const body = { category: 'Soap & chemicals', amount: 2550, methodId: 1, receipt: 'R-1001', idemKey: newKey() };
    const first = await call(cashier, 'POST', '/api/expenses', body);
    expect(first.statusCode).toBe(201);
    expect(first.json().expense).toMatchObject({ category: 'Soap & chemicals', amount: 2550, methodId: 1, receipt: 'R-1001', spentOn: TODAY(), voided: null });
    const again = await call(cashier, 'POST', '/api/expenses', body);
    expect(again.statusCode).toBe(200);
    expect(again.json().expense.id).toBe(first.json().expense.id);
    const list = (await call(cashier, 'GET', `/api/expenses?from=${TODAY()}&to=${TODAY()}`)).json();
    expect(list.expenses.filter((e: { id: number }) => e.id === first.json().expense.id)).toHaveLength(1);
  });

  it('refuses nonsense', async () => {
    expect((await expense(cashier, { amount: 0 })).statusCode).toBe(400);
    expect((await expense(cashier, { amount: 12.5 })).statusCode).toBe(400);
    expect((await expense(cashier, { category: 'Gold plating' })).statusCode).toBe(400);
    expect((await expense(cashier, { methodId: 99999 })).statusCode).toBe(404);
    expect((await expense(cashier, { category: 'Other' })).statusCode).toBe(400); // "Other" must say what for
    expect((await expense(cashier, { category: 'Other', note: 'Gate padlock' })).statusCode).toBe(201);
  });

  it('flags a missing receipt', async () => {
    const before = (await call(cashier, 'GET', `/api/expenses?from=${TODAY()}&to=${TODAY()}`)).json().withoutReceipt as number;
    const made = await expense(cashier, { receipt: '   ' });
    expect(made.json().expense.receipt).toBeNull();
    const after = (await call(cashier, 'GET', `/api/expenses?from=${TODAY()}&to=${TODAY()}`)).json().withoutReceipt as number;
    expect(after).toBe(before + 1);
  });

  it('can be a few days late, but never in the future or too old', async () => {
    expect((await expense(cashier, { spentOn: daysAgo(5) })).statusCode).toBe(201);
    expect((await expense(cashier, { spentOn: daysAgo(7) })).statusCode).toBe(201);
    const old = await expense(cashier, { spentOn: daysAgo(8) });
    expect(old.statusCode).toBe(400);
    expect(old.json().error.code).toBe('too_old');
    const future = await expense(cashier, { spentOn: dayOf(new Date(Date.now() + 2 * 86_400_000)) });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.code).toBe('bad_date');
  });

  it('needs someone signed in', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/expenses', payload: { category: 'Water', amount: 100, methodId: 1, idemKey: newKey() } });
    expect(res.statusCode).toBe(401);
  });

  it('adds up cash and MoMo apart, and leaves voided ones out', async () => {
    const day = daysAgo(6);
    await expense(cashier, { spentOn: day, amount: 1000, methodId: 1, receipt: 'a' });
    await expense(cashier, { spentOn: day, amount: 400, methodId: 2, receipt: 'b' });
    const wrong = (await expense(cashier, { spentOn: day, amount: 9999, methodId: 1, receipt: 'c' })).json().expense.id as number;
    expect((await call(manager, 'POST', `/api/expenses/${wrong}/void`, { reason: 'Typed the wrong amount' })).statusCode).toBe(200);
    const list = (await call(manager, 'GET', `/api/expenses?from=${day}&to=${day}`)).json();
    expect(list).toMatchObject({ sum: 1400, drawerSum: 1000, otherSum: 400 });
    expect(list.expenses).toHaveLength(3);
    expect(list.expenses.find((e: { id: number }) => e.id === wrong).voided).toMatchObject({ reason: 'Typed the wrong amount' });
  });

  it('can only be voided by a manager or owner, with a reason, once', async () => {
    const id = (await expense(cashier)).json().expense.id as number;
    expect((await call(cashier, 'POST', `/api/expenses/${id}/void`, { reason: 'I made a mistake' })).statusCode).toBe(403);
    expect((await call(manager, 'POST', `/api/expenses/${id}/void`, {})).statusCode).toBe(400);
    expect((await call(manager, 'POST', `/api/expenses/${id}/void`, { reason: 'no' })).statusCode).toBe(400);
    const voided = await call(owner, 'POST', `/api/expenses/${id}/void`, { reason: 'Entered twice by mistake' });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().expense.voided).toMatchObject({ reason: 'Entered twice by mistake' });
    expect((await call(manager, 'POST', `/api/expenses/${id}/void`, { reason: 'Voiding it again' })).statusCode).toBe(409);
    expect((await call(manager, 'POST', '/api/expenses/999999/void', { reason: 'There is no such one' })).statusCode).toBe(404);
  });
});

describe("the day's figures", () => {
  it('count the drawer: payments and held tips in, cash expenses, payouts and handouts out', async () => {
    const before = await summary(manager);
    const job = await finishedJob();
    await pay(job, { amount: 3000 });
    await pay(job, { methodId: 2, amount: 2000, reference: 'MP260101.1234.A12345' });
    await call(cashier, 'POST', '/api/tips', { attendantId, kind: 'held', amount: 700, idemKey: newKey() });
    await call(cashier, 'POST', '/api/tips', { attendantId, kind: 'direct', amount: 5000, idemKey: newKey() }); // never in the drawer
    await expense(cashier, { amount: 450, methodId: 1, receipt: 'x' });
    await expense(cashier, { amount: 800, methodId: 2, receipt: 'y' }); // MoMo leaves the drawer alone
    await call(manager, 'POST', '/api/commissions/payouts', { attendantId, amount: 200, methodId: 1, idemKey: newKey() });
    await call(manager, 'POST', '/api/tips/handouts', { attendantId });

    const after = await summary(manager);
    const handed = 700; // everything held for this attendant, who had nothing held before
    expect(after.takings.drawer - before.takings.drawer).toBe(3000);
    expect(after.takings.other - before.takings.other).toBe(2000);
    expect(after.takings.total - before.takings.total).toBe(5000);
    expect(after.cash!.paymentsIn - before.cash!.paymentsIn).toBe(3000);
    expect(after.cash!.heldTipsIn - before.cash!.heldTipsIn).toBe(700);
    expect(after.cash!.expensesOut - before.cash!.expensesOut).toBe(450);
    expect(after.cash!.payoutsOut - before.cash!.payoutsOut).toBe(200);
    expect(after.cash!.handoutsOut - before.cash!.handoutsOut).toBe(handed);
    expect(after.otherOut.expenses - before.otherOut.expenses).toBe(800);
    expect(after.cash!.expectedBeforeFloat - before.cash!.expectedBeforeFloat).toBe(3000 + 700 - 450 - 200 - handed);
    expect(after.unpaid.amount - before.unpaid.amount).toBe(0); // the job is paid in full
  });

  it('show cars finished but not paid for', async () => {
    const before = await summary(manager);
    const job = await finishedJob();
    await pay(job, { amount: 1500 });
    const after = await summary(manager);
    expect(after.unpaid.count - before.unpaid.count).toBe(1);
    expect(after.unpaid.amount - before.unpaid.amount).toBe(3500);
  });

  it('leave voided payments and expenses out', async () => {
    const before = await summary(manager);
    const job = await finishedJob();
    const paid = await pay(job, { amount: 1200 });
    const paymentId = paid.json().job.payments[0].id as number;
    await call(manager, 'POST', `/api/jobs/${job}/payments/${paymentId}/void`, { reason: 'Wrong job entered' });
    const spent = (await expense(cashier, { amount: 333, receipt: 'z' })).json().expense.id as number;
    await call(manager, 'POST', `/api/expenses/${spent}/void`, { reason: 'Entered by mistake' });
    const after = await summary(manager);
    expect(after.cash!.expectedBeforeFloat).toBe(before.cash!.expectedBeforeFloat);
  });

  it('refuse a day that has not happened', async () => {
    const tomorrow = dayOf(new Date(Date.now() + 86_400_000));
    expect((await call(manager, 'GET', `/api/daily-close?day=${tomorrow}`)).statusCode).toBe(400);
    expect((await closeDay(manager, { day: tomorrow, openingFloat: 0, countedCash: 0 })).statusCode).toBe(400);
    expect((await call(manager, 'GET', '/api/daily-close?day=yesterday')).statusCode).toBe(400);
  });
});

describe('closing a day', () => {
  it('lets a cashier count without being told what the drawer should hold', async () => {
    const day = daysAgo(10);
    const blind = await summary(cashier, day);
    expect(blind.cash).toBeNull();
    expect(blind.close).toBeNull();
    expect(blind.locked).toBe(false);

    // Wrong count, no note: refused, and the answer is not given away.
    const off = await closeDay(cashier, { day, openingFloat: 5000, countedCash: 4000 });
    expect(off.statusCode).toBe(400);
    expect(off.json().error.code).toBe('note_needed');
    expect(off.json().error.message).not.toMatch(/GH₵|short|\bover\b/);

    const done = await closeDay(cashier, { day, openingFloat: 5000, countedCash: 5000 });
    expect(done.statusCode).toBe(201);
    // Once it is closed, the numbers are no secret.
    expect(done.json().summary).toMatchObject({ locked: true, close: { expectedCash: 5000, countedCash: 5000, difference: 0, status: 'closed' } });
  });

  it('shows a manager the answer, and asks them to explain a shortage', async () => {
    const day = daysAgo(9);
    const seen = await summary(manager, day);
    expect(seen.cash).toMatchObject({ expectedBeforeFloat: 0 });
    const off = await closeDay(manager, { day, openingFloat: 5000, countedCash: 4250 });
    expect(off.statusCode).toBe(400);
    expect(off.json().error.message).toMatch(/GH₵7\.50 short/);
    const done = await closeDay(manager, { day, openingFloat: 5000, countedCash: 4250, note: 'Gave change to a customer and forgot to write it' });
    expect(done.statusCode).toBe(201);
    expect(done.json().summary.close).toMatchObject({ expectedCash: 5000, countedCash: 4250, difference: -750, note: 'Gave change to a customer and forgot to write it' });
  });

  it('records a surplus the same way', async () => {
    const day = daysAgo(8);
    const off = await closeDay(manager, { day, openingFloat: 1000, countedCash: 1500 });
    expect(off.json().error.message).toMatch(/GH₵5\.00 over/);
    const done = await closeDay(manager, { day, openingFloat: 1000, countedCash: 1500, note: 'Tip left in the drawer' });
    expect(done.json().summary.close.difference).toBe(500);
  });

  it('cannot be closed twice', async () => {
    const day = daysAgo(10);
    const twice = await closeDay(manager, { day, openingFloat: 5000, countedCash: 5000 });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('already_closed');
  });

  it('suggests the last count as the next float', async () => {
    expect((await summary(manager, daysAgo(9))).suggestedFloat).toBe(5000); // the count of the day before
    expect((await summary(manager, daysAgo(11))).suggestedFloat).toBeNull();
  });

  it('refuses a negative or fractional count', async () => {
    expect((await closeDay(manager, { day: daysAgo(20), openingFloat: -1, countedCash: 0 })).statusCode).toBe(400);
    expect((await closeDay(manager, { day: daysAgo(20), openingFloat: 0, countedCash: 10.5 })).statusCode).toBe(400);
  });

  it('shows the history to a manager, not a cashier', async () => {
    const history = await call(manager, 'GET', '/api/daily-close/history');
    expect(history.statusCode).toBe(200);
    const days = history.json().closes.map((c: { day: string }) => c.day);
    expect(days).toEqual(expect.arrayContaining([daysAgo(10), daysAgo(9), daysAgo(8)]));
    expect(days).toEqual([...days].sort().reverse());
    expect((await call(cashier, 'GET', '/api/daily-close/history')).statusCode).toBe(403);
  });
});

describe('a closed day', () => {
  const day = daysAgo(3);

  it('works out the expected cash from the float and what moved', async () => {
    // 2000 float - 600 cash expense = 1400
    expect((await expense(cashier, { spentOn: day, amount: 600, receipt: 'e1' })).statusCode).toBe(201);
    const s = await summary(manager, day);
    expect(s.cash!.expectedBeforeFloat).toBe(-600);
    const closed = await closeDay(manager, { day, openingFloat: 2000, countedCash: 1400 });
    expect(closed.statusCode).toBe(201);
    expect(closed.json().summary.close).toMatchObject({ expectedCash: 1400, difference: 0 });
  });

  it('refuses new expenses and voids for that day', async () => {
    const blocked = await expense(cashier, { spentOn: day, receipt: 'late' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('day_closed');
    const list = (await call(manager, 'GET', `/api/expenses?from=${day}&to=${day}`)).json();
    expect(list.closedDays).toContain(day);
    const existing = list.expenses[0].id as number;
    const voidAttempt = await call(manager, 'POST', `/api/expenses/${existing}/void`, { reason: 'Trying to change the past' });
    expect(voidAttempt.statusCode).toBe(409);
    expect(voidAttempt.json().error.code).toBe('day_closed');
  });

  it('can only be reopened by a manager or owner, and they have to say why', async () => {
    expect((await call(cashier, 'POST', `/api/daily-close/${day}/reopen`, { reason: 'Forgot an expense' })).statusCode).toBe(403);
    expect((await call(manager, 'POST', `/api/daily-close/${day}/reopen`, {})).statusCode).toBe(400);
    expect((await call(manager, 'POST', `/api/daily-close/${day}/reopen`, { reason: 'x' })).statusCode).toBe(400);
    expect((await call(manager, 'POST', `/api/daily-close/${daysAgo(40)}/reopen`, { reason: 'There is no such day' })).statusCode).toBe(404);
    const open = await call(manager, 'POST', `/api/daily-close/${day}/reopen`, { reason: 'An expense was left out' });
    expect(open.statusCode).toBe(200);
    expect(open.json().summary).toMatchObject({ locked: false, close: { status: 'reopened', reopened: { reason: 'An expense was left out' } } });
    expect((await call(manager, 'POST', `/api/daily-close/${day}/reopen`, { reason: 'Reopening it again' })).statusCode).toBe(409);
  });

  it('takes the expense once reopened, and is counted again when it is closed again', async () => {
    expect((await expense(cashier, { spentOn: day, amount: 400, receipt: 'e2' })).statusCode).toBe(201);
    // The old count is wrong now: 2000 - 600 - 400 = 1000.
    const wrong = await closeDay(manager, { day, openingFloat: 2000, countedCash: 1400 });
    expect(wrong.statusCode).toBe(400);
    const again = await closeDay(manager, { day, openingFloat: 2000, countedCash: 1000 });
    expect(again.statusCode).toBe(201);
    expect(again.json().summary).toMatchObject({ locked: true, close: { expectedCash: 1000, countedCash: 1000, difference: 0, reopened: { reason: 'An expense was left out' } } });
    const trail = await db.execute<{ action: string }>(sql`select action from audit_logs where action like 'dailyclose.%' order by id`);
    expect(trail.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['dailyclose.close', 'dailyclose.reopen', 'dailyclose.reclose']));
  });
});

describe('closing today', () => {
  it('stops payments, held tips, payouts and handouts until a manager reopens the day', async () => {
    const job = await finishedJob();
    const saved = await pay(job, { amount: 1000 });
    const paymentId = saved.json().job.payments[0].id as number;
    const second = { methodId: 1, amount: 2000, idemKey: newKey() };
    expect((await call(cashier, 'POST', `/api/jobs/${job}/payments`, second)).statusCode).toBe(201);
    await call(cashier, 'POST', '/api/tips', { attendantId, kind: 'held', amount: 300, idemKey: newKey() });
    await call(manager, 'POST', '/api/commissions/payouts', { attendantId, amount: 100, methodId: 1, idemKey: newKey() });

    // Count exactly what the drawer should hold, with a float of GH₵30.00.
    const s = await summary(manager);
    const closed = await closeDay(manager, { openingFloat: 3000, countedCash: 3000 + s.cash!.expectedBeforeFloat });
    expect(closed.statusCode).toBe(201);
    expect(closed.json().summary.locked).toBe(true);

    // Nothing more can happen on today.
    const refused = async (res: Awaited<ReturnType<typeof call>>) => {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('day_closed');
    };
    await refused(await pay(job, { amount: 500 }));
    await refused(await call(manager, 'POST', `/api/jobs/${job}/payments/${paymentId}/void`, { reason: 'Trying to change the past' }));
    await refused(await call(cashier, 'POST', '/api/tips', { attendantId, kind: 'held', amount: 100, idemKey: newKey() }));
    await refused(await call(manager, 'POST', '/api/tips/handouts', { attendantId }));
    await refused(await call(manager, 'POST', '/api/commissions/payouts', { attendantId, amount: 50, methodId: 1, idemKey: newKey() }));
    await refused(await expense(cashier, { receipt: 'too late' }));

    // A direct tip never touches the drawer, and sending the same form again still just says "saved".
    expect((await call(cashier, 'POST', '/api/tips', { attendantId, kind: 'direct', amount: 200, idemKey: newKey() })).statusCode).toBe(201);
    expect((await call(cashier, 'POST', `/api/jobs/${job}/payments`, second)).statusCode).toBe(200);

    // Reopening lets the work carry on.
    expect((await call(manager, 'POST', `/api/daily-close/${TODAY()}/reopen`, { reason: 'A late payment came in' })).statusCode).toBe(200);
    expect((await pay(job, { amount: 500 })).statusCode).toBe(201);
    expect((await expense(cashier, { receipt: 'now fine' })).statusCode).toBe(201);
  });
});

describe('what the database itself refuses', () => {
  const refusedWith = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
    } catch (e) {
      return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message;
    }
    throw new Error('the database accepted something it should have refused');
  };

  it('never edits or deletes an expense, and a voided one stays voided', async () => {
    const id = (await expense(cashier, { receipt: 'db' })).json().expense.id as number;
    expect(await refusedWith(() => db.execute(sql`update expenses set amount = 1 where id = ${id}`))).toMatch(/cannot be edited/);
    expect(await refusedWith(() => db.execute(sql`update expenses set spent_on = '2020-01-01' where id = ${id}`))).toMatch(/cannot be edited/);
    expect(await refusedWith(() => db.execute(sql`delete from expenses where id = ${id}`))).toMatch(/voided, never deleted/);
    await call(manager, 'POST', `/api/expenses/${id}/void`, { reason: 'Test of the database rule' });
    expect(await refusedWith(() => db.execute(sql`update expenses set void_reason = 'changed' where id = ${id}`))).toMatch(/voided expense cannot be changed/);
  });

  it('keeps a closed day as it was counted', async () => {
    const day = daysAgo(8);
    expect(await refusedWith(() => db.execute(sql`update daily_closes set counted_cash = 9999 where day = ${day}`))).toMatch(/only be reopened/);
    expect(await refusedWith(() => db.execute(sql`update daily_closes set status = 'reopened' where day = ${day}`))).toMatch(/needs who and why/);
    expect(await refusedWith(() => db.execute(sql`update daily_closes set day = '2020-01-01' where day = ${day}`))).toMatch(/another day/);
    expect(await refusedWith(() => db.execute(sql`delete from daily_closes where day = ${day}`))).toMatch(/voided, never deleted/);
  });

  it('does not let a reopened day forget who reopened it', async () => {
    const day = daysAgo(3);
    await call(manager, 'POST', `/api/daily-close/${day}/reopen`, { reason: 'Checking the database rule' });
    expect(await refusedWith(() => db.execute(sql`update daily_closes set reopen_reason = 'nothing happened' where day = ${day}`))).toMatch(/only be closed again/);
    expect(await refusedWith(() => db.execute(sql`update daily_closes set status = 'closed', reopen_reason = 'nothing happened' where day = ${day}`))).toMatch(/who reopened/);
    const again = await closeDay(manager, { day, openingFloat: 2000, countedCash: 1000 });
    expect(again.statusCode).toBe(201);
  });
});
