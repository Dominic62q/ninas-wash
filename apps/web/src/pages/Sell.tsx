import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { MAX_LINE_QUANTITY, formatAmount, formatGHS, parseGHS, referenceProblem, type JobDetail, type PayMethodDto, type ServiceDto } from '@niinas/shared';
import { QuantityStepper, useServices } from '../components/JobBits';
import { MethodPicker } from '../components/PaymentBits';
import { useToast } from '../components/Toast';
import { Field, FormError, Panel, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { newKey } from '../lib/format';
import { sendReceipt, wantsPrint } from '../lib/receiptShare';
import { useActiveMethods } from '../lib/useMethods';

const plain = (pesewas: number) => formatAmount(pesewas).replace(/,/g, '');
const card = 'border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card';

/** The receipt for a sale that just went through: a PDF on a phone, the print dialog on a computer. */
function useReceipt(job: JobDetail | null) {
  const toast = useToast();
  return useMutation({
    mutationFn: async () => {
      const printWindow = wantsPrint() ? window.open('', '_blank') : null;
      try {
        const { token } = await api<{ token: string }>(`/receipts/for-job/${job!.id}`, { method: 'POST' });
        return await sendReceipt(token, `Receipt ${job!.number}.pdf`, printWindow);
      } catch (e) {
        printWindow?.close();
        throw e;
      }
    },
    onSuccess: (outcome) => {
      if (outcome === 'link') toast.success('Pop-ups are blocked, so the receipt link was copied instead');
      if (outcome === 'downloaded') toast.success('Receipt saved as a PDF');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

const LOW = 5;
const maxFor = (s: ServiceDto) => Math.min(s.stock, MAX_LINE_QUANTITY);

/** "3 duster" or "3x duster" adds three. Anything else is just a search. */
function parseSearch(text: string): { qty: number; term: string } {
  const m = /^(\d{1,2})\s*[x×*]?\s+(.+)$/i.exec(text.trim());
  return m ? { qty: Number(m[1]), term: m[2]! } : { qty: 1, term: text.trim() };
}

function StockBadge({ stock }: { stock: number }) {
  if (stock === 0) return <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-d">Out of stock</span>;
  if (stock <= LOW) return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber">{stock} left</span>;
  return <span className="text-[11px] font-medium text-ink-3">{stock} in stock</span>;
}

/** Sell items off the shelf to a walk-in customer: no car, paid on the spot. */
export function Sell() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const services = useServices();
  const { first } = useActiveMethods();

  const [cart, setCart] = useState<Map<number, number>>(new Map());
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PayMethodDto | null>(null);
  const method = picked ?? first;
  const [reference, setReference] = useState('');
  const [received, setReceived] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  // One key per sale: a double-tap or a retry after a bad connection saves it once.
  const [idemKey, setIdemKey] = useState(newKey);
  const [done, setDone] = useState<JobDetail | null>(null);
  const receipt = useReceipt(done);
  const search = useRef<HTMLInputElement>(null);

  // "/" jumps to the search box from anywhere on the screen, like a till.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items = useMemo(() => (services.data?.services ?? []).filter((s) => s.kind === 'item'), [services.data]);
  const { qty: typedQty, term } = parseSearch(query);
  const shown = term ? items.filter((s) => s.name.toLowerCase().includes(term.toLowerCase())) : items;
  const lines = items.filter((s) => cart.has(s.id)).map((s) => ({ item: s, quantity: cart.get(s.id)! }));
  const count = lines.reduce((n, l) => n + l.quantity, 0);
  const total = lines.reduce((sum, l) => sum + l.item.price * l.quantity, 0);
  const handed = received.trim() === '' ? null : parseGHS(received);
  const change = method?.inDrawer && handed !== null && handed > total ? handed - total : null;
  const short = method?.inDrawer && handed !== null && handed < total;

  function setQuantity(s: ServiceDto, quantity: number) {
    setCart((m) => {
      const next = new Map(m);
      const q = Math.min(quantity, maxFor(s));
      if (q <= 0) next.delete(s.id);
      else next.set(s.id, q);
      return next;
    });
    setError(null);
  }
  const add = (s: ServiceDto, n = 1) => setQuantity(s, (cart.get(s.id) ?? 0) + n);

  function addFromSearch() {
    const hit = shown.find((s) => s.stock > 0);
    if (!hit) return;
    add(hit, typedQty);
    setQuery('');
  }

  const save = useMutation({
    mutationFn: (body: unknown) => api<{ job: JobDetail }>('/jobs/sales', { method: 'POST', body }),
    onSuccess: async ({ job }) => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success(`Sold, ${formatGHS(job.total)} received`);
      setDone(job);
      setCartOpen(false);
      setCart(new Map());
      setQuery('');
      setReference('');
      setReceived('');
      setIdemKey(newKey());
    },
    // Someone else may have sold the last one, so show the shelf as it is now.
    onError: () => queryClient.invalidateQueries({ queryKey: ['services'] }),
  });

  function submit() {
    if (lines.length === 0) return setError('Pick at least one item');
    if (!method) return setError('Pick how the customer paid');
    const problem = referenceProblem(method, reference);
    if (problem) return setError(problem);
    if (short) return setError(`The customer handed over less than ${formatGHS(total)}`);
    setError(null);
    save.mutate({
      lines: lines.map((l) => ({ serviceId: l.item.id, quantity: l.quantity })),
      payments: [{ methodId: method.id, amount: total, reference: reference.trim() || null }],
      idemKey,
    });
  }

  if (!can('payment.record')) {
    return <p className="text-ink-2">Selling items takes the payment straight away, so it needs permission to take payments. Ask a manager.</p>;
  }

  if (done) {
    return (
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-4">
        <section aria-label="Sale complete" className={`${card} rise flex flex-col gap-3 p-5`}>
          <p className="flex items-center gap-2 text-sm font-medium text-green">
            <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-full bg-green text-[11px] text-white">✓</span>
            Sale complete
          </p>
          <p className="display text-[32px] leading-none text-navy">{formatGHS(done.total)}</p>
          <ul className="flex flex-col gap-1 border-t border-line-2 pt-3 text-sm text-ink-2">
            {done.lines.map((l) => (
              <li key={l.id} className="flex justify-between gap-3">
                <span>
                  {l.name}
                  {l.quantity > 1 && <span className="num text-ink-3"> × {l.quantity}</span>}
                </span>
                <span className="num">{formatGHS(l.price)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-3">
            Walk-in customer · {done.number} ·{' '}
            <Link to={`/jobs/${done.id}`} className="text-blue-d">
              See sale
            </Link>
          </p>
        </section>
        <div className="flex gap-3">
          <button type="button" className="btn flex-1" disabled={receipt.isPending} onClick={() => receipt.mutate()}>
            {receipt.isPending ? 'Preparing…' : wantsPrint() ? 'Print receipt' : 'Share receipt'}
          </button>
          <button
            type="button"
            className="btn btn-primary flex-1"
            onClick={() => {
              setDone(null);
              setTimeout(() => search.current?.focus(), 0);
            }}
          >
            New sale
          </button>
        </div>
      </div>
    );
  }

  /** The ticket: what is being sold, the total and how it is paid. Shown beside the products, and in a sheet on a phone. */
  const ticket = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="display text-lg text-navy max-lg:hidden">Current sale</h2>
          <p className="text-xs text-ink-3">Walk-in customer</p>
        </div>
        {lines.length > 0 && (
          <button type="button" className="tap text-sm text-ink-3 underline" onClick={() => setCart(new Map())}>
            Clear
          </button>
        )}
      </div>

      <div className="min-h-[120px] flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="grid h-full min-h-[160px] place-items-center px-6 text-center">
            <div>
              <svg aria-hidden="true" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-ink-3/60">
                <path d="M3.5 4.5h2.2l2 10.5h10.6l1.9-7.5H6.6M9.5 19.5h.01M17 19.5h.01" />
              </svg>
              <p className="mt-2 text-sm font-medium text-ink-2">Nothing in the sale yet</p>
              <p className="text-xs text-ink-3">Search or tap an item to add it</p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-line-2">
            {lines.map((l) => (
              <li key={l.item.id} className="rise flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 font-medium leading-snug text-ink">{l.item.name}</p>
                  <p className="num font-semibold text-ink">{formatGHS(l.item.price * l.quantity)}</p>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <QuantityStepper label={l.item.name} value={l.quantity} max={l.item.stock} onChange={(n) => setQuantity(l.item, n)} />
                  <span className="num text-xs text-ink-3">{formatGHS(l.item.price)} each</span>
                  <button type="button" aria-label={`Remove ${l.item.name}`} onClick={() => setQuantity(l.item, 0)} className="tap -mr-1 px-1.5 text-base leading-none text-ink-3">
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-line bg-band/40 px-4 py-4">
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between text-ink-2">
            <dt>{count === 1 ? '1 item' : `${count} items`}</dt>
            <dd className="num">{formatGHS(total)}</dd>
          </div>
          <div className="flex items-baseline justify-between">
            <dt className="font-medium text-ink">Total</dt>
            <dd className="display text-[30px] leading-none text-navy">{formatGHS(total)}</dd>
          </div>
        </dl>
        {lines.length > 0 && (
          <>
            <MethodPicker label="Paid by" value={method?.id ?? null} onChange={(m) => { setPicked(m); setError(null); }} />
            {method?.requiresReference || (method && !method.inDrawer) ? (
              <Field label={`${method.name} reference${method.requiresReference ? '' : ' (optional)'}`}>
                <input className="input" value={reference} onChange={(e) => { setReference(e.target.value); setError(null); }} maxLength={40} autoComplete="off" placeholder="From the confirmation message" />
              </Field>
            ) : method?.inDrawer ? (
              <Field label="Cash received (optional)" hint={change !== null ? undefined : 'To work out the change'}>
                <input className="input" inputMode="decimal" value={received} onChange={(e) => { setReceived(e.target.value); setError(null); }} autoComplete="off" placeholder="0.00" />
                <div className="flex flex-wrap gap-2">
                  {[total, ...[20, 50, 100, 200].map((n) => n * 100).filter((n) => n > total)].slice(0, 4).map((n, i) => (
                    <button key={n} type="button" onClick={() => setReceived(plain(n))} className="num h-9 cursor-pointer rounded-lg bg-band px-3 text-sm font-semibold text-navy active:scale-95">
                      {i === 0 ? 'Exact' : formatAmount(n).replace(/\.00$/, '')}
                    </button>
                  ))}
                </div>
                {change !== null && (
                  <span className="num text-base font-semibold text-green" aria-live="polite">
                    Give back {formatGHS(change)}
                  </span>
                )}
              </Field>
            ) : null}
          </>
        )}
        <FormError message={error ?? (save.isError ? errorMessage(save.error) : null)} />
        <button type="button" className="btn btn-primary h-[52px] text-base" disabled={save.isPending || lines.length === 0} onClick={submit}>
          {save.isPending ? 'Saving…' : lines.length === 0 ? 'Charge' : `Charge ${formatGHS(total)}`}
        </button>
      </div>
    </div>
  );

  return (
    <div className="grid gap-5 max-lg:flex max-lg:flex-1 max-lg:flex-col lg:h-[calc(100vh-9rem)] lg:min-h-[520px] lg:grid-cols-[minmax(0,1fr)_340px]">
      <section aria-label="Items" className="flex min-h-0 flex-col gap-3 max-lg:flex-1">
        <div className="relative">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-3">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <input
            ref={search}
            type="text"
            role="searchbox"
            aria-label="Search items"
            className="input h-[52px] pl-12 pr-16 text-base"
            placeholder="Search items, then press Enter to add"
            value={query}
            autoComplete="off"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addFromSearch();
              }
              if (e.key === 'Escape') setQuery('');
            }}
          />
          <kbd className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded border border-line-strong px-1.5 py-0.5 text-xs text-ink-3 lg:block">/</kbd>
        </div>
        {term && shown.some((s) => s.stock > 0) && (
          <p className="-mt-1 text-xs text-ink-3">
            Enter adds <strong className="text-ink">{typedQty > 1 ? `${typedQty} × ` : ''}{shown.find((s) => s.stock > 0)!.name}</strong>
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pb-24 lg:pb-1 lg:pr-1">
          {services.isPending && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3" aria-busy="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="skeleton h-[104px]" />
              ))}
            </div>
          )}
          {services.isError && <FormError message={errorMessage(services.error)} />}
          {services.isSuccess && items.length === 0 && (
            <p className={`${card} p-4 text-ink-2`}>
              No items to sell yet. {can('service.manage') ? 'Add them under Settings, Items for sale.' : 'Ask the owner to add them.'}
            </p>
          )}
          {services.isSuccess && items.length > 0 && shown.length === 0 && (
            <p className={`${card} p-6 text-center text-ink-2`}>
              No item matches <strong className="text-ink">“{term}”</strong>
            </p>
          )}
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {shown.map((s) => {
              const inCart = cart.get(s.id) ?? 0;
              const out = s.stock === 0;
              const atMax = inCart >= maxFor(s);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={out || atMax}
                    aria-label={`Add one ${s.name}`}
                    onClick={() => add(s)}
                    className={`relative flex h-full min-h-[104px] w-full cursor-pointer flex-col items-start justify-between gap-3 border-[1.5px] p-3.5 text-left transition-[transform,border-color,background-color] duration-100 active:scale-[0.97] disabled:cursor-default disabled:active:scale-100 max-lg:rounded-[14px] ${
                      inCart > 0 ? 'border-blue bg-blue-50' : 'border-line-strong bg-surface hover:border-blue/60'
                    } ${out ? 'opacity-50' : ''}`}
                  >
                    <span className="pr-8 font-medium leading-snug text-ink">{s.name}</span>
                    <span className="flex flex-col items-start gap-1">
                      <span className="num text-[17px] font-semibold leading-none text-navy">{formatGHS(s.price)}</span>
                      <StockBadge stock={s.stock} />
                    </span>
                    {inCart > 0 && (
                      <span aria-hidden="true" className="num absolute right-2.5 top-2.5 grid h-6 min-w-6 place-items-center rounded-full bg-blue px-1.5 text-xs font-bold text-white">
                        {inCart}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* Computer: the ticket stays beside the products. */}
      <aside aria-label="Current sale" className={`${card} hidden min-h-0 flex-col overflow-hidden lg:flex`}>
        {ticket}
      </aside>

      {/* Phone: a bar at the bottom opens the ticket. */}
      {lines.length > 0 && (
        <div className="sticky bottom-0 z-20 -mx-4 -mb-4 mt-auto rounded-t-[18px] bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_30px_rgba(7,31,71,0.14)] lg:hidden">
          <button type="button" className="btn btn-primary h-[54px] w-full justify-between rounded-xl px-5 text-base" onClick={() => setCartOpen(true)}>
            <span>{count === 1 ? '1 item' : `${count} items`} · View sale</span>
            <span className="num">{formatGHS(total)}</span>
          </button>
        </div>
      )}
      <Panel open={cartOpen} onClose={() => setCartOpen(false)} title="Current sale" tall>
        <div className="-mx-4 -mb-4 flex min-h-0 flex-1 flex-col lg:hidden">{ticket}</div>
      </Panel>
    </div>
  );
}
