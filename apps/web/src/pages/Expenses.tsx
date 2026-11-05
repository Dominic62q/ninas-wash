import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { expenseInput, formatGHS, parseGHS, reasonInput, type ExpenseDto, type ExpensesOverview, type PayMethodDto } from '@niinas/shared';
import { Select } from '../components/Dropdown';
import { MethodPicker } from '../components/PaymentBits';
import { PhotoButton, ReceiptPanel, photoProblem } from '../components/ReceiptPhotos';
import { useToast } from '../components/Toast';
import { EmptyRow, Field, FormError, Panel, Pill, SkeletonRows, Strip, errorMessage } from '../components/ui';
import { api, apiUpload } from '../lib/api';
import { shrinkPhoto } from '../lib/image';
import { useActiveCategories } from '../lib/useCategories';
import { useActiveMethods } from '../lib/useMethods';
import { useAuth } from '../lib/auth';
import { addDays, clock, dayName, newKey, plural, ymd } from '../lib/format';

const RANGES = [
  { value: 'today', label: 'Today', days: 0 },
  { value: 'week', label: 'Last 7 days', days: 6 },
  { value: 'month', label: 'Last 30 days', days: 29 },
] as const;
type Range = (typeof RANGES)[number]['value'];


/** Today and the six days before it, the days an expense can be written down on. */
const dayOptions = (closed: string[]) =>
  Array.from({ length: 8 }, (_, i) => {
    const day = ymd(addDays(new Date(), -i));
    return { value: day, label: `${dayName(day)}${closed.includes(day) ? ' (closed)' : ''}` };
  });

function AddExpensePanel({ open, onClose, closedDays }: { open: boolean; onClose: () => void; closedDays: string[] }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { active: categories } = useActiveCategories();
  const [pickedCategory, setPickedCategory] = useState<string | null>(null);
  const category = categories.find((c) => c.name === pickedCategory) ?? categories[0] ?? null;
  const [photo, setPhoto] = useState<File | null>(null);
  const { first } = useActiveMethods();
  const [picked, setPicked] = useState<PayMethodDto | null>(null);
  const method = picked ?? first;
  const [amountText, setAmountText] = useState('');
  const [spentOn, setSpentOn] = useState(() => ymd(new Date()));
  const [receipt, setReceipt] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  // One key per form: a double-tap or a retry after a bad connection saves the expense once.
  const [idemKey, setIdemKey] = useState(newKey);

  const save = useMutation({
    mutationFn: async (body: unknown) => {
      const saved = await api<{ expense: ExpenseDto }>('/expenses', { method: 'POST', body });
      // The expense is safe once it is saved. A photo that fails to go up can be added again from the list.
      if (!photo) return { problem: null as string | null };
      try {
        await apiUpload(`/expenses/${saved.expense.id}/receipt`, await shrinkPhoto(photo));
        return { problem: null as string | null };
      } catch (e) {
        return { problem: photoProblem(e) };
      }
    },
    onSuccess: async ({ problem }) => {
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
      await queryClient.invalidateQueries({ queryKey: ['daily-close'] });
      if (problem) toast.error(`Expense saved, but the photo did not go up. ${problem} Open the expense to add it again.`);
      else toast.success(`${formatGHS(parseGHS(amountText) ?? 0)} for ${category?.name.toLowerCase() ?? 'the expense'} saved`);
      setPhoto(null);
      setAmountText('');
      setReceipt('');
      setNote('');
      setIdemKey(newKey());
      onClose();
    },
  });

  function submit() {
    const amount = parseGHS(amountText);
    if (amount === null || amount <= 0) return setError('Enter the amount, like 20 or 20.50');
    if (!method) return setError('Pick how it was paid');
    if (!category) return setError('Pick a category');
    if (category.needsNote && !note.trim()) return setError('Say what it was for');
    const parsed = expenseInput.safeParse({ category: category.name, amount, methodId: method.id, spentOn, receipt, note, idemKey });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the details');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={open} onClose={onClose} title="Add an expense">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink-2">Category</span>
        <Select label="Category" value={category?.name ?? ''} options={categories.map((c) => ({ value: c.name, label: c.name }))} onChange={(v) => { setPickedCategory(v); setError(null); }} />
      </div>
      <Field label="Amount (GH₵)">
        <input className="input" inputMode="decimal" value={amountText} onChange={(e) => { setAmountText(e.target.value); setError(null); }} autoComplete="off" placeholder="0.00" aria-label="Amount" />
      </Field>
      <MethodPicker label="Paid with" value={method?.id ?? null} onChange={setPicked} />
      <Field label="Receipt" hint="A photo or a receipt number. With neither, the expense is flagged.">
        <input className="input" value={receipt} onChange={(e) => setReceipt(e.target.value)} maxLength={80} autoComplete="off" placeholder="Receipt number, or where the paper is kept" />
        <div className="flex items-center gap-3">
          <PhotoButton label={photo ? 'Change photo' : 'Take or choose a photo'} onPick={(f) => { setPhoto(f); setError(null); }} />
          {photo && (
            <>
              <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{photo.name}</span>
              <button type="button" className="tap text-sm text-red-d" onClick={() => setPhoto(null)}>
                Remove
              </button>
            </>
          )}
        </div>
      </Field>
      <Field label={category?.needsNote ? 'What was it for?' : 'Note (optional)'}>
        <input className="input" value={note} onChange={(e) => { setNote(e.target.value); setError(null); }} maxLength={200} autoComplete="off" placeholder={category?.needsNote ? 'Gate padlock' : '20 litres of liquid soap'} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink-2">Day it was spent</span>
        <Select label="Day" value={spentOn} options={dayOptions(closedDays)} onChange={setSpentOn} />
      </div>
      <FormError message={error ?? (save.isError ? errorMessage(save.error) : null)} />
      <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
        {save.isPending ? 'Saving…' : 'Save expense'}
      </button>
    </Panel>
  );
}

