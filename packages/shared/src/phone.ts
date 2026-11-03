/**
 * Phone numbers are stored in one plain form so the same person is never saved twice:
 * Ghana numbers as 10 digits starting 0 ("0245510932"), anything else as "+" and digits.
 * Returns undefined when the text is not a usable number.
 */
export function normalizePhone(input: string): string | undefined {
  const s = input.trim().replace(/[\s().-]/g, '');
  const intl = /^(?:\+|00)?233(\d{9})$/.exec(s);
  if (intl) return `0${intl[1]}`;
  if (/^0\d{9}$/.test(s)) return s;
  if (/^\+\d{8,15}$/.test(s)) return s;
  return undefined;
}

/** "0245510932" -> "024 551 0932". Other numbers are shown as stored. */
export function formatPhone(stored: string | null | undefined): string {
  if (!stored) return '';
  const m = /^(0\d{2})(\d{3})(\d{4})$/.exec(stored);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : stored;
}
