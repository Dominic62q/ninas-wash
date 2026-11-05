import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  attendantInput,
  createUserInput,
  formatPhone,
  outranks,
  type AttendantDto,
  type TemporaryPassword,
  type UserDto,
} from '@niinas/shared';
import { Avatar } from '../components/Avatar';
import { Select } from '../components/Dropdown';
import { useToast } from '../components/Toast';
import { Check, ConfirmPanel, EmptyRow, Field, FormError, Panel, Pill, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { plural, shortDate } from '../lib/format';
import { useAssignableRoles, useRoles } from '../lib/useRoles';

// ---- attendants ---------------------------------------------------------------

function AttendantForm({ attendant, onDone }: { attendant: AttendantDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(attendant?.name ?? '');
  const [phone, setPhone] = useState(attendant?.phone ?? '');
  const [active, setActive] = useState(attendant?.active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Marking someone as left takes them off every list, so it asks first. */
  const [leaving, setLeaving] = useState<unknown>(null);

  const save = useMutation({
    mutationFn: (body: unknown) =>
      attendant ? api(`/attendants/${attendant.id}`, { method: 'PATCH', body }) : api('/attendants', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['attendants'] });
      toast.success(attendant ? 'Attendant updated' : `${name.trim()} added`);
      onDone();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = attendantInput.safeParse({ name, phone });
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= issue.message;
      setErrors(found);
      return;
    }
    setErrors({});
    if (attendant && attendant.active && !active) return setLeaving({ ...parsed.data, active });
    save.mutate(attendant ? { ...parsed.data, active } : parsed.data);
  }

  return (
    <form onSubmit={submit} onChange={() => setErrors((e) => (Object.keys(e).length ? {} : e))} noValidate className="flex flex-col gap-5">
      <Field label="Name" error={errors.name}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} autoComplete="off" />
      </Field>
      <Field label="Phone (optional)" error={errors.phone}>
        <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!errors.phone} />
      </Field>
      {attendant && (
        <Check label="Still works here" checked={active} onChange={setActive} />
      )}
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <div className="flex gap-3">
        <button type="submit" className="btn btn-primary flex-1" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : attendant ? 'Save changes' : 'Add attendant'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ConfirmPanel
        open={leaving !== null}
        danger
        title={`Mark ${name.trim() || 'this attendant'} as left?`}
        message="They will no longer be offered when a car is booked. Past jobs and commission stay as they are."
        confirmLabel="Mark as left"
        busy={save.isPending}
        onConfirm={() => {
          save.mutate(leaving);
          setLeaving(null);
        }}
        onClose={() => setLeaving(null)}
      />
    </form>
  );
}

