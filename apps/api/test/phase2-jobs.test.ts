import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { jobLineAttendants, jobLines, jobs, payments, users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { roleIdFor } from './roles.js';

const PASSWORD = 'correct horse battery';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;
let ipCounter = 0;
const nextIp = () => `10.3.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function makeUser(username: string, role: 'cashier' | 'manager' | 'owner') {
  const [row] = await db
    .insert(users)
    .values({ name: `${role} ${username}`, username, roleId: await roleIdFor(db, role), passwordHash: await hashPassword(PASSWORD) })
    .returning();
  return row!;
}

async function signIn(username: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
    remoteAddress: nextIp(),
  });
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
let fullWash: number;
let polish: number;
let ama: number;
let kofi: number;
let kwesi: number;
let plateCounter = 0;
const newPlate = () => `GT ${String(1000 + ++plateCounter)}-26`;

async function makeService(name: string, price: number, commissionValue: number) {
  const res = await call(owner, 'POST', '/api/services', { name, price, commissionKind: 'percent', commissionValue, active: true });
  return res.json().service.id as number;
}
async function makeAttendant(name: string) {
  const res = await call(owner, 'POST', '/api/attendants', { name, phone: null });
  return res.json().attendant.id as number;
}

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p2.owner', 'owner');
  await makeUser('p2.manager', 'manager');
  await makeUser('p2.cashier', 'cashier');
  owner = await signIn('p2.owner');
  manager = await signIn('p2.manager');
  cashier = await signIn('p2.cashier');
  fullWash = await makeService('P2 Full wash', 5000, 1800);
  polish = await makeService('P2 Polish', 3001, 1000);
  ama = await makeAttendant('P2 Ama');
  kofi = await makeAttendant('P2 Kofi');
  kwesi = await makeAttendant('P2 Kwesi');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('booking a job', () => {
  it('needs a signed-in user with the right to book', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs/board' });
    expect(res.statusCode).toBe(401);
  });

  it('books a job for a new car and snapshots price and commission on each line', async () => {
    const plate = newPlate();
    const res = await call(cashier, 'POST', '/api/jobs', {
      plate,
      makeModel: 'Toyota Corolla',
      carType: 'saloon',
      lines: [{ serviceId: fullWash, attendantIds: [ama] }, { serviceId: polish, attendantIds: [ama, kofi] }],
    });
    expect(res.statusCode).toBe(201);
    const job = res.json().job;
    expect(job.status).toBe('pending');
    expect(job.number).toMatch(/^J-\d{8}-\d{3}$/);
    expect(job.subtotal).toBe(8001);
    expect(job.total).toBe(8001);
    expect(job.vehicle.plate).toBe(plate);

    // the price on the line is a copy: changing the service later does not touch it
    await call(owner, 'PATCH', `/api/services/${fullWash}`, { price: 9999 });
    const again = (await call(cashier, 'GET', `/api/jobs/${job.id}`)).json().job;
    expect(again.lines.find((l: { serviceId: number }) => l.serviceId === fullWash).price).toBe(5000);
    await call(owner, 'PATCH', `/api/services/${fullWash}`, { price: 5000 });

    const rows = await db.select().from(jobLines).where(eq(jobLines.jobId, job.id));
    const wash = rows.find((r) => r.serviceId === fullWash)!;
    expect(wash).toMatchObject({ priceAtSale: 5000, commissionKindAtSale: 'percent', commissionValueAtSale: 1800 });
  });

  it('splits a line equally and gives the odd share to the first person', async () => {
    const res = await call(cashier, 'POST', '/api/jobs', {
      plate: newPlate(),
      lines: [{ serviceId: fullWash, attendantIds: [ama, kofi, kwesi] }],
    });
    const shares = res.json().job.lines[0].attendants.map((a: { shareBp: number }) => a.shareBp);
    expect(shares).toEqual([3334, 3333, 3333]);
    expect(shares.reduce((a: number, b: number) => a + b, 0)).toBe(10_000);
  });

  it('starts straight away when asked, and records the move', async () => {
    const res = await call(cashier, 'POST', '/api/jobs', {
      plate: newPlate(),
      lines: [{ serviceId: fullWash, attendantIds: [ama] }],
      start: true,
    });
    const job = res.json().job;
    expect(job.status).toBe('in_progress');
    expect(job.startedAt).not.toBeNull();
    expect(job.history.map((h: { action: string }) => h.action)).toEqual(['job.create', 'job.status']);
  });

  it('refuses to start a job that has a service with nobody on it', async () => {
    const res = await call(cashier, 'POST', '/api/jobs', {
      plate: newPlate(),
      lines: [{ serviceId: fullWash, attendantIds: [] }],
      start: true,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('needs_attendant');
  });

  it('refuses a second open job for the same car, whatever the spacing of the plate', async () => {
    const plate = newPlate();
    const body = { plate, lines: [{ serviceId: fullWash, attendantIds: [ama] }] };
    expect((await call(cashier, 'POST', '/api/jobs', body)).statusCode).toBe(201);
    const second = await call(cashier, 'POST', '/api/jobs', { ...body, plate: plate.replace(/[ -]/g, '').toLowerCase() });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('vehicle_has_open_job');
  });

  it('refuses a discount bigger than the services, and services that are switched off', async () => {
    const big = await call(cashier, 'POST', '/api/jobs', {
      plate: newPlate(),
      lines: [{ serviceId: fullWash, attendantIds: [ama] }],
      discount: 5001,
    });
    expect(big.statusCode).toBe(400);
    expect(big.json().error.code).toBe('discount_too_high');

    const off = await makeService('P2 Retired', 1000, 1000);
    await call(owner, 'PATCH', `/api/services/${off}`, { active: false });
    const res = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: off, attendantIds: [ama] }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_service');
  });

  it('saves a new owner with the car, and reuses them next time', async () => {
    const plate = newPlate();
    const res = await call(cashier, 'POST', '/api/jobs', {
      plate,
      lines: [{ serviceId: fullWash, attendantIds: [ama] }],
      customer: { name: 'Efua Mensah', phone: '0244123456', okToText: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().job.customer).toMatchObject({ name: 'Efua Mensah' });

    const lookup = await call(cashier, 'GET', `/api/vehicles/lookup?plate=${encodeURIComponent(plate)}`);
    expect(lookup.json().customer.name).toBe('Efua Mensah');
  });

  it('applies the discount to the total', async () => {
    const res = await call(cashier, 'POST', '/api/jobs', {
      plate: newPlate(),
      lines: [{ serviceId: fullWash, attendantIds: [ama] }],
      discount: 500,
    });
    expect(res.json().job).toMatchObject({ subtotal: 5000, discount: 500, total: 4500 });
  });
});

describe('moving a job along', () => {
  async function book(attendantIds: number[]) {
    const res = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: fullWash, attendantIds }] });
    return res.json().job as { id: number };
  }

  it('goes pending, in progress, completed, one step at a time', async () => {
    const job = await book([ama]);
    const skip = await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'completed' });
    expect(skip.statusCode).toBe(409);

    const started = await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'in_progress' });
    expect(started.json().job.status).toBe('in_progress');

    const twice = await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'in_progress' });
    expect(twice.statusCode).toBe(409);

    const done = await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'completed' });
    expect(done.json().job.status).toBe('completed');
    expect(done.json().job.completedAt).not.toBeNull();

    const back = await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'in_progress' });
    expect(back.statusCode).toBe(409);
  });

  it('will not start until someone is assigned, and assignment is set once', async () => {
    const job = await book([]);
    const blocked = await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'in_progress' });
    expect(blocked.json().error.code).toBe('needs_attendant');

    const card = (await call(cashier, 'GET', '/api/jobs/board')).json().jobs.find((j: { id: number }) => j.id === job.id);
    expect(card.needsAttendant).toBe(true);

    const lineId = (await call(cashier, 'GET', `/api/jobs/${job.id}`)).json().job.lines[0].id;
    const assigned = await call(cashier, 'PUT', `/api/jobs/${job.id}/lines/${lineId}/attendants`, { attendantIds: [kofi, kwesi] });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().job.lines[0].attendants).toHaveLength(2);

    const again = await call(cashier, 'PUT', `/api/jobs/${job.id}/lines/${lineId}/attendants`, { attendantIds: [ama] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_assigned');

    expect((await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'in_progress' })).statusCode).toBe(200);
  });

  it('adds a service while open, once only, and changes the discount within limits', async () => {
    const job = await book([ama]);
    const added = await call(cashier, 'POST', `/api/jobs/${job.id}/lines`, { serviceId: polish, attendantIds: [kofi] });
    expect(added.statusCode).toBe(201);
    expect(added.json().job.subtotal).toBe(8001);

    const dup = await call(cashier, 'POST', `/api/jobs/${job.id}/lines`, { serviceId: polish, attendantIds: [kofi] });
    expect(dup.statusCode).toBe(409);

    const disc = await call(cashier, 'PATCH', `/api/jobs/${job.id}`, { discount: 1000 });
    expect(disc.json().job.total).toBe(7001);
    expect((await call(cashier, 'PATCH', `/api/jobs/${job.id}`, { discount: 8002 })).statusCode).toBe(400);

    await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'in_progress' });
    await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'completed' });
    const late = await call(cashier, 'POST', `/api/jobs/${job.id}/lines`, { serviceId: fullWash, attendantIds: [ama] });
    expect(late.statusCode).toBe(409);
    expect((await call(cashier, 'PATCH', `/api/jobs/${job.id}`, { discount: 0 })).statusCode).toBe(409);
  });

  it('keeps a history of who did what', async () => {
    const job = await book([ama]);
    await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'in_progress' });
    await call(cashier, 'PATCH', `/api/jobs/${job.id}`, { discount: 100 });
    const detail = (await call(cashier, 'GET', `/api/jobs/${job.id}`)).json().job;
    expect(detail.history.map((h: { action: string }) => h.action)).toEqual(['job.create', 'job.status', 'job.discount']);
    expect(detail.history[0].by).toBe('cashier p2.cashier');
  });
});

describe('the board', () => {
  it('lists open jobs with their services and people, and searches by plate or owner', async () => {
    const plate = newPlate();
    await call(cashier, 'POST', '/api/jobs', {
      plate,
      lines: [{ serviceId: fullWash, attendantIds: [ama, kofi] }],
      customer: { name: 'Yaw Boadu', phone: '0201234567', okToText: false },
    });
    const all = (await call(cashier, 'GET', '/api/jobs/board')).json().jobs as { plate: string; services: string[]; attendants: string[] }[];
    const card = all.find((j) => j.plate === plate)!;
    expect(card.services).toEqual(['P2 Full wash']);
    expect(card.attendants).toEqual(['P2 Ama', 'P2 Kofi']);

    const byPlate = (await call(cashier, 'GET', `/api/jobs/board?q=${encodeURIComponent(plate.replace(/[ -]/g, ''))}`)).json().jobs;
    expect(byPlate.map((j: { plate: string }) => j.plate)).toEqual([plate]);
    const byName = (await call(cashier, 'GET', '/api/jobs/board?q=boadu')).json().jobs;
    expect(byName.map((j: { plate: string }) => j.plate)).toEqual([plate]);
  });

  it('shows every job from one chosen day, and nothing from other days', async () => {
    const plate = newPlate();
    const job = (await call(cashier, 'POST', '/api/jobs', { plate, lines: [{ serviceId: fullWash, attendantIds: [ama] }] })).json().job as { id: number };
    await db.update(jobs).set({ createdAt: new Date('2019-05-04T10:30:00Z') }).where(eq(jobs.id, job.id));
    const on = (await call(cashier, 'GET', '/api/jobs/board?date=2019-05-04')).json().jobs as { id: number }[];
    expect(on.map((j) => j.id)).toEqual([job.id]);
    expect((await call(cashier, 'GET', '/api/jobs/board?date=2019-05-05')).json().jobs).toEqual([]);
    expect((await call(cashier, 'GET', '/api/jobs/board?date=soon')).statusCode).toBe(400);
  });
});

describe('the history list', () => {
  type Row = { id: number; plate: string; status: string; voided: boolean; total: number };
  const list = async (query: string) =>
    (await call(cashier, 'GET', `/api/jobs?${query}`)).json() as { jobs: Row[]; total: number; sum: number };

  it('lists newest first, filters by date and status, and pages', async () => {
    const mk = async () => (await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: fullWash, attendantIds: [ama] }] })).json().job as { id: number; vehicle: { plate: string } };
    const older = await mk();
    const newer = await mk();
    await db.update(jobs).set({ createdAt: new Date('2020-03-10T09:00:00Z') }).where(eq(jobs.id, older.id));

    const old = await list('from=2020-03-10&to=2020-03-10');
    expect(old.jobs.map((j) => j.id)).toEqual([older.id]);
    expect(old.total).toBe(1);
    expect(old.sum).toBe(old.jobs[0]!.total);
    expect((await list('from=2020-03-11&to=2020-03-11')).jobs).toEqual([]);

    const recent = await list('from=2021-01-01');
    expect(recent.jobs[0]!.id).toBe(newer.id); // newest first
    expect(recent.jobs.some((j) => j.id === older.id)).toBe(false);

    expect((await list('status=completed&from=2021-01-01')).jobs.every((j) => j.status === 'completed')).toBe(true);
    const page = await list('limit=1&offset=0');
    expect(page.jobs).toHaveLength(1);
    expect(page.total).toBeGreaterThan(1);
    expect((await list(`q=${encodeURIComponent(newer.vehicle.plate.replace(/[ -]/g, ''))}`)).jobs.map((j) => j.id)).toEqual([newer.id]);
  });

  it('hides voided jobs unless they are asked for', async () => {
    const job = (await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: fullWash, attendantIds: [ama] }] })).json().job as { id: number };
    await call(manager, 'POST', `/api/jobs/${job.id}/void`, { reason: 'Booked on the wrong car' });
    expect((await list('limit=100')).jobs.some((j) => j.id === job.id)).toBe(false);
    const voided = await list('status=voided&limit=100');
    expect(voided.jobs.find((j) => j.id === job.id)).toMatchObject({ voided: true });
  });

  it('refuses a bad date, an end before the start, and a signed-out caller', async () => {
    expect((await call(cashier, 'GET', '/api/jobs?from=yesterday')).statusCode).toBe(400);
    expect((await call(cashier, 'GET', '/api/jobs?from=2026-10-30&to=2026-10-01')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(401);
  });
});

describe('voiding', () => {
  async function book() {
    const res = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: fullWash, attendantIds: [ama] }] });
    return res.json().job as { id: number; vehicle: { plate: string } };
  }

  it('is for managers and owners only, and needs a reason', async () => {
    const job = await book();
    expect((await call(cashier, 'POST', `/api/jobs/${job.id}/void`, { reason: 'Wrong car' })).statusCode).toBe(403);
    expect((await call(manager, 'POST', `/api/jobs/${job.id}/void`, { reason: '' })).statusCode).toBe(400);
  });

  it('keeps the whole record, takes the job off the board and frees the car', async () => {
    const job = await book();
    const res = await call(manager, 'POST', `/api/jobs/${job.id}/void`, { reason: 'Booked on the wrong car' });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.voided).toMatchObject({ by: 'manager p2.manager', reason: 'Booked on the wrong car' });
    expect(res.json().job.lines).toHaveLength(1);

    const board = (await call(cashier, 'GET', '/api/jobs/board')).json().jobs as { id: number }[];
    expect(board.find((j) => j.id === job.id)).toBeUndefined();

    const rows = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(rows).toHaveLength(1);
    expect((await db.select().from(jobLineAttendants)).length).toBeGreaterThan(0);

    // the car can be booked again
    const again = await call(cashier, 'POST', '/api/jobs', { plate: job.vehicle.plate, lines: [{ serviceId: polish, attendantIds: [kofi] }] });
    expect(again.statusCode).toBe(201);
  });

  it('cannot be changed once voided, or voided twice', async () => {
    const job = await book();
    await call(owner, 'POST', `/api/jobs/${job.id}/void`, { reason: 'Customer left' });
    expect((await call(owner, 'POST', `/api/jobs/${job.id}/void`, { reason: 'Again please' })).statusCode).toBe(409);
    expect((await call(cashier, 'POST', `/api/jobs/${job.id}/status`, { to: 'in_progress' })).statusCode).toBe(409);
    expect((await call(cashier, 'PATCH', `/api/jobs/${job.id}`, { discount: 10 })).statusCode).toBe(409);
  });

  it('refuses while the job has payments', async () => {
    const job = await book();
    const [recorder] = await db.select().from(users).where(eq(users.username, 'p2.cashier'));
    await db.insert(payments).values({ jobId: job.id, method: 'cash', amount: 5000, idemKey: `p2-${job.id}`, recordedBy: recorder!.id });
    const res = await call(manager, 'POST', `/api/jobs/${job.id}/void`, { reason: 'Mistake made' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('has_payments');
  });
});
