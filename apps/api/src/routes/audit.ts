import { desc, eq, lt } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { auditLogs, users } from '../db/schema.js';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Pass the last `id` you received to get the next, older page. */
  before: z.coerce.number().int().positive().optional(),
});

export const auditRoutes: FastifyPluginAsync = async (app) => {
  // Read-only for everyone. There is no write route on purpose: entries are written by the app itself.
  app.get('/', { preHandler: app.requirePermission('audit.read') }, async (req) => {
    const { limit, before } = query.parse(req.query);
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
      .where(before ? lt(auditLogs.id, before) : undefined)
      .orderBy(desc(auditLogs.id))
      .limit(limit);
    return { entries: rows };
  });
};
