import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Panel } from './ui';

// The browser's own <select> looks different on every phone and cannot be styled, so the app draws its own.
// On a computer the list opens in the page, under the button. On a phone it opens as a sheet from the bottom:
// it cannot be closed by touching the page to scroll, it never raises the keyboard by itself, and Done stays in reach.

interface Option<T> {
  value: T;
  label: string;
}

const PHONE = '(max-width: 1023px)';

function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(PHONE);
    if (!m) return;
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

/** A touch screen: focusing the search box would raise the keyboard over the list. */
const touchScreen = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;

/** Closes on a tap outside or Esc. */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    // A click, not a pointer-down: touching the page to scroll it must not close the list.
    document.addEventListener('click', away);
    return () => document.removeEventListener('click', away);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation(); // do not also close a panel the dropdown sits in
      e.preventDefault();
      setOpen(false);
    }
  };
  return { open, setOpen, root, onKeyDown };
}

const triggerClass = 'input flex cursor-pointer items-center justify-between gap-2 text-left';
/** The list opens in the page flow, under the button. It pushes what is below down instead of floating,
 *  so it can never be cut off by a panel or a bottom sheet. */
const popoverClass = () => 'mt-1.5 max-h-72 overflow-y-auto border border-line-strong bg-surface';

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`flex-none text-ink-3 ${open ? 'rotate-180' : ''}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Phone: the bottom bar of a sheet. Sticks to the bottom of the sheet and clears the home bar. */
function SheetFooter({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-line bg-surface px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">{children}</div>
  );
}

/** Pick one thing from a list. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  invalid,
}: {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (v: T) => void;
  invalid?: boolean;
}) {
  const { open, setOpen, root, onKeyDown } = useDropdown();
  const phone = usePhone();
  const current = options.find((o) => o.value === value);
  const pick = (v: T) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div ref={root} onKeyDown={onKeyDown}>
      <button type="button" className={triggerClass} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-invalid={invalid} onClick={() => setOpen(!open)}>
        <span className="truncate">{current?.label ?? ''}</span>
        <Chevron open={open} />
      </button>
      {phone ? (
        <Panel open={open} onClose={() => setOpen(false)} title={label}>
          <ul role="listbox" aria-label={label} className="-mx-4 -my-4 flex flex-col pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {options.map((o) => (
              <li key={o.value} role="option" aria-selected={o.value === value}>
                <button
                  type="button"
                  onClick={() => pick(o.value)}
                  className={`flex min-h-[52px] w-full cursor-pointer items-center justify-between gap-2 px-4 text-left text-base ${
                    o.value === value ? 'bg-blue-50 font-bold text-blue-d' : 'text-ink active:bg-band'
                  }`}
                >
                  {o.label}
                  {o.value === value && <span aria-hidden="true">✓</span>}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        open && (
          <ul role="listbox" aria-label={label} className={popoverClass()}>
            {options.map((o) => (
              <li key={o.value} role="option" aria-selected={o.value === value}>
                <button
                  type="button"
                  autoFocus={o.value === value}
                  onClick={() => pick(o.value)}
                  className={`flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 px-4 text-left text-[15px] ${
                    o.value === value ? 'bg-blue-50 font-bold text-blue-d' : 'text-ink hover:bg-band'
                  }`}
                >
                  {o.label}
                  {o.value === value && <span aria-hidden="true">✓</span>}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

/** Pick several things from a list that may be long. Picked ones show underneath and can be removed. */
export function MultiSelect({
  label,
  placeholder,
  options,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  options: readonly Option<number>[];
  value: number[];
  onChange: (v: number[]) => void;
}) {
  const { open, setOpen, root, onKeyDown } = useDropdown();
  const phone = usePhone();
  const [filter, setFilter] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const shown = options.filter((o) => o.label.toLowerCase().includes(filter.trim().toLowerCase()));
  const picked = options.filter((o) => value.includes(o.value));
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  // On a computer, bring the whole list, with its Done button, into view once when it opens.
  useEffect(() => {
    if (open && !phone) list.current?.scrollIntoView({ block: 'nearest' });
  }, [open, phone]);

  const search = options.length > 6 && (
    <input
      className="input h-11"
      type="search"
      enterKeyHint="search"
      value={filter}
      onChange={(e) => setFilter(e.target.value)}
      placeholder="Search"
      aria-label={`Search ${label}`}
      autoComplete="off"
      autoFocus={!touchScreen()}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      <div ref={root} onKeyDown={onKeyDown}>
        <button
          type="button"
          className={triggerClass}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            setFilter('');
          }}
        >
          <span className={`truncate ${picked.length ? '' : 'text-ink-3'}`}>{picked.length ? `${picked.length} picked` : placeholder}</span>
          <Chevron open={open} />
        </button>

        {phone ? (
          <Panel open={open} onClose={() => setOpen(false)} title={label} tall={options.length > 6}>
            {search}
            <ul role="listbox" aria-label={label} aria-multiselectable="true" className="-mx-4 flex flex-1 flex-col">
              {shown.length === 0 && <li className="px-4 py-3 text-sm text-ink-3">No match.</li>}
              {shown.map((o) => {
                const on = value.includes(o.value);
                return (
                  <li key={o.value} role="option" aria-selected={on}>
                    <button
                      type="button"
                      onClick={() => toggle(o.value)}
                      className={`flex min-h-[52px] w-full cursor-pointer items-center gap-3 px-4 text-left text-base ${on ? 'bg-blue-50 font-bold text-blue-d' : 'text-ink active:bg-band'}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`grid h-[22px] w-[22px] flex-none place-items-center rounded-md border-[1.5px] text-xs text-white ${on ? 'border-blue bg-blue' : 'border-line-strong bg-surface'}`}
                      >
                        {on ? '✓' : ''}
                      </span>
                      {o.label}
                    </button>
                  </li>
                );
              })}
            </ul>
            <SheetFooter>
              <button type="button" className="btn btn-primary h-12 w-full" onClick={() => setOpen(false)}>
                {picked.length ? `Done · ${picked.length} picked` : 'Done'}
              </button>
            </SheetFooter>
          </Panel>
        ) : (
          open && (
            <div className={`${popoverClass()} scroll-mb-28`} ref={list}>
              {search && <div className="sticky top-0 border-b border-line-2 bg-surface p-2">{search}</div>}
              <ul role="listbox" aria-label={label} aria-multiselectable="true">
                {shown.length === 0 && <li className="px-4 py-3 text-sm text-ink-3">No match.</li>}
                {shown.map((o) => {
                  const on = value.includes(o.value);
                  return (
                    <li key={o.value} role="option" aria-selected={on}>
                      <button
                        type="button"
                        onClick={() => toggle(o.value)}
                        className={`flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 text-left text-[15px] ${on ? 'bg-blue-50 font-bold text-blue-d' : 'text-ink hover:bg-band'}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`grid h-5 w-5 flex-none place-items-center border-[1.5px] text-xs text-white ${on ? 'border-blue bg-blue' : 'border-line-strong bg-surface'}`}
                        >
                          {on ? '✓' : ''}
                        </span>
                        {o.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="sticky bottom-0 border-t border-line-2 bg-surface p-2">
                <button type="button" className="btn h-10 w-full text-sm" onClick={() => setOpen(false)}>
                  Done
                </button>
              </div>
            </div>
          )
        )}
      </div>
      {picked.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={`Picked: ${label}`}>
          {picked.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                onClick={() => toggle(o.value)}
                aria-label={`Remove ${o.label}`}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-[1.5px] border-blue bg-blue-50 pl-3.5 pr-3 text-sm font-bold text-blue-d max-lg:min-h-9 max-lg:rounded-md max-lg:border-0 max-lg:px-3"
              >
                {o.label}
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
