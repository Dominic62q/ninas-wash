import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { jobLines, services, stockMoves } from '../db/schema.js';
import { conflict } from './errors.js';

type Reason = (typeof stockMoves.$inferInsert)['reason'];

/**
 * Change an item's shelf count and record why, in one step. The count never goes below zero:
 * taking more than is on the shelf fails with "Only 3 Car shine left." and changes nothing.
 * Call inside a transaction, so the stock and the sale it belongs to save together.
 */
export async function moveStock(
  tx: DbOrTx,
  move: { serviceId: number; change: number; reason: Reason; by: number; jobId?: number | null; note?: string | null },
): Promise<number> {
  if (move.change === 0) throw new Error('moveStock called with no change');
  const [row] = await tx
    .update(services)
    .set({ stock: sql`${services.stock} + ${move.change}` })
    .where(and(eq(services.id, move.serviceId), eq(services.kind, 'item'), move.change < 0 ? gte(services.stock, -move.change) : undefined))
    .returning({ stock: services.stock });
  if (!row) {
    const [item] = await tx.select({ name: services.name, stock: services.stock, kind: services.kind }).from(services).where(eq(services.id, move.serviceId));
    if (!item || item.kind !== 'item') throw new Error(`service ${move.serviceId} is not an item`);
    throw conflict('out_of_stock', item.stock === 0 ? `${item.name} is out of stock.` : `Only ${item.stock} ${item.name} left.`);
  }
  await tx.insert(stockMoves).values({
    serviceId: move.serviceId,
    change: move.change,
    reason: move.reason,
    jobId: move.jobId ?? null,
    after: row.stock,
    note: move.note ?? null,
    by: move.by,
  });
  return row.stock;
}

/** A voided job's items go back on the shelf. */
export async function returnJobStock(tx: DbOrTx, jobId: number, by: number) {
  const lines = await tx
    .select({ serviceId: jobLines.serviceId, quantity: jobLines.quantity })
    .from(jobLines)
    .innerJoin(services, eq(services.id, jobLines.serviceId))
    .where(and(eq(jobLines.jobId, jobId), eq(services.kind, 'item'), isNull(jobLines.removedAt)));
  for (const l of lines) await moveStock(tx, { serviceId: l.serviceId, change: l.quantity, reason: 'void', jobId, by });
}
