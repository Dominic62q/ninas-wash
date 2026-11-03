import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { EXPENSE_BACKDATE_DAYS, expenseInput, reasonInput, type ExpenseDto, type ExpensesOverview } from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { dailyCloses, expenses, users } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { assertDayOpen, dayOf } from '../lib/dayLock.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import { idParams } from '../lib/params.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const listQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  limit: z.coerce.number().int().min(1).max(300).default(150),
});

const voider = alias(users, 'voider');

async function selectExpenses(db: DbOrTx, where: ReturnType<typeof and>, limit: number): Promise<ExpenseDto[]> {
  const rows = await db
    .select({ e: expenses, by: users.name, voidedBy: voider.name })
    .from(expenses)
    .innerJoin(users, eq(users.id, expenses.enteredBy))
    .leftJoin(voider, eq(voider.id, expenses.voidedBy))
    .where(where)
    .orderBy(desc(expenses.spentOn), desc(expenses.id))
    .limit(limit);
  return rows.map(({ e, by, voidedBy }) => ({
    id: e.id,
    category: e.category,
    amount: e.amount,
    method: e.method,
    spentOn: e.spentOn,
    receipt: e.receiptFile,
    note: e.note,
    by,
    at: e.createdAt.toISOString(),
    voided: e.voidedAt ? { at: e.voidedAt.toISOString(), by: voidedBy ?? 'Someone', reason: e.voidReason ?? '' } : null,
  }));
}

/** Money the business spent. Written down when it happens, voided (never deleted) when it was wrong. */
export const expenseRoutes: FastifyPluginAsync = async (app) => {
  const record = { preHandler: app.requirePermission('expense.create') };

  app.get('/', record, async (req): Promise<ExpensesOverview> => {
    const q = listQuery.parse(req.query);
    const today = dayOf();
    const to = q.to ?? today;
    const from = q.from ?? dayOf(new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000));
    if (to < from) throw new HttpError(400, 'bad_dates', 'The end date is before the start date.');

    const inRange = and(gte(expenses.spentOn, from), lte(expenses.spentOn, to));
    const list = await selectExpenses(app.db, inRange, q.limit);
    const [totals] = await app.db
      .select({
        sum: sql<number>`coalesce(sum(${expenses.amount}), 0)::int`,
        cash: sql<number>`coalesce(sum(${expenses.amount}) filter (where ${expenses.method} = 'cash'), 0)::int`,
        momo: sql<number>`coalesce(sum(${expenses.amount}) filter (where ${expenses.method} = 'momo'), 0)::int`,
        noReceipt: sql<number>`count(*) filter (where ${expenses.receiptFile} is null)::int`,
      })
      .from(expenses)
      .where(and(inRange, isNull(expenses.voidedAt)));
    const closed = await app.db
      .select({ day: dailyCloses.day })
      .from(dailyCloses)
      .where(and(gte(dailyCloses.day, from), lte(dailyCloses.day, to), eq(dailyCloses.status, 'closed')))
      .orderBy(asc(dailyCloses.day));
    return {
      from,
      to,
      expenses: list,
      sum: totals?.sum ?? 0,
      cashSum: totals?.cash ?? 0,
      momoSum: totals?.momo ?? 0,
      withoutReceipt: totals?.noReceipt ?? 0,
      closedDays: closed.map((c) => c.day),
    };
  });

  app.post('/', record, async (req, reply) => {
    const input = expenseInput.parse(req.body);
    const today = dayOf();
    const spentOn = input.spentOn ?? today;
    if (spentOn > today) throw new HttpError(400, 'bad_date', 'That day has not happened yet.');
    if (spentOn < dayOf(new Date(Date.now() - EXPENSE_BACKDATE_DAYS * 86_400_000))) {
      throw new HttpError(400, 'too_old', `Expenses can be written down up to ${EXPENSE_BACKDATE_DAYS} days late. Ask the owner for older ones.`);
    }

    const result = await app.db.transaction(async (tx) => {
      const [again] = await tx.select({ id: expenses.id }).from(expenses).where(eq(expenses.idemKey, input.idemKey));
      if (again) return { id: again.id, created: false };
      await assertDayOpen(tx, spentOn);
      const [row] = await tx
        .insert(expenses)
        .values({
          category: input.category,
          amount: input.amount,
          method: input.method,
          spentOn,
          receiptFile: input.receipt,
          note: input.note,
          enteredBy: req.user!.id,
          idemKey: input.idemKey,
        })
        .returning({ id: expenses.id });
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'expense.create',
        recordTable: 'expenses',
        recordId: row!.id,
        after: { category: input.category, amount: input.amount, method: input.method, spentOn, receipt: input.receipt },
        ip: req.ip,
      });
      return { id: row!.id, created: true };
    });
    const [expense] = await selectExpenses(app.db, eq(expenses.id, result.id), 1);
    return reply.status(result.created ? 201 : 200).send({ expense });
  });

  // A wrong expense is voided with a reason and entered again. It is never edited or deleted.
  app.post('/:id/void', { preHandler: app.requirePermission('expense.void') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { reason } = reasonInput.parse(req.body);

    await app.db.transaction(async (tx) => {
      const [expense] = await tx.select().from(expenses).where(eq(expenses.id, id)).for('update');
      if (!expense) throw notFound('That expense');
      if (expense.voidedAt) throw conflict('already_voided', 'That expense was already voided.');
      await assertDayOpen(tx, expense.spentOn);
      await tx.update(expenses).set({ voidedAt: new Date(), voidedBy: req.user!.id, voidReason: reason }).where(eq(expenses.id, id));
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'expense.void',
        recordTable: 'expenses',
        recordId: id,
        before: { category: expense.category, amount: expense.amount, method: expense.method, spentOn: expense.spentOn },
        note: reason,
        ip: req.ip,
      });
    });
    const [expense] = await selectExpenses(app.db, eq(expenses.id, id), 1);
    return { expense };
  });
};
