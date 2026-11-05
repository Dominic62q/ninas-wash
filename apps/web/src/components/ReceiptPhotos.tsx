import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { MAX_RECEIPT_PHOTOS, formatGHS, type ExpenseDto } from '@niinas/shared';
import { useToast } from './Toast';
import { FormError, Panel } from './ui';
import { apiUpload } from '../lib/api';
import { shrinkPhoto } from '../lib/image';

/** Server messages and the phone's own messages are both plain English. */
export const photoProblem = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.');

export const photoUrl = (id: number) => `/api/expenses/photos/${id}`;

/** A button that opens the camera or the photo library. Chosen pictures come back as files. */
export function PhotoButton({ label, onPick, disabled }: { label: string; onPick: (file: File) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // so the same picture can be chosen again
          if (file) onPick(file);
        }}
      />
      <button type="button" className="btn" disabled={disabled} onClick={() => input.current?.click()}>
        {label}
      </button>
    </>
  );
}

/** The photos kept for one expense, with a way to add another. Photos are never replaced or removed. */
export function ReceiptPanel({ expense, onClose }: { expense: ExpenseDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const upload = useMutation({
    mutationFn: async (file: File) => apiUpload(`/expenses/${expense!.id}/receipt`, await shrinkPhoto(file)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
      toast.success('Photo added');
    },
  });
  const photos = expense?.photos ?? [];
  const canAdd = expense !== null && expense.voided === null && photos.length < MAX_RECEIPT_PHOTOS;

  return (
    <Panel open={expense !== null} onClose={onClose} title="Receipt" tall>
      {expense && (
        <>
          <p className="text-sm text-ink-2">
            {expense.category} · {formatGHS(expense.amount)} · {expense.receipt ? `receipt ${expense.receipt}` : 'no receipt number'}
          </p>
          {photos.length === 0 ? (
            <p className="py-6 text-center text-ink-3">No photo of the receipt yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {photos.map((id, i) => (
                <li key={id}>
                  <a href={photoUrl(id)} target="_blank" rel="noreferrer" aria-label={`Open photo ${i + 1} full size`}>
                    <img src={photoUrl(id)} alt={`Receipt photo ${i + 1}`} className="w-full rounded-[10px] border border-line bg-band" />
                  </a>
                </li>
              ))}
            </ul>
          )}
          <FormError message={upload.isError ? photoProblem(upload.error) : null} />
          {canAdd && (
            <PhotoButton label={upload.isPending ? 'Uploading…' : photos.length === 0 ? 'Add a photo' : 'Add another photo'} disabled={upload.isPending} onPick={(f) => upload.mutate(f)} />
          )}
        </>
      )}
    </Panel>
  );
}
