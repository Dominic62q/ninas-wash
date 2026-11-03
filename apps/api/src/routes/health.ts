import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    await app.db.execute(sql`select 1`);
    return { ok: true };
  });
};
