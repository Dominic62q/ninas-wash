import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { formatGHS, type DailyCloseHistory, type DashboardDto, type DaySummary } from '@niinas/shared';
import { Icon } from '../components/Icon';
import { Pill } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dayName, plural, ymd } from '../lib/format';
import { moneyFor, navFor } from '../lib/nav';

/** The phone's Money tab: where the drawer stands, and a way into every money screen. */
export function Money() {
  const { can } = useAuth();
  const items = moneyFor(navFor(can));
  const today = ymd(new Date());

  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardDto>('/dashboard'), refetchInterval: 30_000 });
  const close = useQuery({
    queryKey: ['daily-close', today],
    queryFn: () => api<{ summary: DaySummary }>(`/daily-close?day=${today}`),
    enabled: can('dailyclose.close'),
    refetchInterval: 30_000,
  });
  const history = useQuery({
    queryKey: ['daily-close', 'history'],
    queryFn: () => api<DailyCloseHistory>('/daily-close/history'),
    enabled: can('dailyclose.see_expected'),
  });

  const d = dashboard.data;
  const s = close.data?.summary;
  // A cashier counts the drawer blind, so the server sends no sums until the day is closed.
  const cash = s?.cash ?? null;
  const expected = cash ? cash.expectedBeforeFloat + (s?.suggestedFloat ?? 0) : null;
  const lastClose = history.data?.closes.find((c) => c.status === 'closed');

  const value: Record<string, { text: string; note?: string } | undefined> = {
    '/expenses': d?.expenses ? { text: formatGHS(d.expenses.total), note: d.expenses.withoutReceipt > 0 ? `${d.expenses.withoutReceipt} no receipt` : 'All have receipts' } : undefined,
    '/tips': d?.heldTips ? { text: formatGHS(d.heldTips.total), note: d.heldTips.total > 0 ? `Held for ${plural(d.heldTips.attendants, 'attendant')}` : 'Nothing held' } : undefined,
    '/commissions': d && d.commissionOwed !== null ? { text: formatGHS(d.commissionOwed), note: 'Owed to attendants' } : undefined,
    '/daily-close': d?.close ? { text: d.close.status === 'closed' ? 'Closed' : d.close.status === 'reopened' ? 'Reopened' : 'Open', note: lastClose ? `Last closed ${dayName(lastClose.day)}` : undefined } : undefined,
  };

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3">
      {can('dailyclose.close') && (
        <section aria-label="The drawer" className="flex flex-col gap-3 rounded-[14px] bg-surface p-4 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">{expected !== null ? 'Should be in the drawer' : 'Today’s drawer'}</p>
            {s && (s.locked ? <Pill tone="green">Closed</Pill> : <Pill tone="grey">Not closed</Pill>)}
          </div>
          {expected !== null && cash ? (
            <>
              <p className="display num text-[30px] leading-none text-navy">{formatGHS(expected)}</p>
              <p className="text-[13px] text-ink-3">
                <span className="num">{formatGHS(cash.paymentsIn + cash.heldTipsIn)}</span> cash in, <span className="num">{formatGHS(cash.expensesOut + cash.payoutsOut + cash.handoutsOut)}</span> paid out
                {s?.suggestedFloat ? <>, <span className="num">{formatGHS(s.suggestedFloat)}</span> float</> : null}
              </p>
            </>
          ) : (
            <p className="text-[13px] text-ink-3">{s?.locked ? 'Today is closed.' : 'Count the cash at the end of the day and close.'}</p>
          )}
          <Link to="/daily-close" className="btn btn-primary h-[50px] text-[15.5px] no-underline">
            {s?.locked ? 'See today’s close' : 'Count the drawer and close'}
          </Link>
        </section>
      )}

      <ul className="overflow-hidden rounded-[14px] bg-surface shadow-card">
        {items.map((item) => {
          const v = value[item.path];
          return (
            <li key={item.path} className="border-t border-line first:border-t-0">
              <Link to={item.path} className="flex min-h-14 items-center gap-3 px-3.5 py-2.5 text-ink no-underline active:bg-band">
                <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-blue-50 text-navy">
                  <Icon name={item.icon} size={18} />
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block font-semibold">{item.label}</span>
                  {v?.note && <span className="block truncate text-xs text-ink-3">{v.note}</span>}
                </span>
                {v && <span className="num font-bold">{v.text}</span>}
                <span aria-hidden="true" className="text-ink-3">
                  ›
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
