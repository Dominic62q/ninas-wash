import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CAR_TYPES, formatGHS, type JobCard, type JobStatus } from '@niinas/shared';
import { Plate } from '../components/Plate';
import { STATUS_LABEL } from '../components/JobBits';
import { useJobSteps, type JobStep } from '../components/JobActions';
import { PayPill } from '../components/PaymentBits';
import { EmptyRow, FormError, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { addDays, clock, shortDate, ymd } from '../lib/format';
import { JobsList } from './JobsList';

const COLUMNS = ['pending', 'in_progress', 'completed'] as const;
type Column = (typeof COLUMNS)[number];

const EMPTY: Record<Column, string> = { pending: 'No cars waiting.', in_progress: 'No cars being washed.', completed: 'Nothing finished yet.' };

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

function Card({ job, onAsk, now, index }: { job: JobCard; onAsk: (step: JobStep, id: number, plate: string) => void; now: number; index: number }) {
  const detail = `/jobs/${job.id}`;
  const minutes = job.status === 'in_progress' && job.startedAt ? Math.max(0, Math.floor((now - new Date(job.startedAt).getTime()) / 60_000)) : null;
  const long = minutes !== null && minutes >= RUNNING_LONG_MIN;
  const car = [job.makeModel, job.carType && CAR_LABEL[job.carType]].filter(Boolean).join(' · ');
  const { can } = useAuth();
  return (
    <li
      className="rise border border-line bg-surface transition-shadow hover:shadow-[0_4px_14px_rgba(11,42,91,0.10)] max-lg:flex max-lg:items-center max-lg:gap-2 max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <Link to={detail} className="block min-w-0 flex-1 px-3 py-2.5 text-ink no-underline lg:px-4 lg:pb-2 lg:pt-3.5">
        <div className="flex items-center gap-2.5 lg:items-start lg:gap-3">
          <p className="lg:flex-1">
            <Plate plate={job.plate} />
          </p>
          {(job.status === 'completed' || job.paid > 0) && (
            <span className="max-lg:hidden">
              <PayPill total={job.total} paid={job.paid} />
            </span>
          )}
          <p className="num font-bold text-ink max-lg:text-sm lg:text-lg">{formatGHS(job.total)}</p>
        </div>
        <p className="hidden text-sm text-ink-2 lg:block">{[car, job.customerName].filter(Boolean).join(' · ') || 'Walk-in'}</p>
        <p className="mt-1 truncate text-sm font-semibold text-ink lg:mt-1.5 lg:whitespace-normal">{job.services.join(', ')}</p>
        <p className="mt-0.5 text-xs text-ink-3 max-lg:truncate lg:text-sm">
          <span className={job.needsAttendant ? 'font-bold text-amber' : ''}>
            {job.needsAttendant
              ? job.attendants.length > 0
                ? `${job.attendants.join(', ')} · needs attendant`
                : 'No attendant'
              : job.attendants.join(', ')}
          </span>
          <span className="lg:mt-1 lg:block lg:text-xs">
            <span className="lg:hidden">{job.attendants.length > 0 || job.needsAttendant ? ' · ' : ''}</span>
            {since(job)}
            {minutes !== null && (
              <span className={long ? 'ml-1.5 font-bold text-amber' : 'ml-1.5'}>
                · {minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`}
                {long && ' · running long'}
              </span>
            )}
          </span>
        </p>
      </Link>
      {/* On a phone the action is a slim fixed-width button so the car's details keep the room; labels shrink to one word. */}
      <div className="flex shrink-0 gap-2 pr-3 lg:px-4 lg:pb-3.5 lg:pr-4">
        {job.status === 'pending' &&
          (job.needsAttendant ? (
            <Link to={detail} className="btn w-[84px] px-2 no-underline lg:h-11 lg:min-w-[112px] lg:flex-1 lg:px-3">
              Assign
            </Link>
          ) : (
            <button type="button" className="btn btn-primary w-[84px] px-2 lg:h-11 lg:min-w-[112px] lg:flex-1 lg:px-3" onClick={() => onAsk('start', job.id, job.plate)}>
              <span className="lg:hidden">Start</span>
              <span className="max-lg:hidden">Start wash</span>
            </button>
          ))}
        {job.status === 'in_progress' && (
          <button type="button" className="btn btn-primary w-[84px] whitespace-nowrap px-2 lg:h-11 lg:min-w-[112px] lg:flex-1 lg:px-3" onClick={() => onAsk('complete', job.id, job.plate)}>
            <span className="lg:hidden">Done</span>
            <span className="max-lg:hidden">Mark complete</span>
          </button>
        )}
        {job.status === 'completed' &&
          (job.total > job.paid ? (
            can('payment.record') ? (
              <Link to={`${detail}?pay=1`} className="btn btn-primary w-[84px] whitespace-nowrap px-2 no-underline lg:h-11 lg:min-w-[112px] lg:flex-1 lg:px-3">
                <span className="lg:hidden">Pay</span>
                <span className="max-lg:hidden">Take payment</span>
              </Link>
            ) : (
              <p className="w-[84px] py-2 text-center text-sm font-semibold text-amber lg:min-w-[112px] lg:text-left">Owes</p>
            )
          ) : can('job.dispatch') ? (
            <button type="button" className="btn btn-primary w-[84px] px-2 lg:h-11 lg:min-w-[112px] lg:flex-1 lg:px-3" onClick={() => onAsk('dispatch', job.id, job.plate)}>
              Dispatch
            </button>
          ) : (
            <p className="w-[84px] py-2 text-center text-sm font-semibold text-green lg:min-w-[112px] lg:text-left">Ready</p>
          ))}
      </div>
    </li>
  );
}

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
    <div className="flex items-center gap-2 lg:max-w-[620px]">
      <button type="button" className="btn h-10 w-10 px-0 text-lg" aria-label="Previous day" onClick={() => shift(-1)}>
        ‹
      </button>
      <label className="btn relative h-10 flex-1 cursor-pointer text-sm">
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
      <button type="button" className="btn h-10 w-10 px-0 text-lg" aria-label="Next day" disabled={!day} onClick={() => shift(1)}>
        ›
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
  // On a phone, open on the column that has cars in it unless the person has picked one.
  const tab: Column = chosen ?? (day ? (['in_progress', 'pending', 'completed'] as const) : (['in_progress', 'pending'] as const)).find((c) => byStatus(c).length > 0) ?? 'in_progress';

  return (
    <>
      <FormError message={board.isError ? errorMessage(board.error) : null} />

      <DayBar day={day} onChange={onDay} />

      <div role="tablist" aria-label="Job status" className="flex border border-line bg-surface max-lg:gap-0.5 max-lg:rounded-[10px] max-lg:border-0 max-lg:bg-line-2 max-lg:p-[3px] lg:max-w-[620px]">
        {COLUMNS.map((c, i) => (
          <button
            key={c}
            type="button"
            role="tab"
            id={`tab-${c}`}
            aria-selected={tab === c}
            aria-controls="board-panel"
            onClick={() => setChosen(c)}
            className={`flex min-h-10 flex-1 cursor-pointer flex-col items-center justify-center px-2 py-1.5 max-lg:min-h-9 max-lg:rounded-lg max-lg:border-l-0 lg:min-h-12 lg:py-2 ${i > 0 ? 'border-l border-line' : ''} ${
              tab === c
                ? 'bg-blue-50 text-blue-d shadow-[inset_0_-3px_0_var(--color-blue)] max-lg:bg-surface max-lg:text-navy max-lg:shadow-[0_0_0_1px_var(--card-ring),0_1px_2px_rgba(11,42,91,0.08)]'
                : 'text-ink-2 hover:bg-band max-lg:hover:bg-transparent'
            }`}
          >
            <span className="text-sm font-bold">
              {STATUS_LABEL[c]} <span className="num">{byStatus(c).length}</span>
            </span>
          </button>
        ))}
      </div>

      {board.isPending && (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <li key={i} className="skeleton h-40 border border-line" />
          ))}
        </ul>
      )}

      <section id="board-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {byStatus(tab).length === 0 && board.isSuccess ? (
          <div className="border border-dashed border-line bg-band">
            <EmptyRow>{search ? 'Nothing matches.' : day ? 'No jobs that day.' : EMPTY[tab]}</EmptyRow>
          </div>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] items-start gap-2 sm:grid-cols-2 lg:gap-3 xl:grid-cols-3">
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
          className="input min-w-0 flex-1 sm:max-w-[320px] sm:flex-none"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search plate or customer"
          aria-label="Search jobs"
          autoComplete="off"
        />
        <div role="radiogroup" aria-label="View" className="order-last flex w-full max-lg:gap-0.5 max-lg:rounded-[10px] max-lg:bg-line-2 max-lg:p-[3px] lg:order-none lg:ml-auto lg:w-[200px]">
          {VIEWS.map((v, i) => (
            <button
              key={v.value}
              type="button"
              role="radio"
              aria-checked={view === v.value}
              onClick={() => setParams(v.value === 'list' ? { view: 'list' } : {}, { replace: true })}
              className={`h-10 flex-1 cursor-pointer border-[1.5px] px-3 text-sm font-bold max-lg:h-9 max-lg:rounded-lg max-lg:border-0 lg:h-11 ${i > 0 ? '-ml-[1.5px] max-lg:ml-0' : ''} ${
                view === v.value
                  ? 'z-10 border-blue bg-blue-50 text-blue-d max-lg:bg-surface max-lg:text-navy max-lg:shadow-[0_0_0_1px_var(--card-ring),0_1px_2px_rgba(11,42,91,0.08)]'
                  : 'border-line-strong bg-surface text-ink-2 max-lg:bg-transparent'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <Link to="/jobs/new" className="btn btn-primary shrink-0 px-4 no-underline max-lg:hidden">
          New job
        </Link>
      </div>

      {view === 'list' ? <JobsList search={search} /> : <Board search={search} day={day} onDay={(d) => setParams(d ? { day: d } : {}, { replace: true })} />}
    </>
  );
}
