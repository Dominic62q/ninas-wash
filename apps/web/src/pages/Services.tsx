import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { formatAmount, formatGHS, parseGHS, serviceCreate, stockInput, type ChangeEntry, type ServiceDto, type ServiceKind, type StockMoveDto } from '@niinas/shared';
import { useToast } from '../components/Toast';
import { Check, Choice, ConfirmPanel, EmptyRow, Field, FormError, Panel, Pill, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { shortDateTime } from '../lib/format';

type Kind = 'percent' | 'fixed';

/** "18%" or "GH₵5.00" */
const commissionText = (kind: Kind, value: number) => (kind === 'percent' ? `${value / 100}%` : formatGHS(value));

/** Basis points from what was typed ("18", "12.5"). Null if it is not a percentage. */
function parsePercent(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/%$/, ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  price: 'Price',
  commissionKind: 'Commission type',
  commissionValue: 'Commission',
  active: 'Offered',
};

function describe(entry: ChangeEntry, service: ServiceDto): string {
  if (entry.action === 'service.create') return 'Added';
  if (entry.action === 'stock.delivery' || entry.action === 'stock.count') {
    const c = entry.changes.find((x) => x.field === 'stock');
    return `${entry.action === 'stock.delivery' ? 'Delivery' : 'Shelf count'}: stock ${String(c?.from ?? '—')} to ${String(c?.to ?? '—')}`;
  }
  return entry.changes
    .map(({ field, from, to }) => {
      const show = (v: unknown) => {
        if (v === null || v === undefined) return '—';
        if (field === 'price') return formatAmount(Number(v));
        if (field === 'commissionValue') return commissionText(service.commissionKind, Number(v));
        if (field === 'active') return v ? 'on' : 'off';
        return String(v);
      };
      return `${FIELD_LABEL[field] ?? field}: ${show(from)} to ${show(to)}`;
    })
    .join(', ');
}

function History({ service }: { service: ServiceDto }) {
  const history = useQuery({
    queryKey: ['services', service.id, 'history'],
    queryFn: () => api<{ history: ChangeEntry[] }>(`/services/${service.id}/history`),
  });
  const rows = history.data?.history ?? [];
  return (
    <section aria-label="History">
      <h3 className="text-sm font-medium text-ink-2">History</h3>
      {history.isPending && <p className="mt-2 text-ink-3">Loading…</p>}
      {history.isError && <p className="mt-2 text-red-d">{errorMessage(history.error)}</p>}
      {history.isSuccess && rows.length === 0 && <p className="mt-2 text-ink-3">No changes yet</p>}
      <ul className="mt-2 divide-y divide-line-2 border-y border-line-2">
        {rows.map((r) => (
          <li key={r.id} className="py-2.5">
            <p className="text-sm font-medium text-ink">{describe(r, service)}</p>
            <p className="text-xs text-ink-3">
              {r.by ?? 'Someone'}, {shortDateTime(r.at)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LOW_STOCK = 5;

/** How many are on the shelf, in a colour that says whether to reorder. */
function StockText({ stock }: { stock: number }) {
  const tone = stock === 0 ? 'text-red-d' : stock <= LOW_STOCK ? 'text-amber' : 'text-ink-2';
  return <span className={tone}>{stock === 0 ? 'Out of stock' : `${stock} in stock`}</span>;
}

const MOVE_LABEL: Record<StockMoveDto['reason'], string> = { delivery: 'Delivery', sale: 'Sold', void: 'Back from a voided job', count: 'Shelf count', correction: 'Job corrected' };

/** An item's shelf: add a delivery, correct it after counting, and see every change. */
function Stock({ item }: { item: ServiceDto }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'delivery' | 'count'>('delivery');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stock, setStock] = useState(item.stock);

  const moves = useQuery({
    queryKey: ['services', item.id, 'stock'],
    queryFn: () => api<{ moves: StockMoveDto[] }>(`/services/${item.id}/stock`),
  });
  const save = useMutation({
    mutationFn: (body: unknown) => api<{ service: ServiceDto }>(`/services/${item.id}/stock`, { method: 'POST', body }),
    onSuccess: async ({ service }) => {
      setStock(service.stock);
      setAmount('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success(`${service.stock} ${item.name} on the shelf`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(amount.trim());
    if (amount.trim() === '' || !Number.isInteger(n)) return setError(mode === 'delivery' ? 'Enter how many came in, like 24' : 'Enter how many are on the shelf');
    const parsed = stockInput.safeParse(mode === 'delivery' ? { reason: 'delivery', quantity: n, note } : { reason: 'count', count: n, note });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the details');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <section aria-label="Stock" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-ink-2">Stock</h3>
        <p className="num text-lg font-semibold">
          <StockText stock={stock} />
        </p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3 border border-line-2 p-3 max-lg:rounded-[10px]">
        <Choice
          label="What happened"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setAmount('');
            setNote('');
            setError(null);
          }}
          options={[
            { value: 'delivery', label: 'A delivery came in' },
            { value: 'count', label: 'I counted the shelf' },
          ]}
        />
        <Field label={mode === 'delivery' ? 'How many came in' : 'How many are on the shelf'} error={error ?? undefined}>
          <input className="input num" inputMode="numeric" value={amount} onChange={(e) => { setAmount(e.target.value); setError(null); }} aria-invalid={!!error} autoComplete="off" />
        </Field>
        <Field label={mode === 'delivery' ? 'Note (optional)' : 'Why it changed'}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} autoComplete="off" placeholder={mode === 'delivery' ? 'Supplier or invoice number' : 'Two went missing'} />
        </Field>
        <FormError message={save.isError ? errorMessage(save.error) : null} />
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : mode === 'delivery' ? 'Add to stock' : 'Set the stock'}
        </button>
      </form>
      {moves.isError && <p className="text-red-d">{errorMessage(moves.error)}</p>}
      {moves.isSuccess && moves.data.moves.length === 0 && <p className="text-sm text-ink-3">No stock yet. Add the first delivery.</p>}
      {moves.isSuccess && moves.data.moves.length > 0 && (
        <ul className="divide-y divide-line-2 border-y border-line-2">
          {moves.data.moves.map((m) => (
            <li key={m.id} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {MOVE_LABEL[m.reason]}
                  {m.jobId && (
                    <>
                      {' · '}
                      <Link to={`/jobs/${m.jobId}`} className="text-blue-d">
                        See job
                      </Link>
                    </>
                  )}
                </p>
                <p className="text-xs text-ink-3">
                  {m.by}, {shortDateTime(m.at)}
                  {m.note && <> · {m.note}</>}
                </p>
              </div>
              <p className="num text-right text-sm">
                <span className={`font-semibold ${m.change > 0 ? 'text-green' : 'text-ink'}`}>{m.change > 0 ? `+${m.change}` : `−${-m.change}`}</span>
                <span className="block text-xs text-ink-3">{m.after} left</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ServiceForm({ service, newKind, onDone }: { service: ServiceDto | null; newKind: ServiceKind; onDone: () => void }) {
  const isItem = (service?.kind ?? newKind) === 'item';
  const noun = isItem ? 'item' : 'service';
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(service?.name ?? '');
  const [price, setPrice] = useState(service ? formatAmount(service.price).replace(/,/g, '') : '');
  const [kind, setKind] = useState<Kind>(service?.commissionKind ?? 'percent');
  const [commission, setCommission] = useState(
    service ? (service.commissionKind === 'percent' ? String(service.commissionValue / 100) : formatAmount(service.commissionValue).replace(/,/g, '')) : '',
  );
  const [active, setActive] = useState(service?.active ?? true);
  const [opening, setOpening] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Hiding a service or changing what it earns shapes every new job, so it asks first. */
  const [risky, setRisky] = useState<{ body: unknown; title: string; message: string; label: string; danger: boolean } | null>(null);

  const save = useMutation({
    mutationFn: (body: unknown) =>
      service ? api(`/services/${service.id}`, { method: 'PATCH', body }) : api('/services', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success(service ? `${isItem ? 'Item' : 'Service'} updated` : `${name.trim()} added`);
      onDone();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    const priceValue = parseGHS(price);
    if (priceValue === null) found.price = 'Enter the price, like 45 or 45.50';
    // Items earn no commission, so they are always a fixed nothing.
    const commissionValue = isItem ? 0 : kind === 'percent' ? parsePercent(commission) : parseGHS(commission);
    if (commissionValue === null) found.commissionValue = kind === 'percent' ? 'Enter a percentage, like 18' : 'Enter an amount, like 5 or 5.50';

    const openingText = opening.trim();
    if (isItem && !service && openingText !== '' && !/^\d+$/.test(openingText)) found.openingStock = 'Enter a whole number, like 24';
    const parsed = serviceCreate.safeParse({
      openingStock: isItem && !service && openingText !== '' ? Number(openingText) : 0,
      name,
      kind: isItem ? 'item' : 'service',
      price: priceValue ?? 0,
      commissionKind: isItem ? 'fixed' : kind,
      commissionValue: commissionValue ?? 0,
      active,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) found[String(issue.path[0] ?? 'form')] ??= issue.message;
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) return;
    // Whether it is an item is set when it is added, so an edit leaves it out.
    const { kind: _kind, openingStock: _opening, ...edits } = parsed.data;
    if (service) {
      const hide = service.active && !parsed.data.active;
      const money =
        parsed.data.price !== service.price ||
        parsed.data.commissionKind !== service.commissionKind ||
        parsed.data.commissionValue !== service.commissionValue;
      if (hide) {
        return setRisky({ body: edits, title: `Hide ${service.name}?`, message: 'It will not be offered on new jobs. Past jobs keep it.', label: 'Hide it', danger: true });
      }
      if (money) {
        return setRisky({ body: edits, title: `Update ${service.name}?`, message: isItem ? 'The new price applies to new sales only. Past sales keep what they were sold at.' : 'The new price and commission apply to new jobs only. Cars already booked keep what they were sold at.', label: 'Update', danger: false });
      }
    }
    save.mutate(service ? edits : parsed.data);
  }

  return (
    <>
      <form onSubmit={submit} onChange={() => setErrors((e) => (Object.keys(e).length ? {} : e))} noValidate className="flex flex-col gap-5">
        <Field label={isItem ? 'Item name' : 'Service name'} error={errors.name}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} autoComplete="off" />
        </Field>
        <Field label="Price (GH₵)" error={errors.price}>
          <input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={!!errors.price} />
        </Field>
        {isItem ? (
          !service && (
            <Field label="Quantity in stock" hint="How many are on the shelf now. Items earn no commission." error={errors.openingStock}>
              <input className="input num" inputMode="numeric" value={opening} onChange={(e) => setOpening(e.target.value)} aria-invalid={!!errors.openingStock} autoComplete="off" placeholder="0" />
            </Field>
          )
        ) : (
          <>
        <Choice
          label="Washer's commission"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setCommission('');
          }}
          options={[
            { value: 'percent', label: 'Percent of price' },
            { value: 'fixed', label: 'Fixed amount' },
          ]}
        />
        <Field
          label={kind === 'percent' ? 'Commission (%)' : 'Commission (GH₵)'}
          hint="New jobs only"
          error={errors.commissionValue}
        >
          <input className="input num" inputMode="decimal" value={commission} onChange={(e) => setCommission(e.target.value)} aria-invalid={!!errors.commissionValue} />
        </Field>
          </>
        )}
        <Check label={isItem ? 'On sale' : 'Offered'} hint={isItem ? 'Off hides it from new sales' : 'Off hides it from new jobs'} checked={active} onChange={setActive} />
        <FormError message={save.isError ? errorMessage(save.error) : null} />
        <div className="flex gap-3">
          <button type="submit" className="btn btn-primary flex-1" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : service ? 'Save changes' : `Add ${noun}`}
          </button>
          <button type="button" className="btn" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
      <ConfirmPanel
        open={risky !== null}
        danger={risky?.danger ?? false}
        title={risky?.title ?? ''}
        message={risky?.message ?? ''}
        confirmLabel={risky?.label ?? 'Confirm'}
        busy={save.isPending}
        onConfirm={() => {
          if (risky) save.mutate(risky.body);
          setRisky(null);
        }}
        onClose={() => setRisky(null)}
      />
      {service && isItem && <Stock item={service} />}
      {service && <History service={service} />}
    </>
  );
}

/** The list for one kind. Services and items are kept on separate screens. */
function Catalog({ kind }: { kind: ServiceKind }) {
  const isItem = kind === 'item';
  const noun = isItem ? 'item' : 'service';
  const services = useQuery({
    queryKey: ['services', 'all'],
    queryFn: () => api<{ services: ServiceDto[] }>('/services?includeInactive=1'),
  });
  // `null` is the blank form for a new one; `undefined` means the panel is closed.
  const [editing, setEditing] = useState<ServiceDto | null | undefined>(undefined);
  const rows = (services.data?.services ?? []).filter((s) => s.kind === kind);

  return (
    <>
      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary ml-auto" onClick={() => setEditing(null)}>
          Add {noun}
        </button>
      </div>

      <section aria-label={isItem ? 'Items' : 'Services'} className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <div className="hidden grid-cols-[1fr_110px_130px_90px_100px] gap-4 border-b border-line bg-band px-4 py-2.5 text-xs font-medium text-ink-3 lg:grid">
          <span>{isItem ? 'Item' : 'Service'}</span>
          <span className="text-right">Price (GH₵)</span>
          <span>{isItem ? 'Stock' : 'Commission'}</span>
          <span className="text-right">Sold, 7 days</span>
          <span>Status</span>
        </div>
        {services.isPending && <SkeletonRows />}
        {services.isError && <EmptyRow>{errorMessage(services.error)}</EmptyRow>}
        {services.isSuccess && rows.length === 0 && <EmptyRow>No {noun}s yet. Add the first one.</EmptyRow>}
        <ul>
          {rows.map((s) => (
            <li key={s.id} className="border-b border-line-2 last:border-b-0">
              <button
                type="button"
                onClick={() => setEditing(s)}
                className="grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 text-left hover:bg-band lg:grid-cols-[1fr_110px_130px_90px_100px]"
              >
                <span className={`font-medium ${s.active ? 'text-ink' : 'text-ink-3'}`}>{s.name}</span>
                <span className="num text-right font-semibold text-ink">{formatAmount(s.price)}</span>
                <span className="col-start-1 text-sm text-ink-2 lg:col-start-auto">
                  {isItem ? (
                    <StockText stock={s.stock} />
                  ) : (
                    <>
                      {commissionText(s.commissionKind, s.commissionValue)}
                      <span className="lg:hidden"> commission</span>
                    </>
                  )}
                </span>
                <span className="num hidden text-right text-ink-2 lg:block">{s.sold7d}</span>
                <span className="col-start-2 row-start-2 justify-self-end lg:col-start-auto lg:row-start-auto lg:justify-self-start">
                  {s.active ? <Pill tone="green">{isItem ? 'On sale' : 'Offered'}</Pill> : <Pill tone="grey">Hidden</Pill>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} title={`${editing ? 'Edit' : 'Add'} ${noun}`}>
        {editing !== undefined && <ServiceForm key={editing?.id ?? 'new'} service={editing} newKind={kind} onDone={() => setEditing(undefined)} />}
      </Panel>
    </>
  );
}

/** Washing services: priced, with the washer's commission. */
export const Services = () => <Catalog kind="service" />;

/** Things sold off the shelf: priced, counted, no commission. */
export const Items = () => <Catalog kind="item" />;
