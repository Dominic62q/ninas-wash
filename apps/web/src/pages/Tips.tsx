import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { formatGHS, reasonInput, type JobListResult, type TipDto, type TipsOverview } from '@niinas/shared';
import { useAttendants } from '../components/JobBits';
import { TipPanel } from '../components/TipPanel';
import { useToast } from '../components/Toast';
import { ConfirmPanel, EmptyRow, Field, FormError, Panel, Pill, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { addDays, clock, dayName, plural, ymd } from '../lib/format';

function TipStatus({ tip }: { tip: TipDto }) {
  if (tip.voided) return <Pill tone="grey">Voided</Pill>;
  if (tip.kind === 'direct') return <Pill tone="blue">Given directly</Pill>;
  return tip.handedOut ? <Pill tone="green">Handed over</Pill> : <Pill tone="amber">Held</Pill>;
}

function VoidTipPanel({ tip, onClose }: { tip: TipDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api(`/tips/${tip?.id}/void`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tips'] });
      toast.success('Tip voided');
      onClose();
    },
  });

  function submit() {
    const parsed = reasonInput.safeParse({ reason });
    if (!parsed.success) return setError('Say why the tip is being voided');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={tip !== null} onClose={onClose} title="Void this tip">
      {tip && (
        <>
          <p className="text-ink-2">
            <strong className="text-ink">{formatGHS(tip.amount)}</strong> for {tip.attendant} will no longer count. It stays on record with your name and reason.
          </p>
          <Field label="Reason" error={error ?? undefined}>
            <input className="input" value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} maxLength={200} autoComplete="off" aria-invalid={!!error} placeholder="Typed the wrong amount" />
          </Field>
          <FormError message={save.isError ? errorMessage(save.error) : null} />
          <button type="button" className="btn border-red bg-red text-white" disabled={save.isPending} onClick={submit}>
            {save.isPending ? 'Voiding…' : 'Void tip'}
          </button>
        </>
      )}
    </Panel>
  );
}

export function Tips() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [handing, setHanding] = useState<{ attendantId: number; name: string; amount: number } | null>(null);
  const [voiding, setVoiding] = useState<TipDto | null>(null);

  const tips = useQuery({ queryKey: ['tips'], queryFn: () => api<TipsOverview>('/tips'), refetchInterval: 30_000 });
  const attendants = useAttendants();
  const cars = useQuery({
    queryKey: ['jobs', 'recent-for-tips'],
    queryFn: () => api<JobListResult>(`/jobs?from=${ymd(addDays(new Date(), -1))}&limit=100`),
    staleTime: 60_000,
  });

  const handOut = useMutation({
    mutationFn: (attendantId: number) => api('/tips/handouts', { method: 'POST', body: { attendantId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tips'] });
      toast.success(handing ? `${formatGHS(handing.amount)} handed to ${handing.name}` : 'Tips handed over');
      setHanding(null);
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      setHanding(null);
    },
  });

  const jobOptions = [
    { value: '', label: 'Not for one car' },
    ...(cars.data?.jobs ?? [])
      .filter((j) => !j.voided && (j.status === 'completed' || j.status === 'dispatched'))
      .map((j) => ({ value: String(j.id), label: `${j.plate.toUpperCase()} · ${j.services.join(', ')}` })),
  ];

  const data = tips.data;
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3 lg:gap-4">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm text-ink-3">Attendants’ money. Never takings or commission.</p>
        <button type="button" className="btn btn-primary shrink-0 px-4 max-lg:h-10" onClick={() => setAdding(true)}>
          Add tip
        </button>
      </div>

      <FormError message={tips.isError ? errorMessage(tips.error) : null} />

      <section aria-label="Held tips" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
          <h3 className="text-sm font-medium text-ink-2">Held at the till</h3>
          <p className="display num text-[21px] leading-none text-navy lg:text-[24px]">{formatGHS(data?.totalHeld ?? 0)}</p>
        </div>
        {tips.isPending ? (
          <SkeletonRows count={2} />
        ) : data && data.held.length > 0 ? (
          <ul className="divide-y divide-line-2">
            {data.held.map((h) => (
              <li key={h.attendantId} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{h.name}</p>
                  <p className="text-xs text-ink-3">{plural(h.count, 'tip')}</p>
                </div>
                <p className="num font-semibold text-ink">{formatGHS(h.amount)}</p>
                {can('tip.handout') && (
                  <button type="button" className="btn h-9 px-3 text-sm" onClick={() => setHanding({ attendantId: h.attendantId, name: h.name, amount: h.amount })}>
                    Hand over
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyRow>No tips are being held</EmptyRow>
        )}
      </section>

      <section aria-label="Recent tips" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <h3 className="border-b border-line px-4 py-2.5 text-sm font-medium text-ink-2">Last 7 days</h3>
        {tips.isPending ? (
          <SkeletonRows count={3} />
        ) : data && data.tips.length > 0 ? (
          <ul>
            {data.tips.map((t, i) => {
              const day = t.at.slice(0, 10);
              const first = i === 0 || data.tips[i - 1]!.at.slice(0, 10) !== day;
              return (
                <Fragment key={t.id}>
                  {first && <li className="border-b border-line bg-band px-4 py-1.5 text-xs font-medium text-ink-2 [&:not(:first-child)]:border-t">{dayName(day)}</li>}
                  <li className="flex items-start gap-3 border-b border-line-2 px-4 py-2.5 last:border-b-0">
                    <div className={`min-w-0 flex-1 ${t.voided ? 'text-ink-3' : ''}`}>
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className={`font-medium ${t.voided ? 'line-through' : 'text-ink'}`}>{t.attendant}</span>
                        <TipStatus tip={t} />
                      </p>
                      <p className="truncate text-xs text-ink-3">
                        {t.jobId && t.plate ? (
                          <>
                            <Link to={`/jobs/${t.jobId}`} className="text-blue-d">
                              {t.plate.toUpperCase()}
                            </Link>
                            {' · '}
                          </>
                        ) : null}
                        {t.by}, {clock(t.at)}
                      </p>
                      {t.voided && (
                        <p className="text-xs font-medium text-red-d">
                          Voided by {t.voided.by}: {t.voided.reason}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end">
                      <p className={`num font-semibold ${t.voided ? 'text-ink-3 line-through' : 'text-ink'}`}>{formatGHS(t.amount)}</p>
                      {can('tip.void') && !t.voided && !t.handedOut && (
                        <button type="button" className="mt-0.5 cursor-pointer text-xs font-medium text-red-d" onClick={() => setVoiding(t)}>
                          Void
                        </button>
                      )}
                    </div>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        ) : (
          <EmptyRow>No tips in the last 7 days</EmptyRow>
        )}
        {data && data.total > data.tips.length && <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">Showing the latest {data.tips.length} of {data.total}.</p>}
      </section>

      <TipPanel open={adding} onClose={() => setAdding(false)} attendants={attendants.data?.attendants ?? []} jobOptions={jobOptions} />
      <VoidTipPanel key={voiding?.id ?? 'none'} tip={voiding} onClose={() => setVoiding(null)} />
      <ConfirmPanel
        open={handing !== null}
        title="Hand over held tips"
        message={handing ? `Give ${formatGHS(handing.amount)} to ${handing.name}. This clears everything held for them.` : ''}
        confirmLabel="Hand over"
        busy={handOut.isPending}
        onConfirm={() => handing && handOut.mutate(handing.attendantId)}
        onClose={() => setHanding(null)}
      />
    </div>
  );
}
