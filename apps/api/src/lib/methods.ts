import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { MethodTotal, Takings } from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { paymentMethods, payments } from '../db/schema.js';
import { notFound, HttpError } from './errors.js';

/** Sums of an amount column, split by whether the method it was paid with passes through the cash drawer. Never null. */
export const drawerSplit = (amount: PgColumn, inDrawer: PgColumn) => ({
  drawer: sql<number>`coalesce(sum(${amount}) filter (where ${inDrawer}), 0)::int`,
  other: sql<number>`coalesce(sum(${amount}) filter (where not ${inDrawer}), 0)::int`,
});

/** Money received in a period, voided payments left out, split into the drawer and everything else, with each method's share. */
export async function takingsBetween(db: DbOrTx, start: Date, end: Date): Promise<Takings> {
  const rows = await db
    .select({
      methodId: paymentMethods.id,
      name: paymentMethods.name,
      inDrawer: paymentMethods.inDrawer,
      amount: sql<number>`coalesce(sum(${payments.amount}), 0)::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(payments)
    .innerJoin(paymentMethods, eq(paymentMethods.id, payments.methodId))
    .where(and(gte(payments.createdAt, start), lt(payments.createdAt, end), isNull(payments.voidedAt)))
    .groupBy(paymentMethods.id)
    .orderBy(desc(sql`sum(${payments.amount})`), paymentMethods.sortOrder);
  return toTakings(rows.map(({ n: _n, ...m }) => m), rows.reduce((s, r) => s + r.n, 0));
}

export function toTakings(byMethod: MethodTotal[], payments: number): Takings {
  const drawer = byMethod.filter((m) => m.inDrawer).reduce((s, m) => s + m.amount, 0);
  const other = byMethod.filter((m) => !m.inDrawer).reduce((s, m) => s + m.amount, 0);
  return { drawer, other, total: drawer + other, payments, byMethod };
}

/** The method a payment, expense or payout is being made with. It must exist and be switched on. */
export async function activeMethod(db: DbOrTx, id: number) {
  const [row] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, id));
  if (!row) throw notFound('That payment method');
  if (!row.active) throw new HttpError(400, 'method_off', `${row.name} is switched off. Pick another way of paying.`);
  return row;
}
