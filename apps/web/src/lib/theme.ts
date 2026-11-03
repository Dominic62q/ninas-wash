import { useEffect, useSyncExternalStore } from 'react';

// Light, dark, or follow the phone. The page carries the answer as data-theme; public/theme-init.js sets it first, before anything is drawn.

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const KEY = 'niinas-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let choice: ThemeChoice = stored();
const listeners = new Set<() => void>();

const isDark = (c: ThemeChoice): boolean => c === 'dark' || (c === 'system' && (window.matchMedia?.(DARK_QUERY).matches ?? false));

function apply(): void {
  const dark = isDark(choice);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0A111F' : '#0B2A5B');
}

export function setTheme(next: ThemeChoice): void {
  choice = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Private browsing may refuse to save; the choice still applies until the page closes.
  }
  apply();
  listeners.forEach((l) => l());
}

/** Once, at the top of the app: keeps the page in step with the choice, and with the phone's own setting while on Auto. */
export function useThemeSync(): void {
  useEffect(() => {
    apply();
    const m = window.matchMedia?.(DARK_QUERY);
    if (!m) return;
    const on = () => choice === 'system' && apply();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
}

export function useTheme(): { choice: ThemeChoice; set: (c: ThemeChoice) => void } {
  const current = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => choice,
  );
  return { choice: current, set: setTheme };
}
