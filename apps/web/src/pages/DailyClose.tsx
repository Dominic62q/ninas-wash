import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { closeInput, formatGHS, parseGHS, reasonInput, type DailyCloseHistory, type DailyCloseRow, type DaySummary } from '@niinas/shared';
import { Select } from '../components/Dropdown';
import { useToast } from '../components/Toast';
import { ConfirmPanel, EmptyRow, Field, FormError, Panel, Pill, SkeletonRows, TakingsCard, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { addDays, dayName, plural, shortDateTime, ymd } from '../lib/format';

type Cash = NonNullable<DaySummary['cash']>;

/** Balanced, short or over, in words and colour. */
function Difference({ amount }: { amount: number }) {
  if (amount === 0) return <Pill tone="green">Balanced</Pill>;
  return amount < 0 ? <Pill tone="amber">{formatGHS(-amount)} short</Pill> : <Pill tone="blue">{formatGHS(amount)} over</Pill>;
}

function Line({ label, amount, sign, strong }: { label: string; amount: number; sign?: '+' | '−'; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 px-4 py-1.5 text-sm ${strong ? 'border-t border-line bg-band font-medium text-ink' : 'text-ink-2'}`}>
      <span>
        {sign && <span className="mr-1.5 inline-block w-3 text-center text-ink-3">{sign}</span>}
        {label}
      </span>
      <span className="num font-semibold text-ink">{formatGHS(amount)}</span>
    </div>
  );
}

/** What went in and out of the drawer, short: sales in, one line for everything paid out, tap it for the detail. */
function Breakdown({ cash }: { cash: Cash }) {
  const out = cash.expensesOut + cash.payoutsOut + cash.handoutsOut;
  const parts = [
    ['Expenses', cash.expensesOut],
    ['Commission paid', cash.payoutsOut],
    ['Tips handed over', cash.handoutsOut],
  ] as const;
  return (
    <div className="py-1">
      <Line label="Cash sales" amount={cash.paymentsIn} sign="+" />
      {cash.heldTipsIn > 0 && <Line label="Tips held for attendants" amount={cash.heldTipsIn} sign="+" />}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 px-4 py-1.5 text-sm text-ink-2 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="mr-1.5 inline-block w-3 text-center text-ink-3">−</span>
            Paid out <span className="text-xs text-blue-d group-open:hidden">details</span>
          </span>
          <span className="num font-semibold text-ink">{formatGHS(out)}</span>
        </summary>
        <div className="pb-1 pl-7 text-xs text-ink-3">
          {parts.filter(([, n]) => n > 0).map(([label, n]) => (
            <p key={label} className="flex justify-between px-4 py-0.5">
              <span>{label}</span>
              <span className="num">{formatGHS(n)}</span>
            </p>
          ))}
          {out === 0 && <p className="px-4 py-0.5">Nothing paid out</p>}
        </div>
      </details>
    </div>
  );
}

function ReopenPanel({ day, open, onClose }: { day: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api(`/daily-close/${day}/reopen`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['daily-close'] });
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
      toast.success(`${dayName(day)} is open again`);
      setReason('');
      onClose();
    },
  });

  function submit() {
    const parsed = reasonInput.safeParse({ reason });
    if (!parsed.success) return setError('Say why the day is being reopened');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={open} onClose={onClose} title="Reopen this day">
      <p className="text-ink-2">
        Money can be added to and voided on <strong className="text-ink">{dayName(day)}</strong> again. Count and close it afterwards.
      </p>
      <Field label="Reason" error={error ?? undefined}>
        <input className="input" value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} maxLength={200} autoComplete="off" aria-invalid={!!error} placeholder="An expense was left out" />
      </Field>
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <button type="button" className="btn border-red bg-red text-white" disabled={save.isPending} onClick={submit}>
        {save.isPending ? 'Reopening…' : 'Reopen day'}
      </button>
    </Panel>
  );
}

const NOTES = [200, 100, 50, 20, 10, 5, 2, 1] as const;

/** Phone: count the drawer note by note. The total goes into "Cash counted". */
function NoteCounter({ onTotal }: { onTotal: (cedis: number) => void }) {
  const [counts, setCounts] = useState<Record<number, number>>({});
  const touched = useRef(false);
  const total = NOTES.reduce((sum, n) => sum + n * (counts[n] ?? 0), 0);

  // Only after a note is counted, so opening the form does not fill in 0.00.
  useEffect(() => {
    if (touched.current) onTotal(total);
  }, [total]); // eslint-disable-line react-hooks/exhaustive-deps

  function change(n: number, by: number) {
    touched.current = true;
    setCounts((c) => ({ ...c, [n]: Math.max(0, (c[n] ?? 0) + by) }));
  }

  return (
    <details className="rounded-[10px] bg-band lg:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-sm font-medium text-navy [&::-webkit-details-marker]:hidden">
        Count the notes
        <span className="num font-semibold text-ink-2">{total > 0 ? formatGHS(total * 100) : ''}</span>
      </summary>
      <ul className="flex flex-col px-3 pb-2">
        {NOTES.map((n) => (
          <li key={n} className="flex items-center justify-between py-1">
            <span className="num text-sm font-semibold text-ink">GH₵ {n}</span>
            <span className="flex items-center gap-1">
              <button type="button" aria-label={`One less ${n} cedi note`} onClick={() => change(n, -1)} className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg bg-surface text-lg font-medium text-navy active:scale-95">
                −
              </button>
              <span className="num w-9 text-center text-sm font-semibold" aria-live="polite">
                {counts[n] ?? 0}
              </span>
              <button type="button" aria-label={`One more ${n} cedi note`} onClick={() => change(n, 1)} className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg bg-surface text-lg font-medium text-navy active:scale-95">
                +
              </button>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A small "i" that opens its explanation underneath when tapped, so the labels can stay short. */
function InfoButton({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      onClick={onToggle}
      className={`-m-1.5 grid size-9 flex-none cursor-pointer place-items-center rounded-full transition-colors ${open ? 'text-blue-d' : 'text-ink-3 hover:text-ink-2'}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
    </button>
  );
}

/** Count the drawer and close the day. For a manager the sums are on top of the form, for a cashier only the form. */
function CloseForm({ summary }: { summary: DaySummary }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [floatText, setFloatText] = useState(() => (summary.suggestedFloat !== null ? (summary.suggestedFloat / 100).toFixed(2) : ''));
  const [countText, setCountText] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [tip, setTip] = useState<'start' | 'count' | null>(null);
  const toggleTip = (t: 'start' | 'count') => setTip((cur) => (cur === t ? null : t));

  const float = parseGHS(floatText);
  const counted = parseGHS(countText);
  const expected = summary.cash && float !== null ? float + summary.cash.expectedBeforeFloat : null;
  const difference = expected !== null && counted !== null ? counted - expected : null;

  const save = useMutation({
    mutationFn: (body: unknown) => api<{ summary: DaySummary }>('/daily-close', { method: 'POST', body }),
    onSuccess: async ({ summary: done }) => {
      await queryClient.invalidateQueries({ queryKey: ['daily-close'] });
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
      const diff = done.close?.difference ?? 0;
      toast.success(diff === 0 ? `${dayName(done.day)} closed. The drawer balances.` : `${dayName(done.day)} closed with ${formatGHS(Math.abs(diff))} ${diff < 0 ? 'short' : 'over'}`);
      setConfirming(false);
    },
    onError: (e) => {
      setError(errorMessage(e));
      setConfirming(false);
    },
  });

  function review() {
    if (float === null) return setError('Enter the cash that was in the drawer at the start. Use 0 if it was empty.');
    if (counted === null) return setError('Enter the cash you counted, like 250 or 250.50');
    const parsed = closeInput.safeParse({ day: summary.day, openingFloat: float, countedCash: counted, note });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the details');
    if (difference !== null && difference !== 0 && !parsed.data.note) {
      return setError(`The count is ${formatGHS(Math.abs(difference))} ${difference < 0 ? 'short' : 'over'}. Count again, or say why in the note.`);
    }
    setError(null);
    setConfirming(true);
  }

  return (
    <section aria-label="Close the day" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
      <h3 className="border-b border-line px-4 py-2.5 text-sm font-medium text-ink-2">The drawer</h3>
      {summary.cash && <Breakdown cash={summary.cash} />}
      <div className="flex flex-col gap-3 border-t border-line p-4 first:border-t-0">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex h-5 items-center justify-between gap-1">
              <label htmlFor="float-start" className="text-sm font-medium text-ink-2">Cash at start (GH₵)</label>
              <InfoButton label="What is cash at start?" open={tip === 'start'} onToggle={() => toggleTip('start')} />
            </div>
            <input id="float-start" className="input" inputMode="decimal" value={floatText} onChange={(e) => { setFloatText(e.target.value); setError(null); }} autoComplete="off" placeholder="0.00" />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex h-5 items-center justify-between gap-1">
              <label htmlFor="float-count" className="text-sm font-medium text-ink-2">Cash counted (GH₵)</label>
              <InfoButton label="What is cash counted?" open={tip === 'count'} onToggle={() => toggleTip('count')} />
            </div>
            <input id="float-count" className="input" inputMode="decimal" value={countText} onChange={(e) => { setCountText(e.target.value); setError(null); }} autoComplete="off" placeholder="0.00" />
          </div>
        </div>
        {tip && (
          <p role="note" className="bg-band px-3 py-2.5 text-sm text-ink-2 max-lg:rounded-[10px]">
            {tip === 'start'
              ? `The cash that was in the drawer when the day began, like change. ${summary.suggestedFloat !== null ? 'It is filled in from the last close, so change it only if you started with a different amount. ' : ''}Use 0 if it was empty.`
              : 'Count all the cash in the drawer right now, notes and coins. Leave out MoMo and anything paid another way.'}
          </p>
        )}
        <NoteCounter
          onTotal={(cedis) => {
            setCountText(cedis.toFixed(2));
            setError(null);
          }}
        />
        {expected !== null && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
            Should hold <strong className="num text-ink">{formatGHS(expected)}</strong>
            {difference !== null && <Difference amount={difference} />}
          </p>
        )}
        {difference !== 0 && (
          <Field label="Note" hint={difference === null ? undefined : 'Say why the count is off'}>
            <input className="input" value={note} onChange={(e) => { setNote(e.target.value); setError(null); }} maxLength={300} autoComplete="off" placeholder="Optional if it balances" />
          </Field>
        )}
        <FormError message={error} />
        <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={review}>
          Close {summary.isToday ? 'today' : dayName(summary.day)}
        </button>
      </div>
      <ConfirmPanel
        open={confirming}
        title={`Close ${summary.isToday ? 'today' : dayName(summary.day)}?`}
        message={`${formatGHS(counted ?? 0)} counted. Nothing can be added to or voided on the day until ${can('dailyclose.reopen') ? 'you reopen it' : 'a manager reopens it'}.`}
        confirmLabel="Close the day"
        busy={save.isPending}
        onConfirm={() => save.mutate({ day: summary.day, openingFloat: float, countedCash: counted, note: note.trim() || null })}
        onClose={() => setConfirming(false)}
      />
    </section>
  );
}

