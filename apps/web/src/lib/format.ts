/** "2 Oct", or "2 Oct 2025" when it was not this year. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "2 Oct, 14:05" */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return `${shortDate(iso)}, ${new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "14:05" */
export const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

/** "2026-10-30". Ghana keeps UTC all year, and so does the server, so days are cut at UTC midnight. */
/** A unique key for one form. `randomUUID` only exists on https and localhost, so a phone opening the app by IP needs the fallback. */
export const newKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** "Today", "Yesterday", or "Mon 27 Oct" for a day like "2026-10-27". */
export function dayName(day: string): string {
  const today = new Date();
  if (day === ymd(today)) return 'Today';
  if (day === ymd(addDays(today, -1))) return 'Yesterday';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC', ...(d.getUTCFullYear() === today.getUTCFullYear() ? {} : { year: 'numeric' }) });
}
