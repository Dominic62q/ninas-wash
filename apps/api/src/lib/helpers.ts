import { randomInt } from 'node:crypto';

/** Letters and digits that cannot be mistaken for each other when read aloud or copied by hand (no 0/O, 1/l/I). */
const READABLE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** A one-time password an admin hands over. The person must replace it at first sign-in. */
export function temporaryPassword(length = 12): string {
  return Array.from({ length }, () => READABLE[randomInt(READABLE.length)]).join('');
}

/**
 * Compare a saved record with the fields being changed. Returns just the fields that really change,
 * as `before` and `after`, ready for the audit log. Returns null when nothing changes.
 */
export function changedFields<T extends object>(
  current: T,
  patch: Partial<T>,
): { before: Partial<T>; after: Partial<T> } | null {
  const before: Partial<T> = {};
  const after: Partial<T> = {};
  let any = false;
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const next = patch[key];
    if (next === undefined) continue;
    if (JSON.stringify(current[key]) !== JSON.stringify(next)) {
      before[key] = current[key];
      after[key] = next;
      any = true;
    }
  }
  return any ? { before, after } : null;
}

/** True if a database error is "that value already exists", optionally for one named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | null)?.cause ?? (error as { code?: string; constraint?: string });
  if (cause?.code !== '23505') return false;
  return constraint ? cause.constraint === constraint : true;
}
