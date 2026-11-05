import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { formatGHS, type DashboardDto } from '@niinas/shared';
import { Avatar } from '../components/Avatar';
import { BarList, CASH_COLOUR, DayColumns, Donut, Legend, MOMO_COLOUR, SERIES, SegmentBar, methodColour } from '../components/charts';
import { FormError, Pill, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dayName, plural } from '../lib/format';

const STAGES = [
  { key: 'waiting', label: 'Waiting', colour: '#d99a00' },
  { key: 'washing', label: 'Washing', colour: '#0068d8' },
  { key: 'ready', label: 'Ready', colour: '#0b7a43' },
  { key: 'dispatched', label: 'Gone', colour: '#9aa7bd' },
] as const;

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** Cards ease in one after another; `delay` is in milliseconds. */
function Card({ title, to, link, delay = 0, children }: { title: string; to?: string; link?: string; delay?: number; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="rise border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
        <h3 className="text-[13px] font-bold uppercase tracking-[0.06em] text-ink-3">{title}</h3>
        {to && link && (
          <Link to={to} className="text-sm font-semibold text-blue-d no-underline">
            {link} ›
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/** Today against yesterday, in words. Nothing is shown when there is nothing to compare. */
function Delta({ today, yesterday }: { today: number; yesterday: number }) {
  if (yesterday === 0) return <p className="text-sm text-ink-3">{today === 0 ? 'Nothing taken yet' : 'No takings yesterday to compare'}</p>;
  // Today is still going, so a drop against a full day is not bad news. Only say something good, or how far along it is.
  if (today > yesterday) {
    return (
      <p className="text-sm font-semibold text-green">
        ▲ Already above yesterday <span className="font-normal text-ink-3">({formatGHS(yesterday)})</span>
      </p>
    );
  }
  return (
    <p className="text-sm text-ink-3">
      {Math.round((today / yesterday) * 100)}% of yesterday so far ({formatGHS(yesterday)})
    </p>
  );
}

function Tile({ to, label, value, note, tone }: { to: string; label: string; value: ReactNode; note?: string; tone?: 'amber' }) {
  return (
    <Link to={to} className={`flex flex-col gap-0.5 px-4 py-3 text-ink no-underline hover:bg-band ${tone === 'amber' ? 'bg-amber-50 hover:bg-amber-50' : ''}`}>
      <span className="text-xs font-bold uppercase tracking-[0.06em] text-ink-3">{label}</span>
      <span className="num text-xl font-bold leading-tight">{value}</span>
      {note && <span className="truncate text-xs text-ink-3">{note}</span>}
    </Link>
  );
}

function drawer(close: NonNullable<DashboardDto['close']>): { value: ReactNode; note: string; tone?: 'amber' } {
  if (close.status === 'closed') {
    const d = close.difference;
    if (d === null || d === 0) return { value: <Pill tone="green">Closed</Pill>, note: d === 0 ? 'Balanced' : 'Counted' };
    return { value: <Pill tone="amber">Closed</Pill>, note: `${formatGHS(Math.abs(d))} ${d < 0 ? 'short' : 'over'}` };
  }
  if (close.status === 'reopened') return { value: <Pill tone="amber">Reopened</Pill>, note: 'Close it again', tone: 'amber' };
  return { value: <Pill tone="grey">Open</Pill>, note: 'Count when done' };
}

export function Dashboard() {
  const { user, can } = useAuth();
  const query = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardDto>('/dashboard'), refetchInterval: 30_000 });
  if (!user) return null;
  const d = query.data;

  const alerts: { key: string; to: string; text: string }[] = [];
  if (d) {
    if (d.unclosedDays && d.unclosedDays.length > 0) {
      alerts.push({
        key: 'unclosed',
        to: `/daily-close?day=${d.unclosedDays[0]}`,
        text: d.unclosedDays.length === 1 ? `${dayName(d.unclosedDays[0]!)} not closed` : `${d.unclosedDays.length} days not closed`,
      });
    }
    if (d.owing.count > 0) alerts.push({ key: 'owing', to: '/jobs', text: `${plural(d.owing.count, 'car')} owe ${formatGHS(d.owing.amount)}` });
    if (d.expenses && d.expenses.withoutReceipt > 0) alerts.push({ key: 'receipts', to: '/expenses', text: `${d.expenses.withoutReceipt} no receipt` });
  }

  const yesterday = d?.last7?.[5]?.total ?? null;
  const split = d ? d.takings.byMethod.map((m, i) => ({ label: m.name, value: m.amount, colour: methodColour(i) })) : [];
  const serviceTotal = d?.services.reduce((s, x) => s + x.sales, 0) ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-3 lg:gap-4">
      <div className="rise flex items-center gap-3 max-lg:pt-[max(0.25rem,env(safe-area-inset-top))]">
        <Link to="/me" aria-label={`${user.name}. Open your profile`} className="flex-none rounded-full lg:hidden">
          <Avatar name={user.name} size="lg" className="!h-10 !w-10 !text-sm" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink-3 lg:text-sm">{greeting()}</p>
          <h2 className="display truncate text-[19px] leading-tight text-navy lg:text-[28px]">{user.name.split(' ')[0]}</h2>
        </div>
        {can('job.create') && (
          <Link to="/jobs/new" className="btn btn-primary shrink-0 px-4 no-underline max-lg:hidden">
            New job
          </Link>
        )}
      </div>

      <FormError message={query.isError ? errorMessage(query.error) : null} />

      {!d ? (
        <div className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
          <SkeletonRows count={5} />
        </div>
      ) : (
        <>
          {alerts.length > 0 && (
            <ul aria-label="Needs attention" className="rise flex gap-2 overflow-x-auto max-lg:-mx-4 max-lg:px-4 lg:flex-wrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" style={{ animationDelay: '80ms' }}>
              {alerts.map((a) => (
                <li key={a.key} className="shrink-0">
                  <Link to={a.to} className="flex h-9 items-center gap-2 border border-amber/40 bg-amber-50 px-3 text-[13px] font-semibold text-ink no-underline hover:border-amber max-lg:h-[34px] max-lg:rounded-lg">
                    <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-[#d99a00]" />
                    {a.text}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <section
            aria-label="Takings today"
            className="rise border border-line bg-surface px-4 py-3.5 max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card"
            style={{ animationDelay: '160ms' }}
          >
            <p className="text-[13px] font-bold uppercase tracking-[0.06em] text-ink-3">Taken today · {plural(d.takings.payments, 'payment')}</p>
            <p className="display num mt-1 text-[30px] leading-none text-navy lg:text-[46px]">{formatGHS(d.takings.total)}</p>
            <div className="mt-1.5">{yesterday !== null ? <Delta today={d.takings.total} yesterday={yesterday} /> : null}</div>
            <div className="mt-3">
              <SegmentBar parts={split} delay={450} />
              <div className="mt-2">
                <Legend items={split.map((p) => ({ label: p.label, colour: p.colour, value: formatGHS(p.value) }))} />
              </div>
            </div>
          </section>

          {d.last7 && (
            <Card title="Last 7 days" to={can('report.view') ? '/reports' : undefined} link="Reports" delay={240}>
              <DayColumns days={d.last7} />
              <div className="border-t border-line-2 px-4 py-2">
                <Legend items={[{ label: 'In the drawer', colour: CASH_COLOUR }, { label: 'Not in the drawer', colour: MOMO_COLOUR }]} />
              </div>
            </Card>
          )}

          <div className="grid gap-3 lg:grid-cols-2 lg:gap-4">
            <Card title="Cars today" to="/jobs" link="Jobs" delay={320}>
              <div className="flex flex-col gap-3 px-4 py-3.5">
                <div className="flex items-baseline gap-2">
                  <span className="display num text-[28px] leading-none text-navy lg:text-[34px]">{d.cars.total}</span>
                  <span className="text-sm text-ink-3">{d.cars.total === 1 ? 'car' : 'cars'}</span>
                </div>
                <SegmentBar parts={STAGES.map((s) => ({ label: s.label, value: d.cars[s.key], colour: s.colour }))} delay={750} />
                <ul className="grid grid-cols-4 gap-2 text-center">
                  {STAGES.map((s) => (
                    <li key={s.key}>
                      <p className="num text-lg font-bold leading-none text-ink">{d.cars[s.key]}</p>
                      <p className="mt-1 flex items-center justify-center gap-1 text-xs text-ink-3">
                        <span aria-hidden className="inline-block h-2 w-2" style={{ background: s.colour }} />
                        {s.label}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>

            <Card title="Sold today" delay={400}>
              {d.services.length === 0 ? (
                <p className="px-4 py-8 text-center text-ink-3">No cars booked yet.</p>
              ) : (
                <div className="flex items-center gap-4 px-4 py-3.5">
                  <Donut
                    parts={d.services.map((s, i) => ({ label: s.name, value: s.sales, colour: SERIES[i % SERIES.length]! }))}
                    centre={
                      <span>
                        <span className="num block text-[13px] font-bold text-navy">{formatGHS(serviceTotal)}</span>
                        <span className="block text-[10px] text-ink-3">booked</span>
                      </span>
                    }
                  />
                  <ul className="min-w-0 flex-1 text-sm">
                    {d.services.map((s, i) => (
                      <li key={s.name} className="flex items-center gap-2 py-0.5">
                        <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0" style={{ background: SERIES[i % SERIES.length] }} />
                        <span className="min-w-0 flex-1 truncate text-ink">{s.name}</span>
                        <span className="num text-xs text-ink-3">×{s.count}</span>
                        <span className="num w-[4.5rem] text-right font-bold text-ink">{formatGHS(s.sales)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          </div>

          <div className="grid gap-3 lg:grid-cols-2 lg:gap-4">
            <Card title="Who washed today" delay={480}>
              <BarList empty="No cars assigned yet." format={(n) => plural(n, 'car')} colour="var(--series-navy)" rows={d.attendants.map((a) => ({ key: a.name, label: a.name, amount: a.cars }))} />
            </Card>

            <Card title="Money" delay={560}>
              <div className="grid grid-cols-2 divide-x divide-y divide-line-2 [&>*:nth-child(-n+2)]:border-t-0">
                {d.expenses && <Tile to="/expenses" label="Spent today" value={formatGHS(d.expenses.total)} note={d.expenses.withoutReceipt > 0 ? `${d.expenses.withoutReceipt} no receipt` : 'All have receipts'} />}
                {d.heldTips && <Tile to="/tips" label="Tips held" value={formatGHS(d.heldTips.total)} note={d.heldTips.total > 0 ? plural(d.heldTips.attendants, 'attendant') : 'Nothing held'} />}
                {d.commissionOwed !== null && <Tile to="/commissions" label="Commission owed" value={formatGHS(d.commissionOwed)} />}
                {d.close &&
                  (() => {
                    const c = drawer(d.close);
                    return <Tile to="/daily-close" label="Drawer" value={c.value} note={c.note} {...(c.tone ? { tone: c.tone } : {})} />;
                  })()}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
