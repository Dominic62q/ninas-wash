import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { PERMISSION_CATALOG, PERMISSION_GROUPS, PERMISSION_KEYS, can, withNeeded, type Permission, type RoleDto } from '@niinas/shared';
import { useToast } from '../components/Toast';
import { ConfirmPanel, EmptyRow, Field, FormError, Panel, Pill, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { plural } from '../lib/format';
import { ROLES_KEY, useRoles } from '../lib/useRoles';

const NEEDS = new Map<Permission, readonly Permission[]>(PERMISSION_CATALOG.map((p) => [p.key, ('needs' in p ? p.needs : []) as readonly Permission[]]));

/** Taking one away also takes away whatever cannot work without it. */
function without(picked: readonly Permission[], key: Permission): Permission[] {
  const keep = new Set(picked.filter((p) => p !== key));
  let shrank = true;
  while (shrank) {
    shrank = false;
    for (const p of [...keep]) {
      if ((NEEDS.get(p) ?? []).some((n) => !keep.has(n))) {
        keep.delete(p);
        shrank = true;
      }
    }
  }
  return PERMISSION_KEYS.filter((k) => keep.has(k));
}

function RoleForm({ role, onDone }: { role: RoleDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user, permissions: mine } = useAuth();
  const [name, setName] = useState(role?.name ?? '');
  const [picked, setPicked] = useState<Permission[]>(role?.permissions ?? []);
  const [error, setError] = useState<string | undefined>();
  const [removing, setRemoving] = useState(false);

  const readOnly = role?.locked === true || (role !== null && role.id === user?.roleId);

  const save = useMutation({
    mutationFn: (body: { name: string; permissions: Permission[] }) =>
      role ? api(`/roles/${role.id}`, { method: 'PATCH', body }) : api('/roles', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROLES_KEY });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success(role ? 'Role saved' : `${name.trim()} added`);
      onDone();
    },
  });

  const remove = useMutation({
    mutationFn: () => api(`/roles/${role!.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROLES_KEY });
      toast.success('Role removed');
      onDone();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Enter a name for the role');
    setError(undefined);
    save.mutate({ name: name.trim(), permissions: picked });
  }

  function toggle(key: Permission, on: boolean) {
    setPicked((now) => (on ? withNeeded([...now, key]) : without(now, key)));
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      {role?.locked ? (
        <p className="text-sm text-ink-2">The owner role can always do everything, so it cannot be changed or removed.</p>
      ) : readOnly ? (
        <p className="text-sm text-ink-2">You have this role, so you cannot change it. Ask the owner.</p>
      ) : null}

      <Field label="Name" error={error}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} autoComplete="off" maxLength={40} aria-invalid={!!error} />
      </Field>

      <div className="flex flex-col gap-5">
        {PERMISSION_GROUPS.map((group) => {
          const items = PERMISSION_CATALOG.filter((p) => p.group === group);
          return (
            <fieldset key={group} className="flex flex-col gap-2.5">
              <legend className="mb-1 text-sm font-medium text-ink-2">{group}</legend>
              {items.map((p) => {
                const on = role?.locked ? true : picked.includes(p.key);
                const beyond = !can(mine, p.key);
                return (
                  <label key={p.key} className={`flex items-start gap-3 ${readOnly || beyond ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={readOnly || beyond}
                      onChange={(e) => toggle(p.key, e.target.checked)}
                      className="mt-0.5 h-5 w-5 flex-none accent-blue"
                    />
                    <span className="flex flex-col">
                      <span className="text-sm text-ink">{p.label}</span>
                      {beyond && !readOnly && <span className="text-xs text-ink-3">You do not have this yourself</span>}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          );
        })}
      </div>

      <FormError message={save.isError ? errorMessage(save.error) : remove.isError ? errorMessage(remove.error) : null} />
      <div className="flex flex-wrap gap-3">
        {!readOnly && (
          <button type="submit" className="btn btn-primary flex-1" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : role ? 'Save role' : 'Add role'}
          </button>
        )}
        <button type="button" className={readOnly ? 'btn flex-1' : 'btn'} onClick={onDone}>
          {readOnly ? 'Close' : 'Cancel'}
        </button>
      </div>
      {role && !readOnly && (
        <div className="border-t border-line-2 pt-4">
          {role.members > 0 ? (
            <p className="text-sm text-ink-3">{plural(role.members, 'person', 'people')} still {role.members === 1 ? 'has' : 'have'} this role. Give them another role before removing it.</p>
          ) : (
            <button type="button" className="btn text-red-d" onClick={() => setRemoving(true)}>
              Remove role
            </button>
          )}
        </div>
      )}
      <ConfirmPanel
        open={removing}
        danger
        title={`Remove ${role?.name ?? 'this role'}?`}
        message="Nobody has it, so nobody is affected. It cannot be brought back, but you can make it again."
        confirmLabel="Remove role"
        busy={remove.isPending}
        onConfirm={() => {
          remove.mutate();
          setRemoving(false);
        }}
        onClose={() => setRemoving(false)}
      />
    </form>
  );
}

/** Roles and what each may do. The owner's role is fixed; everything else can be made, changed and removed. */
export function Roles() {
  const list = useRoles();
  const [editing, setEditing] = useState<RoleDto | null | undefined>(undefined);
  const rows = list.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3 lg:gap-4">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-ink-3">A role is a name and a list of what that person may do. Give people a role when you add them.</p>
        <button type="button" className="btn btn-primary max-lg:h-10 max-lg:px-4" onClick={() => setEditing(null)}>
          Add role
        </button>
      </div>

      <section aria-label="Roles" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        {list.isPending && <SkeletonRows count={3} />}
        {list.isError && <EmptyRow>{errorMessage(list.error)}</EmptyRow>}
        <ul>
          {rows.map((r) => (
            <li key={r.id} className="border-b border-line-2 last:border-b-0">
              <button type="button" onClick={() => setEditing(r)} className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left hover:bg-band max-lg:py-3 max-lg:active:bg-band">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{r.name}</span>
                  <span className="block text-sm text-ink-3">
                    {plural(r.members, 'person', 'people')} · {r.locked ? 'Everything' : `${r.permissions.length} of ${PERMISSION_KEYS.length} things`}
                  </span>
                </span>
                {r.locked && <Pill tone="blue">Fixed</Pill>}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? editing.name : 'Add role'} tall>
        {editing !== undefined && <RoleForm key={editing?.id ?? 'new'} role={editing} onDone={() => setEditing(undefined)} />}
      </Panel>
    </div>
  );
}