function VoidExpensePanel({ expense, onClose }: { expense: ExpenseDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api(`/expenses/${expense?.id}/void`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
      await queryClient.invalidateQueries({ queryKey: ['daily-close'] });
      toast.success('Expense voided');
      onClose();
    },
  });

  function submit() {
    const parsed = reasonInput.safeParse({ reason });
    if (!parsed.success) return setError('Say why the expense is being voided');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={expense !== null} onClose={onClose} title="Void this expense">
      {expense && (
        <>
          <p className="text-ink-2">
            <strong className="text-ink">{formatGHS(expense.amount)}</strong> for {expense.category.toLowerCase()} will no longer count. It stays on record with your name and reason.
          </p>
          <Field label="Reason" error={error ?? undefined}>
            <input className="input" value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} maxLength={200} autoComplete="off" aria-invalid={!!error} placeholder="Typed the wrong amount" />
          </Field>
          <FormError message={save.isError ? errorMessage(save.error) : null} />
          <button type="button" className="btn border-red bg-red text-white" disabled={save.isPending} onClick={submit}>
            {save.isPending ? 'Voiding…' : 'Void expense'}
          </button>
        </>
      )}
    </Panel>
  );
}

function ExpenseRow({ expense, closed, canVoid, onVoid, onReceipt }: { expense: ExpenseDto; closed: boolean; canVoid: boolean; onVoid: () => void; onReceipt: () => void }) {
  const gone = expense.voided !== null;
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <div className={`min-w-0 flex-1 ${gone ? 'text-ink-3' : ''}`}>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`font-medium ${gone ? 'line-through' : 'text-ink'}`}>{expense.category}</span>
          {gone ? (
            <Pill tone="grey">Voided</Pill>
          ) : (
            <>
              {expense.methodId !== 1 && <Pill tone="blue">{expense.method}</Pill>}
              {expense.receipt === null && expense.photos.length === 0 && <Pill tone="amber">No receipt</Pill>}
            </>
          )}
        </p>
        <p className="truncate text-xs text-ink-3">
          {[expense.note, expense.receipt ? `Receipt ${expense.receipt}` : null].filter(Boolean).join(' · ') || null}
          {expense.note || expense.receipt ? ' · ' : ''}
          {expense.by}, {clock(expense.at)}
        </p>
        {expense.voided && (
          <p className="text-xs font-medium text-red-d">
            Voided by {expense.voided.by}: {expense.voided.reason}
          </p>
        )}
      </div>
      {(expense.photos.length > 0 || !gone) && (
        <button type="button" className="tap text-sm text-blue-d" onClick={onReceipt}>
          {expense.photos.length > 0 ? 'Photo' : 'Add photo'}
        </button>
      )}
      <p className={`num font-semibold ${gone ? 'text-ink-3 line-through' : 'text-ink'}`}>{formatGHS(expense.amount)}</p>
      {canVoid && !gone && !closed && (
        <button type="button" className="tap text-sm text-red-d" onClick={onVoid}>
          Void
        </button>
      )}
    </li>
  );
}

