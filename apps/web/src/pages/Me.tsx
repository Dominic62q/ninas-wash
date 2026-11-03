import { useState } from 'react';
import { Link } from 'react-router';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { ROLE_LABEL } from '../components/ProfileMenu';
import { ThemePicker } from '../components/ThemePicker';
import { ConfirmPanel, Pill } from '../components/ui';
import { useAuth } from '../lib/auth';
import { meFor, navFor } from '../lib/nav';

/** The phone's Me tab: who is signed in, the setup screens, password and sign out. */
export function Me() {
  const { user, can, logout } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const items = meFor(navFor(can));

  async function signOut() {
    setBusy(true);
    await logout();
    setBusy(false);
    setConfirming(false);
  }

  const row = 'flex min-h-14 items-center gap-3 px-3.5 py-2.5 text-ink no-underline active:bg-band';
  const icon = 'grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-blue-50 text-navy';

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3">
      <section aria-label="Your profile" className="flex items-center gap-3.5 rounded-[14px] bg-surface p-4 shadow-card">
        <Avatar name={user.name} size="lg" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-lg font-bold text-navy">{user.name}</p>
          <p className="mt-1.5 flex items-center gap-2 text-[13px] text-ink-3">
            <Pill tone="blue">{ROLE_LABEL[user.role]}</Pill>
            {user.username.toLowerCase() !== ROLE_LABEL[user.role].toLowerCase() && <span className="num truncate">{user.username}</span>}
          </p>
        </div>
      </section>

      <ul className="overflow-hidden rounded-[14px] bg-surface shadow-card">
        {items.map((item) => (
          <li key={item.path} className="border-t border-line first:border-t-0">
            <Link to={item.path} className={row}>
              <span className={icon}>
                <Icon name={item.icon} size={18} />
              </span>
              <span className="flex-1 font-semibold">{item.label}</span>
              <span aria-hidden="true" className="text-ink-3">
                ›
              </span>
            </Link>
          </li>
        ))}
        <li className="border-t border-line first:border-t-0">
          <Link to="/change-password" className={row}>
            <span className={icon}>
              <Icon name="lock" size={18} />
            </span>
            <span className="flex-1 font-semibold">Change password</span>
            <span aria-hidden="true" className="text-ink-3">
              ›
            </span>
          </Link>
        </li>
      </ul>

      <section aria-label="Appearance" className="flex items-center justify-between gap-3 rounded-[14px] bg-surface px-3.5 py-3 shadow-card">
        <span className="font-semibold">Appearance</span>
        <div className="w-[190px]">
          <ThemePicker />
        </div>
      </section>

      <button type="button" className="btn h-[50px] text-[15.5px] text-red" onClick={() => setConfirming(true)}>
        Sign out
      </button>
      <p className="text-center text-xs text-ink-3">Version {new Date(__APP_BUILD__).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })}</p>

      <ConfirmPanel
        open={confirming}
        danger
        title="Sign out?"
        message="You will need your username and password to get back in."
        confirmLabel="Sign out"
        busy={busy}
        onConfirm={() => void signOut()}
        onClose={() => (busy ? undefined : setConfirming(false))}
      />
    </div>
  );
}
