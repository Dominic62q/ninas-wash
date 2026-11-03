import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// A short note that appears after something is done, so a save never feels silent.
// Forms keep their own inline errors; a toast is for the result.

type Tone = 'success' | 'error';
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const SHOW_MS: Record<Tone, number> = { success: 3500, error: 6500 };
const MAX_SHOWN = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: Tone, message: string) => {
      const id = next.current++;
      // A small buzz on phones that support it, so a save is felt as well as seen.
      if (typeof navigator !== 'undefined') navigator.vibrate?.(tone === 'success' ? 12 : [30, 40, 30]);
      setToasts((all) => [...all.slice(-(MAX_SHOWN - 1)), { id, tone, message }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), SHOW_MS[tone]));
    },
    [dismiss],
  );

  useEffect(() => {
    const live = timers.current;
    return () => live.forEach((t) => window.clearTimeout(t));
  }, []);

  const api = useMemo<ToastApi>(() => ({ success: (m) => push('success', m), error: (m) => push('error', m) }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-24 z-50 flex flex-col items-stretch gap-2 lg:inset-x-auto lg:bottom-6 lg:right-6 lg:w-[380px]"
      >
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className={`toast pointer-events-auto flex min-h-11 cursor-pointer items-center gap-3 border border-line border-l-[5px] bg-surface px-3.5 py-2.5 text-left text-sm font-bold text-ink shadow-[0_6px_20px_rgba(11,42,91,0.18)] ${
              t.tone === 'success' ? 'border-l-green' : 'border-l-red'
            }`}
          >
            <span
              aria-hidden="true"
              className={`grid h-6 w-6 flex-none place-items-center rounded-full text-sm text-white ${t.tone === 'success' ? 'bg-green' : 'bg-red'}`}
            >
              {t.tone === 'success' ? '✓' : '!'}
            </span>
            <span className="min-w-0 flex-1">{t.message}</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
