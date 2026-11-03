import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatGHS, JOB_STATUSES, type JobListResult, type JobListRow } from '@niinas/shared';
import { Select } from '../components/Dropdown';
import { Plate } from '../components/Plate';
import { STATUS_LABEL } from '../components/JobBits';
import { Mark, type MarkTone } from '../components/Mark';
import { EmptyRow, FormError, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { addDays, clock, plural, ymd } from '../lib/format';

const RANGES = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Pick dates' },
] as const;
type Range = (typeof RANGES)[number]['value'];

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  ...JOB_STATUSES.map((s) => ({ value: s as string, label: STATUS_LABEL[s] })),
  { value: 'owing', label: 'Owing money' },
  { value: 'voided', label: 'Voided' },
];

const PAGE = 25;

function datesFor(range: Range, from: string, to: string): { from?: string; to?: string } {
  const now = new Date();
  switch (range) {
    case 'today':
      return { from: ymd(now), to: ymd(now) };
    case 'yesterday':
      return { from: ymd(addDays(now, -1)), to: ymd(addDays(now, -1)) };
    case 'week':
      return { from: ymd(addDays(now, -((now.getUTCDay() + 6) % 7))), to: ymd(now) }; // weeks start on Monday
    case 'month':
      return { from: ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to: ymd(now) };
    case 'custom':
      return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    default:
      return {};
  }
}

/** "Today", "Yesterday", or "Mon 27 Oct". */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === addDays(now, -1).toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** Attendants only get a column on a wide screen; on a narrower one the other columns keep their room. */
const COLS = 'lg:grid-cols-[48px_132px_minmax(0,1fr)_minmax(0,1fr)_148px_88px] xl:grid-cols-[56px_140px_minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)_176px_96px]';

/** Only finished jobs can owe: a car still being washed has simply not been paid for yet. */
const owed = (row: JobListRow) => (!row.voided && (row.status === 'completed' || row.status === 'dispatched') && row.paid < row.total ? row.total - row.paid : 0);

const STATUS_TONE: Record<JobListRow['status'], MarkTone> = { pending: 'amber', in_progress: 'blue', completed: 'green', dispatched: 'grey' };

/** `short` leaves the "Owes" amount out; the phone row shows it on its own line instead. */
function RowStatus({ row, short }: { row: JobListRow; short?: boolean }) {
  if (row.voided) return <Mark tone="grey">Voided</Mark>;
  const owes = owed(row);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <Mark tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Mark>
      {owes > 0 && !short && <span className="num text-xs font-medium text-amber">Owes {formatGHS(owes)}</span>}
    </span>
  );
}

function People({ row }: { row: JobListRow }) {
  if (row.needsAttendant) return <span className="font-medium text-amber">{row.attendants.length ? `${row.attendants.join(', ')} · needs attendant` : 'No attendant'}</span>;
  return <>{row.attendants.join(', ') || '—'}</>;
}

function ListRow({ row }: { row: JobListRow }) {
  const who = [row.makeModel, row.customerName].filter(Boolean).join(' · ') || 'Walk-in';
  return (
    <li className="border-b border-line-2 last:border-b-0">
      <Link to={`/jobs/${row.id}`} className={`grid grid-cols-[minmax(0,1fr)] gap-x-4 px-4 py-3 text-ink no-underline transition-colors hover:bg-band lg:items-center ${COLS}`}>
        {/* Phone: three short lines, one kind of thing on each. The customer and car are on the job itself. */}
        <div className="min-w-0 lg:hidden">
          <div className="flex items-center gap-2">
            <Plate plate={row.plate} size="sm" />
            <RowStatus row={row} short />
            <span className="num ml-auto shrink-0 font-semibold">{formatGHS(row.total)}</span>
          </div>
          <p className="mt-1 truncate text-sm font-medium text-ink">{row.services.join(', ')}</p>
          <p className="mt-0.5 flex items-baseline gap-2 text-xs text-ink-3">
            <span className="min-w-0 flex-1 truncate">
              <span className="num">{clock(row.createdAt)}</span> · <People row={row} />
            </span>
            {owed(row) > 0 && <span className="num shrink-0 font-medium text-amber">Owes {formatGHS(owed(row))}</span>}
          </p>
        </div>
        {/* Computer: one line per column. */}
        <span className="num hidden text-sm text-ink-2 lg:block">{clock(row.createdAt)}</span>
        <span className="hidden lg:block">
          <Plate plate={row.plate} size="sm" />
        </span>
        <span className="hidden truncate text-sm text-ink-2 lg:block">{who}</span>
        <span className="hidden truncate text-sm font-medium lg:block">{row.services.join(', ')}</span>
        <span className="hidden truncate text-sm text-ink-3 xl:block">
          <People row={row} />
        </span>
        <span className="hidden lg:block">
          <RowStatus row={row} />
        </span>
        <span className="num hidden text-right font-semibold lg:block">{formatGHS(row.total)}</span>
      </Link>
    </li>
  );
}

