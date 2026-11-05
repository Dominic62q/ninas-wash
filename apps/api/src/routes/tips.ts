import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { formatGHS, handoutInput, reasonInput, tipInput, type TipDto, type TipsOverview } from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { attendants, jobs, tipHandouts, tips, users, vehicles } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { assertDayOpen, dayOf } from '../lib/dayLock.js';
import { conflict, notFound } from '../lib/errors.js';
import { idParams } from '../lib/params.js';

const listQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(1000).default(30),
});

const voider = alias(users, 'voider');

async function selectTips(db: DbOrTx, where: ReturnType<typeof and>, limit: number): Promise<TipDto[]> {
  const rows = await db
    .select({
      tip: tips,
      attendant: attendants.name,
      plate: vehicles.plate,
      by: users.name,
      voidedBy: voider.name,
    })
    .from(tips)
    .innerJoin(attendants, eq(attendants.id, tips.attendantId))
    .innerJoin(users, eq(users.id, tips.recordedBy))
    .leftJoin(jobs, eq(jobs.id, tips.jobId))
    .leftJoin(vehicles, eq(vehicles.id, jobs.vehicleId))
    .leftJoin(voider, eq(voider.id, tips.voidedBy))
    .where(where)
    .orderBy(desc(tips.id))
    .limit(limit);
  return rows.map(({ tip, attendant, plate, by, voidedBy }) => ({
    id: tip.id,
    at: tip.createdAt.toISOString(),
    attendantId: tip.attendantId,
    attendant,
    jobId: tip.jobId,
    plate,
    amount: tip.amount,
    kind: tip.kind,
    handedOut: tip.handoutId !== null,
    by,
    voided: tip.voidedAt ? { at: tip.voidedAt.toISOString(), by: voidedBy ?? 'Someone', reason: tip.voidReason ?? '' } : null,
  }));
}

/** Held tips not yet handed out, per attendant. */
const heldWhere = and(eq(tips.kind, 'held'), isNull(tips.handoutId), isNull(tips.voidedAt));

async function overview(db: DbOrTx, days: number, limit: number): Promise<TipsOverview> {
  const since = new Date(Date.now() - days * 86_400_000);
  const held = await db
    .select({ attendantId: tips.attendantId, name: attendants.name, amount: sql<number>`sum(${tips.amount})::int`, count: sql<number>`count(*)::int` })
    .from(tips)
    .innerJoin(attendants, eq(attendants.id, tips.attendantId))
    .where(heldWhere)
    .groupBy(tips.attendantId, attendants.name)
    .orderBy(attendants.name);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tips)
    .where(gte(tips.createdAt, since));
  return {
    held,
    totalHeld: held.reduce((sum, h) => sum + h.amount, 0),
    tips: await selectTips(db, gte(tips.createdAt, since), limit),
    total: n,
  };
}

/** Tips are the customer's thank-you to an attendant. They never mix into commission. */
export const tipRoutes: FastifyPluginAsync = async (app) => {
  const record = { preHandler: app.requirePermission('tip.record') };

  app.get('/', record, async (req) => {
    const { days, limit } = listQuery.parse(req.query);
    return overview(app.db, days, limit);
  });

  // Direct: the customer handed it over, we only write it down. Held: we took it, and keep it until a handout.
  app.post('/', record, async (req, reply) => {
    const input = tipInput.parse(req.body);

    const result = await app.db.transaction(async (tx) => {
      const [again] = await tx.select().from(tips).where(eq(tips.idemKey, input.idemKey));
      if (again) {
        if (again.attendantId !== input.attendantId) throw conflict('key_reused', 'That tip was already saved for someone else.');
        return { id: again.id, created: false };
      }
      if (input.kind === 'held') await assertDayOpen(tx, dayOf()); // a held tip is cash in the drawer; a direct one never touches it
      const [person] = await tx.select().from(attendants).where(and(eq(attendants.id, input.attendantId), eq(attendants.active, true)));
      if (!person) throw notFound('That attendant');
      if (input.jobId !== null) {
        const [job] = await tx.select({ id: jobs.id, voidedAt: jobs.voidedAt }).from(jobs).where(eq(jobs.id, input.jobId));
        if (!job) throw notFound('That job');
        if (job.voidedAt) throw conflict('job_voided', 'This job was voided.');
      }
      const [row] = await tx
        .insert(tips)
        .values({ attendantId: input.attendantId, jobId: input.jobId, amount: input.amount, kind: input.kind, idemKey: input.idemKey, recordedBy: req.user!.id })
        .returning({ id: tips.id });
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'tip.record',
        recordTable: 'tips',
        recordId: row!.id,
        after: { attendant: person.name, amount: input.amount, kind: input.kind, jobId: input.jobId },
        ip: req.ip,
      });
      return { id: row!.id, created: true };
    });
    const [tip] = await selectTips(app.db, eq(tips.id, result.id), 1);
    return reply.status(result.created ? 201 : 200).send({ tip });
  });

  // Hand over everything held for one attendant, in one go. One handout, one receipt.
  app.post('/handouts', { preHandler: app.requirePermission('tip.handout') }, async (req, reply) => {
    const { attendantId } = handoutInput.parse(req.body);

    const handout = await app.db.transaction(async (tx) => {
      const [person] = await tx.select().from(attendants).where(eq(attendants.id, attendantId)).for('update');
      if (!person) throw notFound('That attendant');
      await assertDayOpen(tx, dayOf());
      const held =await tx.select({ id: tips.id, amount: tips.amount }).from(tips).where(and(heldWhere, eq(tips.attendantId, attendantId))).for('update');
      if (held.length === 0) throw conflict('nothing_held', `No tips are being held for ${person.name}.`);
      const amount = held.reduce((sum, t) => sum + t.amount, 0);
      const [row] = await tx.insert(tipHandouts).values({ attendantId, amount, givenBy: req.user!.id }).returning();
      await tx.update(tips).set({ handoutId: row!.id }).where(and(heldWhere, eq(tips.attendantId, attendantId)));
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'tip.handout',
        recordTable: 'tip_handouts',
        recordId: row!.id,
        after: { attendant: person.name, amount, tips: held.length },
        ip: req.ip,
      });
      return { id: row!.id, attendant: person.name, amount, count: held.length };
    });
    return reply.status(201).send({ handout: handout, summary: `${formatGHS(handout.amount)} handed to ${handout.attendant}` });
  });

  // A wrong tip is voided with a reason. Once it has been handed out, it can no longer be changed.
  app.post('/:id/void', { preHandler: app.requirePermission('tip.void') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { reason } = reasonInput.parse(req.body);

    await app.db.transaction(async (tx) => {
      const [tip] = await tx.select().from(tips).where(eq(tips.id, id)).for('update');
      if (!tip) throw notFound('That tip');
      if (tip.voidedAt) throw conflict('already_voided', 'That tip was already voided.');
      if (tip.handoutId !== null) throw conflict('handed_out', 'That tip was already handed out.');
      if (tip.kind === 'held') await assertDayOpen(tx, dayOf(tip.createdAt));
      await tx.update(tips).set({ voidedAt: new Date(), voidedBy: req.user!.id, voidReason: reason }).where(eq(tips.id, id));
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'tip.void',
        recordTable: 'tips',
        recordId: id,
        before: { amount: tip.amount, kind: tip.kind },
        note: reason,
        ip: req.ip,
      });
    });
    const [tip] = await selectTips(app.db, eq(tips.id, id), 1);
    return { tip };
  });
};
