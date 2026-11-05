import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useToast } from './Toast';
import { ConfirmPanel, errorMessage } from './ui';

export type JobStep = 'start' | 'complete' | 'dispatch';

interface Asking {
  step: JobStep;
  id: number;
  plate: string;
}

const COPY: Record<JobStep, { title: (plate: string) => string; message: string; label: string; done: (plate: string) => string }> = {
  start: {
    title: (p) => `Start washing ${p}?`,
    message: 'The car moves to Washing and the timer starts',
    label: 'Start wash',
    done: (p) => `Wash started on ${p}`,
  },
  complete: {
    title: (p) => `Mark ${p} complete?`,
    message: 'The wash is finished. Commission is worked out from the price now, and the car is ready for payment.',
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
  const [asking, setAsking] = useState<Asking | null>(null);

  const run = useMutation({
    mutationFn: ({ step, id }: Asking) =>
      step === 'dispatch'
        ? api(`/jobs/${id}/dispatch`, { method: 'POST', body: {} })
        : api(`/jobs/${id}/status`, { method: 'POST', body: { to: step === 'start' ? 'in_progress' : 'completed' } }),
    onSuccess: (_data, { step, plate }) => toast.success(COPY[step].done(plate)),
    onError: (e) => toast.error(errorMessage(e)),
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
  };
}
