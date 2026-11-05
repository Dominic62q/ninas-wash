import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { can, type DashboardDto } from '@niinas/shared';
import { commissionPayouts, commissions, dailyCloses, expenses, jobs, tips } from '../db/schema.js';
import { dayOf } from '../lib/dayLock.js';
import { figures } from './dailyClose.js';

/** How far back a day that was never closed still counts as a problem. */
const UNCLOSED_LOOKBACK_DAYS = 7;

/** The home screen: today at a glance. Each person gets only the parts their role works with. */
export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: app.requireAuth }, async (req): Promise<DashboardDto> => {
    const { db } = app;
    const role = req.user!.permissions;
    const day = dayOf();
    const start = new Date(`${day}T00:00:00Z`);
    const end = new Date(start.getTime() + 86_400_000);
    const today = and(gte(jobs.createdAt, start), lt(jobs.createdAt, end), isNull(jobs.voidedAt));

    const f = await figures(db, day);

    const stages = await db
      .select({ status: jobs.status, n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(today)
      .groupBy(jobs.status);
    const at = (s: string) => stages.find((r) => r.status === s)?.n ?? 0;
    const cars = {
      waiting: at('pending'),
      washing: at('in_progress'),
      ready: at('completed'),
      dispatched: at('dispatched'),
      total: stages.reduce((sum, r) => sum + r.n, 0),
    };

    // Owing across every day: a car finished last week and not paid for is still money out there.
    const owed = await db.execute<{ count: number; amount: number }>(sql`
      select count(*)::int as count, coalesce(sum(t.total - t.paid), 0)::int as amount
      from (
        select greatest(coalesce((select sum(price_at_sale) from job_lines where job_id = j.id), 0) - j.discount, 0) as total,
               coalesce((select sum(amount) from payments where job_id = j.id and voided_at is null), 0) as paid
        from jobs j
        where j.voided_at is null and j.status in ('completed', 'dispatched')
      ) t
      where t.total > t.paid`);

    let close: DashboardDto['close'] = null;
    if (can(role, 'dailyclose.close')) {
      const [row] = await db.select().from(dailyCloses).where(eq(dailyCloses.day, day));
      // A cashier counts blind, so the difference only shows once the day is closed.
      const reveal = can(role, 'dailyclose.see_expected') || row?.status === 'closed';
      close = { status: row?.status ?? 'open', difference: row?.status === 'closed' && reveal ? row.difference : null };
    }

    let last7: DashboardDto['last7'] = null;
    if (can(role, 'dailyclose.see_expected')) {
      const rows = await db.execute<{ day: string; cash: number; momo: number }>(sql`
        select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
               coalesce(sum(amount) filter (where method = 'cash'), 0)::int as cash,
               coalesce(sum(amount) filter (where method = 'momo'), 0)::int as momo
        from payments
        where voided_at is null
          and created_at >= ${new Date(start.getTime() - 6 * 86_400_000).toISOString()}::timestamptz
          and created_at < ${end.toISOString()}::timestamptz
        group by 1`);
      last7 = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start.getTime() - (6 - i) * 86_400_000).toISOString().slice(0, 10);
        const r = rows.rows.find((x) => x.day === d);
        return { day: d, cash: r?.cash ?? 0, momo: r?.momo ?? 0, total: (r?.cash ?? 0) + (r?.momo ?? 0) };
      });
    }

    const services = (
      await db.execute<{ name: string; count: number; sales: number }>(sql`
        select s.name, count(*)::int as count, coalesce(sum(l.price_at_sale), 0)::int as sales
        from job_lines l
        join jobs j on j.id = l.job_id
        join services s on s.id = l.service_id
        where j.voided_at is null and j.created_at >= ${start.toISOString()}::timestamptz and j.created_at < ${end.toISOString()}::timestamptz
        group by s.id, s.name
        order by sales desc, s.name
        limit 6`)
    ).rows;

    const attendantRows = (
      await db.execute<{ name: string; cars: number }>(sql`
        select a.name, count(distinct l.job_id)::int as cars
        from job_line_attendants la
        join job_lines l on l.id = la.job_line_id
        join jobs j on j.id = l.job_id
        join attendants a on a.id = la.attendant_id
        where j.voided_at is null and j.created_at >= ${start.toISOString()}::timestamptz and j.created_at < ${end.toISOString()}::timestamptz
        group by a.id, a.name
        order by cars desc, a.name
        limit 6`)
    ).rows;

    let unclosedDays: string[] | null = null;
    if (can(role, 'dailyclose.see_expected')) {
      const rows = await db.execute<{ day: string }>(sql`
        select to_char(d, 'YYYY-MM-DD') as day
        from generate_series(${day}::date - ${sql.raw(String(UNCLOSED_LOOKBACK_DAYS))}, ${day}::date - 1, interval '1 day') d
        where not exists (select 1 from daily_closes c where c.day = d::date and c.status = 'closed')
          and (
            exists (select 1 from payments p where p.voided_at is null and p.created_at >= d and p.created_at < d + interval '1 day')
            or exists (select 1 from expenses e where e.voided_at is null and e.spent_on = d::date)
          )
        order by d desc`);
      unclosedDays = rows.rows.map((r) => r.day);
    }

    let spent: DashboardDto['expenses'] = null;
    if (can(role, 'expense.create')) {
      const [row] = await db
        .select({
          total: sql<number>`coalesce(sum(${expenses.amount}), 0)::int`,
          withoutReceipt: sql<number>`count(*) filter (where ${expenses.receiptFile} is null or btrim(${expenses.receiptFile}) = '')::int`,
        })
        .from(expenses)
        .where(and(eq(expenses.spentOn, day), isNull(expenses.voidedAt)));
      spent = { total: row?.total ?? 0, withoutReceipt: row?.withoutReceipt ?? 0 };
    }

    let heldTips: DashboardDto['heldTips'] = null;
    if (can(role, 'tip.record')) {
      const [row] = await db
        .select({ total: sql<number>`coalesce(sum(${tips.amount}), 0)::int`, attendants: sql<number>`count(distinct ${tips.attendantId})::int` })
        .from(tips)
        .where(and(eq(tips.kind, 'held'), isNull(tips.handoutId), isNull(tips.voidedAt)));
      heldTips = { total: row?.total ?? 0, attendants: row?.attendants ?? 0 };
    }

    let commissionOwed: number | null = null;
    if (can(role, 'commission.view')) {
      const [earned] = await db
        .select({ n: sql<number>`coalesce(sum(${commissions.amount}), 0)::int` })
        .from(commissions)
        .where(eq(commissions.status, 'earned'));
      const [paid] = await db
        .select({ n: sql<number>`coalesce(sum(${commissionPayouts.amount}), 0)::int` })
        .from(commissionPayouts)
        .where(isNull(commissionPayouts.voidedAt));
      commissionOwed = (earned?.n ?? 0) - (paid?.n ?? 0);
    }

    return {
      day,
      takings: f.takings,
      cars,
      owing: { count: owed.rows[0]?.count ?? 0, amount: owed.rows[0]?.amount ?? 0 },
      close,
      last7,
      services,
      attendants: attendantRows,
      unclosedDays,
      expenses: spent,
      heldTips,
      commissionOwed,
    };
  });
};
