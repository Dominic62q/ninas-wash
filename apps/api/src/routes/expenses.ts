import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { EXPENSE_BACKDATE_DAYS, MAX_RECEIPT_BYTES, MAX_RECEIPT_PHOTOS, expenseInput, reasonInput, type ExpenseDto, type ExpensesOverview } from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { dailyCloses, expenseCategories, expenseReceipts, expenses, paymentMethods, users } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { assertDayOpen, dayOf } from '../lib/dayLock.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import { activeMethod, drawerSplit } from '../lib/methods.js';
import { idParams } from '../lib/params.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const listQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  limit: z.coerce.number().int().min(1).max(300).default(150),
});

const voider = alias(users, 'voider');

/** What the bytes really are, whatever the sender claimed. Only photos get through. */
function imageType(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Counts as having a receipt when it has a number or at least one photo. */
export const noReceipt = sql`(${expenses.receiptFile} is null or btrim(${expenses.receiptFile}) = '') and not exists (select 1 from expense_receipts r where r.expense_id = ${expenses.id})`;

async function selectExpenses(db: DbOrTx, where: ReturnType<typeof and>, limit: number): Promise<ExpenseDto[]> {
  const rows = await db
    .select({ e: expenses, by: users.name, voidedBy: voider.name, method: paymentMethods.name })
    .from(expenses)
    .innerJoin(users, eq(users.id, expenses.enteredBy))
    .innerJoin(paymentMethods, eq(paymentMethods.id, expenses.methodId))
    .leftJoin(voider, eq(voider.id, expenses.voidedBy))
    .where(where)
    .orderBy(desc(expenses.spentOn), desc(expenses.id))
    .limit(limit);
  const photoRows = rows.length
    ? await db
        .select({ id: expenseReceipts.id, expenseId: expenseReceipts.expenseId })
        .from(expenseReceipts)
        .where(inArray(expenseReceipts.expenseId, rows.map((r) => r.e.id)))
        .orderBy(asc(expenseReceipts.id))
    : [];
  const photos = new Map<number, number[]>();
  for (const p of photoRows) photos.set(p.expenseId, [...(photos.get(p.expenseId) ?? []), p.id]);
  return rows.map(({ e, by, voidedBy, method }) => ({
    id: e.id,
    category: e.category,
    amount: e.amount,
    methodId: e.methodId,
    method,
    spentOn: e.spentOn,
    receipt: e.receiptFile,
    photos: photos.get(e.id) ?? [],
    note: e.note,
    by,
    at: e.createdAt.toISOString(),
    voided: e.voidedAt ? { at: e.voidedAt.toISOString(), by: voidedBy ?? 'Someone', reason: e.voidReason ?? '' } : null,
  }));
}

/** Money the business spent. Written down when it happens, voided (never deleted) when it was wrong. */
export const expenseRoutes: FastifyPluginAsync = async (app) => {
  const record = { preHandler: app.requirePermission('expense.create') };

  // Receipt photos arrive as the raw image, already shrunk by the phone. Nothing else is accepted on this route.
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: MAX_RECEIPT_BYTES }, (_req, body, done) => done(null, body));

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
        ...drawerSplit(expenses.amount, paymentMethods.inDrawer),
        noReceipt: sql<number>`count(*) filter (where ${noReceipt})::int`,
      })
      .from(expenses)
      .innerJoin(paymentMethods, eq(paymentMethods.id, expenses.methodId))
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
      drawerSum: totals?.drawer ?? 0,
      otherSum: totals?.other ?? 0,
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
      const method = await activeMethod(tx, input.methodId);
      const [category] = await tx.select().from(expenseCategories).where(sql`lower(${expenseCategories.name}) = lower(${input.category})`);
      if (!category) throw new HttpError(400, 'bad_category', 'Pick one of the categories in the list.');
      if (!category.active) throw new HttpError(400, 'category_off', `${category.name} is switched off. Pick another category.`);
      if (category.needsNote && !input.note) throw new HttpError(400, 'note_needed', 'Say what it was for.');
      const [row] = await tx
        .insert(expenses)
        .values({
          category: category.name,
          amount: input.amount,
          methodId: method.id,
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
        after: { category: category.name, amount: input.amount, method: method.name, spentOn, receipt: input.receipt },
        ip: req.ip,
      });
      return { id: row!.id, created: true };
    });
    const [expense] = await selectExpenses(app.db, eq(expenses.id, result.id), 1);
    return reply.status(result.created ? 201 : 200).send({ expense });
  });

  // A photo of the paper receipt. Photos are added, never replaced, so a blurry one can be followed by a better one.
  app.post('/:id/receipt', { ...record, bodyLimit: MAX_RECEIPT_BYTES }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, 'bad_photo', 'Send the photo as an image.');
    const type = imageType(bytes);
    if (!type) throw new HttpError(400, 'bad_photo', 'That is not a photo. Use a JPEG, PNG or WebP picture.');

    const photo = await app.db.transaction(async (tx) => {
      const [expense] = await tx.select().from(expenses).where(eq(expenses.id, id)).for('update');
      if (!expense) throw notFound('That expense');
      if (expense.voidedAt) throw conflict('voided', 'That expense was voided, so it cannot take a photo.');
      const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(expenseReceipts).where(eq(expenseReceipts.expenseId, id))) as [{ n: number }];
      if (n >= MAX_RECEIPT_PHOTOS) throw conflict('too_many_photos', `An expense can carry ${MAX_RECEIPT_PHOTOS} photos.`);
      const [row] = await tx
        .insert(expenseReceipts)
        .values({ expenseId: id, contentType: type, size: bytes.length, data: bytes, uploadedBy: req.user!.id })
        .returning({ id: expenseReceipts.id });
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'expense.receipt',
        recordTable: 'expenses',
        recordId: id,
        after: { photo: row!.id, size: bytes.length },
        ip: req.ip,
      });
      return row!;
    });
    const [expense] = await selectExpenses(app.db, eq(expenses.id, id), 1);
    return reply.status(201).send({ photo: photo.id, expense });
  });

  app.get('/photos/:photoId', record, async (req, reply) => {
    const { photoId } = z.object({ photoId: z.coerce.number().int().positive() }).parse(req.params);
    const [photo] = await app.db.select().from(expenseReceipts).where(eq(expenseReceipts.id, photoId));
    if (!photo) throw notFound('That photo');
    return reply
      .header('content-type', photo.contentType)
      .header('cache-control', 'private, max-age=86400, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(photo.data);
  });

  // A wrong expense is voided with a reason and entered again. It is never edited or deleted.
  app.post('/:id/void', { preHandler: app.requirePermission('expense.void') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { reason } = reasonInput.parse(req.body);

    await app.db.transaction(async (tx) => {
      const [expense] = await tx.select().from(expenses).where(eq(expenses.id, id)).for('update');
      if (!expense) throw notFound('That expense');
      const [method] = await tx.select({ name: paymentMethods.name }).from(paymentMethods).where(eq(paymentMethods.id, expense.methodId));
      if (expense.voidedAt) throw conflict('already_voided', 'That expense was already voided.');
      await assertDayOpen(tx, expense.spentOn);
      await tx.update(expenses).set({ voidedAt: new Date(), voidedBy: req.user!.id, voidReason: reason }).where(eq(expenses.id, id));
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'expense.void',
        recordTable: 'expenses',
        recordId: id,
        before: { category: expense.category, amount: expense.amount, method: method?.name, spentOn: expense.spentOn },
        note: reason,
        ip: req.ip,
      });
    });
    const [expense] = await selectExpenses(app.db, eq(expenses.id, id), 1);
    return { expense };
  });
};
