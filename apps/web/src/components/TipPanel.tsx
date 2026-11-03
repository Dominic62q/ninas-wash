import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { TIP_KINDS, formatGHS, parseGHS, tipInput, type TipKind } from '@niinas/shared';
import { Select } from './Dropdown';
import { useToast } from './Toast';
import { Choice, Field, FormError, Panel, errorMessage } from './ui';
import { api } from '../lib/api';
import { newKey } from '../lib/format';

const KIND_LABEL: Record<TipKind, string> = { held: 'We keep it', direct: 'Given to them' };
const KIND_OPTIONS = TIP_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }));

export interface TipTarget {
  /** Pre-picked when the tip is for one car. */
  job?: { id: number; plate: string } | null;
  /** Who can get it: the people who washed that car, or everyone on the Tips page. */
  attendants: { id: number; name: string }[];
  /** On the Tips page: cars from the last day or two to pick from. Left out when the car is already known. */
  jobOptions?: { value: string; label: string }[];
}

/** Write down a tip. Held tips stay with us until a manager hands them over. */
export function TipPanel({ open, onClose, attendants, job, jobOptions }: TipTarget & { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [picked, setAttendantId] = useState('');
  // Only one person to choose from (a car with one attendant): no need to ask.
  const attendantId = attendants.length === 1 ? String(attendants[0]!.id) : picked;
  const [kind, setKind] = useState<TipKind>('held');
  const [amountText, setAmountText] = useState('');
  const [jobPick, setJobPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  // One key per form: a double-tap or a retry after a bad connection saves the tip once.
  const [idemKey, setIdemKey] = useState(newKey);

  const amount = parseGHS(amountText);
  const options = [{ value: '', label: 'Choose who it is for' }, ...attendants.map((a) => ({ value: String(a.id), label: a.name }))];

  const save = useMutation({
    mutationFn: (body: unknown) => api('/tips', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tips'] });
      const who = attendants.find((a) => String(a.id) === attendantId)?.name ?? 'attendant';
      toast.success(`${formatGHS(amount ?? 0)} tip saved for ${who}`);
      setAmountText('');
      setJobPick('');
      setIdemKey(newKey());
      onClose();
    },
  });

  function submit() {
    if (!attendantId) return setError('Choose who the tip is for');
    if (amount === null || amount <= 0) return setError('Enter the amount, like 5 or 5.50');
    const parsed = tipInput.safeParse({ attendantId: Number(attendantId), jobId: job?.id ?? (jobPick ? Number(jobPick) : null), amount, kind, idemKey });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the details');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={open} onClose={onClose} title="Add a tip">
      {job && (
        <p className="text-ink-2">
          For <strong className="text-ink">{job.plate.toUpperCase()}</strong>
        </p>
      )}
      {attendants.length === 1 ? (
        <p className="text-ink-2">
          For <strong className="text-ink">{attendants[0]!.name}</strong>
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-bold text-ink-2">Who is it for?</span>
          <Select label="Attendant" value={attendantId} options={options} onChange={(v) => { setAttendantId(v); setError(null); }} invalid={!!error && !attendantId} />
        </div>
      )}
      {!job && jobOptions && jobOptions.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-bold text-ink-2">Which car? (optional)</span>
          <Select label="Car" value={jobPick} options={jobOptions} onChange={setJobPick} />
        </div>
      )}
      <Choice label="How was it given?" value={kind} options={KIND_OPTIONS} onChange={setKind} />
      <p className="-mt-3 text-xs text-ink-3">
        {kind === 'held' ? 'Money we took at the till and keep until a manager hands it over.' : 'The customer gave it straight to them. Written down only.'}
      </p>
      <Field label="Amount (GH₵)">
        <input className="input" inputMode="decimal" value={amountText} onChange={(e) => { setAmountText(e.target.value); setError(null); }} autoComplete="off" placeholder="0.00" aria-label="Amount" />
      </Field>
      <FormError message={error ?? (save.isError ? errorMessage(save.error) : null)} />
      <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
        {save.isPending ? 'Saving…' : 'Save tip'}
      </button>
    </Panel>
  );
}
