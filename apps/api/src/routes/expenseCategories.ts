import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { expenseCategoryInput, updateExpenseCategoryInput, type ExpenseCategoryDto } from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { expenseCategories } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { changedFields, isUniqueViolation } from '../lib/helpers.js';
import { idParams } from '../lib/params.js';

async function list(db: DbOrTx): Promise<ExpenseCategoryDto[]> {
  const rows = await db
    .select({
      c: expenseCategories,
      used: sql<boolean>`exists (select 1 from expenses where lower(expenses.category) = lower(${expenseCategories.name}))`,
    })
    .from(expenseCategories)
    .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id));
  return rows.map(({ c, used }) => ({ id: c.id, name: c.name, needsNote: c.needsNote, active: c.active, used }));
}

/** The kinds of expense. Anyone who can record an expense reads them; the owner decides what is on the list. */
export const expenseCategoryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: app.requireAuth }, async () => ({ categories: await list(app.db) }));

  app.post('/', { preHandler: app.requirePermission('settings.manage') }, async (req, reply) => {
    const input = expenseCategoryInput.parse(req.body);
    try {
      const id = await app.db.transaction(async (tx) => {
        const [last] = await tx.select({ n: sql<number>`coalesce(max(${expenseCategories.sortOrder}), 0)::int` }).from(expenseCategories);
        // New ones go after the starting ones, but ahead of the switched-off leftovers that were kept for history.
        const [created] = await tx
          .insert(expenseCategories)
          .values({ ...input, sortOrder: Math.min((last?.n ?? 0) + 1, 99) })
          .returning({ id: expenseCategories.id });
        await writeAudit(tx, { userId: req.user!.id, action: 'category.create', recordTable: 'expense_categories', recordId: created!.id, after: input, ip: req.ip });
        return created!.id;
      });
      return reply.status(201).send({ category: (await list(app.db)).find((c) => c.id === id)! });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('duplicate_category', 'There is already a category with that name.');
      throw e;
    }
  });

  app.patch('/:id', { preHandler: app.requirePermission('settings.manage') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const patch = updateExpenseCategoryInput.parse(req.body);
    await app.db.transaction(async (tx) => {
      const [current] = await tx.select().from(expenseCategories).where(eq(expenseCategories.id, id)).for('update');
      if (!current) throw notFound('That category');
      const diff = changedFields({ needsNote: current.needsNote, active: current.active }, patch);
      if (!diff) return;
      if (diff.after.active === false) {
        const [others] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(expenseCategories)
          .where(sql`${expenseCategories.active} and ${expenseCategories.id} <> ${id}`);
        if ((others?.n ?? 0) === 0) throw conflict('last_category', 'At least one category has to stay switched on.');
      }
      await tx.update(expenseCategories).set({ ...diff.after, updatedAt: new Date() }).where(eq(expenseCategories.id, id));
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'category.update',
        recordTable: 'expense_categories',
        recordId: id,
        before: { name: current.name, ...diff.before },
        after: diff.after,
        ip: req.ip,
      });
    });
    return { category: (await list(app.db)).find((c) => c.id === id)! };
  });
};
