import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { formatAmount, formatGHS, parseGHS, serviceInput, type ChangeEntry, type ServiceDto } from '@niinas/shared';
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
      <h3 className="text-[13px] font-bold uppercase tracking-[0.06em] text-ink-3">History</h3>
      {history.isPending && <p className="mt-2 text-ink-3">Loading…</p>}
      {history.isError && <p className="mt-2 text-red-d">{errorMessage(history.error)}</p>}
      {history.isSuccess && rows.length === 0 && <p className="mt-2 text-ink-3">No changes yet.</p>}
      <ul className="mt-2 divide-y divide-line-2 border-y border-line-2">
        {rows.map((r) => (
          <li key={r.id} className="py-2.5">
            <p className="text-sm font-semibold text-ink">{describe(r, service)}</p>
            <p className="text-xs text-ink-3">
              {r.by ?? 'Someone'}, {shortDateTime(r.at)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ServiceForm({ service, onDone }: { service: ServiceDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(service?.name ?? '');
  const [price, setPrice] = useState(service ? formatAmount(service.price).replace(/,/g, '') : '');
  const [kind, setKind] = useState<Kind>(service?.commissionKind ?? 'percent');
  const [commission, setCommission] = useState(
    service ? (service.commissionKind === 'percent' ? String(service.commissionValue / 100) : formatAmount(service.commissionValue).replace(/,/g, '')) : '',
  );
  const [active, setActive] = useState(service?.active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Hiding a service or changing what it earns shapes every new job, so it asks first. */
  const [risky, setRisky] = useState<{ body: unknown; title: string; message: string; label: string; danger: boolean } | null>(null);

  const save = useMutation({
    mutationFn: (body: unknown) =>
      service ? api(`/services/${service.id}`, { method: 'PATCH', body }) : api('/services', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success(service ? 'Service updated' : `${name.trim()} added`);
      onDone();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    const priceValue = parseGHS(price);
    if (priceValue === null) found.price = 'Enter the price, like 45 or 45.50';
    const commissionValue = kind === 'percent' ? parsePercent(commission) : parseGHS(commission);
    if (commissionValue === null) found.commissionValue = kind === 'percent' ? 'Enter a percentage, like 18' : 'Enter an amount, like 5 or 5.50';

    const parsed = serviceInput.safeParse({
      name,
      price: priceValue ?? 0,
      commissionKind: kind,
      commissionValue: commissionValue ?? 0,
      active,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) found[String(issue.path[0] ?? 'form')] ??= issue.message;
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) return;
    if (service) {
      const hide = service.active && !parsed.data.active;
      const money =
        parsed.data.price !== service.price ||
        parsed.data.commissionKind !== service.commissionKind ||
        parsed.data.commissionValue !== service.commissionValue;
      if (hide) {
        return setRisky({ body: parsed.data, title: `Hide ${service.name}?`, message: 'It will not be offered on new jobs. Past jobs keep it.', label: 'Hide it', danger: true });
      }
      if (money) {
        return setRisky({ body: parsed.data, title: `Update ${service.name}?`, message: 'The new price and commission apply to new jobs only. Cars already booked keep what they were sold at.', label: 'Update', danger: false });
      }
    }
    save.mutate(parsed.data);
  }

  return (
    <>
      <form onSubmit={submit} onChange={() => setErrors((e) => (Object.keys(e).length ? {} : e))} noValidate className="flex flex-col gap-5">
        <Field label="Service name" error={errors.name}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} autoComplete="off" />
        </Field>
        <Field label="Price (GH₵)" error={errors.price}>
          <input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={!!errors.price} />
        </Field>
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
          hint="New jobs only."
          error={errors.commissionValue}
        >
          <input className="input num" inputMode="decimal" value={commission} onChange={(e) => setCommission(e.target.value)} aria-invalid={!!errors.commissionValue} />
        </Field>
        <Check label="Offered" hint="Off hides it from new jobs." checked={active} onChange={setActive} />
        <FormError message={save.isError ? errorMessage(save.error) : null} />
        <div className="flex gap-3">
          <button type="submit" className="btn btn-primary flex-1" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : service ? 'Save changes' : 'Add service'}
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
      {service && <History service={service} />}
    </>
  );
}

export function Services() {
  const services = useQuery({
    queryKey: ['services', 'all'],
    queryFn: () => api<{ services: ServiceDto[] }>('/services?includeInactive=1'),
  });
  // `null` is the blank form for a new service; `undefined` means the panel is closed.
  const [editing, setEditing] = useState<ServiceDto | null | undefined>(undefined);
  const rows = services.data?.services ?? [];

  return (
    <>
      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary ml-auto" onClick={() => setEditing(null)}>
          Add service
        </button>
      </div>

      <section aria-label="Services" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <div className="hidden grid-cols-[1fr_110px_130px_90px_100px] gap-4 border-b border-line bg-band px-4 py-2.5 text-xs font-bold uppercase tracking-[0.06em] text-ink-3 lg:grid">
          <span>Service</span>
          <span className="text-right">Price (GH₵)</span>
          <span>Commission</span>
          <span className="text-right">Sold, 7 days</span>
          <span>Status</span>
        </div>
        {services.isPending && <SkeletonRows />}
        {services.isError && <EmptyRow>{errorMessage(services.error)}</EmptyRow>}
        {services.isSuccess && rows.length === 0 && <EmptyRow>No services yet. Add the first one.</EmptyRow>}
        <ul>
          {rows.map((s) => (
            <li key={s.id} className="border-b border-line-2 last:border-b-0">
              <button
                type="button"
                onClick={() => setEditing(s)}
                className="grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 text-left hover:bg-band lg:grid-cols-[1fr_110px_130px_90px_100px]"
              >
                <span className={`font-bold ${s.active ? 'text-ink' : 'text-ink-3'}`}>{s.name}</span>
                <span className="num text-right font-bold text-ink">{formatAmount(s.price)}</span>
                <span className="col-start-1 text-sm text-ink-2 lg:col-start-auto">{commissionText(s.commissionKind, s.commissionValue)}<span className="lg:hidden"> commission</span></span>
                <span className="num hidden text-right text-ink-2 lg:block">{s.sold7d}</span>
                <span className="col-start-2 row-start-2 justify-self-end lg:col-start-auto lg:row-start-auto lg:justify-self-start">
                  {s.active ? <Pill tone="green">Offered</Pill> : <Pill tone="grey">Hidden</Pill>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Panel open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? 'Edit service' : 'Add service'}>
        {editing !== undefined && <ServiceForm key={editing?.id ?? 'new'} service={editing} onDone={() => setEditing(undefined)} />}
      </Panel>
    </>
  );
}
