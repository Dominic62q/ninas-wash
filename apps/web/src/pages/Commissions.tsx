import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatGHS, parseGHS, payoutInput, reasonInput, type CommissionLedger, type CommissionOverview, type LedgerEntry, type PayMethodDto } from '@niinas/shared';
import { useToast } from '../components/Toast';
import { EmptyRow, Field, FormError, PAGE, Panel, Pill, ShowMore, SkeletonRows, errorMessage } from '../components/ui';
import { MethodPicker } from '../components/PaymentBits';
import { api } from '../lib/api';
import { useActiveMethods } from '../lib/useMethods';
import { newKey, shortDateTime } from '../lib/format';

type Payout = Extract<LedgerEntry, { type: 'payout' }>;

function PayOutPanel({ ledger, onClose }: { ledger: CommissionLedger | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [amountText, setAmountText] = useState(ledger ? String(ledger.owed / 100) : '');
  const { first } = useActiveMethods();
  const [picked, setPicked] = useState<PayMethodDto | null>(null);
  const method = picked ?? first;
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  // One key per form, so a double tap or a retry on a bad connection pays once.
  const [idemKey] = useState(newKey);

  const save = useMutation({
    mutationFn: (body: unknown) => api('/commissions/payouts', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['commissions'] });
      toast.success(`${formatGHS(parseGHS(amountText) ?? 0)} paid to ${ledger?.attendant.name}`);
      onClose();
    },
  });

  function submit() {
    if (!ledger) return;
    const amount = parseGHS(amountText);
    if (amount === null || amount <= 0) return setError('Enter the amount, like 20 or 20.50');
    if (amount > ledger.owed) return setError(`Only ${formatGHS(ledger.owed)} is owed`);
    if (!method) return setError('Pick how they were paid');
    const parsed = payoutInput.safeParse({ attendantId: ledger.attendant.id, amount, methodId: method.id, note: note.trim() || null, idemKey });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the details');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={ledger !== null} onClose={onClose} title="Pay commission">
      {ledger && (
        <>
          <p className="text-ink-2">
            <strong className="text-ink">{ledger.attendant.name}</strong> is owed <strong className="text-ink">{formatGHS(ledger.owed)}</strong>. Pay all of it or part of it.
          </p>
          <Field label="Amount (GH₵)">
            <input className="input" inputMode="decimal" value={amountText} onChange={(e) => { setAmountText(e.target.value); setError(null); }} autoComplete="off" aria-label="Amount" />
          </Field>
          <MethodPicker label="Paid how?" value={method?.id ?? null} onChange={setPicked} />
          <Field label="Note (optional)">
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} autoComplete="off" placeholder="Week ending Friday" />
          </Field>
          <FormError message={error ?? (save.isError ? errorMessage(save.error) : null)} />
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Record payout'}
          </button>
        </>
      )}
    </Panel>
  );
}

function VoidPayoutPanel({ payout, attendantName, onClose }: { payout: Payout | null; attendantName: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api(`/commissions/payouts/${payout?.id}/void`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['commissions'] });
      toast.success('Payout voided');
      onClose();
    },
  });

  function submit() {
    const parsed = reasonInput.safeParse({ reason });
    if (!parsed.success) return setError('Say why the payout is being voided');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={payout !== null} onClose={onClose} title="Void this payout">
      {payout && (
        <>
          <p className="text-ink-2">
            The <strong className="text-ink">{formatGHS(payout.amount)}</strong> paid to {attendantName} will count as owed again. The payout stays on record with your name and reason.
          </p>
          <Field label="Reason" error={error ?? undefined}>
            <input className="input" value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} maxLength={200} autoComplete="off" aria-invalid={!!error} placeholder="Paid the wrong person" />
          </Field>
          <FormError message={save.isError ? errorMessage(save.error) : null} />
          <button type="button" className="btn border-red bg-red text-white" disabled={save.isPending} onClick={submit}>
            {save.isPending ? 'Voiding…' : 'Void payout'}
          </button>
        </>
      )}
    </Panel>
  );
}

/** One line of a ledger. On an attendant's own screen there is no void button and no link to the job. */
export function LedgerRow({ entry, onVoid }: { entry: LedgerEntry; onVoid?: (p: Payout) => void }) {
  if (entry.type === 'earned') {
    return (
      <li className="flex items-start gap-3 px-4 py-2.5">
        <div className={`min-w-0 flex-1 ${entry.reversed ? 'text-ink-3' : ''}`}>
          <p className="truncate">
            {onVoid ? (
              <Link to={`/jobs/${entry.jobId}`} className="font-medium text-blue-d">
                {entry.plate.toUpperCase()}
              </Link>
            ) : (
              <span className="font-medium text-ink">{entry.plate.toUpperCase()}</span>
            )}{' '}
            <span className={entry.reversed ? 'line-through' : 'text-ink-2'}>{entry.service}</span>
          </p>
          <p className="text-xs text-ink-3">
            {entry.sharePct < 100 ? `${entry.sharePct}% share, ` : ''}
            {shortDateTime(entry.at)}
            {entry.reversed ? ' · car was voided' : ''}
          </p>
        </div>
        <p className={`num font-semibold ${entry.reversed ? 'text-ink-3 line-through' : 'text-ink'}`}>{formatGHS(entry.amount)}</p>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-3 bg-band/50 px-4 py-2.5">
      <div className={`min-w-0 flex-1 ${entry.voided ? 'text-ink-3' : ''}`}>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`font-medium ${entry.voided ? 'line-through' : 'text-ink'}`}>Paid out</span>
          <Pill tone={entry.voided ? 'grey' : 'green'}>{entry.voided ? 'Voided' : entry.method}</Pill>
        </p>
        <p className="text-xs text-ink-3">
          {entry.by}, {shortDateTime(entry.at)}
          {entry.note ? ` · ${entry.note}` : ''}
        </p>
        {entry.voided && (
          <p className="text-xs font-medium text-red-d">
            Voided by {entry.voided.by}: {entry.voided.reason}
          </p>
        )}
      </div>
      <p className={`num font-semibold ${entry.voided ? 'text-ink-3 line-through' : 'text-green'}`}>−{formatGHS(entry.amount)}</p>
      {!entry.voided && onVoid && (
        <button type="button" className="tap text-sm text-red-d" onClick={() => onVoid(entry)}>
          Void
        </button>
      )}
    </li>
  );
}

