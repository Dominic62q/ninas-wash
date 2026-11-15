import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import {
  CAR_TYPES,
  addLineInput,
  assignInput,
  discountInput,
  editLineInput,
  formatAmount,
  formatGHS,
  formatPhone,
  parseGHS,
  removeLineInput,
  voidInput,
  type JobDetail as JobDetailDto,
  type JobHistoryEntry,
  type ServiceKind,
} from '@niinas/shared';
import { Plate } from '../components/Plate';
import { AttendantPicker, BusyNote, QuantityStepper, StagePill, useAttendants, useServices } from '../components/JobBits';
import { SlideToConfirm } from '../components/SlideToConfirm';
import { TipPanel } from '../components/TipPanel';
import { useJobSteps, type JobStep } from '../components/JobActions';
import { DispatchPanel, PayPanel, PayPill, VoidPaymentPanel } from '../components/PaymentBits';
import { useToast } from '../components/Toast';
import { Field, FormError, Panel, Pill, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { sendReceipt, wantsPrint } from '../lib/receiptShare';
import { plural, shortDateTime } from '../lib/format';

const CAR_LABEL: Record<(typeof CAR_TYPES)[number], string> = { saloon: 'Saloon', suv: 'SUV', pickup: 'Pickup', van: 'Van', other: 'Other' };

const money = (v: unknown) => formatGHS(Number(v ?? 0));

/** A boxed section. On a phone it is a rounded card with a hairline instead of a border. */
const card = 'border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card';

/** One line of the history, in words. */
function describe(h: JobHistoryEntry): string {
  const a = h.after ?? {};
  const b = h.before ?? {};
  switch (h.action) {
    case 'job.create':
      return 'Booked';
    case 'sale.create':
      return 'Sold to a walk-in customer';
    case 'job.status':
      return String(a.status ?? '').replace('_', ' ').replace(/^./, (c) => c.toUpperCase());
    case 'job.add_line':
      return `Added ${String(a.service)}`;
    case 'job.assign':
      return `${String(a.service)}: ${((a.attendants as string[] | undefined) ?? []).join(', ')}`;
    case 'job.edit_line': {
      const who = (v: Record<string, unknown>) => ((v.attendants as string[] | undefined) ?? []).join(', ');
      const changes = [
        a.quantity !== b.quantity ? `${String(b.quantity)} → ${String(a.quantity)}` : '',
        who(a) !== who(b) ? `${who(b) || 'nobody'} → ${who(a)}` : '',
      ].filter(Boolean);
      return `Corrected ${String(b.service)}${changes.length ? `: ${changes.join(', ')}` : ''}`;
    }
    case 'job.remove_line':
      return `Took off ${String(b.service)}${Number(b.quantity) > 1 ? ` × ${String(b.quantity)}` : ''}`;
    case 'job.discount':
      return `Discount ${money(b.discount)} → ${money(a.discount)}`;
    case 'job.void':
      return 'Voided';
    case 'payment.record':
      // Entries from before payment methods were editable hold the old lowercase words.
      return `${a.method === 'momo' ? 'MoMo' : a.method === 'cash' ? 'Cash' : String(a.method)} ${money(a.amount)} received`;
    case 'payment.void':
      return `Payment of ${money(b.amount)} voided`;
    case 'job.dispatch':
      return Number(a.owed ?? 0) > 0 ? `Dispatched with ${money(a.owed)} owing` : 'Dispatched';
    default:
      return h.action;
  }
}

/** The job's one attendant, if a service on it already has someone. New services start with them. */
const jobAttendant = (job: JobDetailDto): number[] => {
  const id = job.lines.flatMap((l) => l.attendants.map((a) => a.id))[0];
  return id === undefined ? [] : [id];
};

function AssignPanel({ job, lineId, onClose }: { job: JobDetailDto; lineId: number | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const attendants = useAttendants();
  const toast = useToast();
  const line = job.lines.find((l) => l.id === lineId);
  const [ids, setIds] = useState<number[]>(() => jobAttendant(job));
  const [busyNote, setBusyNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}/lines/${lineId}/attendants`, { method: 'PUT', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.success('Attendant assigned');
      onClose();
    },
  });

  function submit() {
    const parsed = assignInput.safeParse({ attendantIds: ids, busyNote });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Pick an attendant');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={lineId !== null} onClose={onClose} title="Assign an attendant">
      {line && (
        <>
          <p className="text-ink-2">
            Who is washing <strong className="text-ink">{line.name}</strong>? One person does the whole job.
          </p>
          <AttendantPicker label="Attendant" options={attendants.data?.attendants ?? []} value={ids} onChange={(next) => { setIds(next); setError(null); }} />
          <FormError message={error ?? (save.isError ? errorMessage(save.error) : null)} />
          <BusyNote error={save.error} note={busyNote} onNote={setBusyNote} />
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
    </Panel>
  );
}

function AddServicePanel({ job, kind, open, onClose }: { job: JobDetailDto; kind: ServiceKind; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const services = useServices();
  const attendants = useAttendants();
  const toast = useToast();
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [ids, setIds] = useState<number[]>(() => jobAttendant(job));
  const [busyNote, setBusyNote] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const onJob = new Set(job.lines.map((l) => l.serviceId));
  const options = (services.data?.services ?? []).filter((s) => s.kind === kind && !onJob.has(s.id));
  const chosen = options.find((o) => o.id === serviceId);
  const isItem = kind === 'item';

  const save = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}/lines`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.success(isItem ? 'Item added to the job' : 'Service added to the job');
      setServiceId(null);
      setIds([]);
      setQuantity(1);
      onClose();
    },
  });

  function submit() {
    if (serviceId === null) return setError(isItem ? 'Choose an item' : 'Choose a service');
    const parsed = addLineInput.safeParse({ serviceId, quantity, attendantIds: isItem ? [] : ids, busyNote });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the details');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={open} onClose={onClose} title={isItem ? 'Add an item' : 'Add a service'}>
      {options.length === 0 && <p className="text-ink-3">{isItem ? 'There are no more items to add' : 'Every service is already on this job'}</p>}
      <div className="flex flex-col gap-2">
        {options.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={serviceId === s.id}
            disabled={s.kind === 'item' && s.stock === 0}
            onClick={() => { setServiceId(s.id); setQuantity(1); setError(null); }}
            className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 border-[1.5px] px-4 text-left ${
              serviceId === s.id ? 'border-blue bg-blue-50' : 'border-line-strong bg-surface'
            }`}
          >
            <span className="min-w-0">
              <span className="block font-medium text-ink">{s.name}</span>
              {s.kind === 'item' && <span className={`block text-xs ${s.stock === 0 ? 'text-red-d' : 'text-ink-3'}`}>{s.stock === 0 ? 'Out of stock' : `${s.stock} on the shelf`}</span>}
            </span>
            <span className="num font-semibold text-navy">{formatGHS(s.price)}</span>
          </button>
        ))}
      </div>
      {serviceId !== null && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <QuantityStepper label={isItem ? 'of this item' : 'of this service'} value={quantity} onChange={setQuantity} max={isItem ? chosen?.stock : undefined} />
            {quantity > 1 && <span className="num text-sm text-ink-3">{quantity} × {formatGHS(chosen?.price ?? 0)}</span>}
          </div>
          {isItem ? (
            <p className="text-xs text-ink-3">Items are sold off the shelf, so they need no attendant and earn no commission.</p>
          ) : (
            <>
              <AttendantPicker label="Attendant" options={attendants.data?.attendants ?? []} value={ids} onChange={setIds} />
            </>
          )}
        </div>
      )}
      <FormError message={error ?? (save.isError ? errorMessage(save.error) : null)} />
      <BusyNote error={save.error} note={busyNote} onNote={setBusyNote} />
      <button type="button" className="btn btn-primary" disabled={save.isPending || options.length === 0} onClick={submit}>
        {save.isPending ? 'Adding…' : 'Add to job'}
      </button>
    </Panel>
  );
}

function DiscountPanel({ job, open, onClose }: { job: JobDetailDto; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState(job.discount ? formatAmount(job.discount).replace(/,/g, '') : '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.success('Discount saved');
      onClose();
    },
  });

  function submit() {
    const value = text.trim() === '' ? 0 : parseGHS(text);
    if (value === null) return setError('Enter the discount, like 5 or 5.50');
    const parsed = discountInput.safeParse({ discount: value });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the amount');
    if (value > job.subtotal) return setError(`Cannot be more than ${formatGHS(job.subtotal)}`);
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={open} onClose={onClose} title="Discount">
      <Field label="Discount (GH₵)" hint={`Up to ${formatGHS(job.subtotal)}`} error={error ?? undefined}>
        <input className="input" inputMode="decimal" value={text} onChange={(e) => { setText(e.target.value); setError(null); }} autoComplete="off" placeholder="0.00" aria-invalid={!!error} />
      </Field>
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
        {save.isPending ? 'Saving…' : 'Save discount'}
      </button>
    </Panel>
  );
}

/** A manager corrects one service before it is paid: how many, or who does it. The reason goes in the activity log. */
function EditLinePanel({ job, lineId, onClose }: { job: JobDetailDto; lineId: number | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const attendants = useAttendants();
  const services = useServices();
  const toast = useToast();
  const line = job.lines.find((l) => l.id === lineId);
  const [quantity, setQuantity] = useState(line?.quantity ?? 1);
  const [ids, setIds] = useState<number[]>(line?.attendants[0] ? [line.attendants[0].id] : []);
  const [reason, setReason] = useState('');
  const [busyNote, setBusyNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const isItem = line?.kind === 'item';
  // What is on the shelf now, plus what this line already holds.
  const onShelf = (services.data?.services ?? []).find((s) => s.id === line?.serviceId)?.stock;
  const most = isItem && onShelf !== undefined && line ? onShelf + line.quantity : undefined;

  const save = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}/lines/${lineId}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success('Job corrected');
      onClose();
    },
  });

  function submit() {
    if (!line) return;
    const personNow = line.attendants[0]?.id;
    const body: Record<string, unknown> = { reason, busyNote };
    if (quantity !== line.quantity) body.quantity = quantity;
    if (!isItem && ids[0] !== undefined && ids[0] !== personNow) body.attendantIds = ids;
    const parsed = editLineInput.safeParse(body);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the details');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={lineId !== null} onClose={onClose} title="Correct this service">
      {line && (
        <>
          <p className="text-ink-2">
            Fix <strong className="text-ink">{line.name}</strong> before it is paid. Your name and the reason go on record.
          </p>
          <div className="flex items-center gap-3">
            <QuantityStepper label={isItem ? 'of this item' : 'of this service'} value={quantity} onChange={(n) => { setQuantity(n); setError(null); }} max={most} />
            {quantity !== line.quantity && <span className="num text-sm text-ink-3">{formatGHS((line.price / line.quantity) * quantity)}</span>}
          </div>
          {!isItem && <AttendantPicker label="Attendant" options={attendants.data?.attendants ?? []} value={ids} onChange={(next) => { setIds(next); setError(null); }} />}
          <Field label="Why is it being corrected?" error={error ?? undefined}>
            <input className="input" value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} maxLength={200} autoComplete="off" aria-invalid={!!error} placeholder="Customer wanted two seats, not three" />
          </Field>
          <FormError message={save.isError ? errorMessage(save.error) : null} />
          <BusyNote error={save.error} note={busyNote} onNote={setBusyNote} />
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save correction'}
          </button>
        </>
      )}
    </Panel>
  );
}

/** Take one service or item off a job that has not been paid. It stays on record with who and why. */
function RemoveLinePanel({ job, lineId, onClose }: { job: JobDetailDto; lineId: number | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const line = job.lines.find((l) => l.id === lineId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const last = job.lines.length <= 1;
  const save = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}/lines/${lineId}/remove`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success(line?.kind === 'item' ? 'Item taken off, back on the shelf' : 'Service taken off the job');
      onClose();
    },
  });

  function submit() {
    const parsed = removeLineInput.safeParse({ reason });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Say why');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={lineId !== null} onClose={onClose} title="Take this off the job">
      {line && (
        <>
          <p className="text-ink-2">
            Take <strong className="text-ink">{line.name}{line.quantity > 1 ? ` × ${line.quantity}` : ''}</strong> off this job?{' '}
            {last ? 'It is the only thing on the job, so void the job instead.' : line.kind === 'item' ? 'It goes back on the shelf.' : 'The total goes down by its price.'}
          </p>
          <Field label="Reason" error={error ?? undefined}>
            <input className="input" value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} maxLength={200} autoComplete="off" aria-invalid={!!error} placeholder="Added by mistake" />
          </Field>
          <FormError message={save.isError ? errorMessage(save.error) : null} />
          <button type="button" className="btn border-red bg-red text-white" disabled={save.isPending || last} onClick={submit}>
            {save.isPending ? 'Taking off…' : 'Take off the job'}
          </button>
        </>
      )}
    </Panel>
  );
}

