import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { auditLogs, roles, users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { roleIdFor } from './roles.js';

const PASSWORD = 'correct horse battery';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;
let ipCounter = 0;
const nextIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function makeUser(username: string, roleId: number) {
  const [row] = await db.insert(users).values({ name: username, username, roleId, passwordHash: await hashPassword(PASSWORD) }).returning();
  return row!;
}

async function signIn(username: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD }, remoteAddress: nextIp() });
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';
}

const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as object | undefined });

let owner: string;
let manager: string;
let cashier: string;
let lead: string;
let leadRoleId: number;

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('p9.owner', await roleIdFor(db, 'owner'));
  await makeUser('p9.manager', await roleIdFor(db, 'manager'));
  await makeUser('p9.cashier', await roleIdFor(db, 'cashier'));
  owner = await signIn('p9.owner');
  manager = await signIn('p9.manager');
  cashier = await signIn('p9.cashier');

  // A role that may run roles and users but only has a few other things.
  const [r] = await db
    .insert(roles)
    .values({ name: 'P9 lead', permissions: ['role.manage', 'user.manage', 'user.reset_password', 'job.create', 'payment.record'] })
    .returning();
  leadRoleId = r!.id;
  await makeUser('p9.lead', leadRoleId);
  lead = await signIn('p9.lead');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('reading roles', () => {
  it('shows the three starting roles with the owner first and locked', async () => {
    const res = await call(owner, 'GET', '/api/roles');
    expect(res.statusCode).toBe(200);
    const list = res.json().roles as { name: string; locked: boolean; permissions: string[] }[];
    expect(list[0]).toMatchObject({ name: 'Owner', locked: true });
    expect(list[0]!.permissions).toContain('role.manage');
    expect(list.map((r) => r.name)).toEqual(expect.arrayContaining(['Manager', 'Cashier']));
  });

  it('is closed to people who cannot add users or change passwords', async () => {
    expect((await call(cashier, 'GET', '/api/roles')).statusCode).toBe(403);
    expect((await call(manager, 'GET', '/api/roles')).statusCode).toBe(200);
  });

  it('reports the signed-in role name and permissions', async () => {
    const me = (await call(cashier, 'GET', '/api/auth/me')).json();
    expect(me.user.role).toBe('Cashier');
    expect(me.permissions).toContain('job.create');
    expect(me.permissions).not.toContain('user.manage');
  });
});

describe('making roles', () => {
  it('lets only people with role.manage create one', async () => {
    const body = { name: 'P9 nobody', permissions: ['job.create'] };
    expect((await call(manager, 'POST', '/api/roles', body)).statusCode).toBe(403);
    expect((await call(cashier, 'POST', '/api/roles', body)).statusCode).toBe(403);
  });

  it('adds what a permission needs and writes it to the activity log', async () => {
    const res = await call(owner, 'POST', '/api/roles', { name: 'P9 till', permissions: ['payment.void'] });
    expect(res.statusCode).toBe(201);
    expect(res.json().role.permissions).toEqual(expect.arrayContaining(['payment.void', 'payment.record', 'job.create']));
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'role.create')).limit(1);
    expect(log).toBeTruthy();
  });

  it('refuses a duplicate name and a blank one', async () => {
    expect((await call(owner, 'POST', '/api/roles', { name: 'P9 till', permissions: [] })).statusCode).toBe(409);
    expect((await call(owner, 'POST', '/api/roles', { name: '   ', permissions: [] })).statusCode).toBe(400);
  });

  it('ignores permissions that do not exist', async () => {
    const res = await call(owner, 'POST', '/api/roles', { name: 'P9 odd', permissions: ['job.create', 'fly.to.the.moon'] });
    expect(res.statusCode).toBe(201);
    expect(res.json().role.permissions).toEqual(['job.create']);
  });

  it('never lets anyone give a role more than they hold themselves', async () => {
    const tooMuch = await call(lead, 'POST', '/api/roles', { name: 'P9 greedy', permissions: ['service.manage'] });
    expect(tooMuch.statusCode).toBe(403);
    const fine = await call(lead, 'POST', '/api/roles', { name: 'P9 smaller', permissions: ['job.create'] });
    expect(fine.statusCode).toBe(201);
  });
});

