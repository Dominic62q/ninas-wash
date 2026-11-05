import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { PayMethodDto } from '@niinas/shared';
import { useToast } from '../components/Toast';
import { Check, EmptyRow, Field, FormError, Panel, Pill, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { METHODS_KEY, useMethods } from '../lib/useMethods';

function MethodForm({ method, onDone }: { method: PayMethodDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(method?.name ?? '');
  const [inDrawer, setInDrawer] = useState(method?.inDrawer ?? false);
  const [requiresReference, setRequiresReference] = useState(method?.requiresReference ?? false);
  const [active, setActive] = useState(method?.active ?? true);
  const [error, setError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (body: unknown) =>
      method ? api(`/payment-methods/${method.id}`, { method: 'PATCH', body }) : api('/payment-methods', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      toast.success(method ? 'Saved' : `${name.trim()} added`);
      onDone();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Enter a name, like Bank transfer');
    setError(undefined);
    save.mutate({ name: name.trim(), ...(lockDrawer ? {} : { inDrawer }), requiresReference, active });
  }

  // Once money has moved through a method, old days were counted with its drawer setting, so that setting stays.
  const lockDrawer = method?.used === true;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <Field label="Name" error={error}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={40} aria-invalid={!!error} placeholder="Bank transfer" />
      </Field>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Check label="The money goes in the cash drawer" checked={inDrawer} onChange={setInDrawer} disabled={lockDrawer} hint="Cash does. MoMo and bank transfers do not. The daily close counts only what is in the drawer." />
          {lockDrawer && <p className="pl-8 text-xs text-ink-3">This has already been used, so this setting is fixed. Add a new method instead.</p>}
        </div>
        <Check label="Ask for a reference" checked={requiresReference} onChange={setRequiresReference} hint="The cashier must type the MoMo or transfer reference before saving." />
        {method && <Check label="Available to use" checked={active} onChange={setActive} hint="Switch off a way you no longer take. Old records keep it." />}
      </div>
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn btn-primary flex-1" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : method ? 'Save' : 'Add method'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The ways customers pay and the business pays out. Cash and MoMo to begin with; the owner adds the rest. */
export function PaymentMethods() {
  const list = useMethods();
  const [editing, setEditing] = useState<PayMethodDto | null | undefined>(undefined);
  const rows = list.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3 lg:gap-4">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-ink-3">The ways money is paid in and out. They show up when taking a payment, adding an expense or paying commission.</p>
        <button type="button" className="btn btn-primary max-lg:h-10 max-lg:px-4" onClick={() => setEditing(null)}>
          Add method
        </button>
      </div>

      <section aria-label="Payment methods" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        {list.isPending && <SkeletonRows count={3} />}
        {list.isError && <EmptyRow>{errorMessage(list.error)}</EmptyRow>}
        <ul>
          {rows.map((m) => (
            <li key={m.id} className="border-b border-line-2 last:border-b-0">
              <button type="button" onClick={() => setEditing(m)} className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left hover:bg-band max-lg:py-3 max-lg:active:bg-band">
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-medium ${m.active ? 'text-ink' : 'text-ink-3'}`}>{m.name}</span>
                  <span className="block text-sm text-ink-3">
                    {m.inDrawer ? 'In the cash drawer' : 'Not in the drawer'}
                    {m.requiresReference ? ' · asks for a reference' : ''}
                  </span>
                </span>
                {!m.active && <Pill tone="grey">Off</Pill>}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? editing.name : 'Add a payment method'}>
        {editing !== undefined && <MethodForm key={editing?.id ?? 'new'} method={editing} onDone={() => setEditing(undefined)} />}
      </Panel>
    </div>
  );
}
