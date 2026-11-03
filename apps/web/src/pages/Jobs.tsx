import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CAR_TYPES, formatGHS, type JobCard, type JobStatus } from '@niinas/shared';
import { Mark } from '../components/Mark';
import { Plate } from '../components/Plate';
import { STATUS_LABEL } from '../components/JobBits';
import { useJobSteps, type JobStep } from '../components/JobActions';
import { FormError, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { addDays, clock, shortDate, ymd } from '../lib/format';
import { JobsList } from './JobsList';

const COLUMNS = ['pending', 'in_progress', 'completed'] as const;
type Column = (typeof COLUMNS)[number];

const EMPTY: Record<Column, string> = { pending: 'No cars waiting', in_progress: 'No cars being washed', completed: 'Nothing finished yet' };

const CAR_LABEL: Record<(typeof CAR_TYPES)[number], string> = { saloon: 'Saloon', suv: 'SUV', pickup: 'Pickup', van: 'Van', other: 'Other' };

function useDebounced<T>(value: T, ms = 250): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

/** A wash taking longer than this many minutes is flagged on the board. */
const RUNNING_LONG_MIN = 45;

/** The current time, refreshed every 30 seconds so "minutes on the bay" stays live without a reload. */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** When the job reached its current step: today shows the time, older jobs show the date as well. */
function since(job: JobCard): string {
  const at = job.status === 'completed' ? job.completedAt : job.status === 'in_progress' ? job.startedAt : job.createdAt;
  if (!at) return '';
  const verb = job.status === 'completed' ? 'Done' : job.status === 'in_progress' ? 'Started' : 'Booked';
  const today = new Date(at).toDateString() === new Date().toDateString();
  return `${verb} ${today ? clock(at) : `${shortDate(at)}, ${clock(at)}`}`;
}

function PayMark({ total, paid }: { total: number; paid: number }) {
  if (total <= 0) return null;
  if (paid >= total) return <Mark tone="green">Paid</Mark>;
  return paid > 0 ? <Mark tone="blue">Part paid</Mark> : <Mark tone="amber">Unpaid</Mark>;
}

/** The slim phone button, and on a computer a compact outline one, so blue stays for New job and the selected states. */
const ACT = 'w-[84px] px-2 font-medium lg:h-9 lg:w-auto lg:px-4';
const QUIET = 'lg:border-line-strong lg:bg-surface lg:text-blue-d lg:hover:border-blue lg:hover:bg-blue-50';

function Card({ job, onAsk, now, index }: { job: JobCard; onAsk: (step: JobStep, id: number, plate: string) => void; now: number; index: number }) {
  const detail = `/jobs/${job.id}`;
  const minutes = job.status === 'in_progress' && job.startedAt ? Math.max(0, Math.floor((now - new Date(job.startedAt).getTime()) / 60_000)) : null;
  const long = minutes !== null && minutes >= RUNNING_LONG_MIN;
  const car = [job.makeModel, job.carType && CAR_LABEL[job.carType]].filter(Boolean).join(' · ');
  const { can } = useAuth();
  return (
    <li
      className="rise border border-line bg-surface transition-colors hover:border-line-strong max-lg:flex max-lg:items-center max-lg:gap-2 max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <Link to={detail} className="block min-w-0 flex-1 px-3 py-3 text-ink no-underline lg:px-4 lg:pb-3 lg:pt-4">
        <div className="flex items-center gap-3 lg:flex-wrap lg:items-baseline lg:gap-x-3 lg:gap-y-1">
          <p>
            <Plate plate={job.plate} />
          </p>
          <p className="num font-semibold text-ink max-lg:text-sm lg:ml-auto lg:text-base">{formatGHS(job.total)}</p>
        </div>
        <p className="hidden text-sm text-ink-2 lg:mt-2 lg:block">{[car, job.customerName].filter(Boolean).join(' · ') || 'Walk-in'}</p>
        <p className="mt-1 truncate text-sm font-medium text-ink lg:whitespace-normal">{job.services.join(', ')}</p>
        <p className="mt-1 text-xs text-ink-3 max-lg:truncate lg:mt-2">
          <span className={job.needsAttendant ? 'font-medium text-amber' : ''}>
            {job.needsAttendant
              ? job.attendants.length > 0
                ? `${job.attendants.join(', ')} · needs attendant`
                : 'No attendant'
              : job.attendants.join(', ')}
          </span>
          <span className="lg:mt-1 lg:block">
            <span className="lg:hidden">{job.attendants.length > 0 || job.needsAttendant ? ' · ' : ''}</span>
            {since(job)}
            {minutes !== null && (
              <span className={long ? 'num ml-2 font-medium text-amber' : 'num ml-2'}>
                · {minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`}
                {long && ' · running long'}
              </span>
            )}
          </span>
        </p>
      </Link>
      {/* On a phone the action is a slim fixed-width button so the car's details keep the room; labels shrink to one word. On a computer it is a footer under the details. */}
      <div className="flex shrink-0 gap-2 pr-3 lg:items-center lg:justify-between lg:border-t lg:border-line-2 lg:px-4 lg:py-3">
        <span className="max-lg:hidden">{(job.status === 'completed' || job.paid > 0) && <PayMark total={job.total} paid={job.paid} />}</span>
        {job.status === 'pending' &&
          (job.needsAttendant ? (
            <Link to={detail} className={`btn no-underline ${ACT}`}>
              Assign
            </Link>
          ) : (
            <button type="button" className={`btn btn-primary ${ACT} ${QUIET}`} onClick={() => onAsk('start', job.id, job.plate)}>
              <span className="lg:hidden">Start</span>
              <span className="max-lg:hidden">Start wash</span>
            </button>
          ))}
        {job.status === 'in_progress' && (
          <button type="button" className={`btn btn-primary whitespace-nowrap ${ACT} ${QUIET}`} onClick={() => onAsk('complete', job.id, job.plate)}>
            <span className="lg:hidden">Done</span>
            <span className="max-lg:hidden">Mark complete</span>
          </button>
        )}
        {job.status === 'completed' &&
          (job.total > job.paid ? (
            can('payment.record') ? (
              <Link to={`${detail}?pay=1`} className={`btn btn-primary whitespace-nowrap no-underline ${ACT} ${QUIET}`}>
                <span className="lg:hidden">Pay</span>
                <span className="max-lg:hidden">Take payment</span>
              </Link>
            ) : (
              <p className="w-[84px] py-2 text-center text-sm font-medium text-amber lg:w-auto lg:py-0">Owes</p>
            )
          ) : can('job.dispatch') ? (
            <button type="button" className={`btn btn-primary ${ACT} ${QUIET}`} onClick={() => onAsk('dispatch', job.id, job.plate)}>
              Dispatch
            </button>
          ) : (
            <p className="w-[84px] py-2 text-center text-sm font-medium text-green lg:w-auto lg:py-0">Ready</p>
          ))}
      </div>
    </li>
  );
}

const CHEVRON = (flip: boolean) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={flip ? 'rotate-180' : ''}>
    <path d="m15 5-7 7 7 7" />
  </svg>
);

/** Step through days with the arrows, or tap the date to pick one. No date means today plus anything unfinished. */
function DayBar({ day, onChange }: { day: string; onChange: (day: string) => void }) {
  const today = ymd(new Date());
  const current = day || today;
  const pick = (d: string) => onChange(!d || d >= today ? '' : d);
  const shift = (n: number) => pick(ymd(addDays(new Date(`${current}T00:00:00Z`), n)));
  const label = !day
    ? 'Today'
    : day === ymd(addDays(new Date(), -1))
      ? 'Yesterday'
      : new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (
    <div className="flex items-center gap-2 lg:max-w-[360px]">
      <button type="button" className="btn h-10 w-10 px-0" aria-label="Previous day" onClick={() => shift(-1)}>
        {CHEVRON(false)}
      </button>
      <label className="btn relative h-10 flex-1 cursor-pointer text-sm font-medium">
        {label}
        <input
          type="date"
          aria-label="Pick a day"
          value={current}
          max={today}
          onChange={(e) => pick(e.target.value)}
          onClick={(e) => e.currentTarget.showPicker?.()}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <button type="button" className="btn h-10 w-10 px-0" aria-label="Next day" disabled={!day} onClick={() => shift(1)}>
        {CHEVRON(true)}
      </button>
    </div>
  );
}

function Board({ search, day, onDay }: { search: string; day: string; onDay: (day: string) => void }) {
  const [chosen, setChosen] = useState<Column | null>(null);

  const board = useQuery({
    queryKey: ['jobs', 'board', search, day],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (search) qs.set('q', search);
      if (day) qs.set('date', day);
      return api<{ jobs: JobCard[] }>(`/jobs/board${qs.size ? `?${qs}` : ''}`);
    },
    refetchInterval: 15_000, // other phones and computers add jobs too
    placeholderData: (previous) => previous,
  });

  const steps = useJobSteps();

  const now = useNow();
  const jobs = board.data?.jobs ?? [];
  const byStatus = (s: JobStatus) => jobs.filter((j) => j.status === s);
  const emptyText = (c: Column) => (search ? 'Nothing matches' : day ? 'No jobs that day' : EMPTY[c]);
  // Open on the column that has cars in it unless the person has picked one.
  const tab: Column = chosen ?? (day ? (['in_progress', 'pending', 'completed'] as const) : (['in_progress', 'pending'] as const)).find((c) => byStatus(c).length > 0) ?? 'in_progress';

  return (
    <>
      <FormError message={board.isError ? errorMessage(board.error) : null} />

      <DayBar day={day} onChange={onDay} />

      <div role="tablist" aria-label="Job status" className="flex gap-0.5 rounded-[10px] bg-line-2 p-0.5 lg:max-w-[480px]">
        {COLUMNS.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            id={`tab-${c}`}
            aria-selected={tab === c}
            aria-controls="board-panel"
            onClick={() => setChosen(c)}
            className={`flex min-h-9 flex-1 cursor-pointer items-center justify-center rounded-lg px-2 py-1.5 text-sm font-medium transition-colors ${tab === c ? 'bg-surface text-navy shadow-card' : 'text-ink-2'}`}
          >
            {STATUS_LABEL[c]} <span className="num ml-1">{byStatus(c).length}</span>
          </button>
        ))}
      </div>

      {board.isPending && (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <li key={i} className="skeleton h-40 border border-line max-lg:rounded-[14px] max-lg:border-0" />
          ))}
        </ul>
      )}

      <section id="board-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {byStatus(tab).length === 0 && board.isSuccess ? (
          <p className="border border-dashed border-line px-4 py-8 text-center text-sm text-ink-3 max-lg:rounded-[14px]">{emptyText(tab)}</p>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] items-start gap-2 sm:grid-cols-2 lg:gap-4 xl:grid-cols-3">
            {byStatus(tab).map((job, i) => (
              <Card key={job.id} job={job} index={i} now={now} onAsk={steps.ask} />
            ))}
          </ul>
        )}
      </section>
      {steps.dialog}
    </>
  );
}

const VIEWS = [
  { value: 'board', label: 'Board' },
  { value: 'list', label: 'List' },
] as const;

export function Jobs() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'list' ? 'list' : 'board';
  const [q, setQ] = useState('');
  const search = useDebounced(q.trim());
  const rawDay = params.get('day') ?? '';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) && rawDay < ymd(new Date()) ? rawDay : '';

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input min-w-0 flex-1 sm:max-w-[320px] sm:flex-none lg:h-10 lg:text-sm"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Plate or customer"
          aria-label="Search jobs"
          autoComplete="off"
        />
        <div role="radiogroup" aria-label="View" className="order-last flex w-full gap-0.5 rounded-[10px] bg-line-2 p-0.5 lg:order-none lg:ml-auto lg:w-[200px]">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="radio"
              aria-checked={view === v.value}
              onClick={() => setParams(v.value === 'list' ? { view: 'list' } : {}, { replace: true })}
              className={`h-9 flex-1 cursor-pointer rounded-lg px-3 text-sm font-medium transition-colors ${view === v.value ? 'bg-surface text-navy shadow-card' : 'text-ink-2'}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <Link to="/jobs/new" className="btn btn-primary shrink-0 px-4 font-medium no-underline max-lg:hidden lg:h-10">
          New job
        </Link>
      </div>

      {view === 'list' ? <JobsList search={search} /> : <Board search={search} day={day} onDay={(d) => setParams(d ? { day: d } : {}, { replace: true })} />}
    </>
  );
}
