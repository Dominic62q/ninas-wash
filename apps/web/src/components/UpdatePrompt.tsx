import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const CHECK_EVERY_MS = 30 * 60_000;
const REMIND_AFTER_MS = 30 * 60_000;

/**
 * A new version of the app is downloaded quietly in the background, then offered here. It never
 * reloads by itself, because a till left open all day may be halfway through a payment.
 * The app asks the server for a newer version every half hour, and whenever it comes back into view.
 */
export function UpdatePrompt() {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => {
        if (navigator.onLine) void registration.update().catch(() => undefined);
      };
      window.setInterval(check, CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    },
  });

  // "Later" is not "never": someone leaving the till open all day still hears about it again.
  useEffect(() => {
    if (!dismissed) return;
    const t = window.setTimeout(() => setDismissed(false), REMIND_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [dismissed]);

  if (!needRefresh || dismissed) return null;

  return (
    <div
      role="alertdialog"
      aria-label="Update ready"
      className="toast fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[60] border border-line border-l-[5px] border-l-blue bg-surface p-3.5 shadow-[0_8px_28px_rgba(11,42,91,0.28)] lg:inset-x-auto lg:right-6 lg:top-5 lg:w-[400px]"
    >
      <p className="display text-lg leading-tight text-navy">A new version is ready</p>
      <p className="mt-0.5 text-sm text-ink-2">Finish what you are doing, then refresh to get the latest changes.</p>
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <button type="button" className="btn h-10" onClick={() => setDismissed(true)} disabled={busy}>
          Later
        </button>
        <button
          type="button"
          className="btn btn-primary h-10"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void updateServiceWorker(true);
          }}
        >
          {busy ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>
    </div>
  );
}
