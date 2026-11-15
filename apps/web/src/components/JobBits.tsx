import { useQuery } from '@tanstack/react-query';
import { MAX_LINE_QUANTITY, type JobStatus, type AttendantDto, type ServiceDto } from '@niinas/shared';
import { api } from '../lib/api';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Select } from './Dropdown';
import { Field, Pill } from './ui';

export const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  dispatched: 'Dispatched',
};

const TONE = { pending: 'amber', in_progress: 'blue', completed: 'green', dispatched: 'grey' } as const;

export function StatusPill({ status }: { status: JobStatus }) {
  return <Pill tone={TONE[status]}>{STATUS_LABEL[status]}</Pill>;
}

/** What is offered today. Switched-off services and attendants who left are not returned. */
export function useServices() {
  return useQuery({ queryKey: ['services', 'active'], queryFn: () => api<{ services: ServiceDto[] }>('/services') });
}

export function useAttendants() {
  return useQuery({ queryKey: ['attendants', 'active'], queryFn: () => api<{ attendants: AttendantDto[] }>('/attendants') });
}

/** A dropdown for picking who washes a service: one person per service. The value is a list of zero or one id. */
export function AttendantPicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: number; name: string }[];
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const choices = [{ value: '', label: 'Pick an attendant' }, ...options.map((a) => ({ value: String(a.id), label: a.name }))];
  return <Select label={label} value={value[0] === undefined ? '' : String(value[0])} options={choices} onChange={(v) => onChange(v === '' ? [] : [Number(v)])} />;
}

/**
 * One person does one service at a time. When the server says someone is busy, a manager can still go ahead by giving a reason;
 * everyone else just sees the message. Put it under a form's error and send `note` as `busyNote`.
 */
export function BusyNote({ error, note, onNote }: { error: unknown; note: string; onNote: (v: string) => void }) {
  const { can } = useAuth();
  if (!(error instanceof ApiError) || error.code !== 'attendant_busy' || !can('job.override_busy')) return null;
  return (
    <Field label="Why is it fine to go ahead?" hint="Your name and this reason go on record. Save again to put them on.">
      <input className="input" value={note} onChange={(e) => onNote(e.target.value)} maxLength={200} autoComplete="off" placeholder="The first car is waiting on the customer" />
    </Field>
  );
}

/** How many of a service. Minus and plus, with the number between; never goes below one or above the limit. */
export function QuantityStepper({ label, value, onChange, max = MAX_LINE_QUANTITY }: { label: string; value: number; onChange: (next: number) => void; max?: number }) {
  const step = 'flex h-[44px] w-[44px] cursor-pointer items-center justify-center text-lg leading-none text-ink-2 active:bg-band disabled:cursor-default disabled:text-ink-3/50 lg:h-9 lg:w-9';
  return (
    <div role="group" aria-label={`How many ${label}`} className="inline-flex items-center border-[1.5px] border-line-strong bg-surface max-lg:rounded-[10px]">
      <button type="button" aria-label={`Fewer ${label}`} className={step} disabled={value <= 1} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span aria-live="polite" className="num min-w-8 text-center text-sm font-semibold text-ink">
        {value}
      </span>
      <button type="button" aria-label={`More ${label}`} className={step} disabled={value >= Math.min(max, MAX_LINE_QUANTITY)} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}
