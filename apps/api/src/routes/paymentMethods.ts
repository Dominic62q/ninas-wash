import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { payMethodInput, updatePayMethodInput, type PayMethodDto } from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { paymentMethods } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { changedFields, isUniqueViolation } from '../lib/helpers.js';
import { idParams } from '../lib/params.js';

type Row = typeof paymentMethods.$inferSelect;

const usedBy = (id: number) => sql<boolean>`(
  exists (select 1 from payments where method_id = ${id})
  or exists (select 1 from expenses where method_id = ${id})
  or exists (select 1 from commission_payouts where method_id = ${id}))`;

const toDto = (row: Row, used: boolean): PayMethodDto => ({
  id: row.id,
  name: row.name,
  inDrawer: row.inDrawer,
  requiresReference: row.requiresReference,
  active: row.active,
  used,
});

async function list(db: DbOrTx): Promise<PayMethodDto[]> {
  const rows = await db
    .select({
      m: paymentMethods,
      used: sql<boolean>`(
        exists (select 1 from payments where method_id = ${paymentMethods.id})
        or exists (select 1 from expenses where method_id = ${paymentMethods.id})
        or exists (select 1 from commission_payouts where method_id = ${paymentMethods.id}))`,
    })
    .from(paymentMethods)
    .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.id));
  return rows.map(({ m, used }) => toDto(m, used));
}

/** Ways of paying. Everyone who takes money needs the list; only people who can change settings may change it. */
export const paymentMethodRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: app.requireAuth }, async () => ({ methods: await list(app.db) }));

  app.post('/', { preHandler: app.requirePermission('settings.manage') }, async (req, reply) => {
    const input = payMethodInput.parse(req.body);
    try {
      const row = await app.db.transaction(async (tx) => {
        const [last] = await tx.select({ n: sql<number>`coalesce(max(${paymentMethods.sortOrder}), 0)::int` }).from(paymentMethods);
        const [created] = await tx
          .insert(paymentMethods)
          .values({ ...input, sortOrder: (last?.n ?? 0) + 1 })
          .returning();
        await writeAudit(tx, { userId: req.user!.id, action: 'paymethod.create', recordTable: 'payment_methods', recordId: created!.id, after: input, ip: req.ip });
        return created!;
      });
      return reply.status(201).send({ method: toDto(row, false) });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('duplicate_method', 'There is already a payment method with that name.');
      throw e;
    }
  });

  app.patch('/:id', { preHandler: app.requirePermission('settings.manage') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const patch = updatePayMethodInput.parse(req.body);
    try {
      await app.db.transaction(async (tx) => {
        const [current] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, id)).for('update');
        if (!current) throw notFound('That payment method');
        const diff = changedFields({ name: current.name, inDrawer: current.inDrawer, requiresReference: current.requiresReference, active: current.active }, patch);
        if (!diff) return;

        // Old days were counted with the drawer rule the method had then, so it cannot change once money has moved through it.
        if ('inDrawer' in diff.after) {
          const [{ used }] = (await tx.select({ used: usedBy(id) }).from(paymentMethods).where(eq(paymentMethods.id, id))) as [{ used: boolean }];
          if (used) throw conflict('method_in_use', `${current.name} has already been used, so whether it goes through the cash drawer cannot change. Add a new method instead.`);
        }
        if (diff.after.active === false) {
          const [others] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(paymentMethods)
            .where(sql`${paymentMethods.active} and ${paymentMethods.id} <> ${id}`);
          if ((others?.n ?? 0) === 0) throw conflict('last_method', 'At least one payment method has to stay switched on.');
        }

        await tx.update(paymentMethods).set({ ...diff.after, updatedAt: new Date() }).where(eq(paymentMethods.id, id));
        await writeAudit(tx, { userId: req.user!.id, action: 'paymethod.update', recordTable: 'payment_methods', recordId: id, before: { name: current.name, ...diff.before }, after: diff.after, ip: req.ip });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('duplicate_method', 'There is already a payment method with that name.');
      throw e;
    }
    return { method: (await list(app.db)).find((m) => m.id === id)! };
  });
};
