/**
 * Earns commission for jobs that were completed before commissions existed (Phase 4).
 * Safe to run more than once: a person's commission on a service is only ever created once.
 * Uses the time each job was completed, so "earned this week" stays honest.
 */
import { and, inArray, isNull } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { jobs } from '../src/db/schema.js';
import { earnCommissions } from '../src/lib/commissions.js';

const { db, pool } = createDb(loadConfig().DATABASE_URL);

const finished = await db
  .select({ id: jobs.id, completedAt: jobs.completedAt })
  .from(jobs)
  .where(and(inArray(jobs.status, ['completed', 'dispatched']), isNull(jobs.voidedAt)));

for (const job of finished) {
  await db.transaction((tx) => earnCommissions(tx, job.id, job.completedAt ?? undefined));
}
console.log(`Checked commissions on ${finished.length} finished jobs.`);
await pool.end();
