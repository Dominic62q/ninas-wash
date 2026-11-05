import { and, desc, eq, gte, like, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AUDIT_AREAS, type AuditPage } from '@niinas/shared';
import { auditLogs, users } from '../db/schema.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Pass the last `id` you received to get the next, older page. */
  before: z.coerce.number().int().positive().optional(),
  /** Only this person's entries. */
  userId: z.coerce.number().int().positive().optional(),
  area: z.enum(AUDIT_AREAS.map((a) => a.value) as [string, ...string[]]).optional(),
  from: day.optional(),
  to: day.optional(),
});

export const auditRoutes: FastifyPluginAsync = async (app) => {
  // Read-only for everyone. There is no write route on purpose: entries are written by the app itself.
  app.get('/', { preHandler: app.requirePermission('audit.read') }, async (req): Promise<AuditPage> => {
    const q = query.parse(req.query);
    const filters: (SQL | undefined)[] = [];
    if (q.before) filters.push(lt(auditLogs.id, q.before));
    if (q.userId) filters.push(eq(auditLogs.userId, q.userId));
    if (q.area) {
      const prefixes = AUDIT_AREAS.find((a) => a.value === q.area)?.prefixes ?? [];
      filters.push(or(...prefixes.map((p) => like(auditLogs.action, `${p}%`))));
    }
    // Days are the wash's own (Ghana is UTC all year), so a day's start and end are plain UTC midnights.
    if (q.from) filters.push(gte(auditLogs.at, new Date(`${q.from}T00:00:00Z`)));
    if (q.to) filters.push(lt(auditLogs.at, new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000)));

    const rows = await app.db
      .select({
        id: auditLogs.id,
        at: auditLogs.at,
        action: auditLogs.action,
        recordTable: auditLogs.recordTable,
        recordId: auditLogs.recordId,
        before: auditLogs.before,
        after: auditLogs.after,
        note: auditLogs.note,
        userId: auditLogs.userId,
        userName: users.name,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(and(...filters))
      .orderBy(desc(auditLogs.id))
      .limit(q.limit + 1);

    const page = rows.slice(0, q.limit);
    const people = await app.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(sql`exists (select 1 from ${auditLogs} where ${auditLogs.userId} = ${users.id})`)
      .orderBy(users.name);
    return {
      entries: page.map((r) => ({ ...r, at: r.at.toISOString() })),
      next: rows.length > q.limit ? page[page.length - 1]!.id : null,
      people,
    };
  });
};
