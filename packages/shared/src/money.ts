/**
 * Money is always a whole number of pesewas (100 pesewas = GH₵1).
 * GH₵12.50 is stored and sent as 1250. Only the screen turns it into text.
 */

export type Pesewas = number;

export function assertPesewas(value: number, label = 'amount'): asserts value is Pesewas {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a whole number of pesewas, got ${value}`);
  }
}

const formatter = new Intl.NumberFormat('en-GH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 1250 -> "12.50", 123456 -> "1,234.56". No currency symbol, for tables whose header says GH₵. */
export function formatAmount(pesewas: Pesewas): string {
  assertPesewas(pesewas);
  const sign = pesewas < 0 ? '-' : '';
  const abs = Math.abs(pesewas);
  return sign + formatter.format(Math.trunc(abs / 100) + (abs % 100) / 100);
}

/** 1250 -> "GH₵12.50" */
export function formatGHS(pesewas: Pesewas): string {
  const text = formatAmount(pesewas);
  return text.startsWith('-') ? `-GH₵${text.slice(1)}` : `GH₵${text}`;
}

/**
 * "12.5" / "12.50" / "1,234.56" / "GH₵12.50" -> pesewas.
 * Returns null for anything ambiguous (3+ decimals, letters, empty) so the form can ask again.
 */
export function parseGHS(input: string): Pesewas | null {
  const cleaned = input.replace(/GH₵|GHS|₵/gi, '').replace(/[,\s]/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const cedis = Number(match[1]);
  const pesewas = Number((match[2] ?? '').padEnd(2, '0'));
  const total = cedis * 100 + pesewas;
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Percentage of an amount, where the percentage is in basis points (18% = 1800).
 * Rounds half up, so the answer is a whole pesewa and always the same.
 */
export function percentOf(amount: Pesewas, basisPoints: number): Pesewas {
  assertPesewas(amount);
  assertPesewas(basisPoints, 'basis points');
  return Math.floor((amount * basisPoints + 5000) / 10000);
}

/**
 * Split an amount into `parts` whole-pesewa pieces that add back up exactly.
 * The extra pesewas go to the first pieces: splitEvenly(1000, 3) -> [334, 333, 333].
 */
export function splitEvenly(amount: Pesewas, parts: number): Pesewas[] {
  assertPesewas(amount);
  if (!Number.isInteger(parts) || parts < 1) throw new RangeError('parts must be 1 or more');
  const base = Math.floor(amount / parts);
  const extra = amount - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}