function VoidPanel({ job, open, onClose }: { job: JobDetailDto; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api(`/jobs/${job.id}/void`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      toast.success('Job voided');
      onClose();
    },
  });

  function submit() {
    const parsed = voidInput.safeParse({ reason });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Say why');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={open} onClose={onClose} title="Void this job">
      <p className="text-ink-2">
        The job stays on record with your name and reason. This cannot be undone.
      </p>
      <Field label="Reason" error={error ?? undefined}>
        <input className="input" value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} maxLength={200} autoComplete="off" aria-invalid={!!error} placeholder="Booked on the wrong car" />
      </Field>
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <button type="button" className="btn border-red bg-red text-white" disabled={save.isPending} onClick={submit}>
        {save.isPending ? 'Voiding…' : 'Void job'}
      </button>
    </Panel>
  );
}

type Dialog =
  | { kind: 'assign'; lineId: number }
  | { kind: 'edit'; lineId: number }
  | { kind: 'remove'; lineId: number }
  | { kind: 'add'; of: ServiceKind }
  | { kind: 'discount' }
  | { kind: 'void' }
  | { kind: 'pay' }
  | { kind: 'voidPayment'; paymentId: number }
  | { kind: 'dispatch' }
  | { kind: 'tip' }
  | null;

export function JobDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  // The board's "Take payment" button links here with ?pay=1.
  const [dialog, setDialog] = useState<Dialog>(() => (params.get('pay') === '1' ? { kind: 'pay' } : null));
  const close = () => {
    setDialog(null);
    if (params.has('pay')) setParams({}, { replace: true });
  };

  const query = useQuery({
    queryKey: ['jobs', 'detail', id],
    queryFn: () => api<{ job: JobDetailDto }>(`/jobs/${id}`),
    refetchInterval: 15_000,
  });
  const job = query.data?.job;

  const steps = useJobSteps();
  const toast = useToast();

  /** On a phone the receipt goes out as a PDF through the share sheet. On a computer it opens the print dialog. */
  const shareReceipt = useMutation({
    mutationFn: async () => {
      // A computer's print window has to be opened now, while the tap still counts, before we wait for the server.
      const printWindow = wantsPrint() ? window.open('', '_blank') : null;
      try {
        const { token } = await api<{ token: string }>(`/receipts/for-job/${id}`, { method: 'POST' });
        return await sendReceipt(token, `Receipt ${job?.number ?? id}.pdf`, printWindow);
      } catch (e) {
        printWindow?.close();
        throw e;
      }
    },
    onSuccess: (outcome) => {
      if (outcome === 'link') toast.success('Pop-ups are blocked, so the receipt link was copied instead');
      if (outcome === 'downloaded') toast.success('Receipt saved as a PDF');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
        <div className="skeleton h-10 w-48" />
        <div className="skeleton h-24" />
        <div className="skeleton h-44" />
      </div>
    );
  }
  if (query.isError || !job) {
    return (
      <div className="flex flex-col gap-3">
        <FormError message={errorMessage(query.error)} />
      </div>
    );
  }

  const open = !job.voided && (job.status === 'pending' || job.status === 'in_progress');
  const isSale = job.kind === 'sale';
  const serviceLines = job.lines.filter((l) => l.kind === 'service');
  const itemLines = job.lines.filter((l) => l.kind === 'item');
  const label = job.vehicle?.plate ?? (isSale ? 'Walk-in sale' : 'Walk-in');
  const missing = job.lines.some((l) => l.kind === 'service' && l.attendants.length === 0);
  const car = job.vehicle ? [job.vehicle.makeModel, job.vehicle.carType && CAR_LABEL[job.vehicle.carType]].filter(Boolean).join(' · ') : '';
  const canPay = !job.voided && job.balance > 0 && can('payment.record');
  const finished = !job.voided && job.status === 'completed';
  const mayRelease = can('job.dispatch_with_balance');
  const payingNow = dialog?.kind === 'pay' && canPay;
  const canTip = !job.voided && job.kind === 'wash' && (job.status === 'completed' || job.status === 'dispatched') && can('tip.record');
  const tipRecipients = [...new Map(job.lines.flatMap((l) => l.attendants).map((a) => [a.id, { id: a.id, name: a.name }])).values()];
  const voidingPayment = dialog?.kind === 'voidPayment' ? (job.payments.find((p) => p.id === dialog.paymentId) ?? null) : null;

  /** The one step the phone's bottom bar slides: start, finish or dispatch. */
  const slide: { step: JobStep; label: string; disabled?: boolean } | null =
    open && job.status === 'pending' && job.balance > 0
      ? { step: 'start', label: 'Slide to start washing', disabled: missing }
      : !job.voided && job.status !== 'dispatched' && can('job.dispatch') && job.balance === 0
        ? { step: 'dispatch', label: 'Slide to dispatch' }
        : open && job.status === 'in_progress' && !canPay
          ? { step: 'complete', label: 'Slide when finished' }
          : null;

  /** A manager can still correct a job until money is taken on it or the car leaves. */
  const canCorrect = !job.voided && job.status !== 'dispatched' && job.paid === 0 && can('job.edit');
  const renderLine = (l: JobDetailDto['lines'][number]) => (
    <li key={l.id} className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">
          {l.name}
          {l.quantity > 1 && <span className="num font-normal text-ink-3"> × {l.quantity}</span>}
        </p>
        {l.attendants.length > 0 ? (
          <p className="text-sm text-ink-2">{l.attendants.map((a) => (l.attendants.length > 1 ? `${a.name} ${a.shareBp / 100}%` : a.name)).join(', ')}</p>
        ) : l.kind === 'item' ? (
          <p className="text-sm text-ink-3">Item</p>
        ) : open ? (
          <button type="button" className="tap text-sm text-amber underline" onClick={() => setDialog({ kind: 'assign', lineId: l.id })}>
            Assign attendant
          </button>
        ) : (
          <p className="text-sm text-ink-3">None</p>
        )}
        {canCorrect && (
          <div className="flex gap-4">
            <button type="button" className="tap text-sm text-blue-d" onClick={() => setDialog({ kind: 'edit', lineId: l.id })}>
              Correct
            </button>
            {job.lines.length > 1 && (
              <button type="button" className="tap text-sm text-red-d" onClick={() => setDialog({ kind: 'remove', lineId: l.id })}>
                Take off
              </button>
            )}
          </div>
        )}
      </div>
      <p className="num font-semibold text-ink">{formatGHS(l.price)}</p>
    </li>
  );

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 max-lg:flex-1">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 max-lg:rounded-[14px] max-lg:bg-surface max-lg:p-3.5 max-lg:shadow-card">
        <h2 aria-label={job.vehicle ? `Number plate ${job.vehicle.plate}` : isSale ? 'Walk-in sale' : 'Walk-in customer'}>
          <Plate plate={job.vehicle?.plate ?? null} size="lg" walkIn={isSale ? 'Walk-in sale' : 'Walk-in'} />
        </h2>
        <StagePill job={job} />
        <p className="num ml-auto text-xs text-ink-3 sm:text-sm">{job.number}</p>
      </header>

      {job.voided && (
        <p className="border-l-4 border-red bg-red-50 px-3 py-2.5 text-sm text-red-d">
          <strong>Voided</strong> by {job.voided.by}, {shortDateTime(job.voided.at)}. Reason: {job.voided.reason}
        </p>
      )}

      {open && (
        <div className="grid grid-cols-2 gap-3 sm:flex">
          {job.status === 'pending' && (
            <button type="button" className="btn btn-primary col-span-2 max-lg:hidden sm:flex-1" disabled={missing} onClick={() => steps.ask('start', job.id, label)}>
              Start wash
            </button>
          )}
          {/* Jump to the end: a booked car can be paid for, finished and handed over from here without the steps in between. */}
          {job.status === 'pending' && canPay && can('job.advance') && (
            <button type="button" className="btn col-span-2 max-lg:hidden sm:flex-1" disabled={missing} onClick={() => setDialog({ kind: 'pay' })}>
              Pay · {formatGHS(job.balance)}
            </button>
          )}
          {/* Quick way: take the money and finish in one go. The step by step way (Mark complete, pay, dispatch) stays beside it. */}
          {job.status === 'in_progress' && canPay && (
            <button type="button" className="btn btn-primary col-span-2 max-lg:hidden sm:flex-1" onClick={() => setDialog({ kind: 'pay' })}>
              Pay · {formatGHS(job.balance)}
            </button>
          )}
          {/* Paid in full: the car can go. Dispatching finishes the wash on the way out, so there is no separate "complete" to press. */}
          {job.status === 'in_progress' && job.balance === 0 && can('job.dispatch') && (
            <button type="button" className="btn btn-primary col-span-2 max-lg:hidden sm:flex-1" onClick={() => steps.ask('dispatch', job.id, label)}>
              Dispatch car
            </button>
          )}
          {/* Only for someone who cannot take payments: they still need a way to say the wash is done. */}
          {job.status === 'in_progress' && !canPay && !(job.balance === 0 && can('job.dispatch')) && (
            <button type="button" className="btn btn-primary col-span-2 max-lg:hidden sm:flex-1" onClick={() => steps.ask('complete', job.id, label)}>
              Mark complete
            </button>
          )}
          {!isSale && (
            <button type="button" className="btn sm:flex-1" onClick={() => setDialog({ kind: 'add', of: 'service' })}>
              Add a service
            </button>
          )}
          <button type="button" className="btn sm:flex-1" onClick={() => setDialog({ kind: 'add', of: 'item' })}>
            Add an item
          </button>
          {can('job.void') && (
            <button type="button" className="btn text-red-d" onClick={() => setDialog({ kind: 'void' })}>
              Void
            </button>
          )}
        </div>
      )}
      {open && job.status === 'pending' && missing && <p className="-mt-2 text-sm font-medium text-amber">Assign an attendant to start</p>}
      {/* A finished job: the main step on its own line, everything else together on one row beneath it. */}
      {!open && !job.voided && (
        <div className="flex flex-wrap gap-2">
          {finished && canPay && (
            <button type="button" className="btn btn-primary basis-full max-lg:hidden sm:flex-1 sm:basis-0" onClick={() => setDialog({ kind: 'pay' })}>
              Take payment · {formatGHS(job.balance)}
            </button>
          )}
          {finished && can('job.dispatch') && job.balance === 0 && (
            <button type="button" className="btn btn-primary basis-full max-lg:hidden sm:flex-1 sm:basis-0" onClick={() => steps.ask('dispatch', job.id, label)}>
              Dispatch car
            </button>
          )}
          {finished && can('job.dispatch') && job.balance > 0 && mayRelease && (
            <button type="button" className="btn flex-1" onClick={() => setDialog({ kind: 'dispatch' })}>
              Dispatch with balance
            </button>
          )}
          {finished && canCorrect && !isSale && (
            <button type="button" className="btn" onClick={() => setDialog({ kind: 'add', of: 'service' })}>
              Add a service
            </button>
          )}
          <button type="button" className="btn" disabled={shareReceipt.isPending} onClick={() => shareReceipt.mutate()}>
            {shareReceipt.isPending ? 'Preparing…' : wantsPrint() ? 'Print receipt' : 'Share receipt'}
          </button>
          {canTip && (
            <button type="button" className="btn" onClick={() => setDialog({ kind: 'tip' })}>
              Add tip
            </button>
          )}
          {can('job.void') && (
            <button type="button" className="btn text-red-d" onClick={() => setDialog({ kind: 'void' })}>
              Void
            </button>
          )}
        </div>
      )}
      {finished && job.balance > 0 && can('job.dispatch') && !mayRelease && (
        <p className="-mt-2 text-sm font-medium text-amber">Collect {formatGHS(job.balance)} to dispatch, or ask a manager.</p>
      )}

      <section aria-label="Services and items" className={card}>
        {serviceLines.length > 0 && (
          <>
            <h3 className="border-b border-line px-4 py-3 text-sm font-medium text-ink-2">Services</h3>
            <ul className="divide-y divide-line-2">
            {serviceLines.map(renderLine)}
            </ul>
          </>
        )}
        {itemLines.length > 0 && (
          <>
            <h3 className={`border-b border-line px-4 py-3 text-sm font-medium text-ink-2 ${serviceLines.length > 0 ? 'border-t' : ''}`}>Items</h3>
            <ul className="divide-y divide-line-2">
            {itemLines.map(renderLine)}
            </ul>
          </>
        )}
        <dl className="num flex flex-col gap-1 border-t border-line px-4 py-3 text-sm">
          {job.discount > 0 && (
            <>
              <div className="flex justify-between text-ink-2">
                <dt>Subtotal</dt>
                <dd>{formatGHS(job.subtotal)}</dd>
              </div>
              <div className="flex justify-between text-ink-2">
                <dt>
                  Discount{' '}
                  {(open || (finished && canCorrect)) && (
                    <button type="button" className="tap text-blue-d" onClick={() => setDialog({ kind: 'discount' })}>
                      Change
                    </button>
                  )}
                </dt>
                <dd>− {formatAmount(job.discount)}</dd>
              </div>
            </>
          )}
          <div className="flex items-baseline justify-between">
            <dt className="font-medium text-ink">Total</dt>
            <dd className="display text-[24px] leading-none text-navy lg:text-[28px]">{formatGHS(job.total)}</dd>
          </div>
        </dl>
        {(open || (finished && canCorrect)) && !job.discount && (
          <div className="px-4 pb-1">
            <button type="button" className="tap text-sm text-blue-d" onClick={() => setDialog({ kind: 'discount' })}>
              Add discount
            </button>
          </div>
        )}
      </section>

      <section aria-label="Payments" className={card}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3">
          <h3 className="text-sm font-medium text-ink-2">Payments</h3>
          <PayPill total={job.total} paid={job.paid} />
          {canPay && !finished && (
            <button type="button" className="btn ml-auto h-9 px-3 text-sm" onClick={() => setDialog({ kind: 'pay' })}>
              Take payment
            </button>
          )}
        </div>
        {job.total > 0 && (
          <div className="px-4 pt-3 lg:hidden" aria-hidden="true">
            <div className="h-1.5 overflow-hidden rounded-full bg-line-2">
              <div className="h-full rounded-full bg-blue transition-[width] duration-500" style={{ width: `${Math.min(100, Math.round((job.paid / job.total) * 100))}%` }} />
            </div>
          </div>
        )}
        {job.payments.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-3">Nothing paid yet</p>
        ) : (
          <ul className="divide-y divide-line-2">
            {job.payments.map((p) => (
              <li key={p.id} className="flex items-start gap-3 px-4 py-2.5">
                <div className={`min-w-0 flex-1 ${p.voided ? 'text-ink-3' : ''}`}>
                  <p className={`font-medium ${p.voided ? 'line-through' : 'text-ink'}`}>
                    {p.method} <span className="num">{formatGHS(p.amount)}</span>
                  </p>
                  <p className="text-xs text-ink-3">
                    {p.by}, {shortDateTime(p.at)}
                    {p.reference && <> · Ref {p.reference}</>}
                  </p>
                  {p.voided && (
                    <p className="text-xs font-medium text-red-d">
                      Voided by {p.voided.by}: {p.voided.reason}
                    </p>
                  )}
                </div>
                {!p.voided && !job.voided && can('payment.void') && (
                  <button type="button" className="tap text-sm text-red-d" onClick={() => setDialog({ kind: 'voidPayment', paymentId: p.id })}>
                    Void
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <dl className="num flex flex-col gap-1 border-t border-line px-4 py-3 text-sm">
          <div className="flex justify-between text-ink-2">
            <dt>Paid</dt>
            <dd>{formatGHS(job.paid)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="font-medium text-ink">Balance</dt>
            <dd className={`font-medium ${job.balance > 0 ? 'text-amber' : 'text-green'}`}>{formatGHS(job.balance)}</dd>
          </div>
        </dl>
        {job.dispatchOverride && (
          <p className="border-t border-line bg-amber-50 px-4 py-2.5 text-sm text-ink">
            <strong>Left with a balance</strong> {job.dispatchOverride.by}: {job.dispatchOverride.note}
          </p>
        )}
      </section>

      <div className="grid gap-5 sm:grid-cols-2">
        <section aria-label="Car and customer" className={`${card} px-4 py-3`}>
          <h3 className="text-sm font-medium text-ink-2">Customer</h3>
          {job.customer ? (
            <>
              <p className="mt-1 font-medium text-ink">{job.customer.name}</p>
              <p className="text-sm text-ink-2">{job.customer.phone ? formatPhone(job.customer.phone) : 'No phone'}</p>
              <p className="mt-1 text-xs text-ink-3">{plural(job.customer.visits, 'visit')}</p>
            </>
          ) : (
            <p className="mt-1 text-ink-3">Walk-in customer</p>
          )}
          {car && <p className="mt-2 text-sm text-ink-2">{car}</p>}
          {job.notes && <p className="mt-2 border-t border-line-2 pt-2 text-sm text-ink">Note: {job.notes}</p>}
        </section>

        <section aria-label="History" className={`${card} px-4 py-3`}>
          <h3 className="text-sm font-medium text-ink-2">History</h3>
          <ul className="mt-1 divide-y divide-line-2">
            {job.history.map((h) => (
              <li key={h.id} className="py-2">
                <p className="text-sm font-medium text-ink">{describe(h)}</p>
                <p className="text-xs text-ink-3">
                  {h.by ?? 'Someone'}, {shortDateTime(h.at)}
                </p>
                {h.note && <p className="text-xs text-ink-2">Reason: {h.note}</p>}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Phone: the next step sits at the bottom, where a thumb reaches. Steps that cannot be undone are slid to confirm. */}
      {open && job.status === 'in_progress' && canPay ? (
        <div className="sticky bottom-0 z-20 -mx-4 -mb-4 mt-auto flex gap-3 rounded-t-[18px] bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_30px_rgba(7,31,71,0.14)] lg:hidden">
          <button type="button" className="btn btn-primary h-[54px] flex-1 rounded-xl text-base" onClick={() => setDialog({ kind: 'pay' })}>
            Pay · {formatGHS(job.balance)}
          </button>
        </div>
      ) : slide ? (
        <div className="sticky bottom-0 z-20 -mx-4 -mb-4 mt-auto flex rounded-t-[18px] bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_30px_rgba(7,31,71,0.14)] lg:hidden">
          <SlideToConfirm label={slide.label} busy={steps.busy} disabled={slide.disabled} onConfirm={() => steps.now(slide.step, job.id, label)} />
        </div>
      ) : (
        finished &&
        canPay && (
          <div className="sticky bottom-0 z-20 -mx-4 -mb-4 mt-auto flex rounded-t-[18px] bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_30px_rgba(7,31,71,0.14)] lg:hidden">
            <button type="button" className="btn btn-primary h-[54px] flex-1 rounded-xl text-base" onClick={() => setDialog({ kind: 'pay' })}>
              Take payment · {formatGHS(job.balance)}
            </button>
          </div>
        )
      )}

      <AssignPanel key={dialog?.kind === 'assign' ? dialog.lineId : 'none'} job={job} lineId={dialog?.kind === 'assign' ? dialog.lineId : null} onClose={close} />
      <EditLinePanel key={`edit-${dialog?.kind === 'edit' ? dialog.lineId : 'none'}`} job={job} lineId={dialog?.kind === 'edit' ? dialog.lineId : null} onClose={close} />
      <RemoveLinePanel key={`remove-${dialog?.kind === 'remove' ? dialog.lineId : 'none'}`} job={job} lineId={dialog?.kind === 'remove' ? dialog.lineId : null} onClose={close} />
      <AddServicePanel key={`add-${job.lines.length}-${dialog?.kind === 'add' ? dialog.of : ''}`} job={job} kind={dialog?.kind === 'add' ? dialog.of : 'service'} open={dialog?.kind === 'add'} onClose={close} />
      <DiscountPanel key={`discount-${job.discount}`} job={job} open={dialog?.kind === 'discount'} onClose={close} />
      <VoidPanel job={job} open={dialog?.kind === 'void'} onClose={close} />
      <PayPanel key={`pay-${job.paid}`} job={job} open={payingNow} onClose={close} />
      <VoidPaymentPanel key={`voidpay-${dialog?.kind === 'voidPayment' ? dialog.paymentId : 'none'}`} job={job} payment={voidingPayment} onClose={close} />
      <DispatchPanel job={job} open={dialog?.kind === 'dispatch'} onClose={close} />
      {steps.dialog}
      {steps.clashDialog}
      {canTip && <TipPanel open={dialog?.kind === 'tip'} onClose={close} attendants={tipRecipients} job={{ id: job.id, plate: label }} />}
    </div>
  );
}
