import type { ReactNode } from 'react';
import { formatGHS } from '@niinas/shared';
import { EmptyRow } from './ui';

/** One palette for every chart, so a colour means the same thing everywhere. */
export const SERIES = ['#0068d8', 'var(--series-navy)', '#0b7a43', '#d99a00', '#7fb2ee', '#9aa7bd'];
export const CASH_COLOUR = '#0068d8';
export const MOMO_COLOUR = '#7fb2ee';
/** One colour per payment method, in the order they are listed. Money in the drawer is the strong blue, everything else steps lighter. */
export const METHOD_COLOURS = [CASH_COLOUR, MOMO_COLOUR, '#0a8f6c', '#d99a00', '#8892a0', '#5b7bd5'];
export const methodColour = (i: number) => METHOD_COLOURS[i % METHOD_COLOURS.length]!;

export function Legend({ items }: { items: { label: string; colour: string; value?: ReactNode }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5" style={{ background: i.colour }} />
          {i.label}
          {i.value !== undefined && <strong className="num text-ink">{i.value}</strong>}
        </li>
      ))}
    </ul>
  );
}

/** A list where each row carries a thin bar showing its share of the biggest. */
export function BarList({
  rows,
  empty,
  format = formatGHS,
  colour = '#0068d8',
}: {
  rows: { key: string; label: string; detail?: string; amount: number }[];
  empty: string;
  format?: (n: number) => string;
  colour?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  if (rows.length === 0) return <EmptyRow>{empty}</EmptyRow>;
  return (
    <ul className="divide-y divide-line-2">
      {rows.map((r) => (
        <li key={r.key} className="px-4 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="min-w-0 truncate font-semibold text-ink">
              {r.label}
              {r.detail && <span className="ml-2 text-xs font-normal text-ink-3">{r.detail}</span>}
            </p>
            <p className="num font-bold text-ink">{format(r.amount)}</p>
          </div>
          <div className="mt-1.5 h-1.5 bg-band">
            <div className="h-full" style={{ width: `${Math.max(2, Math.round((r.amount / max) * 100))}%`, background: colour }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One thin bar split into parts, like a progress bar with several colours. */
export function SegmentBar({ parts, delay = 0 }: { parts: { label: string; value: number; colour: string }[]; delay?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="wipe flex h-3 w-full overflow-hidden bg-band" style={{ animationDelay: `${delay}ms` }} role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
      {total > 0 &&
        parts
          .filter((p) => p.value > 0)
          .map((p) => <div key={p.label} title={`${p.label}: ${p.value}`} style={{ width: `${(p.value / total) * 100}%`, background: p.colour }} />)}
    </div>
  );
}

/** A ring split by share. The middle shows whatever the caller puts there. */
export function Donut({ parts, centre, size = 120 }: { parts: { label: string; value: number; colour: string }[]; centre?: ReactNode; size?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  let at = 0;
  const stops =
    total > 0
      ? parts
          .filter((p) => p.value > 0)
          .map((p) => {
            const from = (at / total) * 360;
            at += p.value;
            return `${p.colour} ${from}deg ${(at / total) * 360}deg`;
          })
          .join(', ')
      : 'var(--color-line-2) 0deg 360deg';
  return (
    <div className="relative shrink-0 rounded-full" style={{ width: size, height: size, background: `conic-gradient(${stops})` }} role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
      <div className="absolute inset-[17%] grid place-items-center rounded-full bg-surface text-center leading-tight">{centre}</div>
    </div>
  );
}

const weekday = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

/** A week (or any run of days) of takings, cash and MoMo stacked. The last bar is today and is labelled with its amount. */
export function DayColumns({ days, height = 132 }: { days: { day: string; drawer: number; other: number; total: number }[]; height?: number }) {
  const max = Math.max(1, ...days.map((d) => d.total));
  return (
    <div className="px-4 pb-3 pt-5">
      <div className="relative" style={{ height }}>
        {[0.5, 1].map((f) => (
          <div key={f} aria-hidden className="absolute inset-x-0 border-t border-dashed border-line-2" style={{ bottom: `${f * 100}%` }} />
        ))}
        <div className="absolute inset-0 flex items-end gap-1.5" role="img" aria-label="Takings by day">
          {days.map((d, i) => {
            const last = i === days.length - 1;
            const pct = (n: number) => `${(n / max) * 100}%`;
            return (
              <div
                key={d.day}
                title={`${weekday(d.day)} ${d.day.slice(8)}: ${formatGHS(d.total)}`}
                className="grow-up relative flex h-full min-w-0 flex-1 flex-col justify-end"
                style={{ animationDelay: `${500 + i * 60}ms` }}
              >
                {last && d.total > 0 && <span className="num absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-bold text-navy" style={{ bottom: `calc(${pct(d.total)} + 2px)` }}>{formatGHS(d.total)}</span>}
                <div style={{ height: pct(d.other), background: MOMO_COLOUR }} />
                <div style={{ height: pct(d.drawer), background: CASH_COLOUR }} />
                {d.total === 0 && <div className="h-0.5 bg-line" />}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {days.map((d, i) => (
          <p key={d.day} className={`min-w-0 flex-1 text-center text-xs ${i === days.length - 1 ? 'font-bold text-navy' : 'text-ink-3'}`}>
            {weekday(d.day).slice(0, 3)}
          </p>
        ))}
      </div>
    </div>
  );
}
