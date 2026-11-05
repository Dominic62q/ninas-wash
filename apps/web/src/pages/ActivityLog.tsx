import { useInfiniteQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { AUDIT_AREAS, auditFields, auditLabel, auditSummary, type AuditArea, type AuditEntryDto, type AuditPage } from '@niinas/shared';
import { Select } from '../components/Dropdown';
import { EmptyRow, FormError, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { clock, dayName, ymd } from '../lib/format';

const PAGE = 50;

const AREA_OPTIONS = [{ value: 'all', label: 'Everything' }, ...AUDIT_AREAS.map((a) => ({ value: a.value as string, label: a.label }))];

function Details({ entry }: { entry: AuditEntryDto }) {
  const before = auditFields(entry.before);
  const after = auditFields(entry.after);
  const sides = [
    { title: 'Before', rows: before },
    { title: 'After', rows: after },
  ].filter((s) => s.rows.length > 0);
  if (sides.length === 0 && !entry.note) return <p className="text-sm text-ink-3">Nothing more was written down.</p>;
  return (
    <div className="flex flex-col gap-3">
      {entry.note && (
        <p className="text-sm text-ink-2">
          <span className="text-ink-3">Reason or note: </span>
          {entry.note}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {sides.map((s) => (
          <dl key={s.title} className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="col-span-2 font-medium text-ink-2">{s.title}</dt>
            {s.rows.map(([k, v]) => (
              <Fragment key={k}>
                <dt className="capitalize text-ink-3">{k}</dt>
                <dd className="num min-w-0 break-words text-ink">{v}</dd>
              </Fragment>
            ))}
          </dl>
        ))}
      </div>
    </div>
  );
}

function Row({ entry }: { entry: AuditEntryDto }) {
  const [open, setOpen] = useState(false);
  const summary = auditSummary(entry);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left hover:bg-band max-lg:active:bg-band"
      >
        <span className="num w-11 flex-none pt-0.5 text-sm text-ink-3">{clock(entry.at)}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-ink">{auditLabel(entry.action)}</span>
          <span className="block text-sm text-ink-2">{entry.userName ?? 'Nobody signed in'}</span>
          {summary && <span className="mt-0.5 block truncate text-sm text-ink-3">{summary}</span>}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`mt-1 flex-none text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-line-2 bg-band px-4 py-3 lg:pl-[76px]">
          <Details entry={entry} />
        </div>
      )}
    </li>
  );
}

/** Who did what, and when. Read only: nothing here can be changed or removed. */
export function ActivityLog() {
  const [who, setWho] = useState('all');
  const [area, setArea] = useState<string>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const backwards = from !== '' && to !== '' && to < from;

  const log = useInfiniteQuery({
    queryKey: ['audit', who, area, from, to],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (pageParam) qs.set('before', String(pageParam));
      if (who !== 'all') qs.set('userId', who);
      if (area !== 'all') qs.set('area', area as AuditArea);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      return api<AuditPage>(`/audit?${qs}`);
    },
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: !backwards,
    placeholderData: (previous) => previous,
  });

  const pages = log.data?.pages ?? [];
  const entries = pages.flatMap((p) => p.entries);
  const people = [{ value: 'all', label: 'Everyone' }, ...(pages[0]?.people ?? []).map((p) => ({ value: String(p.id), label: p.name }))];
  const filtered = who !== 'all' || area !== 'all' || from !== '' || to !== '';

  let lastDay = '';
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3 lg:gap-4">
      <p className="text-sm text-ink-3">Every change, with who made it. It cannot be edited or deleted.</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Select label="Who" value={who} options={people} onChange={setWho} />
        <Select label="Area" value={area} options={AREA_OPTIONS} onChange={setArea} />
        <label className="flex flex-col gap-1">
          <span className="sr-only">From</span>
          <input className="input" type="date" aria-label="From" value={from} max={ymd(new Date())} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="sr-only">To</span>
          <input className="input" type="date" aria-label="To" value={to} max={ymd(new Date())} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {filtered && (
        <button
          type="button"
          className="-mt-1 w-fit cursor-pointer text-sm font-medium text-blue-d"
          onClick={() => {
            setWho('all');
            setArea('all');
            setFrom('');
            setTo('');
          }}
        >
          Clear filters
        </button>
      )}

      <FormError message={backwards ? 'The end date is before the start date' : log.isError ? errorMessage(log.error) : null} />

      <section aria-label="Activity" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        {log.isPending && !backwards ? (
          <SkeletonRows count={6} />
        ) : entries.length === 0 ? (
          <EmptyRow>{filtered ? 'Nothing matches those filters' : 'Nothing has happened yet'}</EmptyRow>
        ) : (
          <ul className="divide-y divide-line-2">
            {entries.map((e) => {
              const d = e.at.slice(0, 10);
              const heading = d !== lastDay;
              lastDay = d;
              return (
                <Fragment key={e.id}>
                  {heading && <li className="bg-band px-4 py-1.5 text-sm font-medium text-ink-2">{dayName(d)}</li>}
                  <Row entry={e} />
                </Fragment>
              );
            })}
          </ul>
        )}
      </section>

      {log.hasNextPage && (
        <button type="button" className="btn mx-auto px-6" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          {log.isFetchingNextPage ? 'Loading…' : 'Show older'}
        </button>
      )}
    </div>
  );
}