function ClosedResult({ close, summary }: { close: DailyCloseRow; summary: DaySummary }) {
  const { can } = useAuth();
  const [reopening, setReopening] = useState(false);
  return (
    <section aria-label="Result" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h3 className="flex-1 text-sm font-medium text-ink-2">Closed</h3>
        <Difference amount={close.difference} />
      </div>
      <div className="py-1">
        {summary.cash && <Breakdown cash={summary.cash} />}
        <Line label="Cash at start" amount={close.openingFloat} />
        <Line label="Should hold" amount={close.expectedCash} />
        <Line label="Counted" amount={close.countedCash} strong />
      </div>
      <div className="flex flex-col gap-0.5 px-4 py-2.5 text-xs text-ink-3">
        {close.note && <p className="text-sm text-ink">“{close.note}”</p>}
        <p>
          Closed by {close.closedBy}, {shortDateTime(close.closedAt)}
          {close.reopened ? ` · reopened once by ${close.reopened.by}: ${close.reopened.reason}` : ''}
        </p>
      </div>
      {can('dailyclose.reopen') && (
        <div className="border-t border-line px-4 py-2.5">
          <button type="button" className="btn h-9 px-3 text-sm" onClick={() => setReopening(true)}>
            Reopen this day
          </button>
        </div>
      )}
      <ReopenPanel day={summary.day} open={reopening} onClose={() => setReopening(false)} />
    </section>
  );
}

