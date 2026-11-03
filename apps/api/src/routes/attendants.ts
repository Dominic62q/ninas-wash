import { asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { attendantInput, attendantUpdate, can, type AttendantDto } from '@niinas/shared';
import { attendants, jobLineAttendants, jobLines, jobs } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { changedFields } from '../lib/helpers.js';
import { idParams } from '../lib/params.js';

const list = z.object({ includeInactive: z.enum(['0', '1']).default('0') });

const jobsThisWeek = sql<number>`(
  select count(distinct j.id)::int
  from ${jobLineAttendants} jla
  join ${jobLines} jl on jl.id = jla.job_line_id
  join ${jobs} j on j.id = jl.job_id
  where jla.attendant_id = "attendants"."id" and j.voided_at is null and j.created_at > now() - interval '7 days'
)`;

type Row = typeof attendants.$inferSelect;
const toDto = (row: Row, jobsCount = 0): AttendantDto => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  active: row.active,
  leftOn: row.deactivatedAt ? row.deactivatedAt.toISOString() : null,
  jobsThisWeek: jobsCount,
});

const editable = (row: Row) => ({ name: row.name, phone: row.phone, active: row.active });

/** Attendants are the washers who earn commission. They never sign in, so they are not users. */
export const attendantRoutes: FastifyPluginAsync = async (app) => {
  // Anyone signed in can see active attendants, to put them on a job.
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    const { includeInactive } = list.parse(req.query);
    const showAll = includeInactive === '1' && can(req.user!.role, 'attendant.manage');
    const rows = await app.db
      .select({ attendant: attendants, jobs: jobsThisWeek })
      .from(attendants)
      .where(showAll ? undefined : eq(attendants.active, true))
      .orderBy(desc(attendants.active), asc(attendants.name));
    return { attendants: rows.map((r) => toDto(r.attendant, r.jobs)) };
  });

  app.post('/', { preHandler: app.requirePermission('attendant.manage') }, async (req, reply) => {
    const input = attendantInput.parse(req.body);
    const created = await app.db.transaction(async (tx) => {
      const [row] = await tx.insert(attendants).values(input).returning();
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'attendant.create',
        recordTable: 'attendants',
        recordId: row!.id,
        after: input,
        ip: req.ip,
      });
      return row!;
    });
    return reply.status(201).send({ attendant: toDto(created) });
  });

  // There is no delete. Someone who leaves is set inactive, and their jobs, commissions and payouts stay on record.
  app.patch('/:id', { preHandler: app.requirePermission('attendant.manage') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const patch = attendantUpdate.parse(req.body);

    return app.db.transaction(async (tx) => {
      const [current] = await tx.select().from(attendants).where(eq(attendants.id, id)).for('update');
      if (!current) throw notFound('That attendant');

      const diff = changedFields(editable(current), patch);
      if (!diff) return { attendant: toDto(current) };

      const deactivatedAt =
        patch.active === undefined || patch.active === current.active ? undefined : patch.active ? null : new Date();
      const [row] = await tx
        .update(attendants)
        .set({ ...diff.after, ...(deactivatedAt === undefined ? {} : { deactivatedAt }) })
        .where(eq(attendants.id, id))
        .returning();
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'attendant.update',
        recordTable: 'attendants',
        recordId: id,
        before: diff.before,
        after: diff.after,
        ip: req.ip,
      });
      return { attendant: toDto(row!) };
    });
  });
};
