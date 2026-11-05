import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CommissionLedger } from '@niinas/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { roles, users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { roleIdFor } from './roles.js';

const PASSWORD = 'correct horse battery';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;
let ipCounter = 0;
const nextIp = () => `10.14.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
let plateCounter = 0;
const newPlate = () => `GQ ${String(8000 + ++plateCounter)}-26`;

async function makeUser(username: string, role: 'owner' | 'cashier') {
  await db.insert(users).values({ name: username, username, roleId: await roleIdFor(db, role), passwordHash: await hashPassword(PASSWORD) });
}
async function signInWith(username: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, remoteAddress: nextIp() });
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';
}
type Method = 'GET' | 'POST' | 'PATCH';
const call = (cookie: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as object | undefined, remoteAddress: nextIp() });

let owner: string;
let cashier: string;
let wash: number;
let attendantRole: number;

const makeAttendant = async (name: string) => (await call(owner, 'POST', '/api/attendants', { name, phone: null })).json().attendant.id as number;
const login = (body: Record<string, unknown>) => call(owner, 'POST', '/api/users', { roleId: attendantRole, ...body });

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p14.owner', 'owner');
  await makeUser('p14.cashier', 'cashier');
  owner = await signInWith('p14.owner', PASSWORD);
  cashier = await signInWith('p14.cashier', PASSWORD);
  wash = (await call(owner, 'POST', '/api/services', { name: 'P14 Wash', price: 5000, commissionKind: 'percent', commissionValue: 1000, active: true })).json().service.id;
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, 'Attendant'));
  attendantRole = role!.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('a login for an attendant', () => {
  it('starts with an Attendant role that only sees their own work', async () => {
    const [role] = await db.select().from(roles).where(eq(roles.name, 'Attendant'));
    expect(role!.permissions).toEqual(['self.view']);
  });

  it('is made from the attendant, once, and not for someone who left', async () => {
    const kofi = await makeAttendant('P14 Kofi');
    const made = await login({ name: 'P14 Kofi', username: 'p14.kofi', attendantId: kofi });
    expect(made.statusCode).toBe(201);
    expect(made.json().user).toMatchObject({ attendantId: kofi, role: 'Attendant' });
    expect(typeof made.json().temporaryPassword).toBe('string');

    expect((await login({ name: 'P14 Kofi again', username: 'p14.kofi2', attendantId: kofi })).statusCode).toBe(409);
    expect((await login({ name: 'Nobody', username: 'p14.nobody', attendantId: 999999 })).statusCode).toBe(404);

    const left = await makeAttendant('P14 Left');
    await call(owner, 'PATCH', `/api/attendants/${left}`, { active: false });
    expect((await login({ name: 'P14 Left', username: 'p14.left', attendantId: left })).statusCode).toBe(409);
  });

  it('shows the attendant their own earnings and nobody else’s', async () => {
    const ama = await makeAttendant('P14 Ama');
    const yaw = await makeAttendant('P14 Yaw');
    const made = await login({ name: 'P14 Ama', username: 'p14.ama', attendantId: ama });
    await login({ name: 'P14 Yaw', username: 'p14.yaw', attendantId: yaw });
    const temp = made.json().temporaryPassword as string;
    const session = await signInWith('p14.ama', temp);
    // A temporary password only gets as far as choosing a new one.
    expect((await call(session, 'GET', '/api/commissions/mine')).statusCode).toBe(403);
    expect((await call(session, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: 'a brand new phrase' })).statusCode).toBe(200);

    const job = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [ama] }], start: true });
    expect(job.statusCode).toBe(201);
    await call(cashier, 'POST', `/api/jobs/${job.json().job.id}/status`, { to: 'completed' });
    const other = await call(cashier, 'POST', '/api/jobs', { plate: newPlate(), lines: [{ serviceId: wash, attendantIds: [yaw] }], start: true });
    await call(cashier, 'POST', `/api/jobs/${other.json().job.id}/status`, { to: 'completed' });

    const mine = await call(session, 'GET', '/api/commissions/mine');
    expect(mine.statusCode).toBe(200);
    const ledger = mine.json().ledger as CommissionLedger;
    expect(ledger.attendant.name).toBe('P14 Ama');
    expect(ledger.owed).toBe(500);
    expect(ledger.entries).toHaveLength(1);
  });

  it('cannot reach anything else', async () => {
    const mia = await makeAttendant('P14 Mia');
    const made = await login({ name: 'P14 Mia', username: 'p14.mia', attendantId: mia });
    const temp = made.json().temporaryPassword as string;
    const session = await signInWith('p14.mia', temp);
    await call(session, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: 'another new phrase' });
    expect((await call(session, 'GET', '/api/commissions')).statusCode).toBe(403);
    expect((await call(session, 'GET', `/api/commissions/attendants/${mia}`)).statusCode).toBe(403);
    expect((await call(session, 'GET', '/api/jobs')).statusCode).toBe(403);
    expect((await call(session, 'GET', '/api/dashboard')).statusCode).toBe(403);
    const me = await call(session, 'GET', '/api/auth/me');
    expect(me.json().user.attendantId).toBe(mia);
    expect(me.json().permissions).toEqual(['self.view']);
  });

  it('a user with the permission but no attendant just sees nothing yet', async () => {
    const made = await login({ name: 'P14 Floater', username: 'p14.floater' });
    expect(made.statusCode).toBe(201);
    const temp = made.json().temporaryPassword as string;
    const session = await signInWith('p14.floater', temp);
    await call(session, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: 'floating new phrase' });
    expect((await call(session, 'GET', '/api/commissions/mine')).json().ledger).toBeNull();
  });
});
