import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { dispatchInput, formatAmount, formatGHS, parseGHS, referenceProblem, voidInput, type JobDetail, type PayMethodDto, type PaymentDto } from '@niinas/shared';
import { useToast } from './Toast';
import { Select } from './Dropdown';
import { Choice, Field, FormError, Panel, Pill, errorMessage } from './ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { newKey } from '../lib/format';
import { useActiveMethods } from '../lib/useMethods';
import { QuantityStepper, useServices } from './JobBits';

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

/**
 * Items from the shelf, put on the bill at the till. They go on the job straight away, so the balance above is right
 * before any money is taken. Left out once the bill is settled or the car has gone.
 */
function ShelfItems({ job }: { job: JobDetail }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const services = useServices();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(1);
  const onJob = new Set(job.lines.map((l) => l.serviceId));
  const shelf = (services.data?.services ?? []).filter((s) => s.kind === 'item' && s.stock > 0 && !onJob.has(s.id));
  const chosen = shelf.find((s) => s.id === pick);

  const add = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}/lines`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success('Item added to the bill');
      setPick(null);
      setQuantity(1);
    },
  });

  const mayAdd = can('job.create') && (job.status === 'pending' || job.status === 'in_progress' || job.status === 'completed');
  if (!mayAdd || shelf.length === 0) return null;
  if (!open) {
    return (
      <button type="button" className="tap self-start text-sm text-blue-d" onClick={() => setOpen(true)}>
        Add items from the shelf
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 border border-line bg-band p-3 max-lg:rounded-[10px]">
      <p className="text-sm font-medium text-ink-2">Add to the bill</p>
      <div className="flex flex-wrap gap-2">
        {shelf.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={pick === s.id}
            onClick={() => { setPick(s.id); setQuantity(1); }}
            className={`flex min-h-10 cursor-pointer items-center gap-2 border-[1.5px] px-3 text-left text-sm max-lg:rounded-[10px] ${pick === s.id ? 'border-blue bg-blue-50' : 'border-line-strong bg-surface'}`}
          >
            <span className="font-medium text-ink">{s.name}</span>
            <span className="num text-ink-2">{formatGHS(s.price)}</span>
          </button>
        ))}
      </div>
      {chosen && (
        <div className="flex flex-wrap items-center gap-3">
          <QuantityStepper label={chosen.name} value={quantity} onChange={setQuantity} max={chosen.stock} />
          <span className="num text-sm text-ink-3">{formatGHS(chosen.price * quantity)}</span>
          <button type="button" className="btn btn-primary ml-auto h-10 px-4" disabled={add.isPending} onClick={() => add.mutate({ serviceId: chosen.id, quantity, attendantIds: [] })}>
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}
      {add.isError && <FormError message={errorMessage(add.error)} />}
    </div>
  );
}

/** Take one payment. Part cash and part MoMo is two payments. */
export function PayPanel({ job, open, onClose }: { job: JobDetail; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { first } = useActiveMethods();
  const [picked, setPicked] = useState<PayMethodDto | null>(null);
  const method = picked ?? first;
  const [amountText, setAmountText] = useState(plain(job.balance));
  /** Once the cashier types an amount it is theirs. Until then it follows the balance, which moves when items are added. */
  const [typed, setTyped] = useState(false);
  useEffect(() => {
    if (!typed) setAmountText(plain(job.balance));
  }, [job.balance, typed]);
  const [reference, setReference] = useState('');
  const [received, setReceived] = useState('');
  const [error, setError] = useState<string | null>(null);
  // One key per form: a double-tap or a retry after a bad connection saves the payment once.
  const [idemKey] = useState(newKey);
  const { can } = useAuth();

  const amount = parseGHS(amountText);
  const handed = received.trim() === '' ? null : parseGHS(received);
  const change = method?.inDrawer && amount !== null && handed !== null && handed > amount ? handed - amount : null;

  const save = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}/payments`, { method: 'POST', body }),
    onSuccess: async (_data, body) => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      const finish = (body as { finish?: string | null }).finish;
      toast.success(
        finish === 'dispatch' ? 'Paid and dispatched' : finish === 'wait' ? 'Paid, waiting for dispatch' : amount !== null && amount >= job.balance ? 'Paid in full' : `${formatGHS(amount ?? 0)} received`,
      );
      onClose();
    },
  });

  /** The wash is running or done, so this payment can also finish the job: no separate steps. */
  const running = job.status === 'in_progress' && can('job.advance');
  const finished = job.status === 'completed';
  const covers = amount !== null && amount >= job.balance;
  const canDispatch = (running || finished) && can('job.dispatch') && covers;

  function submit(finish: 'wait' | 'dispatch' | null) {
    if (amount === null || amount <= 0) return setError('Enter the amount, like 20 or 20.50');
    if (amount > job.balance) return setError(`Only ${formatGHS(job.balance)} is still owed`);
    if (!method) return setError('Pick how the customer paid');
    const problem = referenceProblem(method, reference);
    if (problem) return setError(problem);
    setError(null);
    save.mutate({ methodId: method.id, amount, reference: reference.trim() || null, idemKey, finish });
  }

  return (
    <Panel open={open} onClose={onClose} title="Take payment">
      <p className="text-ink-2">
        <strong className="text-ink">{formatGHS(job.balance)}</strong> still owed on this job.
      </p>
      <ShelfItems job={job} />
      <MethodPicker label="Paid by" value={method?.id ?? null} onChange={(m) => { setPicked(m); setError(null); }} />
      <Field label="Amount (GH₵)" hint="Less than the balance? Take the rest in another payment.">
        <input className="input" inputMode="decimal" value={amountText} onChange={(e) => { setAmountText(e.target.value); setTyped(true); setError(null); }} autoComplete="off" aria-label="Amount" />
      </Field>
      {method?.requiresReference || (method && !method.inDrawer) ? (
        <Field label={`${method.name} reference${method.requiresReference ? '' : ' (optional)'}`}>
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
      {canDispatch && (
        <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => submit('dispatch')}>
          {save.isPending ? 'Saving…' : 'Pay and dispatch'}
        </button>
      )}
      {running && (
        <button type="button" className={`btn ${canDispatch ? '' : 'btn-primary'}`} disabled={save.isPending} onClick={() => submit('wait')}>
          {save.isPending ? 'Saving…' : 'Pay and wait for dispatch'}
        </button>
      )}
      {running ? (
        <button type="button" className="tap text-center text-sm text-blue-d" disabled={save.isPending} onClick={() => submit(null)}>
          Save the payment only, the wash carries on
        </button>
      ) : (
        <button type="button" className={`btn ${canDispatch ? '' : 'btn-primary'}`} disabled={save.isPending} onClick={() => submit(null)}>
          {save.isPending ? 'Saving…' : 'Save payment'}
        </button>
      )}
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
      toast.success(`${job.vehicle?.plate.toUpperCase() ?? (job.kind === 'sale' ? 'Sale' : 'Walk-in')} dispatched, ${formatGHS(job.balance)} owing`);
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
