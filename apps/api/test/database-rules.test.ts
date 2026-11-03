import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { auditLogs, jobLines, jobs, payments, services, users, vehicles } from '../src/db/schema.js';
import { writeAudit } from '../src/lib/audit.js';

const { db, pool } = createDb(loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('dbUrl') }).DATABASE_URL);

let userId = 0;
let jobId = 0;

/** Run a statement that must be refused, and return the database's reason. */
async function refusedWith(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    // drizzle wraps the driver error; the database's own message is on `cause`
    const cause = (e as { cause?: { message?: string } }).cause;
    return cause?.message ?? (e as Error).message;
  }
  throw new Error('the database accepted something it should have refused');
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ name: 'Rules tester', username: 'rules.tester', role: 'manager', passwordHash: 'x' })
    .returning({ id: users.id });
  userId = u!.id;
  const [v] = await db.insert(vehicles).values({ plate: 'GN 1-23', plateKey: 'GN123' }).returning({ id: vehicles.id });
  const [j] = await db.insert(jobs).values({ vehicleId: v!.id, createdBy: userId }).returning({ id: jobs.id });
  jobId = j!.id;
  // The job costs GH₵100, so payments have something to be paid against.
  const [svc] = await db.insert(services).values({ name: 'Rules wash', price: 10_000, commissionKind: 'percent', commissionValue: 1000 }).returning({ id: services.id });
  await db.insert(jobLines).values({ jobId, serviceId: svc!.id, priceAtSale: 10_000, commissionKindAtSale: 'percent', commissionValueAtSale: 1000 });
});

afterAll(() => pool.end());

describe('the audit log', () => {
  it('accepts new entries', async () => {
    await writeAudit(db, { userId, action: 'test.add', after: { ok: true } });
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs);
    expect(row!.n).toBeGreaterThan(0);
  });

  it('cannot be edited, deleted or emptied, not even by the app itself', async () => {
    expect(await refusedWith(() => db.execute(sql`update audit_logs set action = 'x'`))).toMatch(/append-only/);
    expect(await refusedWith(() => db.execute(sql`delete from audit_logs`))).toMatch(/append-only/);
    expect(await refusedWith(() => db.execute(sql`truncate audit_logs`))).toMatch(/append-only/);
  });
});

describe('payments', () => {
  const base = () => ({ jobId, recordedBy: userId });

  it('needs a MoMo reference for MoMo and none for cash', async () => {
    expect(
      await refusedWith(() => db.insert(payments).values({ ...base(), method: 'momo', amount: 500, idemKey: 'k-momo-1' })),
    ).toMatch(/payments_momo_needs_reference/);
    expect(
      await refusedWith(() =>
        db.insert(payments).values({ ...base(), method: 'momo', amount: 500, momoReference: '   ', idemKey: 'k-momo-2' }),
      ),
    ).toMatch(/payments_momo_needs_reference/);

    await db.insert(payments).values({ ...base(), method: 'momo', amount: 500, momoReference: 'MP260101.1234', idemKey: 'k-momo-3' });
    await db.insert(payments).values({ ...base(), method: 'cash', amount: 500, idemKey: 'k-cash-1' });
  });

  it('saves once when the same request arrives twice (idempotency key)', async () => {
    await db.insert(payments).values({ ...base(), method: 'cash', amount: 700, idemKey: 'k-double-tap' });
    expect(
      await refusedWith(() => db.insert(payments).values({ ...base(), method: 'cash', amount: 700, idemKey: 'k-double-tap' })),
    ).toMatch(/duplicate key|payments_idem_key/);
  });

  it('refuses zero and negative amounts', async () => {
    for (const amount of [0, -100]) {
      expect(
        await refusedWith(() => db.insert(payments).values({ ...base(), method: 'cash', amount, idemKey: `k-bad-${amount}` })),
      ).toMatch(/payments_amount_positive/);
    }
  });

  it('never add up to more than the job costs', async () => {
    // GH₵17 is already paid of GH₵100, so GH₵83 is left.
    expect(
      await refusedWith(() => db.insert(payments).values({ ...base(), method: 'cash', amount: 8_400, idemKey: 'k-over-1' })),
    ).toMatch(/more than the job costs/);
    await db.insert(payments).values({ ...base(), method: 'cash', amount: 8_300, idemKey: 'k-exact-1' });
    expect(
      await refusedWith(() => db.insert(payments).values({ ...base(), method: 'cash', amount: 1, idemKey: 'k-over-2' })),
    ).toMatch(/more than the job costs/);
    // Voiding it gives the balance back.
    await db.execute(sql`update payments set voided_at = now(), voided_by = ${userId}, void_reason = 'Test undo' where idem_key = 'k-exact-1'`);
    await db.insert(payments).values({ ...base(), method: 'cash', amount: 100, idemKey: 'k-after-void' });
  });

  it('cannot be edited, only voided, and a voided one stays voided', async () => {
    expect(await refusedWith(() => db.execute(sql`update payments set amount = 1 where idem_key = 'k-after-void'`))).toMatch(/cannot be edited/);
    expect(await refusedWith(() => db.execute(sql`update payments set method = 'momo' where idem_key = 'k-after-void'`))).toMatch(/cannot be edited/);
    expect(await refusedWith(() => db.execute(sql`update payments set void_reason = 'changed' where idem_key = 'k-exact-1'`))).toMatch(/voided payment cannot be changed/);
  });

  it('can be voided with a reason but never deleted', async () => {
    expect(await refusedWith(() => db.execute(sql`delete from payments`))).toMatch(/voided, never deleted/);
    expect(
      await refusedWith(() => db.execute(sql`update payments set voided_at = now() where idem_key = 'k-cash-1'`)),
    ).toMatch(/payments_void_complete/);
    await db.execute(
      sql`update payments set voided_at = now(), voided_by = ${userId}, void_reason = 'Customer paid twice' where idem_key = 'k-cash-1'`,
    );
  });
});

describe('other records', () => {
  it('keeps one car per plate however it is typed', async () => {
    expect(
      await refusedWith(() => db.insert(vehicles).values({ plate: 'gn-1 23', plateKey: 'GN123' })),
    ).toMatch(/vehicles_plate_key_unique|duplicate key/);
    expect(
      await refusedWith(() => db.insert(vehicles).values({ plate: 'bad', plateKey: 'has space' })),
    ).toMatch(/vehicles_plate_key_clean/);
  });

  it('refuses a negative discount', async () => {
    expect(
      await refusedWith(() => db.execute(sql`update jobs set discount = -1 where id = ${jobId}`)),
    ).toMatch(/jobs_discount_not_negative/);
  });

  it('refuses to delete jobs and users', async () => {
    expect(await refusedWith(() => db.execute(sql`delete from jobs`))).toMatch(/voided, never deleted/);
    expect(await refusedWith(() => db.execute(sql`delete from users`))).toMatch(/voided, never deleted/);
  });
});
