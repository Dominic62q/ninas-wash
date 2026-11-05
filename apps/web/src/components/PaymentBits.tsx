import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { dispatchInput, formatAmount, formatGHS, parseGHS, referenceProblem, voidInput, type JobDetail, type PayMethodDto, type PaymentDto } from '@niinas/shared';
import { useToast } from './Toast';
import { Select } from './Dropdown';
import { Choice, Field, FormError, Panel, Pill, errorMessage } from './ui';
import { api } from '../lib/api';
import { newKey } from '../lib/format';
import { useActiveMethods } from '../lib/useMethods';

/** Pick how something was paid. Up to three ways sit side by side, more than that become a list. */
export function MethodPicker({ label, value, onChange }: { label: string; value: number | null; onChange: (m: PayMethodDto) => void }) {
  const { active, first } = useActiveMethods();
  const current = active.find((m) => m.id === value) ?? first;
  if (!current) return null;
  const options = active.map((m) => ({ value: String(m.id), label: m.name }));
  const pick = (id: string) => onChange(active.find((m) => String(m.id) === id)!);
  if (active.length > 3) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink-2">{label}</span>
        <Select label={label} value={String(current.id)} options={options} onChange={pick} />
      </div>
    );
  }
  return <Choice label={label} value={String(current.id)} options={options} onChange={pick} />;
}

/** Unpaid, part paid or paid, from what the job costs and what has been received. */
export function PayPill({ total, paid }: { total: number; paid: number }) {
  if (total <= 0) return null;
  if (paid >= total) return <Pill tone="green">Paid</Pill>;
  return paid > 0 ? <Pill tone="blue">Part paid</Pill> : <Pill tone="amber">Unpaid</Pill>;
}

const plain = (pesewas: number) => formatAmount(pesewas).replace(/,/g, '');

/** Take one payment. Part cash and part MoMo is two payments. */
export function PayPanel({ job, open, onClose }: { job: JobDetail; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { first } = useActiveMethods();
  const [picked, setPicked] = useState<PayMethodDto | null>(null);
  const method = picked ?? first;
  const [amountText, setAmountText] = useState(plain(job.balance));
  const [reference, setReference] = useState('');
  const [received, setReceived] = useState('');
  const [error, setError] = useState<string | null>(null);
  // One key per form: a double-tap or a retry after a bad connection saves the payment once.
  const [idemKey] = useState(newKey);

  const amount = parseGHS(amountText);
  const handed = received.trim() === '' ? null : parseGHS(received);
  const change = method?.inDrawer && amount !== null && handed !== null && handed > amount ? handed - amount : null;

  const save = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}/payments`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      toast.success(amount !== null && amount >= job.balance ? 'Paid in full' : `${formatGHS(amount ?? 0)} received`);
      onClose();
    },
  });

  function submit() {
    if (amount === null || amount <= 0) return setError('Enter the amount, like 20 or 20.50');
    if (amount > job.balance) return setError(`Only ${formatGHS(job.balance)} is still owed`);
    if (!method) return setError('Pick how the customer paid');
    const problem = referenceProblem(method, reference);
    if (problem) return setError(problem);
    setError(null);
    save.mutate({ methodId: method.id, amount, reference: reference.trim() || null, idemKey });
  }

  return (
    <Panel open={open} onClose={onClose} title="Take payment">
      <p className="text-ink-2">
        <strong className="text-ink">{formatGHS(job.balance)}</strong> still owed on this job.
      </p>
      <MethodPicker label="Paid by" value={method?.id ?? null} onChange={(m) => { setPicked(m); setError(null); }} />
      <Field label="Amount (GH₵)" hint="Less than the balance? Take the rest in another payment.">
        <input className="input" inputMode="decimal" value={amountText} onChange={(e) => { setAmountText(e.target.value); setError(null); }} autoComplete="off" aria-label="Amount" />
      </Field>
      {method?.requiresReference ? (
        <Field label={`${method.name} reference`}>
          <input className="input" value={reference} onChange={(e) => { setReference(e.target.value); setError(null); }} maxLength={40} autoComplete="off" placeholder="From the confirmation message" />
        </Field>
      ) : method?.inDrawer ? (
        <Field label="Cash received (optional)" hint={change !== null ? undefined : 'To work out the change'}>
          <input className="input" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} autoComplete="off" placeholder="0.00" />
          {/* Phone: the notes people usually hand over, so the change works out without typing. */}
          {amount !== null && amount > 0 && (
            <div className="flex flex-wrap gap-2 lg:hidden">
              {[amount, ...[20, 50, 100, 200].map((n) => n * 100).filter((n) => n > amount)].slice(0, 4).map((n, i) => (
                <button key={n} type="button" onClick={() => setReceived(plain(n))} className="num h-9 cursor-pointer rounded-lg bg-band px-3 text-sm font-semibold text-navy active:scale-95">
                  {i === 0 ? 'Exact' : formatAmount(n).replace(/\.00$/, '')}
                </button>
              ))}
            </div>
          )}
          {change !== null && (
            <span className="num text-sm font-semibold text-green" aria-live="polite">
              Give back {formatGHS(change)}
            </span>
          )}
        </Field>
      ) : null}
      <FormError message={error ?? (save.isError ? errorMessage(save.error) : null)} />
      <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
        {save.isPending ? 'Saving…' : 'Save payment'}
      </button>
    </Panel>
  );
}

/** A wrong payment is voided with a reason and entered again. It is never edited. */
export function VoidPaymentPanel({ job, payment, onClose }: { job: JobDetail; payment: PaymentDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}/payments/${payment?.id}/void`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      toast.success('Payment voided');
      onClose();
    },
  });

  function submit() {
    const parsed = voidInput.safeParse({ reason });
    if (!parsed.success) return setError('Say why the payment is being voided');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={payment !== null} onClose={onClose} title="Void this payment">
      {payment && (
        <>
          <p className="text-ink-2">
            {payment.method} <strong className="text-ink">{formatGHS(payment.amount)}</strong> goes back onto the balance. It stays on record with your name and reason.
          </p>
          <Field label="Reason" error={error ?? undefined}>
            <input className="input" value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} maxLength={200} autoComplete="off" aria-invalid={!!error} placeholder="Typed the wrong amount" />
          </Field>
          <FormError message={save.isError ? errorMessage(save.error) : null} />
          <button type="button" className="btn border-red bg-red text-white" disabled={save.isPending} onClick={submit}>
            {save.isPending ? 'Voiding…' : 'Void payment'}
          </button>
        </>
      )}
    </Panel>
  );
}

/** The car leaves with money still owed: a manager says why. */
export function DispatchPanel({ job, open, onClose }: { job: JobDetail; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}/dispatch`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.success(`${job.vehicle.plate.toUpperCase()} dispatched, ${formatGHS(job.balance)} owing`);
      onClose();
    },
  });

  function submit() {
    const parsed = dispatchInput.safeParse({ note });
    if (!parsed.success || !parsed.data.note) return setError('Say why the car is leaving with a balance');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={open} onClose={onClose} title="Dispatch with a balance">
      <p className="text-ink-2">
        <strong className="text-ink">{formatGHS(job.balance)}</strong> is still owed. Your name and note go on record, and the debt stays on the customer.
      </p>
      <Field label="Why is the car leaving?" error={error ?? undefined}>
        <input className="input" value={note} onChange={(e) => { setNote(e.target.value); setError(null); }} maxLength={200} autoComplete="off" aria-invalid={!!error} placeholder="Regular customer, pays on Friday" />
      </Field>
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
        {save.isPending ? 'Saving…' : 'Dispatch car'}
      </button>
    </Panel>
  );
}
