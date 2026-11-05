import { desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { formatGHS, payoutInput, reasonInput, type CommissionLedger, type CommissionOverview, type LedgerEntry } from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { attendants, commissionPayouts, commissions, jobLineAttendants, jobLines, jobs, paymentMethods, services, users, vehicles } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { balanceOf, relinkPayouts } from '../lib/commissions.js';
import { assertDayOpen, dayOf } from '../lib/dayLock.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import { activeMethod } from '../lib/methods.js';
import { idParams } from '../lib/params.js';

const PAGE = 30;
const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(PAGE) });

const earnedOf = sql<number>`coalesce((
  select sum(c.amount) from commissions c join job_line_attendants jla on jla.id = c.line_attendant_id
  where jla.attendant_id = "attendants"."id" and c.status = 'earned'), 0)::int`;
const earned7dOf = sql<number>`coalesce((
  select sum(c.amount) from commissions c join job_line_attendants jla on jla.id = c.line_attendant_id
  where jla.attendant_id = "attendants"."id" and c.status = 'earned' and c.created_at > now() - interval '7 days'), 0)::int`;
const paidOutOf = sql<number>`coalesce((
  select sum(p.amount) from commission_payouts p where p.attendant_id = "attendants"."id" and p.voided_at is null), 0)::int`;

