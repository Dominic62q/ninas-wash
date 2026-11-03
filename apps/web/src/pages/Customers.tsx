import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import {
  CAR_TYPES,
  customerInput,
  formatGHS,
  formatPhone,
  vehicleInput,
  type CustomerDetail,
  type CustomerRow,
  type CustomerStats,
  type Page,
  type VehicleDto,
} from '@niinas/shared';
import { Select } from '../components/Dropdown';
import { Plate } from '../components/Plate';
import { useToast } from '../components/Toast';
import { Check, EmptyRow, Field, FormError, Panel, Pill, SkeletonRows, Strip, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { plural, shortDate } from '../lib/format';

const PAGE = 25;
const CAR_LABEL: Record<(typeof CAR_TYPES)[number], string> = { saloon: 'Saloon', suv: 'SUV', pickup: 'Pickup', van: 'Van', other: 'Other' };

/** Waits a moment after typing stops, so the list is not reloaded on every key. */
function useDebounced<T>(value: T, ms = 250): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

function CarFields({
  plate,
  makeModel,
  carType,
  errors,
  set,
}: {
  plate: string;
  makeModel: string;
  carType: string;
  errors: Record<string, string>;
  set: (patch: Partial<{ plate: string; makeModel: string; carType: string }>) => void;
}) {
  return (
    <>
      <Field label="Number plate" error={errors['vehicle.plate'] ?? errors.plate}>
        <input
          className="input uppercase"
          value={plate}
          onChange={(e) => set({ plate: e.target.value })}
          aria-invalid={!!(errors['vehicle.plate'] ?? errors.plate)}
          autoCapitalize="characters"
          autoComplete="off"
          placeholder="GR 1234-21"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Make and model (optional)">
          <input className="input" value={makeModel} onChange={(e) => set({ makeModel: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Type (optional)">
          <Select
            label="Type"
            value={carType}
            onChange={(v) => set({ carType: v })}
            options={[{ value: '', label: 'Not set' }, ...CAR_TYPES.map((t) => ({ value: t as string, label: CAR_LABEL[t] }))]}
          />
        </Field>
      </div>
    </>
  );
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const found: Record<string, string> = {};
  for (const issue of error.issues) found[issue.path.map(String).join('.')] ??= issue.message;
  return found;
}

// ---- add or edit a customer ---------------------------------------------------

function CustomerForm({ customer, onDone }: { customer: CustomerRow | null; onDone: (saved?: CustomerRow) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [okToText, setOkToText] = useState(customer?.okToText ?? false);
  const [withCar, setWithCar] = useState(true);
  const [car, setCar] = useState({ plate: '', makeModel: '', carType: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: unknown) =>
      customer
        ? api<{ customer: CustomerRow }>(`/customers/${customer.id}`, { method: 'PATCH', body })
        : api<{ customer: CustomerRow }>('/customers', { method: 'POST', body }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      await queryClient.invalidateQueries({ queryKey: ['customer'] });
      toast.success(customer ? 'Customer updated' : `${data.customer.name} added`);
      onDone(data.customer);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const input = { name, phone, okToText, ...(!customer && withCar && car.plate.trim() ? { vehicle: { ...car, carType: car.carType || null } } : {}) };
    const parsed = customerInput.safeParse(input);
    if (!parsed.success) return setErrors(issues(parsed.error));
    setErrors({});
    if (customer) save.mutate({ name: parsed.data.name, phone: parsed.data.phone, okToText: parsed.data.okToText });
    else save.mutate(parsed.data);
  }

  return (
    <form onSubmit={submit} onChange={() => setErrors((e) => (Object.keys(e).length ? {} : e))} noValidate className="flex flex-col gap-5">
      <Field label="Name" error={errors.name}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} autoComplete="off" />
      </Field>
      <Field label="Phone (optional)" error={errors.phone}>
        <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!errors.phone} />
      </Field>
      <Check
        label="OK to text them"
        hint="Only if they agreed."
        checked={okToText}
        onChange={setOkToText}
      />
      {!customer && (
        <fieldset className="flex flex-col gap-4 border-t border-line pt-5">
          <legend className="sr-only">First car</legend>
          <Check label="Add their car now" checked={withCar} onChange={setWithCar} />
          {withCar && <CarFields {...car} errors={errors} set={(p) => setCar((c) => ({ ...c, ...p }))} />}
        </fieldset>
      )}
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <div className="flex gap-3">
        <button type="submit" className="btn btn-primary flex-1" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : customer ? 'Save changes' : 'Add customer'}
        </button>
        <button type="button" className="btn" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---- cars -------------------------------------------------------------------

function VehicleForm({ customerId, vehicle, onDone }: { customerId: number; vehicle: VehicleDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [car, setCar] = useState({ plate: vehicle?.plate ?? '', makeModel: vehicle?.makeModel ?? '', carType: vehicle?.carType ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: unknown) =>
      vehicle ? api(`/vehicles/${vehicle.id}`, { method: 'PATCH', body }) : api(`/customers/${customerId}/vehicles`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      await queryClient.invalidateQueries({ queryKey: ['customer'] });
      toast.success(vehicle ? 'Car updated' : 'Car added');
      onDone();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = vehicleInput.safeParse({ ...car, carType: car.carType || null });
    if (!parsed.success) return setErrors(issues(parsed.error));
    setErrors({});
    save.mutate(parsed.data);
  }

  return (
    <form onSubmit={submit} onChange={() => setErrors((e) => (Object.keys(e).length ? {} : e))} noValidate className="flex flex-col gap-5">
      <CarFields {...car} errors={errors} set={(p) => setCar((c) => ({ ...c, ...p }))} />
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <div className="flex gap-3">
        <button type="submit" className="btn btn-primary flex-1" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : vehicle ? 'Save car' : 'Add car'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---- one customer -----------------------------------------------------------

function CustomerPanel({ id }: { id: number }) {
  const detail = useQuery({ queryKey: ['customer', id], queryFn: () => api<CustomerDetail>(`/customers/${id}`) });
  const [edit, setEdit] = useState<'customer' | { car: VehicleDto | null } | null>(null);
  const data = detail.data;

  if (edit && data) {
    return (
      <>
        <h3 className="display text-xl text-navy">{edit === 'customer' ? 'Edit customer' : edit.car ? 'Edit car' : 'Add a car'}</h3>
        {edit === 'customer' ? (
          <CustomerForm customer={data.customer} onDone={() => setEdit(null)} />
        ) : (
          <VehicleForm customerId={id} vehicle={edit.car} onDone={() => setEdit(null)} />
        )}
      </>
    );
  }

  return (
    <>
      {detail.isPending && (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
          <div className="skeleton h-14 w-3/5" />
          <div className="skeleton h-16" />
          <div className="skeleton h-28" />
        </div>
      )}
      {detail.isError && <FormError message={errorMessage(detail.error)} />}
      {data && (
        <>
          <section className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="display text-xl leading-tight text-navy lg:text-2xl">{data.customer.name}</p>
              <p className="text-ink-2">{data.customer.phone ? formatPhone(data.customer.phone) : 'No phone'}</p>
              <p className="mt-1 text-sm text-ink-3">{data.customer.okToText ? 'OK to text' : 'Do not text'}</p>
            </div>
            <button type="button" className="btn h-11 px-4" onClick={() => setEdit('customer')}>
              Edit
            </button>
          </section>

          {data.owes > 0 && (
            <p className="border-l-4 border-red bg-red-50 px-3 py-2.5 text-sm font-bold text-red-d">Owes {formatGHS(data.owes)}</p>
          )}

          <dl className="grid grid-cols-3 border border-line">
            {[
              ['Visits', String(data.customer.visits)],
              ['Last visit', data.customer.lastVisit ? shortDate(data.customer.lastVisit) : '—'],
              ['Spent', formatGHS(data.customer.spent)],
            ].map(([label, value], i) => (
              <div key={label} className={`px-3 py-3 ${i > 0 ? 'border-l border-line' : ''}`}>
                <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-3">{label}</dt>
                <dd className="num mt-0.5 font-bold text-navy">{value}</dd>
              </div>
            ))}
          </dl>

          <section aria-label="Cars">
            <div className="flex items-center gap-3">
              <h3 className="flex-1 text-[13px] font-bold uppercase tracking-[0.06em] text-ink-3">Cars</h3>
              <button type="button" className="tap text-sm text-blue-d" onClick={() => setEdit({ car: null })}>
                Add a car
              </button>
            </div>
            {data.customer.vehicles.length === 0 && <p className="mt-2 text-ink-3">No cars.</p>}
            <ul className="mt-2 divide-y divide-line-2 border-y border-line-2">
              {data.customer.vehicles.map((v) => (
                <li key={v.id} className="flex items-center gap-3 py-2.5">
                  <Plate plate={v.plate} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{[v.makeModel, v.carType && CAR_LABEL[v.carType]].filter(Boolean).join(' · ') || 'No details'}</span>
                  <button type="button" className="tap text-sm text-blue-d" onClick={() => setEdit({ car: v })}>
                    Edit
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="Recent visits">
            <h3 className="text-[13px] font-bold uppercase tracking-[0.06em] text-ink-3">Recent visits</h3>
            {data.recentVisits.length === 0 && <p className="mt-2 text-ink-3">No visits.</p>}
            <ul className="mt-2 divide-y divide-line-2 border-y border-line-2">
              {data.recentVisits.map((v) => (
                <li key={v.jobId} className="flex items-center gap-3 py-2.5">
                  <span className="w-16 flex-none text-sm text-ink-3">{shortDate(v.at)}</span>
                  <span className={`min-w-0 flex-1 truncate text-sm ${v.voided ? 'text-ink-3 line-through' : 'text-ink'}`}>{v.services.join(', ') || 'No services'}</span>
                  {v.voided ? <Pill tone="grey">Voided</Pill> : <span className="num text-sm font-bold text-ink">{formatGHS(v.total)}</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}

// ---- the page ---------------------------------------------------------------


export function Customers() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const search = useDebounced(q.trim());
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => setLimit(PAGE), [search]);

  const stats = useQuery({ queryKey: ['customers', 'stats'], queryFn: () => api<CustomerStats>('/customers/stats') });
  const list = useQuery({
    queryKey: ['customers', 'list', search, limit],
    queryFn: () => api<Page<CustomerRow>>(`/customers?limit=${limit}&q=${encodeURIComponent(search)}`),
    placeholderData: (previous) => previous,
  });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const s = stats.data;

  return (
    <>
      <Strip
        items={[
          { label: 'Customers', short: 'Customers', value: s ? String(s.total) : '…' },
          { label: 'New this week', short: 'New this week', value: s ? String(s.newThisWeek) : '…' },
          { label: 'Came back this month', short: 'Came back', value: s?.cameBackThisMonthPct != null ? `${s.cameBackThisMonthPct}%` : '—', note: 'of those seen this month' },
          { label: 'OK to text', short: 'OK to text', value: s?.okToTextPct != null ? `${s.okToTextPct}%` : '—' },
        ]}
      />

      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="customer-search" className="sr-only">
            Search customers
          </label>
          <input
            id="customer-search"
            type="search"
            className="input"
            placeholder="Name, phone or plate"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
          />
        </div>
        {can('customer.export') && (
          <a href="/api/customers/export.csv" download className="btn hidden no-underline sm:inline-flex">
            Export CSV
          </a>
        )}
        <button type="button" className="btn btn-primary flex-none px-5" onClick={() => setAdding(true)}>
          <span>
            + Add<span className="hidden sm:inline"> customer</span>
          </span>
        </button>
      </div>

      <section aria-label="Customers" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <div className="hidden grid-cols-[1.4fr_1.2fr_70px_110px_120px] gap-4 border-b border-line bg-band px-4 py-2.5 text-xs font-bold uppercase tracking-[0.06em] text-ink-3 lg:grid">
          <span>Customer</span>
          <span>Cars</span>
          <span className="text-right">Visits</span>
          <span>Last visit</span>
          <span className="text-right">Spent (GH₵)</span>
        </div>
        {list.isPending && <SkeletonRows />}
        {list.isError && <EmptyRow>{errorMessage(list.error)}</EmptyRow>}
        {list.isSuccess && rows.length === 0 && <EmptyRow>{search ? 'No one matches that.' : 'No customers yet. Add the first one.'}</EmptyRow>}
        <ul>
          {rows.map((c) => (
            <li key={c.id} className="border-b border-line-2 last:border-b-0">
              <button type="button" onClick={() => setSelected(c.id)} className="block w-full cursor-pointer px-4 py-3 text-left hover:bg-band active:bg-band lg:py-3.5">
                {/* Phone: two short lines. Name and phone on the left, plate and visits on the right. */}
                <span className="flex items-center gap-3 lg:hidden">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold text-ink">{c.name}</span>
                    <span className="block truncate text-sm text-ink-3">{c.phone ? formatPhone(c.phone) : 'No phone'}</span>
                  </span>
                  <span className="flex flex-none flex-col items-end gap-1">
                    <span className="flex items-center gap-1.5">
                      {c.vehicles.length > 1 && <span className="text-xs font-bold text-ink-3">+{c.vehicles.length - 1}</span>}
                      {c.vehicles[0] ? <Plate plate={c.vehicles[0].plate} size="sm" /> : <span className="text-sm text-ink-3">No car</span>}
                    </span>
                    <span className="text-xs text-ink-3">
                      {c.lastVisit ? `${plural(c.visits, 'visit')} · ${shortDate(c.lastVisit)}` : 'No visits'}
                    </span>
                  </span>
                </span>

                {/* Computer: the table row. */}
                <span className="hidden grid-cols-[1.4fr_1.2fr_70px_110px_120px] items-center gap-4 lg:grid">
                  <span className="min-w-0">
                    <span className="block truncate font-bold text-ink">{c.name}</span>
                    <span className="block text-sm text-ink-3">{c.phone ? formatPhone(c.phone) : 'No phone'}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-sm text-ink-3">
                    {c.vehicles.length ? c.vehicles.map((v) => <Plate key={v.id} plate={v.plate} size="sm" />) : 'No car saved'}
                  </span>
                  <span className="num text-right">{c.visits}</span>
                  <span className="text-sm text-ink-3">{c.lastVisit ? shortDate(c.lastVisit) : 'Never'}</span>
                  <span className="num text-right font-bold">{(c.spent / 100).toFixed(2)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {total > rows.length && (
          <div className="border-t border-line-2 px-4 py-3 text-center">
            <button type="button" className="font-bold text-blue-d" onClick={() => setLimit((n) => n + PAGE)}>
              Show more ({rows.length} of {total})
            </button>
          </div>
        )}
      </section>

      {can('customer.export') && (
        <a href="/api/customers/export.csv" download className="tap self-center text-sm text-blue-d no-underline sm:hidden">
          Export all as CSV
        </a>
      )}

      <Panel tall open={selected !== null} onClose={() => setSelected(null)} title="Customer">
        {selected !== null && <CustomerPanel key={selected} id={selected} />}
      </Panel>
      <Panel tall open={adding} onClose={() => setAdding(false)} title="Add customer">
        {adding && (
          <CustomerForm
            customer={null}
            onDone={(saved) => {
              setAdding(false);
              if (saved) setSelected(saved.id);
            }}
          />
        )}
      </Panel>
    </>
  );
}
