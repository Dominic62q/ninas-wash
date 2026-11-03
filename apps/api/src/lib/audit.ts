import type { DbOrTx } from '../db/client.js';
import { auditLogs } from '../db/schema.js';

export interface AuditEntry {
  /** Who did it. Leave out for events with no signed-in person, such as a failed sign-in. */
  userId?: number | null;
  /** What happened, as `thing.verb`: `job.create`, `payment.void`, `auth.login`. */
  action: string;
  recordTable?: string;
  recordId?: number;
  /** The record as it was before the change, and as it is after. Never put passwords or tokens in here. */
  before?: unknown;
  after?: unknown;
  /** Why, when the person had to say (void reasons, dispatch overrides, reopen reasons). */
  note?: string;
  ip?: string;
}

/**
 * Write one audit entry. Pass the same transaction as the change itself, so the change
 * and its diary line are saved together or not at all:
 *
 *   await db.transaction(async (tx) => {
 *     await tx.update(...);
 *     await writeAudit(tx, { ... });
 *   });
 */
export async function writeAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    userId: entry.userId ?? null,
    action: entry.action,
    recordTable: entry.recordTable ?? null,
    recordId: entry.recordId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    note: entry.note ?? null,
    ip: entry.ip ?? null,
  });
}
