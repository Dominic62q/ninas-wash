import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from './Toast';
import { ConfirmPanel, Field, Panel, errorMessage } from './ui';

export type JobStep = 'start' | 'complete' | 'dispatch';

interface Asking {
  step: JobStep;
  id: number;
  plate: string;
}

const COPY: Record<JobStep, { title: (plate: string) => string; message: string; label: string; done: (plate: string) => string }> = {
  start: {
    title: (p) => `Start washing ${p}?`,
    message: 'The wash starts and the timer runs',
    label: 'Start wash',
    done: (p) => `Wash started on ${p}`,
  },
  complete: {
    title: (p) => `Mark ${p} complete?`,
    message: 'The wash is finished. Commission is worked out from the price now.',
    label: 'Mark complete',
    done: (p) => `${p} is done`,
  },
  dispatch: {
    title: (p) => `Dispatch ${p}?`,
    message: 'The car leaves the wash. This cannot be taken back.',
    label: 'Dispatch car',
    done: (p) => `${p} dispatched`,
  },
};

/**
 * Start, complete and dispatch each move a car on for good, so each one asks first.
 * Call `ask(...)` from a button and render `dialog` once on the page.
 */
export function useJobSteps() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [asking, setAsking] = useState<Asking | null>(null);
  /** Someone on this wash is busy on another service. A manager can go ahead anyway, with a reason. */
  const [clash, setClash] = useState<{ asking: Asking; message: string } | null>(null);
  const [busyNote, setBusyNote] = useState('');

  const run = useMutation({
    mutationFn: ({ step, id, note }: Asking & { note?: string }) =>
      step === 'dispatch'
        ? api(`/jobs/${id}/dispatch`, { method: 'POST', body: {} })
        : api(`/jobs/${id}/status`, { method: 'POST', body: { to: step === 'start' ? 'in_progress' : 'completed', busyNote: note || null } }),
    onSuccess: (_data, { step, plate }) => {
      toast.success(COPY[step].done(plate));
      setClash(null);
      setBusyNote('');
    },
    onError: (e, vars) => {
      if (e instanceof ApiError && e.code === 'attendant_busy' && can('job.override_busy')) {
        setClash({ asking: { step: vars.step, id: vars.id, plate: vars.plate }, message: e.message });
        return;
      }
      toast.error(errorMessage(e));
    },
    onSettled: () => {
      setAsking(null);
      return queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const copy = COPY[asking?.step ?? 'start'];
  const plate = (asking?.plate ?? '').toUpperCase();

  return {
    ask: (step: JobStep, id: number, plateText: string) => setAsking({ step, id, plate: plateText.toUpperCase() }),
    /** Phone: the slider already asked, so run the step straight away. */
    now: (step: JobStep, id: number, plateText: string) => run.mutate({ step, id, plate: plateText.toUpperCase() }),
    busy: run.isPending,
    dialog: (
      <ConfirmPanel
        open={asking !== null}
        title={copy.title(plate)}
        message={copy.message}
        confirmLabel={copy.label}
        busy={run.isPending}
        onConfirm={() => asking && run.mutate(asking)}
        onClose={() => (run.isPending ? undefined : setAsking(null))}
      />
    ),
    clashDialog: (
      <Panel open={clash !== null} onClose={() => (run.isPending ? undefined : setClash(null))} title="Someone is busy">
        <p className="text-ink-2">{clash?.message}</p>
        <Field label="Why is it fine to go ahead?" hint="Your name and this reason go on record">
          <input className="input" value={busyNote} onChange={(e) => setBusyNote(e.target.value)} maxLength={200} autoComplete="off" placeholder="The first car is waiting on the customer" />
        </Field>
        <button type="button" className="btn btn-primary" disabled={run.isPending || busyNote.trim().length < 3} onClick={() => clash && run.mutate({ ...clash.asking, note: busyNote.trim() })}>
          {run.isPending ? 'Saving…' : 'Start anyway'}
        </button>
      </Panel>
    ),
  };
}
