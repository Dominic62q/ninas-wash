import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DashboardDto, ReportDto } from '@niinas/shared';
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
const nextIp = () => `10.7.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

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
const newPlate = () => `GQ ${String(6000 + ++plateCounter)}-26`;
const newKey = () => `p6-test-key-${++keyCounter}-${Date.now()}`;
const daysAgo = (n: number) => dayOf(new Date(Date.now() - n * 86_400_000));
const TODAY = () => dayOf();

const dashboard = async (who: string) => {
  const res = await call(who, 'GET', '/api/dashboard');
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as DashboardDto;
};
const report = async (from: string, to: string) => {
  const res = await call(owner, 'GET', `/api/reports?from=${from}&to=${to}`);
  expect(res.statusCode).toBe(200);
  return res.json() as ReportDto;
};

let serviceId: number;
let attendantId: number;

async function bookJob(start = true): Promise<number> {
  const made = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId, attendantIds: [attendantId] }], start });
  expect(made.statusCode).toBe(201);
  return made.json().job.id as number;
}
async function finishedJob(): Promise<number> {
  const id = await bookJob();
  expect((await call(cashier, 'POST', `/api/jobs/${id}/status`, { to: 'completed' })).statusCode).toBe(200);
  return id;
}
const pay = (jobId: number, body: Record<string, unknown> = {}) =>
  call(cashier, 'POST', `/api/jobs/${jobId}/payments`, { methodId: 1, amount: 1000, idemKey: newKey(), ...body });

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p6.owner', 'owner');
  await makeUser('p6.manager', 'manager');
  await makeUser('p6.cashier', 'cashier');
  owner = await signIn('p6.owner');
  manager = await signIn('p6.manager');
  cashier = await signIn('p6.cashier');
  serviceId = (await call(owner, 'POST', '/api/services', { name: 'P6 Wash', price: 5000, commissionKind: 'percent', commissionValue: 1000, active: true })).json().service.id;
  attendantId = (await call(owner, 'POST', '/api/attendants', { name: 'P6 Kojo', phone: null })).json().attendant.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('the dashboard', () => {
  it('needs someone signed in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(401);
  });

  it('counts the day: takings by method, cars by stage, money still owed', async () => {
    const before = await dashboard(manager);
    const waiting = await bookJob(false);
    const washing = await bookJob(true);
    const ready = await finishedJob();
    expect((await pay(ready, { methodId: 1, amount: 2000 })).statusCode).toBe(201);
    expect((await pay(washing, { methodId: 2, amount: 700, reference: 'MP260101.1234.A12345' })).statusCode).toBe(201);
    void waiting;

    const after = await dashboard(manager);
    expect(after.day).toBe(TODAY());
    expect(after.takings.drawer - before.takings.drawer).toBe(2000);
    expect(after.takings.other - before.takings.other).toBe(700);
    expect(after.takings.total - before.takings.total).toBe(2700);
    expect(after.takings.payments - before.takings.payments).toBe(2);
    expect(after.cars.waiting - before.cars.waiting).toBe(1);
    expect(after.cars.washing - before.cars.washing).toBe(1);
    expect(after.cars.ready - before.cars.ready).toBe(1);
    expect(after.cars.total - before.cars.total).toBe(3);
    // The finished car is GH₵50.00 and GH₵20.00 was paid.
    expect(after.owing.count - before.owing.count).toBe(1);
    expect(after.owing.amount - before.owing.amount).toBe(3000);
  });

  it('leaves voided payments out of takings and brings the debt back', async () => {
    const id = await finishedJob();
    const before = await dashboard(manager);
    const made = await pay(id, { amount: 5000 });
    expect(made.statusCode).toBe(201);
    const paid = await dashboard(manager);
    expect(paid.takings.total - before.takings.total).toBe(5000);
    expect(paid.owing.count - before.owing.count).toBe(-1);
    expect((await call(manager, 'POST', `/api/jobs/${id}/payments/${made.json().job.payments[0].id}/void`, { reason: 'Wrong job' })).statusCode).toBe(200);
    const voided = await dashboard(manager);
    expect(voided.takings.total).toBe(before.takings.total);
    expect(voided.owing).toEqual(before.owing);
  });

  it('draws the chart data: a week of takings, today’s services and who worked on them', async () => {
    const before = await dashboard(manager);
    const id = await finishedJob();
    expect((await pay(id, { amount: 5000 })).statusCode).toBe(201);
    const after = await dashboard(manager);
    expect(after.last7).toHaveLength(7);
    expect(after.last7![6]!.day).toBe(TODAY());
    expect(after.last7![0]!.day).toBe(daysAgo(6));
    expect(after.last7![6]!.total - before.last7![6]!.total).toBe(5000);
    expect(after.last7![6]!.total).toBe(after.takings.total);
    const wash = (d: DashboardDto) => d.services.find((s) => s.name === 'P6 Wash') ?? { count: 0, sales: 0 };
    expect(wash(after).count - wash(before).count).toBe(1);
    expect(wash(after).sales - wash(before).sales).toBe(5000);
    const kojo = (d: DashboardDto) => d.attendants.find((a) => a.name === 'P6 Kojo')?.cars ?? 0;
    expect(kojo(after) - kojo(before)).toBe(1);
    expect(after.services.length).toBeLessThanOrEqual(6);
    // A cashier counts the drawer blind, so past takings are not shown to them.
    const c = await dashboard(cashier);
    expect(c.last7).toBeNull();
    expect(c.services.length).toBeGreaterThan(0);
  });

  it('only shows each role what it works with', async () => {
    const c = await dashboard(cashier);
    expect(c.close).toMatchObject({ status: expect.any(String) });
    expect(c.expenses).not.toBeNull();
    expect(c.heldTips).not.toBeNull();
    expect(c.commissionOwed).toBeNull();
    expect(c.unclosedDays).toBeNull();

    for (const who of [manager, owner]) {
      const d = await dashboard(who);
      expect(d.commissionOwed).toEqual(expect.any(Number));
      expect(d.unclosedDays).toEqual(expect.any(Array));
    }
  });

  it('adds up today’s expenses and flags the ones with no receipt', async () => {
    const before = (await dashboard(cashier)).expenses!;
    await call(cashier, 'POST', '/api/expenses', { category: 'Water', amount: 1200, methodId: 1, receipt: 'R-1', idemKey: newKey() });
    await call(cashier, 'POST', '/api/expenses', { category: 'Water', amount: 300, methodId: 2, idemKey: newKey() });
    const after = (await dashboard(cashier)).expenses!;
    expect(after.total - before.total).toBe(1500);
    expect(after.withoutReceipt - before.withoutReceipt).toBe(1);
  });

  it('shows held tips until they are handed over, and commission owed to managers', async () => {
    const before = await dashboard(manager);
    const id = await finishedJob();
    expect((await call(cashier, 'POST', '/api/tips', { attendantId, amount: 500, kind: 'held', jobId: id, idemKey: newKey() })).statusCode).toBe(201);
    const after = await dashboard(manager);
    expect(after.heldTips!.total - before.heldTips!.total).toBe(500);
    // 10% of GH₵50.00 earned when the job was finished.
    expect(after.commissionOwed! - before.commissionOwed!).toBe(500);
  });

  it('warns about a recent day with money moving that was never closed, until it is closed', async () => {
    const day = daysAgo(2);
    expect((await call(cashier, 'POST', '/api/expenses', { category: 'Water', amount: 800, methodId: 1, receipt: 'R-9', spentOn: day, idemKey: newKey() })).statusCode).toBe(201);
    expect((await dashboard(manager)).unclosedDays).toContain(day);
    expect((await dashboard(owner)).unclosedDays).toContain(day);

    const summary = (await call(manager, 'GET', `/api/daily-close?day=${day}`)).json().summary;
    const counted = Math.max(0, summary.cash.expectedBeforeFloat);
    const closed = await call(manager, 'POST', '/api/daily-close', { day, openingFloat: 0, countedCash: counted, note: counted === summary.cash.expectedBeforeFloat ? null : 'Test count' });
    expect(closed.statusCode).toBe(201);
    expect((await dashboard(manager)).unclosedDays).not.toContain(day);
  });

  it('tells a cashier today is closed without showing a difference before the close', async () => {
    const d = await dashboard(cashier);
    expect(['open', 'reopened']).toContain(d.close!.status);
    expect(d.close!.difference).toBeNull();
  });
});

describe('reports', () => {
  it('are for the owner only', async () => {
    const url = `/api/reports?from=${TODAY()}&to=${TODAY()}`;
    expect((await call(manager, 'GET', url)).statusCode).toBe(403);
    expect((await call(cashier, 'GET', url)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await call(owner, 'GET', url)).statusCode).toBe(200);
  });

  it('refuse a bad range', async () => {
    expect((await call(owner, 'GET', '/api/reports')).statusCode).toBe(400);
    expect((await call(owner, 'GET', '/api/reports?from=yesterday&to=today')).statusCode).toBe(400);
    const reversed = await call(owner, 'GET', `/api/reports?from=${TODAY()}&to=${daysAgo(3)}`);
    expect(reversed.statusCode).toBe(400);
    expect(reversed.json().error.message).toMatch(/before the start/i);
    const long = await call(owner, 'GET', `/api/reports?from=${daysAgo(400)}&to=${TODAY()}`);
    expect(long.statusCode).toBe(400);
    expect(long.json().error.code).toBe('range_too_long');
    expect((await call(owner, 'GET', `/api/reports?from=${daysAgo(365)}&to=${TODAY()}`)).statusCode).toBe(200);
  });

  it('give a day for every day asked for, zero where nothing happened', async () => {
    const r = await report(daysAgo(29), TODAY());
    expect(r.days).toBe(30);
    expect(r.byDay).toHaveLength(30);
    expect(r.byDay[0]!.day).toBe(daysAgo(29));
    expect(r.byDay[29]!.day).toBe(TODAY());
    expect(r.byDay.reduce((s, d) => s + d.total, 0)).toBe(r.takings.total);
    expect(r.byDay.reduce((s, d) => s + d.drawer, 0)).toBe(r.takings.drawer);
  });

  it('add up what one day sold, who earned and what was spent', async () => {
    const before = await report(TODAY(), TODAY());
    const a = await finishedJob();
    const b = await bookJob();
    // A discount can only be given while the car is still open.
    expect((await call(cashier, 'PATCH', `/api/jobs/${b}`, { discount: 500 })).statusCode).toBe(200);
    expect((await call(cashier, 'POST', `/api/jobs/${b}/status`, { to: 'completed' })).statusCode).toBe(200);
    expect((await pay(a, { amount: 5000 })).statusCode).toBe(201);
    expect((await pay(b, { methodId: 2, amount: 1500, reference: 'MP260101.1234.B67890' })).statusCode).toBe(201);
    await call(cashier, 'POST', '/api/expenses', { category: 'Electricity', amount: 2500, methodId: 2, receipt: 'E-1', idemKey: newKey() });

    const r = await report(TODAY(), TODAY());
    expect(r.takings.total - before.takings.total).toBe(6500);
    expect(r.takings.drawer - before.takings.drawer).toBe(5000);
    expect(r.takings.other - before.takings.other).toBe(1500);
    expect(r.jobs.count - before.jobs.count).toBe(2);
    expect(r.jobs.sales - before.jobs.sales).toBe(10000);
    expect(r.jobs.net - before.jobs.net).toBe(9500);
    expect(r.jobs.discounts - before.jobs.discounts).toBe(500);
    expect(r.expenses.total - before.expenses.total).toBe(2500);
    expect(r.expenses.other - before.expenses.other).toBe(2500);

    const service = (x: ReportDto) => x.byService.find((s) => s.name === 'P6 Wash') ?? { count: 0, sales: 0 };
    expect(service(r).count - service(before).count).toBe(2);
    expect(service(r).sales - service(before).sales).toBe(10000);
    const kojo = (x: ReportDto) => x.byAttendant.find((a) => a.name === 'P6 Kojo') ?? { cars: 0, earned: 0 };
    expect(kojo(r).cars - kojo(before).cars).toBe(2);
    expect(kojo(r).earned - kojo(before).earned).toBe(r.commission.earned - before.commission.earned);
    expect(kojo(r).earned - kojo(before).earned).toBeGreaterThanOrEqual(900);
    expect(kojo(r).earned - kojo(before).earned).toBeLessThanOrEqual(1000);
    expect(r.expenses.byCategory.find((c) => c.category === 'Electricity')!.amount).toBeGreaterThanOrEqual(2500);
    expect(r.net).toBe(r.takings.total - r.expenses.total - r.commission.earned);
  });

  it('take back a voided job from sales and commission', async () => {
    const before = await report(TODAY(), TODAY());
    const id = await finishedJob();
    const mid = await report(TODAY(), TODAY());
    expect(mid.jobs.count - before.jobs.count).toBe(1);
    expect(mid.commission.earned - before.commission.earned).toBe(500);
    expect((await call(manager, 'POST', `/api/jobs/${id}/void`, { reason: 'Booked twice' })).statusCode).toBe(200);
    const after = await report(TODAY(), TODAY());
    expect(after.jobs.count).toBe(before.jobs.count);
    expect(after.jobs.sales).toBe(before.jobs.sales);
    expect(after.commission.earned).toBe(before.commission.earned);
  });

  it('show tips apart from takings, and payouts apart from commission earned', async () => {
    const before = await report(TODAY(), TODAY());
    const id = await finishedJob();
    expect((await call(cashier, 'POST', '/api/tips', { attendantId, amount: 700, kind: 'held', jobId: id, idemKey: newKey() })).statusCode).toBe(201);
    expect((await call(cashier, 'POST', '/api/tips', { attendantId, amount: 300, kind: 'direct', jobId: id, idemKey: newKey() })).statusCode).toBe(201);
    const after = await report(TODAY(), TODAY());
    expect(after.tips.held - before.tips.held).toBe(700);
    expect(after.tips.direct - before.tips.direct).toBe(300);
    expect(after.takings.total).toBe(before.takings.total);
    expect(after.net - before.net).toBe(-500); // commission earned on the new car, no money received
  });

  it('list expenses by category, biggest first, and leave voided ones out', async () => {
    const day = daysAgo(4);
    const before = await report(day, day);
    const made = await call(cashier, 'POST', '/api/expenses', { category: 'Repairs', amount: 4000, methodId: 1, spentOn: day, idemKey: newKey() });
    expect(made.statusCode).toBe(201);
    const mid = await report(day, day);
    expect(mid.expenses.total - before.expenses.total).toBe(4000);
    expect(mid.expenses.withoutReceipt - before.expenses.withoutReceipt).toBe(1);
    const amounts = mid.expenses.byCategory.map((c) => c.amount);
    expect([...amounts].sort((x, y) => y - x)).toEqual(amounts);
    expect((await call(manager, 'POST', `/api/expenses/${made.json().expense.id}/void`, { reason: 'Wrong day' })).statusCode).toBe(200);
    const after = await report(day, day);
    expect(after.expenses.total).toBe(before.expenses.total);
  });

  it('count cash that balanced, ran short or over, and list days never closed', async () => {
    const closedDay = daysAgo(2);
    const r = await report(closedDay, closedDay);
    expect(r.cash.closedDays).toBe(1);
    expect(r.cash.balanced + r.cash.short + r.cash.over).toBe(1);
    expect(r.cash.notClosed).not.toContain(closedDay);

    // Past days with an expense and no close (phase 5 days are closed or empty; this one has an expense only).
    const open = daysAgo(1);
    expect((await call(cashier, 'POST', '/api/expenses', { category: 'Water', amount: 100, methodId: 1, receipt: 'x', spentOn: open, idemKey: newKey() })).statusCode).toBe(201);
    const week = await report(daysAgo(6), TODAY());
    expect(week.cash.notClosed).toContain(open);
    expect(week.cash.notClosed).not.toContain(TODAY()); // today is still being worked on
    expect(week.cash.differences.every((d) => d.difference !== 0)).toBe(true);
  });
});
