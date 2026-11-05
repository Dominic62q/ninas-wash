import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { ExpenseCategoryDto } from '@niinas/shared';
import { useToast } from '../components/Toast';
import { Check, EmptyRow, Field, FormError, Panel, Pill, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { CATEGORIES_KEY, useExpenseCategories } from '../lib/useCategories';

function CategoryForm({ category, onDone }: { category: ExpenseCategoryDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(category?.name ?? '');
  const [needsNote, setNeedsNote] = useState(category?.needsNote ?? false);
  const [active, setActive] = useState(category?.active ?? true);
  const [error, setError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (body: unknown) =>
      category ? api(`/expense-categories/${category.id}`, { method: 'PATCH', body }) : api('/expense-categories', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY });
      toast.success(category ? 'Saved' : `${name.trim()} added`);
      onDone();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!category && !name.trim()) return setError('Enter a name, like Security');
    setError(undefined);
    save.mutate(category ? { needsNote, active } : { name: name.trim(), needsNote });
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      {category ? (
        <p className="text-sm text-ink-2">
          The name stays as it is, because past expenses carry it. To rename, add a new category and switch this one off.
        </p>
      ) : (
        <Field label="Name" error={error}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={40} aria-invalid={!!error} placeholder="Security" />
        </Field>
      )}
      <div className="flex flex-col gap-4">
        <Check label="Ask what it was for" checked={needsNote} onChange={setNeedsNote} hint="The person must write a short note, like they do for Other." />
        {category && <Check label="Available to use" checked={active} onChange={setActive} hint="Switch off one you no longer use. Old expenses keep it." />}
      </div>
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn btn-primary flex-1" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : category ? 'Save' : 'Add category'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The kinds of expense people pick from. The owner adds new ones and switches off the ones no longer used. */
export function ExpenseCategories() {
  const list = useExpenseCategories();
  const [editing, setEditing] = useState<ExpenseCategoryDto | null | undefined>(undefined);
  const rows = list.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3 lg:gap-4">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-ink-3">What the money is spent on. These are the choices when someone adds an expense.</p>
        <button type="button" className="btn btn-primary max-lg:h-10 max-lg:px-4" onClick={() => setEditing(null)}>
          Add category
        </button>
      </div>

      <section aria-label="Expense categories" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        {list.isPending && <SkeletonRows count={4} />}
        {list.isError && <EmptyRow>{errorMessage(list.error)}</EmptyRow>}
        <ul>
          {rows.map((c) => (
            <li key={c.id} className="border-b border-line-2 last:border-b-0">
              <button type="button" onClick={() => setEditing(c)} className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left hover:bg-band max-lg:py-3 max-lg:active:bg-band">
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-medium ${c.active ? 'text-ink' : 'text-ink-3'}`}>{c.name}</span>
                  {c.needsNote && <span className="block text-sm text-ink-3">Asks what it was for</span>}
                </span>
                {!c.active && <Pill tone="grey">Off</Pill>}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? editing.name : 'Add a category'}>
        {editing !== undefined && <CategoryForm key={editing?.id ?? 'new'} category={editing} onDone={() => setEditing(undefined)} />}
      </Panel>
    </div>
  );
}