function LedgerPanel({ attendantId, onClose }: { attendantId: number | null; onClose: () => void }) {
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState<Payout | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const ledger = useQuery({
    queryKey: ['commissions', 'ledger', attendantId, limit],
    queryFn: () => api<{ ledger: CommissionLedger }>(`/commissions/attendants/${attendantId}?limit=${limit}`),
    enabled: attendantId !== null,
    placeholderData: (previous) => previous,
  });
  const data = ledger.data?.ledger;

  return (
    <Panel open={attendantId !== null} onClose={onClose} title={data?.attendant.name ?? 'Commission'} tall>
      {ledger.isPending && <SkeletonRows count={3} />}
      <FormError message={ledger.isError ? errorMessage(ledger.error) : null} />
      {data && (
        <>
          <dl className="grid grid-cols-3 border border-line">
            {[
              ['Earned', data.earned],
              ['Paid out', data.paidOut],
              ['Owed', data.owed],
            ].map(([label, value], i) => (
              <div key={label} className={`px-3 py-2.5 ${i > 0 ? 'border-l border-line' : ''}`}>
                <dt className="text-xs font-medium text-ink-3">{label}</dt>
                <dd className={`display num mt-1 text-[20px] leading-none ${label === 'Owed' ? 'text-navy' : 'text-ink-2'}`}>{formatGHS(value as number)}</dd>
              </div>
            ))}
          </dl>
          {data.owed < 0 && <p className="border-l-4 border-amber bg-amber-50 px-3 py-2.5 text-sm font-medium text-amber">Paid more than earned, because a car was voided after payout</p>}
          <button type="button" className="btn btn-primary" disabled={data.owed <= 0} onClick={() => setPaying(true)}>
            Pay out
          </button>
          <div className="-mx-4 border-y border-line lg:-mx-5">
            {data.entries.length === 0 ? (
              <EmptyRow>Nothing earned yet</EmptyRow>
            ) : (
              <ul className="divide-y divide-line-2">
                {data.entries.map((e) => (
                  <LedgerRow key={`${e.type}-${e.id}`} entry={e} onVoid={setVoiding} />
                ))}
              </ul>
            )}
            <ShowMore shown={data.entries.length} total={data.total} busy={ledger.isFetching} onMore={() => setLimit((n) => n + PAGE)} />
          </div>
          <PayOutPanel key={`pay-${paying}-${data.owed}`} ledger={paying ? data : null} onClose={() => setPaying(false)} />
          <VoidPayoutPanel key={`void-${voiding?.id ?? 'none'}`} payout={voiding} attendantName={data.attendant.name} onClose={() => setVoiding(null)} />
        </>
      )}
    </Panel>
  );
}

export function Commissions() {
  const [open, setOpen] = useState<number | null>(null);
  const overview = useQuery({ queryKey: ['commissions', 'overview'], queryFn: () => api<CommissionOverview>('/commissions'), refetchInterval: 60_000 });
  const data = overview.data;

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
      <p className="text-sm text-ink-2">Commission is earned when a car is marked Completed. Open a name to see the detail and to pay it out.</p>
      <FormError message={overview.isError ? errorMessage(overview.error) : null} />

      <section aria-label="Commission owed" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
          <h3 className="text-sm font-medium text-ink-2">Owed to attendants</h3>
          <p className="display num text-[21px] leading-none text-navy lg:text-[24px]">{formatGHS(data?.totalOwed ?? 0)}</p>
        </div>
        {overview.isPending ? (
          <SkeletonRows />
        ) : data && data.attendants.length > 0 ? (
          <ul className="divide-y divide-line-2">
            {data.attendants.map((a) => (
              <li key={a.attendantId}>
                <button type="button" onClick={() => setOpen(a.attendantId)} className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-band">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`truncate font-medium ${a.active ? 'text-ink' : 'text-ink-3'}`}>{a.name}</span>
                      {!a.active && <Pill tone="grey">Left</Pill>}
                    </span>
                    <span className="block text-xs text-ink-3">{formatGHS(a.earned7d)} earned this week</span>
                  </span>
                  <span className={`num font-semibold ${a.owed > 0 ? 'text-ink' : 'text-ink-3'}`}>{formatGHS(a.owed)}</span>
                  <span aria-hidden="true" className="text-ink-3">›</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyRow>No attendants yet</EmptyRow>
        )}
      </section>

      <LedgerPanel attendantId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