describe('changing and removing roles', () => {
  it('cannot touch the owner role', async () => {
    const ownerRole = await roleIdFor(db, 'owner');
    expect((await call(owner, 'PATCH', `/api/roles/${ownerRole}`, { name: 'Boss' })).statusCode).toBe(403);
    expect((await call(owner, 'DELETE', `/api/roles/${ownerRole}`)).statusCode).toBe(403);
  });

  it('keeps the owner role safe even from the database itself', async () => {
    const ownerRole = await roleIdFor(db, 'owner');
    await expect(db.update(roles).set({ name: 'Boss' }).where(eq(roles.id, ownerRole))).rejects.toThrow();
    await expect(db.delete(roles).where(eq(roles.id, ownerRole))).rejects.toThrow();
  });

  it('blocks changing the role you hold yourself', async () => {
    const res = await call(lead, 'PATCH', `/api/roles/${leadRoleId}`, { permissions: ['role.manage', 'user.manage', 'user.reset_password', 'job.create', 'payment.record', 'job.void'] });
    expect(res.statusCode).toBe(403);
  });

  it('applies a change at once to people already signed in', async () => {
    const created = await call(owner, 'POST', '/api/roles', { name: 'P9 shifting', permissions: ['job.create', 'expense.create'] });
    const id = created.json().role.id as number;
    await makeUser('p9.shifter', id);
    const cookie = await signIn('p9.shifter');
    const body = { amount: 500, category: 'Other', note: 'x', method: 'cash', idemKey: 'p9-shift-1' };
    expect((await call(cookie, 'POST', '/api/expenses', body)).statusCode).not.toBe(403);

    const patch = await call(owner, 'PATCH', `/api/roles/${id}`, { permissions: ['job.create'] });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().role.permissions).toEqual(['job.create']);
    expect((await call(cookie, 'POST', '/api/expenses', { ...body, idemKey: 'p9-shift-2' })).statusCode).toBe(403);
  });

  it('removes a role nobody has, and refuses one that is in use', async () => {
    const made = await call(owner, 'POST', '/api/roles', { name: 'P9 spare', permissions: [] });
    const spare = made.json().role.id as number;
    expect((await call(owner, 'DELETE', `/api/roles/${spare}`)).statusCode).toBe(200);
    expect((await call(owner, 'DELETE', `/api/roles/${leadRoleId}`)).statusCode).toBe(409);
    expect((await call(owner, 'DELETE', `/api/roles/${spare}`)).statusCode).toBe(404);
  });
});

describe('giving people a role', () => {
  it('stops anyone from handing out a role stronger than their own', async () => {
    const managerRole = await roleIdFor(db, 'manager');
    const res = await call(lead, 'POST', '/api/users', { name: 'Too Strong', username: 'p9.toostrong', roleId: managerRole });
    expect(res.statusCode).toBe(403);
  });

  it('lets them hand out a role that is within their own', async () => {
    const small = await call(owner, 'POST', '/api/roles', { name: 'P9 junior', permissions: ['job.create'] });
    const res = await call(lead, 'POST', '/api/users', { name: 'Small Fry', username: 'p9.smallfry', roleId: small.json().role.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe('P9 junior');
  });

  it('refuses a role that does not exist', async () => {
    const res = await call(owner, 'POST', '/api/users', { name: 'Ghost', username: 'p9.ghost', roleId: 999999 });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('stops a person from changing their own role', async () => {
    const [me] = await db.select().from(users).where(eq(users.username, 'p9.lead'));
    const res = await call(lead, 'PATCH', `/api/users/${me!.id}`, { roleId: await roleIdFor(db, 'cashier') });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