export function Expenses() {
  const { can } = useAuth();
  const [range, setRange] = useState<Range>('week');
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<ExpenseDto | null>(null);
  const [receiptFor, setReceiptFor] = useState<number | null>(null);

  const days = RANGES.find((r) => r.value === range)!.days;
  const to = ymd(new Date());
  const from = ymd(addDays(new Date(), -days));
  const query = useQuery({
    queryKey: ['expenses', from, to],
    queryFn: () => api<ExpensesOverview>(`/expenses?from=${from}&to=${to}&limit=300`),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  const closedDays = data?.closedDays ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
      <div className="flex items-center gap-3">
        <div role="radiogroup" aria-label="Dates" className="flex flex-1 gap-2 overflow-x-auto">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={range === r.value}
              onClick={() => setRange(r.value)}
              className={`btn h-9 shrink-0 px-3 text-sm ${range === r.value ? 'border-blue bg-blue-50 text-blue-d' : ''}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-primary shrink-0 px-4" onClick={() => setAdding(true)}>
          Add expense
        </button>
      </div>

      <FormError message={query.isError ? errorMessage(query.error) : null} />

      <Strip
        compact
        items={[
          { label: 'Spent', value: formatGHS(data?.sum ?? 0) },
          { label: 'From the drawer', short: 'Drawer', value: formatGHS(data?.drawerSum ?? 0) },
          { label: 'Paid another way', short: 'Other', value: formatGHS(data?.otherSum ?? 0) },
          { label: 'No receipt', short: 'No receipt', value: String(data?.withoutReceipt ?? 0) },
        ]}
      />

      <section aria-label="Expenses" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        {query.isPending ? (
          <SkeletonRows count={4} />
        ) : data && data.expenses.length > 0 ? (
          <ul>
            {data.expenses.map((e, i) => {
              const closed = closedDays.includes(e.spentOn);
              const first = i === 0 || data.expenses[i - 1]!.spentOn !== e.spentOn;
              return (
                <Fragment key={e.id}>
                  {first && (
                    <li className="flex items-center gap-2 border-b border-t border-line bg-band px-4 py-1.5 text-xs font-medium text-ink-2 first:border-t-0">
                      {dayName(e.spentOn)}
                      {closed && <Pill tone="grey">Closed</Pill>}
                    </li>
                  )}
                  <ExpenseRow expense={e} closed={closed} canVoid={can('expense.void')} onVoid={() => setVoiding(e)} onReceipt={() => setReceiptFor(e.id)} />
                </Fragment>
              );
            })}
          </ul>
        ) : (
          <EmptyRow>{range === 'today' ? 'No expenses today' : 'No expenses in this period'}</EmptyRow>
        )}
      </section>
      {data && data.expenses.length > 0 && <p className="text-center text-xs text-ink-3">{plural(data.expenses.length, 'expense')}. Voided ones are not counted above.</p>}

      <AddExpensePanel open={adding} onClose={() => setAdding(false)} closedDays={closedDays} />
      <ReceiptPanel expense={data?.expenses.find((e) => e.id === receiptFor) ?? null} onClose={() => setReceiptFor(null)} />
      <VoidExpensePanel key={voiding?.id ?? 'none'} expense={voiding} onClose={() => setVoiding(null)} />
    </div>
  );
}