/** Every job, newest first, for any dates. */
export function JobsList({ search }: { search: string }) {
  const [params, setParams] = useSearchParams();
  const range = (RANGES.find((r) => r.value === params.get('range'))?.value ?? 'week') as Range;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const status = STATUS_OPTIONS.find((o) => o.value === params.get('status'))?.value ?? 'all';
  const [limit, setLimit] = useState(PAGE);

  const set = (changes: Record<string, string | null>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );

  const dates = datesFor(range, from, to);
  const backwards = !!dates.from && !!dates.to && dates.to < dates.from;
  const filterKey = `${dates.from ?? ''}|${dates.to ?? ''}|${status}|${search}`;
  useEffect(() => setLimit(PAGE), [filterKey]);

  const query = useQuery({
    queryKey: ['jobs', 'list', filterKey, limit],
    queryFn: () => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (dates.from) qs.set('from', dates.from);
      if (dates.to) qs.set('to', dates.to);
      if (status !== 'all') qs.set('status', status);
      if (search) qs.set('q', search);
      return api<JobListResult>(`/jobs?${qs}`);
    },
    enabled: !backwards,
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });

  const rows = query.data?.jobs ?? [];
  const total = query.data?.total ?? 0;

  return (
    <>
      <div role="radiogroup" aria-label="Dates" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:px-0">
        {RANGES.map((r) => (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={range === r.value}
            onClick={() => set({ range: r.value === 'week' ? null : r.value, ...(r.value === 'custom' ? {} : { from: null, to: null }) })}
            className={`btn h-9 shrink-0 px-3 text-sm font-medium lg:h-10 ${range === r.value ? 'border-blue bg-blue-50 text-blue-d' : ''}`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {range === 'custom' && (
        <div className="grid grid-cols-2 gap-3 lg:max-w-[420px]">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-2">From</span>
            <input className="input" type="date" value={from} max={ymd(new Date())} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-2">To</span>
            <input className="input" type="date" value={to} max={ymd(new Date())} onChange={(e) => set({ to: e.target.value })} />
          </label>
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="w-44 shrink-0">
          <Select label="Status" value={status} options={STATUS_OPTIONS} onChange={(v) => set({ status: v === 'all' ? null : v })} />
        </div>
        <p className="num ml-auto text-right text-sm text-ink-2" aria-live="polite">
          {query.data ? (
            <>
              <span className="font-medium text-ink">{plural(total, 'job')}</span>
              {status !== 'voided' && total > 0 && <> · {formatGHS(query.data.sum)}</>}
            </>
          ) : null}
        </p>
      </div>

      <FormError message={backwards ? 'The end date is before the start date.' : query.isError ? errorMessage(query.error) : null} />

      {query.isPending && !backwards ? (
        <div className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
          <SkeletonRows count={6} />
        </div>
      ) : (
        !backwards && (
          <div className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
            {rows.length === 0 ? (
              <EmptyRow>{search ? 'Nothing matches' : 'No jobs in this period'}</EmptyRow>
            ) : (
              <>
                <div className={`hidden gap-x-4 border-b border-line bg-band px-4 py-2 text-xs font-medium text-ink-3 lg:grid ${COLS}`} aria-hidden="true">
                  <span>Time</span>
                  <span>Plate</span>
                  <span>Customer</span>
                  <span>Services</span>
                  <span className="max-xl:hidden">Attendants</span>
                  <span>Status</span>
                  <span className="text-right">Total</span>
                </div>
                <ul>
                  {rows.map((row, i) => (
                    <Fragment key={row.id}>
                      {(i === 0 || dayLabel(rows[i - 1]!.createdAt) !== dayLabel(row.createdAt)) && (
                        <li className="border-b border-line bg-band px-4 py-2 text-xs font-medium text-ink-2" aria-hidden="true">
                          {dayLabel(row.createdAt)}
                        </li>
                      )}
                      <ListRow row={row} />
                    </Fragment>
                  ))}
                </ul>
              </>
            )}
          </div>
        )
      )}

      {rows.length > 0 && rows.length < total && (
        <button type="button" className="btn self-center px-6" disabled={query.isFetching} onClick={() => setLimit((n) => n + PAGE)}>
          {query.isFetching ? 'Loading' : `Show more (${rows.length} of ${total})`}
        </button>
      )}
    </>
  );
}
