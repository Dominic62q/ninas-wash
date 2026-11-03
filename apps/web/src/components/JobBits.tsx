import { useQuery } from '@tanstack/react-query';
import type { JobStatus, AttendantDto, ServiceDto } from '@niinas/shared';
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
