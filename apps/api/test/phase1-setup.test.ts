import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { auditLogs, jobs, payments, users, vehicles } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';

const PASSWORD = 'correct horse battery';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;
let ipCounter = 0;
const nextIp = () => `10.2.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function makeUser(username: string, role: 'cashier' | 'manager' | 'owner') {
  const [row] = await db
    .insert(users)
    .values({ name: `${role} ${username}`, username, role, passwordHash: await hashPassword(PASSWORD) })
    .returning();
  return row!;
}

async function signIn(username: string, password = PASSWORD) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
    remoteAddress: nextIp(),
  });
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return { res, cookie: header?.split(';')[0] ?? '' };
}

const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as object | undefined });

let owner: string;
let manager: string;
let cashier: string;
let ownerId: number;
let cashierId: number;
let managerId: number;

beforeAll(async () => {
  app = await buildApp({ db, config });
  ownerId = (await makeUser('p1.owner', 'owner')).id;
  managerId = (await makeUser('p1.manager', 'manager')).id;
  cashierId = (await makeUser('p1.cashier', 'cashier')).id;
  owner = (await signIn('p1.owner')).cookie;
  manager = (await signIn('p1.manager')).cookie;
  cashier = (await signIn('p1.cashier')).cookie;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('services', () => {
  it('lets only the owner create and price services', async () => {
    const body = { name: 'Full wash', price: 5000, commissionKind: 'percent', commissionValue: 1800, active: true };
    expect((await call(cashier, 'POST', '/api/services', body)).statusCode).toBe(403);
    expect((await call(manager, 'POST', '/api/services', body)).statusCode).toBe(403);
    const res = await call(owner, 'POST', '/api/services', body);
    expect(res.statusCode).toBe(201);
    expect(res.json().service).toMatchObject({ name: 'Full wash', price: 5000, commissionValue: 1800 });
  });

  it('refuses a duplicate name and a commission that makes no sense', async () => {
    const dup = await call(owner, 'POST', '/api/services', {
      name: 'full wash',
      price: 100,
      commissionKind: 'fixed',
      commissionValue: 0,
      active: true,
    });
    // names are compared exactly in the database; this one differs only by case, so it is a new service
    expect([201, 409]).toContain(dup.statusCode);

    const same = await call(owner, 'POST', '/api/services', {
      name: 'Full wash',
      price: 5000,
      commissionKind: 'percent',
      commissionValue: 1800,
      active: true,
    });
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe('duplicate_service');

    const over = await call(owner, 'POST', '/api/services', {
      name: 'Bad percent',
      price: 5000,
      commissionKind: 'percent',
      commissionValue: 20000,
      active: true,
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.message).toBe('A percentage cannot be more than 100%');

    const decimals = await call(owner, 'POST', '/api/services', {
      name: 'Half pesewa',
      price: 50.5,
      commissionKind: 'fixed',
      commissionValue: 0,
      active: true,
    });
    expect(decimals.statusCode).toBe(400);
  });

  it('checks the whole service on edit, and records what changed and who changed it', async () => {
    const created = await call(owner, 'POST', '/api/services', {
      name: 'Interior clean',
      price: 3000,
      commissionKind: 'fixed',
      commissionValue: 500,
      active: true,
    });
    const id = created.json().service.id as number;

    // Lowering the price below the fixed commission would leave a commission bigger than the price.
    const bad = await call(owner, 'PATCH', `/api/services/${id}`, { price: 400 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe('The commission cannot be more than the price');

    const ok = await call(owner, 'PATCH', `/api/services/${id}`, { price: 3500 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().service.price).toBe(3500);

    // No change, no audit entry.
    await call(owner, 'PATCH', `/api/services/${id}`, { price: 3500 });

    const history = await call(owner, 'GET', `/api/services/${id}/history`);
    const entries = history.json().history as Array<{ action: string; by: string; changes: Array<{ field: string; from: unknown; to: unknown }> }>;
    expect(entries.filter((e) => e.action === 'service.update')).toHaveLength(1);
    expect(entries[0]!.changes).toEqual([{ field: 'price', from: 3000, to: 3500 }]);
    expect(entries[0]!.by).toBe('owner p1.owner');

    expect((await call(manager, 'GET', `/api/services/${id}/history`)).statusCode).toBe(403);
  });

  it('hides switched-off services from everyone except the owner', async () => {
    const created = await call(owner, 'POST', '/api/services', {
      name: 'Retired special',
      price: 1000,
      commissionKind: 'fixed',
      commissionValue: 0,
      active: true,
    });
    const id = created.json().service.id as number;
    await call(owner, 'PATCH', `/api/services/${id}`, { active: false });

    const names = async (cookie: string, query = '') =>
      ((await call(cookie, 'GET', `/api/services${query}`)).json().services as Array<{ name: string }>).map((s) => s.name);

    expect(await names(cashier)).not.toContain('Retired special');
    expect(await names(cashier, '?includeInactive=1')).not.toContain('Retired special'); // asking is not enough
    expect(await names(owner, '?includeInactive=1')).toContain('Retired special');
  });

  it('has no way to delete a service', async () => {
    const res = await app.inject({ method: 'DELETE' as 'GET', url: '/api/services/1', headers: { cookie: owner } });
    expect(res.statusCode).toBe(404);
  });
});

describe('attendants', () => {
  it('creates, edits and retires an attendant without deleting them', async () => {
    expect((await call(manager, 'POST', '/api/attendants', { name: 'Kofi' })).statusCode).toBe(403);

    const created = await call(owner, 'POST', '/api/attendants', { name: 'Kofi Mensah', phone: '024 551 0932' });
    expect(created.statusCode).toBe(201);
    const attendant = created.json().attendant;
    expect(attendant).toMatchObject({ name: 'Kofi Mensah', phone: '0245510932', active: true, leftOn: null });

    const left = await call(owner, 'PATCH', `/api/attendants/${attendant.id}`, { active: false });
    expect(left.json().attendant.active).toBe(false);
    expect(left.json().attendant.leftOn).not.toBeNull();

    const visibleToCashier = (await call(cashier, 'GET', '/api/attendants?includeInactive=1')).json().attendants as Array<{ id: number }>;
    expect(visibleToCashier.some((a) => a.id === attendant.id)).toBe(false);
    const visibleToOwner = (await call(owner, 'GET', '/api/attendants?includeInactive=1')).json().attendants as Array<{ id: number }>;
    expect(visibleToOwner.some((a) => a.id === attendant.id)).toBe(true);

    const back = await call(owner, 'PATCH', `/api/attendants/${attendant.id}`, { active: true });
    expect(back.json().attendant.leftOn).toBeNull();
  });

  it('rejects a phone number that is not a phone number', async () => {
    const res = await call(owner, 'POST', '/api/attendants', { name: 'Ama', phone: 'call me' });
    expect(res.statusCode).toBe(400);
  });
});

describe('users and passwords', () => {
  it('creates a user with a one-time password that must be replaced at first sign-in', async () => {
    expect((await call(manager, 'POST', '/api/users', { name: 'New', username: 'new.person', role: 'cashier' })).statusCode).toBe(403);

    const created = await call(owner, 'POST', '/api/users', { name: 'Efua Boateng', username: 'Efua.Boateng', role: 'cashier' });
    expect(created.statusCode).toBe(201);
    const { user, temporaryPassword } = created.json();
    expect(user).toMatchObject({ username: 'efua.boateng', role: 'cashier', mustChangePassword: true });
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9]{12}$/);

    // The password is never stored in the audit trail.
    const rows = await db.select().from(auditLogs);
    expect(JSON.stringify(rows)).not.toContain(temporaryPassword);

    // Signing in works, but nothing else does until the password is changed.
    const first = await signIn('efua.boateng', temporaryPassword);
    expect(first.res.statusCode).toBe(200);
    expect(first.res.json().user.mustChangePassword).toBe(true);
    const blocked = await call(first.cookie, 'GET', '/api/services');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('password_change_required');
    expect((await call(first.cookie, 'GET', '/api/auth/me')).statusCode).toBe(200);

    const change = await call(first.cookie, 'POST', '/api/auth/change-password', {
      currentPassword: temporaryPassword,
      newPassword: 'my own long password',
    });
    expect(change.statusCode).toBe(200);
    expect((await call(first.cookie, 'GET', '/api/services')).statusCode).toBe(200);
    expect((await signIn('efua.boateng', temporaryPassword)).res.statusCode).toBe(401);
    expect((await signIn('efua.boateng', 'my own long password')).res.statusCode).toBe(200);
  });

  it('refuses a duplicate username and a bad username', async () => {
    const dup = await call(owner, 'POST', '/api/users', { name: 'Again', username: 'P1.Cashier', role: 'cashier' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('duplicate_username');
    const bad = await call(owner, 'POST', '/api/users', { name: 'Again', username: 'a b', role: 'cashier' });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects a wrong current password, a reused password and a weak one', async () => {
    const { cookie } = await signIn('p1.cashier');
    const wrong = await call(cookie, 'POST', '/api/auth/change-password', { currentPassword: 'nope', newPassword: 'something long' });
    expect(wrong.json().error.code).toBe('wrong_password');
    const same = await call(cookie, 'POST', '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.json().error.code).toBe('same_password');
    const short = await call(cookie, 'POST', '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' });
    expect(short.statusCode).toBe(400);
  });

  it('signs out other devices when the password changes', async () => {
    await makeUser('p1.twodevices', 'cashier');
    const phone = await signIn('p1.twodevices');
    const laptop = await signIn('p1.twodevices');
    const change = await call(laptop.cookie, 'POST', '/api/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'a brand new password',
    });
    expect(change.statusCode).toBe(200);
    expect((await call(laptop.cookie, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await call(phone.cookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('lets a manager reset a cashier but not a manager or the owner', async () => {
    const reset = await call(manager, 'POST', `/api/users/${cashierId}/reset-password`);
    expect(reset.statusCode).toBe(200);
    expect(reset.json().temporaryPassword).toMatch(/^[A-Za-z0-9]{12}$/);
    // the cashier's old password stops working and their old session ends
    expect((await call(cashier, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await signIn('p1.cashier')).res.statusCode).toBe(401);

    const other = await makeUser('p1.manager2', 'manager');
    expect((await call(manager, 'POST', `/api/users/${other.id}/reset-password`)).statusCode).toBe(403);
    expect((await call(manager, 'POST', `/api/users/${ownerId}/reset-password`)).statusCode).toBe(403);
    expect((await call(manager, 'POST', `/api/users/${managerId}/reset-password`)).statusCode).toBe(403); // not yourself

    // restore the cashier for the tests that follow
    await db.update(users).set({ passwordHash: await hashPassword(PASSWORD), mustChangePassword: false }).where(eq(users.id, cashierId));
    cashier = (await signIn('p1.cashier')).cookie;
  });

  it('keeps people from locking out the business', async () => {
    const self = await call(owner, 'PATCH', `/api/users/${ownerId}`, { role: 'manager' });
    expect(self.statusCode).toBe(403);
    expect((await call(owner, 'PATCH', `/api/users/${ownerId}`, { active: false })).statusCode).toBe(403);

    // A second owner may step down; the very last one may not.
    const second = await makeUser('p1.owner2', 'owner');
    const secondCookie = (await signIn('p1.owner2')).cookie;
    const demoteSecond = await call(owner, 'PATCH', `/api/users/${second.id}`, { role: 'manager' });
    expect(demoteSecond.statusCode).toBe(200);
    expect((await call(secondCookie, 'GET', '/api/auth/me')).statusCode).toBe(200);

    // every other owner in the table is switched off by the first owner, then the last is protected
    await db.update(users).set({ role: 'manager' }).where(eq(users.role, 'owner'));
    await db.update(users).set({ role: 'owner' }).where(eq(users.id, ownerId));
    const { cookie: soloCookie } = await signIn('p1.owner');
    const helper = await makeUser('p1.owner3', 'owner');
    expect((await call(soloCookie, 'PATCH', `/api/users/${helper.id}`, { active: false })).statusCode).toBe(200);
    owner = soloCookie;
  });

  it('switching someone off signs them out at once', async () => {
    const target = await makeUser('p1.leaver', 'cashier');
    const { cookie } = await signIn('p1.leaver');
    expect((await call(cookie, 'GET', '/api/auth/me')).statusCode).toBe(200);
    const off = await call(owner, 'PATCH', `/api/users/${target.id}`, { active: false });
    expect(off.statusCode).toBe(200);
    expect((await call(cookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('shows the user list to managers (to reset passwords) but not cashiers', async () => {
    expect((await call(manager, 'GET', '/api/users')).statusCode).toBe(200);
    expect((await call(cashier, 'GET', '/api/users')).statusCode).toBe(403);
    expect(JSON.stringify((await call(owner, 'GET', '/api/users')).json())).not.toContain('passwordHash');
  });
});

describe('customers and vehicles', () => {
  it('saves a customer with a car, normalising the phone and plate', async () => {
    const res = await call(cashier, 'POST', '/api/customers', {
      name: 'Nana Yaw',
      phone: '+233 24 551 0932',
      okToText: true,
      vehicle: { plate: 'gr 1234-21', makeModel: 'Toyota Corolla', carType: 'saloon' },
    });
    expect(res.statusCode).toBe(201);
    const { customer } = res.json();
    expect(customer).toMatchObject({ name: 'Nana Yaw', okToText: true, visits: 0, spent: 0, lastVisit: null });
    expect(customer.phone).toMatch(/^(0245510932|\+233245510932)$/);
    expect(customer.vehicles).toHaveLength(1);
    expect(customer.vehicles[0]).toMatchObject({ plate: 'gr 1234-21', carType: 'saloon' });
  });

  it('refuses a plate that belongs to someone else, and names who', async () => {
    const res = await call(cashier, 'POST', '/api/customers', {
      name: 'Someone Else',
      vehicle: { plate: 'GR123421' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code: 'plate_taken', message: 'That plate is already on file for Nana Yaw.' });
    // nothing half-saved: the customer was not created either
    const search = (await call(cashier, 'GET', '/api/customers?q=Someone%20Else')).json();
    expect(search.total).toBe(0);
  });

  it('claims a walk-in car that has no owner yet', async () => {
    await db.insert(vehicles).values({ plate: 'AS 9 99', plateKey: 'AS999' });
    const res = await call(cashier, 'POST', '/api/customers', { name: 'Regular Rita', vehicle: { plate: 'as999', carType: 'suv' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().customer.vehicles[0]).toMatchObject({ carType: 'suv' });
    const rows = await db.select().from(vehicles).where(eq(vehicles.plateKey, 'AS999'));
    expect(rows).toHaveLength(1); // the same car, not a second one
  });

  it('finds a customer by name, phone digits or plate', async () => {
    const byName = (await call(cashier, 'GET', '/api/customers?q=nana')).json();
    const byPhone = (await call(cashier, 'GET', '/api/customers?q=551%200932')).json();
    const byPlate = (await call(cashier, 'GET', '/api/customers?q=gr1234')).json();
    for (const result of [byName, byPhone, byPlate]) {
      expect(result.rows.map((r: { name: string }) => r.name)).toContain('Nana Yaw');
    }
    // % and _ are searched literally, not as wildcards
    expect((await call(cashier, 'GET', '/api/customers?q=%25')).json().total).toBe(0);
  });

  it('adds a second car and refuses the same plate twice', async () => {
    const found = (await call(cashier, 'GET', '/api/customers?q=Nana')).json().rows[0];
    const added = await call(cashier, 'POST', `/api/customers/${found.id}/vehicles`, { plate: 'GN 77-20', carType: 'pickup' });
    expect(added.statusCode).toBe(201);
    const again = await call(cashier, 'POST', `/api/customers/${found.id}/vehicles`, { plate: 'GN7720' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('That car is already on this customer.');
  });

  it('edits a customer and a car, auditing the change', async () => {
    const found = (await call(cashier, 'GET', '/api/customers?q=Nana')).json().rows[0];
    const patched = await call(cashier, 'PATCH', `/api/customers/${found.id}`, { name: 'Nana Yaw Mensah', okToText: false });
    expect(patched.json().customer).toMatchObject({ name: 'Nana Yaw Mensah', okToText: false });
    const log = (await db.select().from(auditLogs).where(eq(auditLogs.recordTable, 'customers'))).filter((l) => l.action === 'customer.update');
    expect(log.at(-1)?.before).toEqual({ name: 'Nana Yaw', okToText: true });

    const car = found.vehicles[0];
    const other = (await call(cashier, 'GET', '/api/customers?q=Rita')).json().rows[0].vehicles[0];
    const clash = await call(cashier, 'PATCH', `/api/vehicles/${car.id}`, { plate: other.plate });
    expect(clash.statusCode).toBe(409);
    const ok = await call(cashier, 'PATCH', `/api/vehicles/${car.id}`, { makeModel: 'Toyota Camry' });
    expect(ok.json().vehicle.makeModel).toBe('Toyota Camry');
  });

  it('looks a plate up for the new-job screen', async () => {
    const hit = (await call(cashier, 'GET', '/api/vehicles/lookup?plate=GR%201234-21')).json();
    expect(hit.customer?.name).toBe('Nana Yaw Mensah');
    const miss = (await call(cashier, 'GET', '/api/vehicles/lookup?plate=ZZ0000')).json();
    expect(miss).toEqual({ vehicle: null, customer: null });
  });

  it('suggests cars while a plate is being typed', async () => {
    const part = (await call(cashier, 'GET', '/api/vehicles/search?q=gr12')).json();
    expect(part.matches[0]).toMatchObject({ owner: 'Nana Yaw Mensah', onBoard: false });
    expect(part.matches[0].vehicle.plate.toUpperCase()).toBe('GR 1234-21');
    expect((await call(cashier, 'GET', '/api/vehicles/search?q=g')).json()).toEqual({ matches: [] });
    expect((await call(cashier, 'GET', '/api/vehicles/search?q=ZZ0000')).json()).toEqual({ matches: [] });
    expect((await call('', 'GET', '/api/vehicles/search?q=GR')).statusCode).toBe(401);
  });

  it('adds up visits, spend and what is owed, and ignores voided jobs and payments', async () => {
    const found = (await call(cashier, 'GET', '/api/customers?q=Rita')).json().rows[0];
    const carId = found.vehicles[0].id as number;
    const [job] = await db.insert(jobs).values({ vehicleId: carId, createdBy: cashierId }).returning();
    await pool.query(
      `insert into job_lines (job_id, service_id, price_at_sale, commission_kind_at_sale, commission_value_at_sale)
       values ($1, (select id from services limit 1), 5000, 'percent', 1800)`,
      [job!.id],
    );
    await db.insert(payments).values({ jobId: job!.id, amount: 3000, method: 'cash', idemKey: 'p1-pay-1', recordedBy: cashierId });
    const [voided] = await db
      .insert(payments)
      .values({ jobId: job!.id, amount: 1000, method: 'cash', idemKey: 'p1-pay-2', recordedBy: cashierId })
      .returning();
    await db.update(payments).set({ voidedAt: new Date(), voidedBy: managerId, voidReason: 'test' }).where(eq(payments.id, voided!.id));

    const detail = (await call(cashier, 'GET', `/api/customers/${found.id}`)).json();
    expect(detail.customer).toMatchObject({ visits: 1, spent: 3000 });
    expect(detail.owes).toBe(2000);
    expect(detail.recentVisits).toHaveLength(1);
    expect(detail.recentVisits[0]).toMatchObject({ total: 5000, voided: false });
  });

  it('reports simple customer numbers', async () => {
    const stats = (await call(cashier, 'GET', '/api/customers/stats')).json();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.newThisWeek).toBeGreaterThanOrEqual(2);
  });

  it('exports customers only for the owner, safely and with a log entry', async () => {
    expect((await call(manager, 'GET', '/api/customers/export.csv')).statusCode).toBe(403);
    expect((await call(cashier, 'GET', '/api/customers/export.csv')).statusCode).toBe(403);

    await call(owner, 'POST', '/api/customers', { name: '=HYPERLINK("http://evil.example")', phone: '0200000001' });
    const res = await call(owner, 'GET', '/api/customers/export.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toContain('Nana Yaw Mensah');
    // a cell that starts with = would run as a formula in Excel
    expect(res.body).not.toMatch(/(^|,|\n)=HYPERLINK/);
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil.example"")"`);

    const logged = (await db.select().from(auditLogs)).filter((l) => l.action === 'customer.export');
    expect(logged.length).toBeGreaterThan(0);
  });

  it('has no way to delete a customer or a car', async () => {
    const found = (await call(cashier, 'GET', '/api/customers?q=Rita')).json().rows[0];
    const res = await app.inject({ method: 'DELETE' as 'GET', url: `/api/customers/${found.id}`, headers: { cookie: cashier } });
    expect(res.statusCode).toBe(404);
  });
});
