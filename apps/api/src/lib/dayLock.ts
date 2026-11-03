import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { dailyCloses } from '../db/schema.js';
import { conflict } from './errors.js';

/** The business day of a moment. Ghana is on UTC, so the day is the UTC date. */
export const dayOf = (at: Date = new Date()): string => at.toISOString().slice(0, 10);

/** A lock number for one day: the days since 1970. */
const lockKey = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/**
 * Money can't be added to a closed day, or voided on one. A manager reopens the day first.
 *
 * Every money change takes a shared lock on the day, and closing takes the exclusive one, so a payment
 * that is half-saved while the day is being closed either lands before the count or is refused after it.
 * The lock is released when the transaction ends.
 */
export async function assertDayOpen(tx: DbOrTx, day: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${lockKey(day)}::bigint)`);
  const [closed] = await tx
    .select({ day: dailyCloses.day })
    .from(dailyCloses)
    .where(and(eq(dailyCloses.day, day), eq(dailyCloses.status, 'closed')));
  if (closed) {
    throw conflict('day_closed', `${day === dayOf() ? 'Today' : day} has been closed. A manager can reopen it.`);
  }
}

/** Used by the close itself: nothing else can add money to that day while the count is being taken. */
export async function lockDayForClose(tx: DbOrTx, day: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(day)}::bigint)`);
}
