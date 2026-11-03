import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { changePasswordInput } from '@niinas/shared';
import { useToast } from '../components/Toast';
import { Field, FormError, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Used twice: when someone signs in with a temporary password (they cannot go anywhere else until
 * they finish), and any time a person wants to change their own password.
 */
export function ChangePassword() {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const forced = user?.mustChangePassword ?? false;

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: unknown) => api('/auth/change-password', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      toast.success('Password changed');
      navigate('/', { replace: true });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    const parsed = changePasswordInput.safeParse({ currentPassword: current, newPassword: next });
    if (!parsed.success) for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= issue.message;
    if (next !== again) found.again = 'The two passwords are not the same';
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) return;
    save.mutate(parsed.data);
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[460px] flex-col justify-center gap-6 px-5 py-10">
      <div>
        <h1 className="display text-[24px] leading-none text-navy lg:text-[30px]">{forced ? 'Choose your password' : 'Change password'}</h1>
        <p className="mt-2 text-ink-2">{forced ? 'Choose a new password to continue.' : 'Other devices will be signed out.'}</p>
      </div>
      <form onSubmit={submit} onChange={() => setErrors((e) => (Object.keys(e).length ? {} : e))} noValidate className="flex flex-col gap-5">
        <Field label={forced ? 'Temporary password' : 'Current password'} error={errors.currentPassword}>
          <input
            className="input"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            aria-invalid={!!errors.currentPassword}
            autoComplete="current-password"
          />
        </Field>
        <Field label="New password" hint="At least 8 characters." error={errors.newPassword}>
          <input
            className="input"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-invalid={!!errors.newPassword}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm password" error={errors.again}>
          <input
            className="input"
            type="password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            aria-invalid={!!errors.again}
            autoComplete="new-password"
          />
        </Field>
        <FormError message={save.isError ? errorMessage(save.error) : null} />
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save password'}
        </button>
      </form>
      {forced ? (
        <button type="button" className="tap self-start text-sm text-blue-d" onClick={() => void logout()}>
          Sign out instead
        </button>
      ) : (
        <Link to="/" className="tap self-start text-sm text-blue-d no-underline">
          Back
        </Link>
      )}
    </main>
  );
}
