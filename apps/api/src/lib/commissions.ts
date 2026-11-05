import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { percentOf } from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { commissionPayouts, commissions, jobLineAttendants, jobLines } from '../db/schema.js';

/** What the attendants on one line earn between them: the service's rule as it was when it was sold. */
const lineCommission = (price: number, quantity: number, kind: 'percent' | 'fixed', value: number) =>
  kind === 'percent' ? percentOf(price, value) : value * quantity;

/**
 * Split a whole-pesewa amount by shares in basis points so the pieces add back up exactly.
 * Any left-over pesewas go to the first people, one each, like splitEvenly.
 */
export function splitByShares(amount: number, sharesBp: number[]): number[] {
  const pieces = sharesBp.map((bp) => Math.floor((amount * bp) / 10_000));
  let left = amount - pieces.reduce((sum, p) => sum + p, 0);
  for (let i = 0; left > 0 && pieces.length > 0; i = (i + 1) % pieces.length, left--) pieces[i]! += 1;
  return pieces;
}

/**
 * Called when a job is marked Completed: one commission for each person on each service.
 * It is based on the price at sale, so a whole-job discount does not reduce what attendants earn.
 */
export async function earnCommissions(tx: DbOrTx, jobId: number, at?: Date): Promise<void> {
  const rows = await tx
    .select({
      lineId: jobLines.id,
      price: jobLines.priceAtSale,
      quantity: jobLines.quantity,
      kind: jobLines.commissionKindAtSale,
      value: jobLines.commissionValueAtSale,
      lineAttendantId: jobLineAttendants.id,
      shareBp: jobLineAttendants.shareBp,
    })
    .from(jobLineAttendants)
    .innerJoin(jobLines, eq(jobLines.id, jobLineAttendants.jobLineId))
    .where(eq(jobLines.jobId, jobId))
    .orderBy(asc(jobLines.id), asc(jobLineAttendants.id));

  const byLine = new Map<number, typeof rows>();
  for (const row of rows) byLine.set(row.lineId, [...(byLine.get(row.lineId) ?? []), row]);

  const values = [...byLine.values()].flatMap((people) => {
    const first = people[0]!;
    const amounts = splitByShares(lineCommission(first.price, first.quantity, first.kind, first.value), people.map((p) => p.shareBp));
    return people.map((p, i) => ({ lineAttendantId: p.lineAttendantId, amount: amounts[i]!, ...(at ? { createdAt: at } : {}) }));
  });
  if (values.length > 0) await tx.insert(commissions).values(values).onConflictDoNothing();
}

/** The job was voided: take back what its attendants had earned. Money already paid out shows as a negative balance. */
export async function reverseCommissions(tx: DbOrTx, jobId: number): Promise<void> {
  const lineAttendantIds = tx
    .select({ id: jobLineAttendants.id })
    .from(jobLineAttendants)
    .innerJoin(jobLines, eq(jobLines.id, jobLineAttendants.jobLineId))
    .where(eq(jobLines.jobId, jobId));
  const reversed = await tx
    .update(commissions)
    .set({ status: 'reversed', reversedAt: new Date() })
    .where(and(eq(commissions.status, 'earned'), inArray(commissions.lineAttendantId, lineAttendantIds)))
    .returning({ lineAttendantId: commissions.lineAttendantId });
  if (reversed.length === 0) return;
  const people = await tx
    .selectDistinct({ attendantId: jobLineAttendants.attendantId })
    .from(jobLineAttendants)
    .where(inArray(jobLineAttendants.id, reversed.map((r) => r.lineAttendantId)));
  for (const p of people) await relinkPayouts(tx, p.attendantId);
}

/** Total earned and total paid out for one attendant, in pesewas. */
export async function balanceOf(tx: DbOrTx, attendantId: number): Promise<{ earned: number; paidOut: number; owed: number }> {
  const [earned] = await tx
    .select({ s: sql<number>`coalesce(sum(${commissions.amount}), 0)::int` })
    .from(commissions)
    .innerJoin(jobLineAttendants, eq(jobLineAttendants.id, commissions.lineAttendantId))
    .where(and(eq(jobLineAttendants.attendantId, attendantId), eq(commissions.status, 'earned')));
  const [paid] = await tx
    .select({ s: sql<number>`coalesce(sum(${commissionPayouts.amount}), 0)::int` })
    .from(commissionPayouts)
    .where(and(eq(commissionPayouts.attendantId, attendantId), isNull(commissionPayouts.voidedAt)));
  const e = earned?.s ?? 0;
  const p = paid?.s ?? 0;
  return { earned: e, paidOut: p, owed: e - p };
}

/**
 * Tick off the oldest commissions as paid, in order, until the money paid out runs out.
 * A part payout leaves the next commission unticked. The balance does not depend on this: it is earned minus paid out.
 */
export async function relinkPayouts(tx: DbOrTx, attendantId: number): Promise<void> {
  const payouts = await tx
    .select({ id: commissionPayouts.id, amount: commissionPayouts.amount })
    .from(commissionPayouts)
    .where(and(eq(commissionPayouts.attendantId, attendantId), isNull(commissionPayouts.voidedAt)))
    .orderBy(asc(commissionPayouts.id));
  const earned = await tx
    .select({ id: commissions.id, amount: commissions.amount, payoutId: commissions.payoutId })
    .from(commissions)
    .innerJoin(jobLineAttendants, eq(jobLineAttendants.id, commissions.lineAttendantId))
    .where(and(eq(jobLineAttendants.attendantId, attendantId), eq(commissions.status, 'earned')))
    .orderBy(asc(commissions.id));

  let earnedSoFar = 0;
  for (const c of earned) {
    earnedSoFar += c.amount;
    let paidSoFar = 0;
    let coveredBy: number | null = null;
    if (c.amount > 0) {
      for (const p of payouts) {
        paidSoFar += p.amount;
        if (paidSoFar >= earnedSoFar) {
          coveredBy = p.id;
          break;
        }
      }
    }
    if (coveredBy !== c.payoutId) await tx.update(commissions).set({ payoutId: coveredBy }).where(eq(commissions.id, c.id));
  }
}
