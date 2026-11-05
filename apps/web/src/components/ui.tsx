import { useEffect, useRef, type ReactNode } from 'react';
import { formatGHS, type Takings } from '@niinas/shared';
import { ApiError } from '../lib/api';
import { plural } from '../lib/format';

/** The text to show under a failed save. Server messages are already plain English. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'Something went wrong. Try again.';
}

/**
 * A side panel on a computer and a sheet from the bottom on a phone.
 * Built on the browser's own dialog, so Esc closes it, focus stays inside and the page behind is inert.
 */
export function Panel({
  open,
  onClose,
  title,
  tall,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** On a phone, always open to the same height instead of fitting the content. For sheets people browse in. */
  tall?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // a click on the dimmed area
      }}
      className={`panel m-auto max-h-[92dvh] ${tall ? 'max-sm:h-[92dvh]' : ''} w-full max-w-[520px] overflow-y-auto border border-line bg-surface p-0 text-ink backdrop:bg-black/60 max-sm:mx-0 max-sm:mb-0 max-sm:max-w-none lg:mr-0 lg:h-screen lg:max-h-none lg:w-[520px] lg:max-w-[520px]`}
    >
      {open && (
        <div className="flex min-h-full flex-col">
          <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 lg:px-5 lg:py-3.5">
            <h2 className="display flex-1 text-xl leading-none text-navy lg:text-[22px]">{title}</h2>
            <button type="button" onClick={onClose} className="tap -mr-3 text-sm text-blue-d">
              Close
            </button>
          </div>
          <div className="flex flex-1 flex-col gap-4 px-4 py-4 lg:gap-5 lg:px-5 lg:py-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | undefined; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink-2">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-ink-3">{hint}</span>}
      {error && (
        <span role="alert" className="text-[13px] font-medium text-red-d">
          {error}
        </span>
      )}
    </label>
  );
}

export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="border-l-4 border-red bg-red-50 px-3 py-2.5 text-sm font-medium text-red-d">
      {message}
    </p>
  );
}

export function Check({ label, checked, onChange, hint, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-5 w-5 flex-none accent-blue" />
      <span className="flex flex-col">
        <span className="text-sm font-medium text-ink">{label}</span>
        {hint && <span className="text-xs text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

/** Two or three choices shown side by side. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink-2">{label}</span>
      <div className="flex gap-0.5 rounded-[10px] bg-line-2 p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`h-9 flex-1 cursor-pointer rounded-lg px-3 text-sm font-medium transition-colors lg:h-11 ${
              value === o.value ? 'bg-surface text-navy shadow-card' : 'text-ink-2'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Pill({ tone, children }: { tone: 'green' | 'grey' | 'amber' | 'blue'; children: ReactNode }) {
  const styles = {
    green: 'bg-green-50 text-green',
    grey: 'bg-band text-ink-3',
    amber: 'bg-amber-50 text-amber',
    blue: 'bg-blue-50 text-blue-d',
  } as const;
  return <span className={`inline-block whitespace-nowrap px-2 py-0.5 text-xs font-bold max-lg:rounded-md ${styles[tone]}`}>{children}</span>;
}

/**
 * Headline numbers in one ruled strip. On a phone all of them sit side by side, value over a short label.
 * `roomy` is for money: four amounts do not fit side by side on a phone, so they sit two by two at a size that reads.
 */
export function Strip({ items, roomy, compact }: { items: { label: string; short?: string; value: string; note?: string }[]; roomy?: boolean; compact?: boolean }) {
  const phoneCols = roomy && !compact && items.length === 4 ? 2 : 4;
  return (
    <dl className={`grid border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card lg:grid-cols-4 ${phoneCols === 2 ? 'max-lg:grid-cols-2' : 'max-lg:grid-cols-4'}`}>
      {items.map((item, i) => (
        <div
          key={item.label}
          className={`flex min-w-0 flex-col py-2.5 max-lg:items-center ${compact ? 'px-1 max-lg:py-2' : 'px-2'} max-lg:text-center lg:px-4 lg:py-3.5 ${i % phoneCols > 0 ? 'max-lg:border-l max-lg:border-line' : ''} ${i >= phoneCols ? 'max-lg:border-t max-lg:border-line' : ''} ${i > 0 ? 'lg:border-l lg:border-line' : ''}`}
        >
          <dd className={`display num order-first leading-none text-navy lg:order-none lg:mt-1 lg:text-[26px] ${phoneCols === 2 ? 'text-[22px]' : compact ? 'text-[13.5px]' : 'text-[18px]'}`}>{item.value}</dd>
          <dt className="mt-1 text-[11px] font-medium leading-tight text-ink-3 lg:order-first lg:mt-0 lg:text-xs">
            <span className="lg:hidden">{item.short ?? item.label}</span>
            <span className="hidden lg:inline">{item.label}</span>
          </dt>
          {item.note && <p className="mt-1 hidden text-xs text-ink-3 lg:block">{item.note}</p>}
        </div>
      ))}
    </dl>
  );
}

/** The day's takings: the total big, each way of paying underneath, every amount with room to read. */
export function TakingsCard({ takings, label = 'Taken' }: { takings: Takings; label?: string }) {
  return (
    <section aria-label="Takings" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3">
        <p className="text-sm font-medium text-ink-2">
          {label} · {plural(takings.payments, 'payment')}
        </p>
        <p className="display num text-[24px] leading-none text-navy lg:text-[28px]">{formatGHS(takings.total)}</p>
      </div>
      {takings.byMethod.length > 0 && (
        <ul className="grid grid-cols-2 border-t border-line text-sm">
          {takings.byMethod.map((m, i) => (
            <li key={m.methodId} className={`flex items-baseline justify-between gap-2 px-4 py-2 text-ink-2 ${i % 2 === 1 ? 'border-l border-line' : ''}`}>
              <span className="truncate">{m.name}</span>
              <span className="num font-semibold text-ink">{formatGHS(m.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** How many rows a long list shows at first, and adds each time "Show more" is pressed. */
export const PAGE = 30;

/** Sits under a list that is cut short. Loads the next page; the list refetches with a bigger limit. */
export function ShowMore({ shown, total, busy, onMore }: { shown: number; total: number; busy: boolean; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div className="border-t border-line-2 px-4 py-3 text-center">
      <button type="button" className="inline-flex h-[44px] items-center px-3 font-medium text-blue-d" disabled={busy} onClick={onMore}>
        {busy ? 'Loading' : `Show more (${shown} of ${total})`}
      </button>
    </div>
  );
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-ink-3">{children}</p>;
}

export function PageActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

/** Grey placeholder rows shown while a list loads, so the page does not jump when it arrives. */
export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" role="status">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-line-2 px-4 py-4 last:border-b-0">
          <div className="flex flex-1 flex-col gap-2">
            <div className="skeleton h-4 w-2/5" />
            <div className="skeleton h-3 w-3/5" />
          </div>
          <div className="skeleton h-6 w-16" />
        </div>
      ))}
    </div>
  );
}

/** A confirmation that looks like the rest of the app instead of the browser's own pop-up. */
export function ConfirmPanel({
  open,
  title,
  message,
  confirmLabel,
  busy,
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Panel open={open} onClose={onClose} title={title}>
      <p className="text-ink-2">{message}</p>
      <div className="grid grid-cols-2 gap-3">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'border-red bg-red text-white' : 'btn-primary'}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Panel>
  );
}
