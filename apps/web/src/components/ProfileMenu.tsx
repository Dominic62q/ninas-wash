import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../lib/auth';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { ThemePicker } from './ThemePicker';
import { ConfirmPanel, Panel } from './ui';

export const ROLE_LABEL = { cashier: 'Cashier', manager: 'Manager', owner: 'Owner' } as const;

/**
 * The signed-in person: their avatar opens a small sheet with who they are, a way to change
 * their password, and Sign out, which always asks first so a stray tap never drops a till session.
 */
export function ProfileMenu({ variant }: { variant: 'header' | 'rail' }) {
  const { user, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  async function signOut() {
    setBusy(true);
    await logout();
    setBusy(false);
    setConfirming(false);
    setMenu(false);
  }

  return (
    <>
      {variant === 'header' ? (
        <button
          type="button"
          aria-label={`${user.name}, ${ROLE_LABEL[user.role]}. Open profile`}
          aria-haspopup="dialog"
          onClick={() => setMenu(true)}
          className="-mr-1 grid h-11 w-11 flex-none cursor-pointer place-items-center rounded-full active:scale-95 lg:hidden"
        >
          <Avatar name={user.name} />
        </button>
      ) : (
        <div className="mt-3 border-t border-white/15 pt-3">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setMenu(true)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/5"
          >
            <Avatar name={user.name} ring />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium text-white">{user.name}</span>
              {user.name.toLowerCase() !== ROLE_LABEL[user.role].toLowerCase() && <span className="block text-xs text-[#8fa3c7]">{ROLE_LABEL[user.role]}</span>}
            </span>
            <span aria-hidden="true" className="text-[#8fa3c7]">
              <Icon name="more" size={16} />
            </span>
          </button>
        </div>
      )}

      <Panel open={menu} onClose={() => (busy ? undefined : setMenu(false))} title="Your profile">
        <div className="flex items-center gap-3.5">
          <Avatar name={user.name} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-lg font-bold leading-tight text-ink">{user.name}</p>
            <p className="text-sm text-ink-3">
              {ROLE_LABEL[user.role]}
              {user.username.toLowerCase() !== ROLE_LABEL[user.role].toLowerCase() && (
                <>
                  {' · '}
                  <span className="num">{user.username}</span>
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] font-bold text-ink-2">Appearance</p>
          <ThemePicker />
        </div>
        <div className="flex flex-col gap-2">
          <Link to="/change-password" onClick={() => setMenu(false)} className="btn justify-between no-underline">
            Change password <span aria-hidden="true">›</span>
          </Link>
          <button type="button" className="btn border-red/40 text-red" onClick={() => setConfirming(true)}>
            Sign out
          </button>
        </div>
        <p className="mt-auto text-center text-xs text-ink-3">Version {new Date(__APP_BUILD__).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })}</p>
      </Panel>

      <ConfirmPanel
        open={confirming}
        danger
        title="Sign out?"
        message="You will need your username and password to get back in."
        confirmLabel="Sign out"
        busy={busy}
        onConfirm={() => void signOut()}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}
