import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { can, serviceInput, serviceUpdate, type ChangeEntry, type ServiceDto } from '@niinas/shared';
import { auditLogs, jobLines, jobs, services, users } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { changedFields, isUniqueViolation } from '../lib/helpers.js';
import { idParams } from '../lib/params.js';

const list = z.object({ includeInactive: z.enum(['0', '1']).default('0') });

const sold7d = sql<number>`(
  select count(*)::int from ${jobLines} jl join ${jobs} j on j.id = jl.job_id
  where jl.service_id = "services"."id" and j.voided_at is null and j.created_at > now() - interval '7 days'
)`;

type Row = typeof services.$inferSelect;
const toDto = (row: Row, sold = 0): ServiceDto => ({
  id: row.id,
  name: row.name,
  price: row.price,
  commissionKind: row.commissionKind,
  commissionValue: row.commissionValue,
  active: row.active,
  sold7d: sold,
  updatedAt: row.updatedAt.toISOString(),
});

/** The fields a person can edit. Used to compare before and after for the audit log. */
const editable = (row: Row) => ({
  name: row.name,
  price: row.price,
  commissionKind: row.commissionKind,
  commissionValue: row.commissionValue,
  active: row.active,
});

const DUPLICATE = () => conflict('duplicate_service', 'A service with that name already exists.');

export const serviceRoutes: FastifyPluginAsync = async (app) => {
  // Everyone signed in needs the list to build a job. Only the owner sees hidden ones.
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    const { includeInactive } = list.parse(req.query);
    const showHidden = includeInactive === '1' && can(req.user!.permissions, 'service.manage');
    const rows = await app.db
      .select({ service: services, sold: sold7d })
      .from(services)
      .where(showHidden ? undefined : eq(services.active, true))
      .orderBy(desc(services.active), asc(services.name));
    return { services: rows.map((r) => toDto(r.service, r.sold)) };
  });

  app.post('/', { preHandler: app.requirePermission('service.manage') }, async (req, reply) => {
    const input = serviceInput.parse(req.body);
    try {
      const created = await app.db.transaction(async (tx) => {
        const [row] = await tx.insert(services).values(input).returning();
        await writeAudit(tx, {
          userId: req.user!.id,
          action: 'service.create',
          recordTable: 'services',
          recordId: row!.id,
          after: input,
          ip: req.ip,
        });
        return row!;
      });
      return reply.status(201).send({ service: toDto(created) });
    } catch (e) {
      if (isUniqueViolation(e)) throw DUPLICATE();
      throw e;
    }
  });

  // Changes apply to new jobs only: job lines keep the price and commission they were sold at.
  app.patch('/:id', { preHandler: app.requirePermission('service.manage') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const patch = serviceUpdate.parse(req.body);

    try {
      return await app.db.transaction(async (tx) => {
        const [current] = await tx.select().from(services).where(eq(services.id, id)).for('update');
        if (!current) throw notFound('That service');

        // Check the whole service as it would be after the change, not just the changed field.
        const merged = serviceInput.parse({ ...editable(current), ...patch });
        const diff = changedFields(editable(current), merged);
        if (!diff) return { service: toDto(current) };

        const [row] = await tx
          .update(services)
          .set({ ...diff.after, updatedAt: new Date() })
          .where(eq(services.id, id))
          .returning();
        await writeAudit(tx, {
          userId: req.user!.id,
          action: 'service.update',
          recordTable: 'services',
          recordId: id,
          before: diff.before,
          after: diff.after,
          ip: req.ip,
        });
        return { service: toDto(row!) };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw DUPLICATE();
      throw e;
    }
  });

  // "Price 45.00 to 50.00, by Kwabena Asare, 2 Oct", straight from the audit log.
  app.get('/:id/history', { preHandler: app.requirePermission('service.manage') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const rows = await app.db
      .select({
        id: auditLogs.id,
        at: auditLogs.at,
        action: auditLogs.action,
        before: auditLogs.before,
        after: auditLogs.after,
        by: users.name,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(and(eq(auditLogs.recordTable, 'services'), eq(auditLogs.recordId, id)))
      .orderBy(desc(auditLogs.id))
      .limit(50);

    const history: ChangeEntry[] = rows.map((r) => {
      const before = (r.before ?? {}) as Record<string, unknown>;
      const after = (r.after ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        at: r.at.toISOString(),
        by: r.by,
        action: r.action,
        changes: Object.keys(after).map((field) => ({ field, from: before[field] ?? null, to: after[field] })),
      };
    });
    return { history };
  });
};
