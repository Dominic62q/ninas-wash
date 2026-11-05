import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { REPORT_MAX_DAYS, reportQuery, type ReportDto } from '@niinas/shared';
import { HttpError } from '../lib/errors.js';
import { takingsBetween } from '../lib/methods.js';
import { dayOf } from '../lib/dayLock.js';

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/** How the business did over a period. Owner only. Takings are cash-basis: money when it was received, not when the car was washed. */
export const reportRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: app.requirePermission('report.view') }, async (req): Promise<ReportDto> => {
    const parsed = reportQuery.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'bad_range', parsed.error.issues[0]?.message ?? 'Pick a start and end date.');
    const { from, to } = parsed.data;
    const days = daysBetween(from, to);
    if (days > REPORT_MAX_DAYS) throw new HttpError(400, 'range_too_long', `Pick a period of at most ${REPORT_MAX_DAYS} days.`);

    const lo = `${from}T00:00:00Z`;
    const hi = new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString();
    const q = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => (await app.db.execute<T>(query)).rows;

    const payRows = await q<{ day: string; drawer: number; other: number }>(sql`
      select to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
             coalesce(sum(p.amount) filter (where m.in_drawer), 0)::int as drawer,
             coalesce(sum(p.amount) filter (where not m.in_drawer), 0)::int as other
      from payments p
      join payment_methods m on m.id = p.method_id
      where p.voided_at is null and p.created_at >= ${lo}::timestamptz and p.created_at < ${hi}::timestamptz
      group by 1`);
    const byDay: ReportDto['byDay'] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10);
      const r = payRows.find((p) => p.day === d);
      byDay.push({ day: d, drawer: r?.drawer ?? 0, other: r?.other ?? 0, total: (r?.drawer ?? 0) + (r?.other ?? 0) });
    }
    const takings = await takingsBetween(app.db, new Date(lo), new Date(hi));

    const [jobRow] = await q<{ count: number; sales: number; net: number; owing_count: number; owing_amount: number }>(sql`
      select count(*)::int as count,
             coalesce(sum(t.total), 0)::int as sales,
             coalesce(sum(greatest(t.total - t.discount, 0)), 0)::int as net,
             count(*) filter (where t.finished and greatest(t.total - t.discount, 0) > t.paid)::int as owing_count,
             coalesce(sum(greatest(t.total - t.discount, 0) - t.paid) filter (where t.finished and greatest(t.total - t.discount, 0) > t.paid), 0)::int as owing_amount
      from (
        select j.discount,
               j.status in ('completed', 'dispatched') as finished,
               coalesce((select sum(price_at_sale) from job_lines where job_id = j.id), 0) as total,
               coalesce((select sum(amount) from payments where job_id = j.id and voided_at is null), 0) as paid
        from jobs j
        where j.voided_at is null and j.created_at >= ${lo}::timestamptz and j.created_at < ${hi}::timestamptz
      ) t`);
    const count = jobRow?.count ?? 0;
    const sales = jobRow?.sales ?? 0;
    const net = jobRow?.net ?? 0;

    const byService = await q<{ name: string; count: number; sales: number }>(sql`
      select s.name, count(*)::int as count, coalesce(sum(l.price_at_sale), 0)::int as sales
      from job_lines l
      join jobs j on j.id = l.job_id
      join services s on s.id = l.service_id
      where j.voided_at is null and j.created_at >= ${lo}::timestamptz and j.created_at < ${hi}::timestamptz
      group by s.id, s.name
      order by sales desc, s.name`);

    const byAttendant = await q<{ name: string; cars: number; earned: number }>(sql`
      select a.name, count(distinct l.job_id)::int as cars, coalesce(sum(c.amount), 0)::int as earned
      from commissions c
      join job_line_attendants la on la.id = c.line_attendant_id
      join job_lines l on l.id = la.job_line_id
      join attendants a on a.id = la.attendant_id
      where c.status = 'earned' and c.created_at >= ${lo}::timestamptz and c.created_at < ${hi}::timestamptz
      group by a.id, a.name
      order by earned desc, a.name`);

    const spentRows = await q<{ category: string; drawer: number; other: number; count: number; no_receipt: number }>(sql`
      select e.category,
             coalesce(sum(e.amount) filter (where m.in_drawer), 0)::int as drawer,
             coalesce(sum(e.amount) filter (where not m.in_drawer), 0)::int as other,
             count(*)::int as count,
             count(*) filter (where e.receipt_file is null or btrim(e.receipt_file) = '')::int as no_receipt
      from expenses e
      join payment_methods m on m.id = e.method_id
      where e.voided_at is null and e.spent_on >= ${from}::date and e.spent_on <= ${to}::date
      group by e.category`);
    const expenses = {
      total: spentRows.reduce((s, r) => s + r.drawer + r.other, 0),
      drawer: spentRows.reduce((s, r) => s + r.drawer, 0),
      other: spentRows.reduce((s, r) => s + r.other, 0),
      withoutReceipt: spentRows.reduce((s, r) => s + r.no_receipt, 0),
      byCategory: spentRows
        .map((r) => ({ category: r.category, amount: r.drawer + r.other, count: r.count }))
        .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
    };

    const [earnedRow] = await q<{ n: number }>(sql`
      select coalesce(sum(amount), 0)::int as n from commissions
      where status = 'earned' and created_at >= ${lo}::timestamptz and created_at < ${hi}::timestamptz`);
    const [paidRow] = await q<{ n: number }>(sql`
      select coalesce(sum(amount), 0)::int as n from commission_payouts
      where voided_at is null and created_at >= ${lo}::timestamptz and created_at < ${hi}::timestamptz`);
    const commission = { earned: earnedRow?.n ?? 0, paidOut: paidRow?.n ?? 0 };

    const [tipRow] = await q<{ held: number; direct: number }>(sql`
      select coalesce(sum(amount) filter (where kind = 'held'), 0)::int as held,
             coalesce(sum(amount) filter (where kind = 'direct'), 0)::int as direct
      from tips
      where voided_at is null and created_at >= ${lo}::timestamptz and created_at < ${hi}::timestamptz`);

    const closes = await q<{ day: string; difference: number }>(sql`
      select to_char(day, 'YYYY-MM-DD') as day, difference from daily_closes
      where status = 'closed' and day >= ${from}::date and day <= ${to}::date
      order by day desc`);
    // Past days only: today is still being worked on.
    const notClosed = await q<{ day: string }>(sql`
      select to_char(d, 'YYYY-MM-DD') as day
      from generate_series(${from}::date, least(${to}::date, ${dayOf()}::date - 1), interval '1 day') d
      where not exists (select 1 from daily_closes c where c.day = d::date and c.status = 'closed')
        and (
          exists (select 1 from payments p where p.voided_at is null and p.created_at >= d and p.created_at < d + interval '1 day')
          or exists (select 1 from expenses e where e.voided_at is null and e.spent_on = d::date)
        )
      order by d desc`);

    return {
      from,
      to,
      days,
      takings,
      byDay,
      jobs: {
        count,
        sales,
        discounts: sales - net,
        net,
        average: count > 0 ? Math.round(net / count) : 0,
        owing: { count: jobRow?.owing_count ?? 0, amount: jobRow?.owing_amount ?? 0 },
      },
      byService,
      byAttendant,
      expenses,
      commission,
      tips: { held: tipRow?.held ?? 0, direct: tipRow?.direct ?? 0 },
      cash: {
        closedDays: closes.length,
        balanced: closes.filter((c) => c.difference === 0).length,
        short: closes.filter((c) => c.difference < 0).length,
        over: closes.filter((c) => c.difference > 0).length,
        differences: closes.filter((c) => c.difference !== 0).map((c) => ({ day: c.day, difference: c.difference })),
        notClosed: notClosed.map((r) => r.day),
      },
      net: takings.total - expenses.total - commission.earned,
    };
  });
};
