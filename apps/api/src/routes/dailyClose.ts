import { and, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { can, closeInput, formatGHS, reasonInput, type DailyCloseHistory, type DailyCloseRow, type DaySummary, type Role } from '@niinas/shared';
import type { DbOrTx } from '../db/client.js';
import { commissionPayouts, dailyCloses, expenses, jobs, payments, tipHandouts, tips, users } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { dayOf, lockDayForClose } from '../lib/dayLock.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';

const dayParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');

const reopener = alias(users, 'reopener');

/** Money in a column, summed, for one method or for all. Never null. */
const total = (amount: PgColumn, method?: { col: PgColumn; is: 'cash' | 'momo' }): SQL<number> =>
  method
    ? sql<number>`coalesce(sum(${amount}) filter (where ${method.col} = ${method.is}), 0)::int`
    : sql<number>`coalesce(sum(${amount}), 0)::int`;

/** What went in and out of the drawer on a day. The same maths is used to show the day and to close it. */
export async function figures(db: DbOrTx, day: string) {
  const start = new Date(`${day}T00:00:00Z`);
  const end = new Date(start.getTime() + 86_400_000);
  const during = (col: PgColumn) => and(gte(col, start), lt(col, end));

  const [pay] = await db
    .select({
      cash: total(payments.amount, { col: payments.method, is: 'cash' }),
      momo: total(payments.amount, { col: payments.method, is: 'momo' }),
      n: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(and(during(payments.createdAt), isNull(payments.voidedAt)));

  // A held tip is cash the customer gave us to keep for the attendant, so it sits in the drawer until it is handed out.
  const [held] = await db
    .select({ amount: total(tips.amount) })
    .from(tips)
    .where(and(during(tips.createdAt), eq(tips.kind, 'held'), isNull(tips.voidedAt)));
  const [handouts] = await db.select({ amount: total(tipHandouts.amount) }).from(tipHandouts).where(during(tipHandouts.createdAt));

  const [spent] = await db
    .select({
      cash: total(expenses.amount, { col: expenses.method, is: 'cash' }),
      momo: total(expenses.amount, { col: expenses.method, is: 'momo' }),
    })
    .from(expenses)
    .where(and(eq(expenses.spentOn, day), isNull(expenses.voidedAt)));

  const [paid] = await db
    .select({
      cash: total(commissionPayouts.amount, { col: commissionPayouts.method, is: 'cash' }),
      momo: total(commissionPayouts.amount, { col: commissionPayouts.method, is: 'momo' }),
    })
    .from(commissionPayouts)
    .where(and(during(commissionPayouts.createdAt), isNull(commissionPayouts.voidedAt)));

  const owingResult = await db.execute<{ count: number; amount: number }>(sql`
    select count(*)::int as count, coalesce(sum(t.total - t.paid), 0)::int as amount
    from (
      select greatest(coalesce((select sum(price_at_sale) from job_lines where job_id = j.id), 0) - j.discount, 0) as total,
             coalesce((select sum(amount) from payments where job_id = j.id and voided_at is null), 0) as paid
      from jobs j
      where j.created_at >= ${start.toISOString()}::timestamptz and j.created_at < ${end.toISOString()}::timestamptz
        and j.voided_at is null and j.status in ('completed', 'dispatched')
    ) t
    where t.total > t.paid`);
  const owing = owingResult.rows[0];

  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(during(jobs.createdAt), isNull(jobs.voidedAt), inArray(jobs.status, ['pending', 'in_progress'])));

  const cash = {
    paymentsIn: pay?.cash ?? 0,
    heldTipsIn: held?.amount ?? 0,
    expensesOut: spent?.cash ?? 0,
    payoutsOut: paid?.cash ?? 0,
    handoutsOut: handouts?.amount ?? 0,
  };
  const expectedBeforeFloat = cash.paymentsIn + cash.heldTipsIn - cash.expensesOut - cash.payoutsOut - cash.handoutsOut;
  return {
    takings: { cash: pay?.cash ?? 0, momo: pay?.momo ?? 0, total: (pay?.cash ?? 0) + (pay?.momo ?? 0), payments: pay?.n ?? 0 },
    cash: { ...cash, expectedBeforeFloat },
    momoOut: { expenses: spent?.momo ?? 0, payouts: paid?.momo ?? 0 },
    unpaid: { count: owing?.count ?? 0, amount: owing?.amount ?? 0 },
    notFinished: open?.n ?? 0,
  };
}

const closeRows = async (db: DbOrTx, where?: ReturnType<typeof and>, limit = 1): Promise<DailyCloseRow[]> => {
  const rows = await db
    .select({ c: dailyCloses, closer: users.name, reopenedBy: reopener.name })
    .from(dailyCloses)
    .innerJoin(users, eq(users.id, dailyCloses.closedBy))
    .leftJoin(reopener, eq(reopener.id, dailyCloses.reopenedBy))
    .where(where)
    .orderBy(desc(dailyCloses.day))
    .limit(limit);
  return rows.map(({ c, closer, reopenedBy }) => ({
    day: c.day,
    status: c.status,
    openingFloat: c.openingFloat,
    expectedCash: c.expectedCash,
    countedCash: c.countedCash,
    difference: c.difference ?? c.countedCash - c.expectedCash,
    momoTotal: c.momoTotal,
    note: c.note,
    closedBy: closer,
    closedAt: c.closedAt.toISOString(),
    reopened: c.reopenedAt ? { at: c.reopenedAt.toISOString(), by: reopenedBy ?? 'Someone', reason: c.reopenReason ?? '' } : null,
  }));
};

export async function summaryFor(db: DbOrTx, day: string, role: Role): Promise<DaySummary> {
  const f = await figures(db, day);
  const [row] = await closeRows(db, eq(dailyCloses.day, day));
  const [before] = await db
    .select({ counted: dailyCloses.countedCash })
    .from(dailyCloses)
    .where(and(lt(dailyCloses.day, day), eq(dailyCloses.status, 'closed')))
    .orderBy(desc(dailyCloses.day))
    .limit(1);

  const locked = row?.status === 'closed';
  const sees = can(role, 'dailyclose.see_expected');
  return {
    day,
    isToday: day === dayOf(),
    // A cashier counts without being told what the drawer should hold. Once the day is closed, the answer is no secret.
    close: row && (sees || locked) ? row : null,
    locked,
    takings: f.takings,
    cash: sees || locked ? f.cash : null,
    momoOut: f.momoOut,
    unpaid: f.unpaid,
    notFinished: f.notFinished,
    suggestedFloat: before?.counted ?? null,
  };
}

/** The end-of-day cash-up: count the drawer, compare it with what it should hold, and lock the day. */
export const dailyCloseRoutes: FastifyPluginAsync = async (app) => {
  const close = { preHandler: app.requirePermission('dailyclose.close') };

  app.get('/', close, async (req) => {
    const { day } = z.object({ day: dayParam.optional() }).parse(req.query);
    const wanted = day ?? dayOf();
    if (wanted > dayOf()) throw new HttpError(400, 'bad_date', 'That day has not happened yet.');
    return { summary: await summaryFor(app.db, wanted, req.user!.role) };
  });

  app.get('/history', { preHandler: app.requirePermission('dailyclose.see_expected') }, async (): Promise<DailyCloseHistory> => {
    return { closes: await closeRows(app.db, undefined, 60) };
  });

  app.post('/', close, async (req, reply) => {
    const input = closeInput.parse(req.body);
    const today = dayOf();
    const day = input.day ?? today;
    if (day > today) throw new HttpError(400, 'bad_date', 'That day has not happened yet.');

    await app.db.transaction(async (tx) => {
      // Nobody can add money to the day while it is being counted.
      await lockDayForClose(tx, day);
      const [existing] = await tx.select().from(dailyCloses).where(eq(dailyCloses.day, day)).for('update');
      if (existing?.status === 'closed') throw conflict('already_closed', `${day} is already closed.`);

      const f = await figures(tx, day);
      const expected = input.openingFloat + f.cash.expectedBeforeFloat;
      const difference = input.countedCash - expected;
      if (difference !== 0 && !input.note) {
        const how = can(req.user!.role, 'dailyclose.see_expected')
          ? `The count is ${formatGHS(Math.abs(difference))} ${difference < 0 ? 'short' : 'over'}.`
          : 'The count is not what the drawer should hold.';
        throw new HttpError(400, 'note_needed', `${how} Count again, or say why in the note.`);
      }

      const values = {
        openingFloat: input.openingFloat,
        expectedCash: expected,
        countedCash: input.countedCash,
        momoTotal: f.takings.momo,
        note: input.note,
        status: 'closed' as const,
        closedBy: req.user!.id,
        closedAt: new Date(),
      };
      let id: number;
      if (existing) {
        await tx.update(dailyCloses).set(values).where(eq(dailyCloses.id, existing.id));
        id = existing.id;
      } else {
        const [row] = await tx.insert(dailyCloses).values({ day, ...values }).returning({ id: dailyCloses.id });
        id = row!.id;
      }
      await writeAudit(tx, {
        userId: req.user!.id,
        action: existing ? 'dailyclose.reclose' : 'dailyclose.close',
        recordTable: 'daily_closes',
        recordId: id,
        after: { day, openingFloat: input.openingFloat, expected, counted: input.countedCash, difference, momo: f.takings.momo },
        ...(input.note ? { note: input.note } : {}),
        ip: req.ip,
      });
    });
    return reply.status(201).send({ summary: await summaryFor(app.db, day, req.user!.role) });
  });

  // Only a manager or owner can open a closed day again, and has to say why. Closing it again replaces the count.
  app.post('/:day/reopen', { preHandler: app.requirePermission('dailyclose.reopen') }, async (req) => {
    const { day } = z.object({ day: dayParam }).parse(req.params);
    const { reason } = reasonInput.parse(req.body);

    await app.db.transaction(async (tx) => {
      const [row] = await tx.select().from(dailyCloses).where(eq(dailyCloses.day, day)).for('update');
      if (!row) throw notFound('That day');
      if (row.status !== 'closed') throw conflict('not_closed', `${day} is not closed.`);
      await tx
        .update(dailyCloses)
        .set({ status: 'reopened', reopenedAt: new Date(), reopenedBy: req.user!.id, reopenReason: reason })
        .where(eq(dailyCloses.id, row.id));
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'dailyclose.reopen',
        recordTable: 'daily_closes',
        recordId: row.id,
        before: { day, expected: row.expectedCash, counted: row.countedCash },
        note: reason,
        ip: req.ip,
      });
    });
    return { summary: await summaryFor(app.db, day, req.user!.role) };
  });
};
