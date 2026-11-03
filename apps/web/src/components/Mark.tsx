import type { ReactNode } from 'react';

export type MarkTone = 'green' | 'red' | 'amber' | 'blue' | 'grey';

const TEXT: Record<MarkTone, string> = { green: 'text-green', red: 'text-red-d', amber: 'text-amber', blue: 'text-blue-d', grey: 'text-ink-3' };
const DOT: Record<MarkTone, string> = { green: 'bg-green', red: 'bg-red', amber: 'bg-amber', blue: 'bg-blue', grey: 'bg-ink-3' };

/** A status as a small dot and a word, so a list of jobs or texts is not a row of coloured tags. */
export function Mark({ tone, children }: { tone: MarkTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium ${TEXT[tone]}`}>
      <span aria-hidden="true" className={`size-2 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}
