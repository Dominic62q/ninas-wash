import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { auditLogs, users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { roleIdFor } from './roles.js';

const PASSWORD = 'correct horse battery';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;
let ipCounter = 0;

/** The login route is rate limited per address, so each test call comes from its own. */
const nextIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function makeUser(username: string, role: 'cashier' | 'manager' | 'owner', active = true) {
  await db.insert(users).values({
    name: `${role} ${username}`,
    username,
    roleId: await roleIdFor(db, role),
    active,
    passwordHash: await hashPassword(PASSWORD),
  });
}

async function login(username: string, password = PASSWORD, remoteAddress = nextIp()) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, remoteAddress });
}

const cookieOf = (res: Awaited<ReturnType<typeof login>>) => {
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
};

beforeAll(async () => {
  app = await buildApp({ db, config });
  await makeUser('t.cashier', 'cashier');
  await makeUser('t.manager', 'manager');
  await makeUser('t.owner', 'owner');
  await makeUser('t.gone', 'cashier', false);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('signing in', () => {
  it('signs in with the right password and sets a locked-down cookie', async () => {
    const res = await login('t.cashier');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({ username: 't.cashier', role: 'Cashier' });
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.permissions).toContain('job.create');
    expect(body.permissions).not.toContain('job.void');

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('niinas_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('is not case sensitive on the username', async () => {
    expect((await login('T.Cashier')).statusCode).toBe(200);
  });

  it('gives the same answer for a wrong password, an unknown user and an inactive user', async () => {
    const wrongPassword = await login('t.cashier', 'nope');
    const unknownUser = await login('nobody.here');
    const inactive = await login('t.gone');
    for (const res of [wrongPassword, unknownUser, inactive]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toEqual({ code: 'bad_credentials', message: 'Wrong username or password.' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('rejects empty input with a plain message', async () => {
    const res = await login('', '');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Enter your username');
  });

  it('slows down repeated attempts from one address', async () => {
    const ip = '10.9.9.9';
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login('t.cashier', 'wrong', ip)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('records good and bad sign-ins in the audit log', async () => {
    await login('t.owner');
    await login('t.owner', 'wrong');
    const rows = await db.select().from(auditLogs);
    expect(rows.some((r) => r.action === 'auth.login')).toBe(true);
    const failed = rows.find((r) => r.action === 'auth.login_failed');
    expect(failed?.userId).toBeNull();
    expect(JSON.stringify(failed)).not.toContain('wrong'); // the password is never logged
  });
});

describe('sessions', () => {
  it('knows who you are while signed in, and forgets you after sign-out', async () => {
    const cookie = cookieOf(await login('t.manager'));
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.role).toBe('Manager');

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('turns away someone who is not signed in', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('stores only a hash of the cookie token', async () => {
    const cookie = cookieOf(await login('t.cashier'));
    const token = cookie.split('=')[1]!;
    const stored = await pool.query('select id from sessions');
    expect(stored.rows.some((r: { id: string }) => r.id === token)).toBe(false);
  });

  it('stops working when the person is made inactive', async () => {
    await makeUser('t.leaver', 'cashier');
    const cookie = cookieOf(await login('t.leaver'));
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
    await db.update(users).set({ active: false }).where(eq(users.username, 't.leaver'));
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('refuses a change that comes from another website', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 't.cashier', password: PASSWORD },
      headers: { origin: 'https://evil.example' },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('roles', () => {
  it('keeps the audit log away from cashiers but open to managers and owners', async () => {
    const cashier = cookieOf(await login('t.cashier'));
    const manager = cookieOf(await login('t.manager'));
    const owner = cookieOf(await login('t.owner'));

    const asCashier = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: cashier } });
    expect(asCashier.statusCode).toBe(403);
    expect(asCashier.json().error.code).toBe('forbidden');

    for (const cookie of [manager, owner]) {
      const res = await app.inject({ method: 'GET', url: '/api/audit?limit=5', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json().entries.length).toBeGreaterThan(0);
    }
  });

  it('filters the audit log by person and area, and pages with a next marker', async () => {
    const owner = cookieOf(await login('t.owner'));
    const all = (await app.inject({ method: 'GET', url: '/api/audit?limit=2', headers: { cookie: owner } })).json();
    expect(all.entries).toHaveLength(2);
    expect(all.next).toBe(all.entries[1].id);
    expect(all.people.length).toBeGreaterThan(0);

    const older = (await app.inject({ method: 'GET', url: `/api/audit?limit=2&before=${all.next}`, headers: { cookie: owner } })).json();
    expect(older.entries.every((e: { id: number }) => e.id < all.next)).toBe(true);

    const people = (await app.inject({ method: 'GET', url: '/api/audit?area=people&limit=50', headers: { cookie: owner } })).json();
    expect(people.entries.length).toBeGreaterThan(0);
    expect(people.entries.every((e: { action: string }) => /^(user|role|attendant|auth|customer)\./.test(e.action))).toBe(true);

    const nobody = (await app.inject({ method: 'GET', url: '/api/audit?userId=999999', headers: { cookie: owner } })).json();
    expect(nobody.entries).toEqual([]);
  });

  it('asks signed-out visitors to sign in before telling them anything about permissions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(res.statusCode).toBe(401);
  });
});

describe('health', () => {
  it('reports the database is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true });
  });
});