export function DailyClose() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = ymd(new Date());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day')! : today;

  const query = useQuery({
    queryKey: ['daily-close', day],
    queryFn: () => api<{ summary: DaySummary }>(`/daily-close?day=${day}`),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });
  const history = useQuery({
    queryKey: ['daily-close', 'history'],
    queryFn: () => api<DailyCloseHistory>('/daily-close/history'),
    enabled: can('dailyclose.see_expected'),
  });

  const s = query.data?.summary;
  const options = Array.from({ length: 8 }, (_, i) => ymd(addDays(new Date(), -i)));
  if (!options.includes(day)) options.push(day);
  const closedSet = new Set((history.data?.closes ?? []).filter((c) => c.status === 'closed').map((c) => c.day));

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3 lg:gap-4">
      <div className="flex items-center gap-3">
        <div className="w-48 shrink-0">
          <Select
            label="Day"
            value={day}
            options={options.map((d) => ({ value: d, label: `${dayName(d)}${closedSet.has(d) ? ' · closed' : ''}` }))}
            onChange={(v) => setParams(v === today ? {} : { day: v }, { replace: true })}
          />
        </div>
        {s?.close?.status === 'reopened' && <Pill tone="amber">Reopened</Pill>}
      </div>

      <FormError message={query.isError ? errorMessage(query.error) : null} />

      {!s ? (
        <div className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
          <SkeletonRows count={4} />
        </div>
      ) : (
        <>
          <TakingsCard takings={s.takings} />

          {!s.locked && (s.unpaid.count > 0 || s.notFinished > 0 || s.close?.status === 'reopened') && (
            <p className="border-l-4 border-amber bg-amber-50 px-3 py-2 text-sm text-ink-2">
              {[
                s.close?.status === 'reopened' && s.close.reopened ? `Reopened by ${s.close.reopened.by}: ${s.close.reopened.reason}` : null,
                s.notFinished > 0 ? `${plural(s.notFinished, 'car')} not finished` : null,
                s.unpaid.count > 0 ? `${plural(s.unpaid.count, 'finished car')} owe ${formatGHS(s.unpaid.amount)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}

          {s.locked && s.close ? <ClosedResult close={s.close} summary={s} /> : <CloseForm key={`${s.day}-${s.close?.status ?? 'open'}`} summary={s} />}
        </>
      )}

      {can('dailyclose.see_expected') && (
        <section aria-label="Past days" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
          <h3 className="border-b border-line px-4 py-2.5 text-sm font-medium text-ink-2">Past closes</h3>
          {history.isPending ? (
            <SkeletonRows count={3} />
          ) : history.data && history.data.closes.length > 0 ? (
            <ul className="divide-y divide-line-2">
              {history.data.closes.map((c) => (
                <li key={c.day}>
                  <button type="button" onClick={() => setParams(c.day === today ? {} : { day: c.day }, { replace: true })} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-band">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink">{dayName(c.day)}</p>
                      <p className="num truncate text-xs text-ink-3">{c.status === 'reopened' ? 'Reopened, not yet closed' : `Counted ${formatGHS(c.countedCash)} · ${c.closedBy}`}</p>
                    </div>
                    {c.status === 'reopened' ? <Pill tone="amber">Reopened</Pill> : <Difference amount={c.difference} />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyRow>No days have been closed yet</EmptyRow>
          )}
        </section>
      )}
    </div>
  );
}