/** The newest `limit` lines of what an attendant earned and was paid, with how many there are in all. */
export async function ledgerFor(db: DbOrTx, attendantId: number, limit = PAGE): Promise<CommissionLedger | null> {
  const [attendant] = await db.select().from(attendants).where(eq(attendants.id, attendantId));
  if (!attendant) return null;
  const { earned, paidOut, owed } = await balanceOf(db, attendantId);

  const earnedRows = await db
    .select({
      id: commissions.id,
      at: commissions.createdAt,
      amount: commissions.amount,
      status: commissions.status,
      shareBp: jobLineAttendants.shareBp,
      jobId: jobs.id,
      plate: vehicles.plate,
      service: services.name,
    })
    .from(commissions)
    .innerJoin(jobLineAttendants, eq(jobLineAttendants.id, commissions.lineAttendantId))
    .innerJoin(jobLines, eq(jobLines.id, jobLineAttendants.jobLineId))
    .innerJoin(jobs, eq(jobs.id, jobLines.jobId))
    .innerJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
    .innerJoin(services, eq(services.id, jobLines.serviceId))
    .where(eq(jobLineAttendants.attendantId, attendantId))
    .orderBy(desc(commissions.id))
    .limit(limit);

  const payoutRows = await db
    .select({ p: commissionPayouts, by: users.name, method: paymentMethods.name })
    .from(commissionPayouts)
    .innerJoin(users, eq(users.id, commissionPayouts.paidBy))
    .innerJoin(paymentMethods, eq(paymentMethods.id, commissionPayouts.methodId))
    .where(eq(commissionPayouts.attendantId, attendantId))
    .orderBy(desc(commissionPayouts.id))
    .limit(limit);
  const voiderIds = [...new Set(payoutRows.flatMap((r) => (r.p.voidedBy ? [r.p.voidedBy] : [])))];
  const voiders = voiderIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, voiderIds)) : [];
  const nameOf = new Map(voiders.map((u) => [u.id, u.name]));

  const entries: LedgerEntry[] = [
    ...earnedRows.map(
      (r): LedgerEntry => ({
        type: 'earned',
        id: r.id,
        at: r.at.toISOString(),
        amount: r.amount,
        jobId: r.jobId,
        plate: r.plate,
        service: r.service,
        sharePct: r.shareBp / 100,
        reversed: r.status === 'reversed',
      }),
    ),
    ...payoutRows.map(
      ({ p, by, method }): LedgerEntry => ({
        type: 'payout',
        id: p.id,
        at: p.createdAt.toISOString(),
        amount: p.amount,
        methodId: p.methodId,
        method,
        by,
        note: p.note,
        voided: p.voidedAt ? { at: p.voidedAt.toISOString(), by: nameOf.get(p.voidedBy!) ?? 'Someone', reason: p.voidReason ?? '' } : null,
      }),
    ),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    // Each side was cut at `limit`, so the newest `limit` of the two together are all in here.
    .slice(0, limit);

  const [{ n: earnedCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(commissions)
    .innerJoin(jobLineAttendants, eq(jobLineAttendants.id, commissions.lineAttendantId))
    .where(eq(jobLineAttendants.attendantId, attendantId));
  const [{ n: payoutCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(commissionPayouts)
    .where(eq(commissionPayouts.attendantId, attendantId));

  return { attendant: { id: attendant.id, name: attendant.name, active: attendant.active }, owed, earned, paidOut, entries, total: earnedCount + payoutCount };
}

/** What each attendant has earned and is owed. Payouts happen here. Managers and owners only. */
export const commissionRoutes: FastifyPluginAsync = async (app) => {
  const view = { preHandler: app.requirePermission('commission.view') };
  const pay = { preHandler: app.requirePermission('commission.payout') };

  app.get('/', view, async (): Promise<CommissionOverview> => {
    const rows = await app.db
      .select({ id: attendants.id, name: attendants.name, active: attendants.active, earned: earnedOf, earned7d: earned7dOf, paid: paidOutOf })
      .from(attendants)
      .where(or(eq(attendants.active, true), sql`${earnedOf} - ${paidOutOf} <> 0`));
    const list = rows
      .map((r) => ({ attendantId: r.id, name: r.name, active: r.active, owed: r.earned - r.paid, earned7d: r.earned7d }))
      .sort((a, b) => b.owed - a.owed || a.name.localeCompare(b.name));
    return { attendants: list, totalOwed: list.reduce((sum, r) => sum + r.owed, 0) };
  });

  // An attendant who signs in sees their own ledger, and only theirs.
  app.get('/mine', { preHandler: app.requirePermission('self.view') }, async (req) => {
    const { limit } = pageQuery.parse(req.query);
    const attendantId = req.user!.attendantId;
    if (attendantId === null) return { ledger: null };
    return { ledger: await ledgerFor(app.db, attendantId, limit) };
  });

  app.get('/attendants/:id', view, async (req) => {
    const { id } = idParams.parse(req.params);
    const { limit } = pageQuery.parse(req.query);
    const ledger = await ledgerFor(app.db, id, limit);
    if (!ledger) throw notFound('That attendant');
    return { ledger };
  });

  // Pay out some or all of what is owed. Part payouts are fine. The same key twice pays once.
  app.post('/payouts', pay, async (req, reply) => {
    const input = payoutInput.parse(req.body);

    const created = await app.db.transaction(async (tx) => {
      const [person] = await tx.select().from(attendants).where(eq(attendants.id, input.attendantId)).for('update');
      if (!person) throw notFound('That attendant');
      const [again] = await tx.select().from(commissionPayouts).where(eq(commissionPayouts.idemKey, input.idemKey));
      if (again) {
        if (again.attendantId !== input.attendantId) throw conflict('key_reused', 'That payout was already saved for someone else.');
        return false;
      }
      await assertDayOpen(tx, dayOf());
      const method = await activeMethod(tx, input.methodId);
      const { owed } = await balanceOf(tx, input.attendantId);
      if (owed <= 0) throw conflict('nothing_owed', `Nothing is owed to ${person.name}.`);
      if (input.amount > owed) throw new HttpError(400, 'too_much', `Only ${formatGHS(owed)} is owed to ${person.name}.`);
      const [row] = await tx
        .insert(commissionPayouts)
        .values({ attendantId: input.attendantId, amount: input.amount, methodId: method.id, note: input.note, idemKey: input.idemKey, paidBy: req.user!.id })
        .returning();
      await relinkPayouts(tx, input.attendantId);
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'commission.payout',
        recordTable: 'commission_payouts',
        recordId: row!.id,
        after: { attendant: person.name, method: method.name, amount: input.amount },
        ...(input.note ? { note: input.note } : {}),
        ip: req.ip,
      });
      return true;
    });
    return reply.status(created ? 201 : 200).send({ ledger: await ledgerFor(app.db, input.attendantId) });
  });

  // A wrong payout is voided with a reason and entered again. It is never edited or deleted.
  app.post('/payouts/:id/void', pay, async (req) => {
    const { id } = idParams.parse(req.params);
    const { reason } = reasonInput.parse(req.body);

    const attendantId = await app.db.transaction(async (tx) => {
      const [payout] = await tx.select().from(commissionPayouts).where(eq(commissionPayouts.id, id)).for('update');
      if (!payout) throw notFound('That payout');
      if (payout.voidedAt) throw conflict('already_voided', 'That payout was already voided.');
      await assertDayOpen(tx, dayOf(payout.createdAt));
      const [method] = await tx.select({ name: paymentMethods.name }).from(paymentMethods).where(eq(paymentMethods.id, payout.methodId));
      await tx.select().from(attendants).where(eq(attendants.id, payout.attendantId)).for('update');
      await tx.update(commissionPayouts).set({ voidedAt: new Date(), voidedBy: req.user!.id, voidReason: reason }).where(eq(commissionPayouts.id, id));
      await relinkPayouts(tx, payout.attendantId);
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'commission.payout_void',
        recordTable: 'commission_payouts',
        recordId: id,
        before: { method: method?.name, amount: payout.amount },
        note: reason,
        ip: req.ip,
      });
      return payout.attendantId;
    });
    return { ledger: await ledgerFor(app.db, attendantId) };
  });
};
