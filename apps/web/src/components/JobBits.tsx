import { useQuery } from '@tanstack/react-query';
import { MAX_LINE_QUANTITY, type JobStatus, type AttendantDto, type ServiceDto } from '@niinas/shared';
import { api } from '../lib/api';
import { MultiSelect } from './Dropdown';
import { Pill } from './ui';

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

/** A dropdown for picking the people who wash a service. Two or more share the commission equally. */
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
  return <MultiSelect label={label} placeholder="Pick attendants" options={options.map((a) => ({ value: a.id, label: a.name }))} value={value} onChange={onChange} />;
}

export const sharedNote = (count: number) => (count >= 2 ? `Shared equally between ${count}` : null);

/** How many of a service. Minus and plus, with the number between; never goes below one or above the limit. */
export function QuantityStepper({ label, value, onChange }: { label: string; value: number; onChange: (next: number) => void }) {
  const step = 'flex h-[44px] w-[44px] cursor-pointer items-center justify-center text-lg leading-none text-ink-2 active:bg-band disabled:cursor-default disabled:text-ink-3/50 lg:h-9 lg:w-9';
  return (
    <div role="group" aria-label={`How many ${label}`} className="inline-flex items-center border-[1.5px] border-line-strong bg-surface max-lg:rounded-[10px]">
      <button type="button" aria-label={`Fewer ${label}`} className={step} disabled={value <= 1} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span aria-live="polite" className="num min-w-8 text-center text-sm font-semibold text-ink">
        {value}
      </span>
      <button type="button" aria-label={`More ${label}`} className={step} disabled={value >= MAX_LINE_QUANTITY} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}