function Attendants({ shown }: { shown: boolean }) {
  const list = useQuery({
    queryKey: ['attendants', 'all'],
    queryFn: () => api<{ attendants: AttendantDto[] }>('/attendants?includeInactive=1'),
  });
  const [editing, setEditing] = useState<AttendantDto | null | undefined>(undefined);
  const rows = list.data?.attendants ?? [];

  return (
    <section aria-labelledby="attendants-h" className={`flex flex-col gap-3 ${shown ? '' : 'max-lg:hidden'}`}>
      <div className="flex items-center gap-3">
        <h2 id="attendants-h" className="display flex-1 text-[22px] text-navy max-lg:sr-only">
          Attendants
        </h2>
        <button type="button" className="btn btn-primary max-lg:ml-auto max-lg:h-10 max-lg:px-4" onClick={() => setEditing(null)}>
          Add attendant
        </button>
      </div>
      <div className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        {list.isPending && <SkeletonRows />}
        {list.isError && <EmptyRow>{errorMessage(list.error)}</EmptyRow>}
        {list.isSuccess && rows.length === 0 && <EmptyRow>No attendants yet. Add the first one.</EmptyRow>}
        <ul>
          {rows.map((a) => (
            <li key={a.id} className="border-b border-line-2 last:border-b-0">
              <button
                type="button"
                onClick={() => setEditing(a)}
                className="flex w-full cursor-pointer items-center gap-4 px-4 py-3.5 text-left hover:bg-band max-lg:gap-3 max-lg:py-2.5"
              >
                <span className={a.active ? '' : 'opacity-50'}>
                  <Avatar name={a.name} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-medium ${a.active ? 'text-ink' : 'text-ink-3'}`}>{a.name}</span>
                  <span className="block truncate text-sm text-ink-3">
                    {a.phone ? formatPhone(a.phone) : 'No phone'}
                    <span className="lg:hidden"> · {a.active ? plural(a.jobsThisWeek, 'job') : `left ${shortDate(a.leftOn)}`}</span>
                  </span>
                </span>
                <span className="text-right text-sm text-ink-2 max-lg:hidden">
                  {a.active ? `${plural(a.jobsThisWeek, 'job')} this week` : `Left ${shortDate(a.leftOn)}`}
                </span>
                {a.active ? <span className="max-lg:hidden"><Pill tone="green">Active</Pill></span> : <Pill tone="grey">Left</Pill>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? 'Edit attendant' : 'Add attendant'}>
        {editing !== undefined && <AttendantForm key={editing?.id ?? 'new'} attendant={editing} onDone={() => setEditing(undefined)} />}
      </Panel>
    </section>
  );
}

// ---- users ----------------------------------------------------------------------

/** Shown once. After this the password exists only as a hash and cannot be looked up again. */
function TemporaryPasswordPanel({ who, password, onClose }: { who: string; password: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Panel open={password !== null} onClose={onClose} title="Temporary password">
      <p className="text-ink-2">
        Give this to <strong className="text-ink">{who}</strong>. They choose their own at first sign-in.
      </p>
      <p className="num select-all border border-line bg-band px-4 py-4 text-center font-mono text-[28px] font-bold tracking-[0.12em] text-navy">{password}</p>
      <p className="border-l-4 border-amber bg-amber-50 px-3 py-2.5 text-sm font-medium text-amber">
        Shown once. If lost, reset it again.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          className="btn flex-1"
          onClick={() => {
            if (password) void navigator.clipboard?.writeText(password).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn btn-primary flex-1" onClick={onClose}>
          Done
        </button>
      </div>
    </Panel>
  );
}

function UserForm({
  user,
  onDone,
  onCreated,
}: {
  user: UserDto | null;
  onDone: () => void;
  onCreated: (who: string, password: string) => void;
}) {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const { assignable } = useAssignableRoles();
  /** The chosen role's id. Empty until the list arrives, then the person with the least access is the safe starting point. */
  const [picked, setPicked] = useState<string>(user ? String(user.roleId) : '');
  const [active, setActive] = useState(user?.active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const isSelf = user !== null && me?.id === user.id;
  // Only roles that do no more than you can. Whoever is being edited keeps their current role in the list.
  const options = [...assignable];
  if (user && !options.some((o) => o.id === user.roleId)) options.unshift({ id: user.roleId, name: user.role, locked: user.roleLocked, permissions: [], members: 0 });
  const initial = String(options.slice().sort((a, b) => a.permissions.length - b.permissions.length)[0]?.id ?? '');
  const toast = useToast();
  /** Switching someone off or changing their role takes effect at once, so it asks first. */
  const [risky, setRisky] = useState<{ body: unknown; title: string; message: string; label: string } | null>(null);

  const save = useMutation({
    mutationFn: (body: unknown) =>
      user
        ? api<{ user: UserDto }>(`/users/${user.id}`, { method: 'PATCH', body })
        : api<{ user: UserDto } & TemporaryPassword>('/users', { method: 'POST', body }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      const created = data as { user: UserDto } & Partial<TemporaryPassword>;
      toast.success(created.temporaryPassword ? `${created.user.name} added` : 'Changes saved');
      if (created.temporaryPassword) onCreated(created.user.name, created.temporaryPassword);
      onDone();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (user) {
      if (!name.trim()) return setErrors({ name: 'Enter the name' });
      setErrors({});
      // Your own role and status are not sent, so the server never has to refuse them.
      if (isSelf) return save.mutate({ name });
      const roleId = Number(picked || user.roleId);
      const body = { name, roleId, active };
      const first = name.trim().split(/\s+/)[0] ?? 'This person';
      const nextRole = options.find((o) => o.id === roleId)?.name ?? 'another role';
      if (user.active && !active) {
        return setRisky({ body, title: `Switch off ${first}?`, message: `${name.trim()} is signed out now and cannot sign in until you switch them back on.`, label: 'Switch off' });
      }
      if (roleId !== user.roleId) {
        return setRisky({ body, title: `Change ${first} to ${nextRole}?`, message: `${name.trim()} goes from ${user.role} to ${nextRole}. What they can see and do changes right away.`, label: 'Change role' });
      }
      return save.mutate(body);
    }
    const parsed = createUserInput.safeParse({ name, username, roleId: Number(picked || initial) });
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= issue.message;
      setErrors(found);
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  return (
    <form onSubmit={submit} onChange={() => setErrors((e) => (Object.keys(e).length ? {} : e))} noValidate className="flex flex-col gap-5">
      <Field label="Name" error={errors.name}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} autoComplete="off" />
      </Field>
      <Field label="Username" hint={user ? undefined : 'Letters, numbers, dots, dashes'} error={errors.username}>
        <input
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={user !== null}
          aria-invalid={!!errors.username}
          autoCapitalize="none"
          autoComplete="off"
        />
      </Field>
      {!isSelf && (
        <Select
          label="Role"
          value={picked || initial}
          onChange={setPicked}
          options={options.map((o) => ({ value: String(o.id), label: o.name }))}
        />
      )}
      {user && !isSelf && <Check label="Can sign in" hint="Off signs them out" checked={active} onChange={setActive} />}
      {isSelf && <p className="text-sm text-ink-3">You cannot change your own role or access</p>}
      {!user && <p className="text-sm text-ink-3">A one-time password is shown after saving</p>}
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <div className="flex gap-3">
        <button type="submit" className="btn btn-primary flex-1" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : user ? 'Save changes' : 'Add user'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ConfirmPanel
        open={risky !== null}
        danger={risky?.label === 'Switch off'}
        title={risky?.title ?? ''}
        message={risky?.message ?? ''}
        confirmLabel={risky?.label ?? 'Confirm'}
        busy={save.isPending}
        onConfirm={() => {
          if (risky) save.mutate(risky.body);
          setRisky(null);
        }}
        onClose={() => setRisky(null)}
      />
    </form>
  );
}

function Users({ shown: visible }: { shown: boolean }) {
  const { user: me, can } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['users'], queryFn: () => api<{ users: UserDto[] }>('/users') });
  const [editing, setEditing] = useState<UserDto | null | undefined>(undefined);
  const [shown, setShown] = useState<{ who: string; password: string } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<UserDto | null>(null);
  const rows = list.data?.users ?? [];

  const reset = useMutation({
    mutationFn: (u: UserDto) => api<TemporaryPassword>(`/users/${u.id}/reset-password`, { method: 'POST' }).then((r) => ({ who: u.name, password: r.temporaryPassword })),
    onSuccess: async (result) => {
      setResetError(null);
      setShown(result);
      toast.success(`Password reset for ${result.who}`);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => {
      setResetError(errorMessage(e));
      toast.error(errorMessage(e));
    },
  });

  /** The server enforces this too. Here it only hides buttons that would be refused. */
  const { permissions } = useAuth();
  const roles = useRoles();
  const permissionsOfRole = (u: UserDto) => roles.data?.find((r) => r.id === u.roleId)?.permissions ?? [];
  const canLookAfter = (u: UserDto) => u.id !== me?.id && outranks(permissions, permissionsOfRole(u));
  const canReset = canLookAfter;
  const owner = can('user.manage');

  return (
    <section aria-labelledby="users-h" className={`flex flex-col gap-3 ${visible ? '' : 'max-lg:hidden'}`}>
      <div className="flex items-center gap-3">
        <h2 id="users-h" className="display flex-1 text-[22px] text-navy max-lg:sr-only">
          Users
        </h2>
        {owner && (
          <button type="button" className="btn btn-primary max-lg:ml-auto max-lg:h-10 max-lg:px-4" onClick={() => setEditing(null)}>
            Add user
          </button>
        )}
      </div>
      <FormError message={resetError} />
      <div className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        {list.isPending && <SkeletonRows />}
        {list.isError && <EmptyRow>{errorMessage(list.error)}</EmptyRow>}
        <ul>
          {rows.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line-2 px-4 py-3.5 last:border-b-0 max-lg:gap-x-2 max-lg:py-2.5">
              <div className="flex min-w-0 flex-1 basis-48 items-center gap-3 max-lg:basis-full">
                <span className={u.active ? '' : 'opacity-50'}>
                  <Avatar name={u.name} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`truncate font-medium ${u.active ? 'text-ink' : 'text-ink-3'}`}>
                    {u.name}
                    {u.id === me?.id && <span className="ml-2 text-xs font-medium text-ink-3">You</span>}
                  </p>
                  <p className="text-sm text-ink-3">
                    {u.username} · {u.lastLoginAt ? `Last in ${shortDate(u.lastLoginAt)}` : 'Never signed in'}
                  </p>
                </div>
              </div>
              <Pill tone={u.roleLocked ? 'blue' : 'grey'}>{u.role}</Pill>
              {!u.active ? <Pill tone="grey">Switched off</Pill> : u.mustChangePassword ? <Pill tone="amber">Temporary password</Pill> : <span className="max-lg:hidden"><Pill tone="green">Active</Pill></span>}
              <div className="flex gap-2 max-lg:ml-auto">
                {canReset(u) && (
                  <button
                    type="button"
                    className="btn h-11 px-4 max-lg:h-9 max-lg:px-3 max-lg:text-sm"
                    disabled={reset.isPending}
                    onClick={() => setConfirming(u)}
                  >
                    Reset password
                  </button>
                )}
                {owner && (u.id === me?.id || canLookAfter(u)) && (
                  <button type="button" className="btn h-11 px-4 max-lg:h-9 max-lg:px-3 max-lg:text-sm" onClick={() => setEditing(u)}>
                    Edit
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <ConfirmPanel
        open={confirming !== null}
        title="Reset password"
        message={`Reset ${confirming?.name ?? ''}'s password? They will be signed out.`}
        confirmLabel="Reset password"
        busy={reset.isPending}
        danger
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) reset.mutate(confirming, { onSettled: () => setConfirming(null) });
        }}
      />
      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? 'Edit user' : 'Add user'}>
        {editing !== undefined && (
          <UserForm
            key={editing?.id ?? 'new'}
            user={editing}
            onDone={() => setEditing(undefined)}
            onCreated={(who, password) => setShown({ who, password })}
          />
        )}
      </Panel>
      <TemporaryPasswordPanel who={shown?.who ?? ''} password={shown?.password ?? null} onClose={() => setShown(null)} />
    </section>
  );
}

export function Staff() {
  const { can } = useAuth();
  const both = can('attendant.manage');
  const [tab, setTab] = useState<'attendants' | 'users'>('attendants');
  return (
    <div className="flex flex-col gap-3 lg:gap-8">
      {both && (
        <div role="tablist" aria-label="Staff" className="flex gap-0.5 rounded-[10px] bg-line-2 p-0.5 lg:hidden">
          {(['attendants', 'users'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`h-9 flex-1 cursor-pointer rounded-lg px-3 text-sm font-medium transition-colors ${
                tab === t ? 'bg-surface text-navy shadow-card' : 'text-ink-2'
              }`}
            >
              {t === 'attendants' ? 'Attendants' : 'Users'}
            </button>
          ))}
        </div>
      )}
      {both && <Attendants shown={tab === 'attendants'} />}
      <Users shown={!both || tab === 'users'} />
    </div>
  );
}
