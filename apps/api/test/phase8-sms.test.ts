import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { smsMessages, users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import type { GatewayResult, SmsGateway } from '../src/lib/sms.js';
import { roleIdFor } from './roles.js';

const PASSWORD = 'correct horse battery';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') });
const { db, pool } = createDb(config.DATABASE_URL);
let app: FastifyInstance;
let ipCounter = 0;
const nextIp = () => `10.8.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

/** Stands in for Nalo: remembers every text and answers whatever the test says to. */
const sent: { msisdn: string; message: string }[] = [];
let answer: GatewayResult = { status: 'sent', code: '1701', ref: 'job-1', error: null };
const gateway: SmsGateway = {
  configured: true,
  async send(msisdn, message) {
    sent.push({ msisdn, message });
    return answer;
  },
};
const OK: GatewayResult = { status: 'sent', code: '1701', ref: 'job-1', error: null };

async function makeUser(username: string, role: 'cashier' | 'manager' | 'owner') {
  await db.insert(users).values({ name: `${role} ${username}`, username, roleId: await roleIdFor(db, role), passwordHash: await hashPassword(PASSWORD) });
}

async function signIn(username: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD }, remoteAddress: nextIp() });
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

type Method = 'GET' | 'POST' | 'PUT';
const call = (cookie: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as object | undefined });

let owner: string;
let manager: string;
let cashier: string;
let serviceId: number;
let attendantId: number;
let plateCounter = 0;
let phoneCounter = 0;
let keyCounter = 0;
const newPlate = () => `GS ${String(7000 + ++plateCounter)}-26`;
const newPhone = () => `0245${String(800000 + ++phoneCounter)}`;
const newKey = () => `p8-test-key-${++keyCounter}-${Date.now()}`;
const settle = () => app.sms.idle();

/** Books a car for a customer. Returns the job id and customer id. */
async function book(customer: { name: string; phone: string; okToText: boolean } | null, start = false) {
  const res = await call(cashier, 'POST', '/api/jobs', {
    plate: newPlate(),
    ...(customer ? { customer } : {}),
    lines: [{ serviceId, attendantIds: [attendantId] }],
    start,
  });
  expect(res.statusCode).toBe(201);
  await settle();
  const job = res.json().job as { id: number; vehicle: { customerId: number | null } };
  return { jobId: job.id, customerId: job.vehicle?.customerId ?? null };
}

const messagesFor = (jobId: number) => db.select().from(smsMessages).where(eq(smsMessages.jobId, jobId)).orderBy(smsMessages.id);

beforeAll(async () => {
  app = await buildApp({ db, config, smsGateway: gateway });
  await makeUser('p8.owner', 'owner');
  await makeUser('p8.manager', 'manager');
  await makeUser('p8.cashier', 'cashier');
  owner = await signIn('p8.owner');
  manager = await signIn('p8.manager');
  cashier = await signIn('p8.cashier');
  serviceId = (await call(owner, 'POST', '/api/services', { name: 'P8 Wash', price: 5000, commissionKind: 'percent', commissionValue: 1000, active: true })).json().service.id;
  attendantId = (await call(owner, 'POST', '/api/attendants', { name: 'P8 Kojo', phone: null })).json().attendant.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('who can see and change texts', () => {
  it('keeps the history and wording from cashiers, and the wording and credits from managers', async () => {
    expect((await call(cashier, 'GET', '/api/sms/overview')).statusCode).toBe(403);
    expect((await call(cashier, 'GET', '/api/sms/messages')).statusCode).toBe(403);
    expect((await call(manager, 'GET', '/api/sms/overview')).statusCode).toBe(200);
    expect((await call(manager, 'PUT', '/api/sms/templates/job_ready', { body: 'Hi {name}', enabled: true })).statusCode).toBe(403);
    expect((await call(manager, 'POST', '/api/sms/credits', { type: 'topup', credits: 10 })).statusCode).toBe(403);
    expect((await call(cashier, 'POST', '/api/sms/send', { customerId: 1, message: 'Hi', idemKey: newKey() })).statusCode).toBe(403);
  });
});

describe('the wording of the automatic texts', () => {
  it('starts with the standard wording for the three events', async () => {
    const { templates } = (await call(owner, 'GET', '/api/sms/overview')).json();
    expect(templates.map((t: { event: string }) => t.event)).toEqual(['job_booked', 'job_ready', 'payment_received']);
    expect(templates.every((t: { enabled: boolean; isDefault: boolean }) => t.enabled && t.isDefault)).toBe(true);
  });

  it('lets the owner change it, and put it back', async () => {
    const put = await call(owner, 'PUT', '/api/sms/templates/job_booked', { body: 'Welcome {name}! {plate} is in the queue.', enabled: true });
    expect(put.statusCode).toBe(200);
    expect(put.json().template).toMatchObject({ body: 'Welcome {name}! {plate} is in the queue.', isDefault: false });
    const reset = await call(owner, 'POST', '/api/sms/templates/job_booked/reset');
    expect(reset.json().template).toMatchObject({ isDefault: true, enabled: true });
  });

  it('refuses a word the text has no value for, and characters that make texts cost double', async () => {
    const wrong = await call(owner, 'PUT', '/api/sms/templates/job_booked', { body: 'You owe {balance}', enabled: true });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('bad_placeholder');
    expect((await call(owner, 'PUT', '/api/sms/templates/job_booked', { body: 'Hello {name} 😀', enabled: true })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', '/api/sms/templates/job_booked', { body: '   ', enabled: true })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', '/api/sms/templates/nonsense', { body: 'Hi', enabled: true })).statusCode).toBe(400);
  });

  it('swaps curly quotes and the cedi sign for plain ones', async () => {
    const put = await call(owner, 'PUT', '/api/sms/templates/payment_received', { body: 'Thanks {name}, we got ₵ {amount} for {plate} – don’t worry.', enabled: true });
    expect(put.statusCode).toBe(200);
    expect(put.json().template.body).toBe("Thanks {name}, we got GHS {amount} for {plate} - don't worry.");
    await call(owner, 'POST', '/api/sms/templates/payment_received/reset');
  });
});

describe('automatic texts', () => {
  it('texts a customer who agreed when the car is booked, ready, and paid for', async () => {
    answer = OK;
    sent.length = 0;
    const phone = newPhone();
    const { jobId } = await book({ name: 'Mr Kofi Mensah', phone, okToText: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msisdn).toBe(`233${phone.slice(1)}`);
    expect(sent[0]!.message).toMatch(/^Hi Kofi, your car GS \d{4}-26 is booked in at Niina's Wash\./);

    // Starting the wash sends nothing.
    await call(cashier, 'POST', `/api/jobs/${jobId}/status`, { to: 'in_progress' });
    await settle();
    expect(sent).toHaveLength(1);

    await call(cashier, 'POST', `/api/jobs/${jobId}/status`, { to: 'completed' });
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message).toContain('is ready for pickup');
    expect(sent[1]!.message).toContain('Total GHS 50.00, still to pay GHS 50.00');

    const key = newKey();
    const paid = await call(cashier, 'POST', `/api/jobs/${jobId}/payments`, { method: 'cash', amount: 3000, idemKey: key });
    expect(paid.statusCode).toBe(201);
    await settle();
    expect(sent).toHaveLength(3);
    expect(sent[2]!.message).toContain('received GHS 30.00');
    expect(sent[2]!.message).toContain('Still to pay: GHS 20.00');

    // The same tap sent again saves no new payment, so it sends no new text.
    const again = await call(cashier, 'POST', `/api/jobs/${jobId}/payments`, { method: 'cash', amount: 3000, idemKey: key });
    expect(again.statusCode).toBe(200);
    await settle();
    expect(sent).toHaveLength(3);

    const rows = await messagesFor(jobId);
    expect(rows.map((r) => [r.event, r.status, r.segments])).toEqual([
      ['job_booked', 'sent', 1],
      ['job_ready', 'sent', 1],
      ['payment_received', 'sent', 1],
    ]);
    expect(rows[0]).toMatchObject({ gatewayCode: '1701', gatewayRef: 'job-1', sentBy: null });
  });

  it('notes, but does not send, a text to someone who has not agreed', async () => {
    sent.length = 0;
    const { jobId } = await book({ name: 'Ama Quiet', phone: newPhone(), okToText: false });
    expect(sent).toHaveLength(0);
    const [row] = await messagesFor(jobId);
    expect(row).toMatchObject({ event: 'job_booked', status: 'skipped', error: 'This customer has not agreed to texts.' });
  });

  it('says nothing about a walk-in with no phone', async () => {
    sent.length = 0;
    const { jobId } = await book(null);
    expect(sent).toHaveLength(0);
    expect(await messagesFor(jobId)).toHaveLength(0);
  });

  it('stays quiet while a text is switched off', async () => {
    await call(owner, 'PUT', '/api/sms/templates/job_booked', { body: 'Hi {name}, {plate} is booked.', enabled: false });
    sent.length = 0;
    const { jobId } = await book({ name: 'Yaw Off', phone: newPhone(), okToText: true });
    expect(sent).toHaveLength(0);
    expect(await messagesFor(jobId)).toHaveLength(0);
    await call(owner, 'POST', '/api/sms/templates/job_booked/reset');
  });

  it('never lets a failed text hold up the job, and records why', async () => {
    answer = { status: 'failed', code: '1025', ref: null, error: 'Out of SMS credit. Top up on the Nalo portal.' };
    const { jobId } = await book({ name: 'Efua Broke', phone: newPhone(), okToText: true });
    const [row] = await messagesFor(jobId);
    expect(row).toMatchObject({ status: 'failed', gatewayCode: '1025' });
    expect((await call(manager, 'GET', '/api/sms/overview')).json().credits.outOfCredit).toBe(true);
    answer = OK;
  });
});

describe('texts typed by hand', () => {
  async function customer(okToText: boolean, phone: string | null) {
    const res = await call(manager, 'POST', '/api/customers', { name: 'P8 Customer', phone, okToText });
    expect(res.statusCode).toBe(201);
    return res.json().customer.id as number;
  }

  it('sends one text, and only one however many times the button is pressed', async () => {
    answer = OK;
    sent.length = 0;
    const id = await customer(true, newPhone());
    const body = { customerId: id, message: 'Your seat covers are ready, too.', idemKey: newKey() };
    const first = await call(manager, 'POST', '/api/sms/send', body);
    expect(first.statusCode).toBe(201);
    expect(first.json().message).toMatchObject({ event: 'manual', status: 'sent', customer: { id }, by: 'manager p8.manager' });
    const again = await call(manager, 'POST', '/api/sms/send', body);
    expect(again.statusCode).toBe(200);
    expect(again.json().message.id).toBe(first.json().message.id);
    expect(sent).toHaveLength(1);
  });

  it('will not text someone with no phone, or who has not agreed', async () => {
    const noPhone = await customer(true, null);
    const notOk = await customer(false, newPhone());
    const a = await call(manager, 'POST', '/api/sms/send', { customerId: noPhone, message: 'Hello', idemKey: newKey() });
    expect(a.statusCode).toBe(409);
    expect(a.json().error.code).toBe('no_phone');
    const b = await call(manager, 'POST', '/api/sms/send', { customerId: notOk, message: 'Hello', idemKey: newKey() });
    expect(b.statusCode).toBe(409);
    expect(b.json().error.code).toBe('not_ok_to_text');
    expect((await call(manager, 'POST', '/api/sms/send', { customerId: 99999999, message: 'Hello', idemKey: newKey() })).statusCode).toBe(404);
  });

  it('can try a failed text again, but not one that already went', async () => {
    const id = await customer(true, newPhone());
    answer = { status: 'failed', code: null, ref: null, error: 'Could not reach Nalo. Check the internet connection.' };
    const failed = (await call(manager, 'POST', '/api/sms/send', { customerId: id, message: 'Ready when you are.', idemKey: newKey() })).json().message;
    expect(failed.status).toBe('failed');

    answer = OK;
    const retry = await call(manager, 'POST', `/api/sms/messages/${failed.id}/resend`, { idemKey: newKey() });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().message).toMatchObject({ status: 'sent', body: 'Ready when you are.' });
    const twice = await call(manager, 'POST', `/api/sms/messages/${retry.json().message.id}/resend`, { idemKey: newKey() });
    expect(twice.statusCode).toBe(409);
  });
});

describe('credits', () => {
  it('adds up what was bought, takes off what was sent, and clears the out-of-credit warning', async () => {
    const before = (await call(owner, 'GET', '/api/sms/overview')).json().credits as { balance: number; used: number };
    const top = await call(owner, 'POST', '/api/sms/credits', { type: 'topup', credits: 500, note: 'Nalo bundle' });
    expect(top.statusCode).toBe(201);
    expect(top.json().balance).toBe(before.balance + 500);

    const after = (await call(owner, 'GET', '/api/sms/overview')).json();
    expect(after.credits.outOfCredit).toBe(false);
    expect(after.credits.entries[0]).toMatchObject({ kind: 'topup', credits: 500, note: 'Nalo bundle' });
    expect(after.gateway).toMatchObject({ configured: true, senderId: 'NiinasWash' });
  });

  it('writes down a correction when the balance is set to what Nalo shows', async () => {
    const set = await call(owner, 'POST', '/api/sms/credits', { type: 'set', balance: 321 });
    expect(set.statusCode).toBe(201);
    expect(set.json().balance).toBe(321);
    const { credits } = (await call(owner, 'GET', '/api/sms/overview')).json();
    expect(credits.balance).toBe(321);
    expect(credits.entries[0]).toMatchObject({ kind: 'adjust' });
    // Saying the same thing again changes nothing.
    expect((await call(owner, 'POST', '/api/sms/credits', { type: 'set', balance: 321 })).statusCode).toBe(200);
  });

  it('refuses nonsense', async () => {
    expect((await call(owner, 'POST', '/api/sms/credits', { type: 'topup', credits: 0 })).statusCode).toBe(400);
    expect((await call(owner, 'POST', '/api/sms/credits', { type: 'topup', credits: 1.5 })).statusCode).toBe(400);
    expect((await call(owner, 'POST', '/api/sms/credits', { type: 'set', balance: -4 })).statusCode).toBe(400);
  });
});

describe('the history', () => {
  it('lists texts newest first, and can be narrowed', async () => {
    const all = (await call(manager, 'GET', '/api/sms/messages?limit=100')).json();
    expect(all.total).toBeGreaterThan(5);
    const ids = all.messages.map((m: { id: number }) => m.id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a));

    const failed = (await call(manager, 'GET', '/api/sms/messages?status=failed')).json();
    expect(failed.messages.length).toBeGreaterThan(0);
    expect(failed.messages.every((m: { status: string }) => m.status === 'failed')).toBe(true);

    const manual = (await call(manager, 'GET', '/api/sms/messages?event=manual')).json();
    expect(manual.messages.every((m: { event: string }) => m.event === 'manual')).toBe(true);

    const search = (await call(manager, 'GET', `/api/sms/messages?q=${encodeURIComponent('Kofi')}`)).json();
    expect(search.messages.some((m: { body: string }) => m.body.includes('Kofi'))).toBe(true);
  });

  it('cannot be edited or deleted, not even by the database user', async () => {
    const [row] = await db.select().from(smsMessages).limit(1);
    await expect(pool.query('update sms_messages set body = $1 where id = $2', ['changed', row!.id])).rejects.toThrow(/cannot be edited/);
    await expect(pool.query('delete from sms_messages where id = $1', [row!.id])).rejects.toThrow(/never deleted/);
    await expect(pool.query('delete from sms_credit_entries')).rejects.toThrow(/never deleted/);
  });
});
