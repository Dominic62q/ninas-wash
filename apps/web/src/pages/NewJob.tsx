import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  CAR_TYPES,
  createJobInput,
  formatAmount,
  formatGHS,
  formatPhone,
  normalizePlate,
  parseGHS,
  type CustomerRow,
  type VehicleDto,
  type VehicleMatch,
} from '@niinas/shared';
import { Avatar } from '../components/Avatar';
import { MultiSelect, Select } from '../components/Dropdown';
import { Plate } from '../components/Plate';
import { AttendantPicker, sharedNote, useAttendants, useServices } from '../components/JobBits';
import { useToast } from '../components/Toast';
import { Check, Field, FormError, Panel, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { plural, shortDate } from '../lib/format';

const CAR_LABEL: Record<(typeof CAR_TYPES)[number], string> = { saloon: 'Saloon', suv: 'SUV', pickup: 'Pickup', van: 'Van', other: 'Other' };

function useDebounced<T>(value: T, ms = 300): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

interface Lookup {
  vehicle: VehicleDto | null;
  customer: CustomerRow | null;
}

/** Phone: tap faces to put people on a service. */
function WasherRow({ people, value, label, onToggle }: { people: { id: number; name: string }[]; value: number[]; label: string; onToggle: (id: number) => void }) {
  return (
    <ul aria-label={`Who is washing ${label}`} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {people.map((p) => {
        const on = value.includes(p.id);
        return (
          <li key={p.id} className="flex-none">
            <button
              type="button"
              aria-pressed={on}
              aria-label={p.name}
              onClick={() => onToggle(p.id)}
              className={`flex w-[60px] cursor-pointer flex-col items-center gap-1.5 text-[12.5px] font-semibold ${on ? 'text-navy' : 'text-ink-2'}`}
            >
              <span className={`rounded-full transition-opacity ${on ? 'opacity-100 ring-2 ring-white ring-offset-2 ring-offset-blue' : 'opacity-50'}`}>
                <Avatar name={p.name} className="!h-11 !w-11 !text-sm" />
              </span>
              <span className="max-w-full truncate">{p.name.split(' ')[0]}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function NewJob() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const services = useServices();
  const attendants = useAttendants();

  const [plate, setPlate] = useState('');
  const [makeModel, setMakeModel] = useState('');
  const [carType, setCarType] = useState('');
  const [saveOwner, setSaveOwner] = useState(false);
  const [owner, setOwner] = useState({ name: '', phone: '', okToText: false });
  /** serviceId -> the people on it. A service is on the job when it has a key. */
  const [picked, setPicked] = useState<Map<number, number[]>>(new Map());
  const [startNow, setStartNow] = useState(false);
  const [plateSheet, setPlateSheet] = useState(false);
  const sheetInput = useRef<HTMLInputElement>(null);
  // The plate was tapped to be typed, so the keyboard may come up. The sheet's own effect has opened the dialog by now.
  useEffect(() => {
    if (plateSheet) sheetInput.current?.focus();
  }, [plateSheet]);
  const [discount, setDiscount] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const plateKey = normalizePlate(plate);
  const lookupKey = useDebounced(plateKey.length >= 3 ? plateKey : '');
  const lookup = useQuery({
    queryKey: ['lookup', lookupKey],
    queryFn: () => api<Lookup>(`/vehicles/lookup?plate=${encodeURIComponent(lookupKey)}`),
    enabled: lookupKey !== '',
  });
  const suggestKey = useDebounced(plateKey.length >= 2 ? plateKey : '', 200);
  const suggest = useQuery({
    queryKey: ['vehicle-search', suggestKey],
    queryFn: () => api<{ matches: VehicleMatch[] }>(`/vehicles/search?q=${encodeURIComponent(suggestKey)}`),
    enabled: suggestKey !== '',
    placeholderData: (prev) => prev,
  });
  const known = lookupKey === plateKey && lookup.data?.vehicle ? lookup.data : null;
  const matches = suggestKey === plateKey ? (suggest.data?.matches ?? []) : [];
  const exactMatch = matches.some((m) => normalizePlate(m.vehicle.plate) === plateKey);
  const showMatches = matches.length > 0 && !exactMatch && !known;
  const searching = plateKey.length >= 3 && (lookupKey !== plateKey || lookup.isFetching);
  const isNewCar = plateKey.length >= 3 && !searching && !known;
  const needsOwner = !!known && !known.customer;

  const serviceList = services.data?.services ?? [];
  const people = attendants.data?.attendants ?? [];
  const subtotal = serviceList.filter((s) => picked.has(s.id)).reduce((sum, s) => sum + s.price, 0);
  const discountValue = discount.trim() === '' ? 0 : parseGHS(discount);
  const total = Math.max(subtotal - (discountValue ?? 0), 0);
  /** People on every chosen service, and everyone on at least one. */
  const lines = [...picked.values()];
  const onAll = lines.length === 0 ? [] : lines.reduce((a, b) => a.filter((id) => b.includes(id)));
  const onAny = new Set(lines.flat()).size;

  const save = useMutation({
    mutationFn: (body: unknown) => api('/jobs', { method: 'POST', body }),
    onSuccess: async (_data, body) => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      toast.success((body as { start: boolean }).start ? 'Job saved and wash started' : 'Job saved as pending');
      navigate('/jobs');
    },
  });

  function toggleService(id: number) {
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(id)) next.delete(id);
      else next.set(id, []);
      return next;
    });
    setErrors((e) => (Object.keys(e).length ? {} : e));
  }

  /** Phone: the services dropdown. A new service starts with the people already on every other service. */
  function setServices(ids: number[]) {
    setPicked((m) => new Map(ids.map((id) => [id, m.get(id) ?? onAll] as const)));
    setErrors((e) => (Object.keys(e).length ? {} : e));
  }

  /** Phone: the shortcut row. Adds the person to every service, or takes them off every one. */
  function toggleCrew(id: number) {
    const remove = onAll.includes(id);
    setPicked((m) => new Map([...m].map(([k, ids]) => [k, remove ? ids.filter((x) => x !== id) : ids.includes(id) ? ids : [...ids, id]] as const)));
    setErrors((e) => (Object.keys(e).length ? {} : e));
  }

  function submit(start: boolean) {
    const found: Record<string, string> = {};
    if (discountValue === null) found.discount = 'Enter the discount, like 5 or 5.50';
    if (start && [...picked.values()].some((ids) => ids.length === 0)) {
      found.lines = 'Pick attendants for each service, or save as pending.';
    }
    const wantsOwner = (isNewCar || needsOwner) && saveOwner;
    const parsed = createJobInput.safeParse({
      plate,
      makeModel: isNewCar ? makeModel : null,
      carType: isNewCar ? carType || null : null,
      lines: [...picked].map(([serviceId, attendantIds]) => ({ serviceId, attendantIds })),
      discount: discountValue ?? 0,
      notes,
      start,
      ...(wantsOwner ? { customer: { name: owner.name, phone: owner.phone, okToText: owner.okToText } } : {}),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === 'customer' ? `customer.${String(issue.path[1])}` : String(issue.path[0] ?? 'form');
        found[key] ??= issue.message;
      }
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) return;
    save.mutate(parsed.data);
  }

  return (
    <form
      noValidate
      onSubmit={(e) => e.preventDefault()}
      onChange={() => setErrors((e) => (Object.keys(e).length ? {} : e))}
      className="mx-auto flex w-full max-w-[860px] flex-col gap-4 max-lg:flex-1 lg:gap-6"
    >
      <section aria-label="The car" className="flex flex-col gap-3 border border-line bg-surface p-4 max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card lg:gap-4 lg:p-5">
        <h2 className="display text-lg text-navy lg:text-xl">The car</h2>
        <Field label="Number plate" error={errors.plate}>
          <input
            className="input uppercase max-lg:hidden"
            value={plate}
            onChange={(e) => setPlate(e.target.value)}
            aria-invalid={!!errors.plate}
            autoCapitalize="characters"
            autoComplete="off"
            autoFocus
            placeholder="GR 1234-21"
          />
          {/* Phone: the plate opens a sheet, like the services do. The keyboard comes up only once the sheet is open. */}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label="Number plate"
            aria-invalid={!!errors.plate}
            onClick={() => setPlateSheet(true)}
            className={`input flex h-[60px] cursor-pointer items-center justify-center border-l-[10px] border-l-[var(--plate-stripe)] text-center text-[26px] font-bold uppercase tracking-[0.08em] lg:hidden ${plate.trim() ? '' : 'text-ink-3'}`}
          >
            {plate.trim() || 'GR 1234-21'}
          </button>
        </Field>

        <Panel open={plateSheet} onClose={() => setPlateSheet(false)} title="Number plate" tall>
          <input
            className="input h-[54px] border-l-[10px] border-l-[var(--plate-stripe)] text-center text-[22px] font-bold uppercase tracking-[0.08em]"
            type="search"
            enterKeyHint="done"
            value={plate}
            onChange={(e) => setPlate(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), setPlateSheet(false))}
            aria-label="Search number plate"
            autoCapitalize="characters"
            autoComplete="off"
            ref={sheetInput}
            placeholder="GR 1234-21"
          />
          <ul aria-label="Cars on file" className="-mx-4 flex flex-1 flex-col">
            {plateKey.length < 2 && <li className="px-4 py-3 text-sm text-ink-3">Type the plate. Cars we know show up here.</li>}
            {matches.map((m) => (
              <li key={m.vehicle.id}>
                <button
                  type="button"
                  disabled={m.onBoard}
                  onClick={() => {
                    setPlate(m.vehicle.plate);
                    setPlateSheet(false);
                  }}
                  className="flex min-h-[56px] w-full cursor-pointer items-center gap-3 px-4 py-2 text-left active:bg-band disabled:opacity-60"
                >
                  <Plate plate={m.vehicle.plate} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{[m.owner ?? 'Walk-in', m.vehicle.makeModel].filter(Boolean).join(' · ')}</span>
                  {m.onBoard && <span className="text-xs font-bold text-amber">On the board</span>}
                </button>
              </li>
            ))}
            {plateKey.length >= 3 && !exactMatch && !known && matches.length === 0 && !searching && (
              <li className="px-4 py-3 text-sm text-ink-2">No car on file with this plate. It will be saved as a new car.</li>
            )}
          </ul>
          <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-line bg-surface px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            <button type="button" className="btn btn-primary h-12 w-full" disabled={plateKey.length < 2} onClick={() => setPlateSheet(false)}>
              {searching ? 'Looking…' : plateKey.length >= 2 ? `Use ${plate.trim().toUpperCase()}` : 'Done'}
            </button>
          </div>
        </Panel>

        {showMatches && (
          <ul aria-label="Cars on file" className="-mt-2 flex flex-col border border-line bg-surface max-lg:hidden">
            {matches.map((m) => (
              <li key={m.vehicle.id} className="border-b border-line-2 last:border-b-0">
                <button
                  type="button"
                  disabled={m.onBoard}
                  onClick={() => setPlate(m.vehicle.plate)}
                  className="tap flex min-h-11 w-full items-center gap-3 px-3 py-1.5 text-left disabled:opacity-60"
                >
                  <Plate plate={m.vehicle.plate} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-2">
                    {[m.owner ?? 'Walk-in', m.vehicle.makeModel].filter(Boolean).join(' · ')}
                  </span>
                  {m.onBoard && <span className="text-xs font-bold text-amber">On the board</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {plateKey.length >= 2 && (
          <div className="flex items-center gap-3 max-lg:hidden">
            <Plate plate={plate.trim()} size="lg" />
            {searching && <span className="text-sm text-ink-3">Looking…</span>}
          </div>
        )}
        {known?.vehicle && (
          <div className="border-l-4 border-green bg-green-50 px-3 py-2.5 text-sm">
            <p className="font-bold text-ink">
              {[known.vehicle.makeModel, known.vehicle.carType && CAR_LABEL[known.vehicle.carType]].filter(Boolean).join(' · ') || 'A car we know'}
            </p>
            <p className="text-ink-2">
              {known.customer
                ? `${known.customer.name}${known.customer.phone ? `, ${formatPhone(known.customer.phone)}` : ''} · ${plural(known.customer.visits, 'visit')}${
                    known.customer.lastVisit ? `, last on ${shortDate(known.customer.lastVisit)}` : ''
                  }`
                : 'Walk-in car with no owner saved'}
            </p>
          </div>
        )}
        {isNewCar && (
          <>
            <p className="border-l-4 border-blue bg-blue-50 px-3 py-2.5 text-sm font-semibold text-blue-d">New car</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Make and model (optional)">
                <input className="input" value={makeModel} onChange={(e) => setMakeModel(e.target.value)} autoComplete="off" placeholder="Toyota Corolla" />
              </Field>
              <Field label="Type (optional)">
                <Select
                  label="Type"
                  value={carType}
                  onChange={setCarType}
                  options={[{ value: '', label: 'Not set' }, ...CAR_TYPES.map((t) => ({ value: t as string, label: CAR_LABEL[t] }))]}
                />
              </Field>
            </div>
          </>
        )}
        {(isNewCar || needsOwner) && (
          <>
            <Check label="Save owner for next time" checked={saveOwner} onChange={setSaveOwner} />
            {saveOwner && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" error={errors['customer.name']}>
                  <input className="input" value={owner.name} onChange={(e) => setOwner((o) => ({ ...o, name: e.target.value }))} autoComplete="off" aria-invalid={!!errors['customer.name']} />
                </Field>
                <Field label="Phone" error={errors['customer.phone']}>
                  <input
                    className="input"
                    type="tel"
                    inputMode="tel"
                    value={owner.phone}
                    onChange={(e) => setOwner((o) => ({ ...o, phone: e.target.value }))}
                    autoComplete="off"
                    placeholder="024 123 4567"
                    aria-invalid={!!errors['customer.phone']}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Check label="OK to text them" checked={owner.okToText} onChange={(v) => setOwner((o) => ({ ...o, okToText: v }))} />
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section aria-label="Services" className="flex flex-col gap-3 border border-line bg-surface p-4 max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card sm:p-5">
        <h2 className="display text-lg text-navy lg:text-xl">Services</h2>
        {(services.isPending || attendants.isPending) && <p className="text-ink-3">Loading…</p>}
        {services.isError && <FormError message={errorMessage(services.error)} />}
        {services.isSuccess && serviceList.length === 0 && <p className="text-ink-3">No services yet. Add them under Services.</p>}
        {/* Phone: one dropdown for the services. */}
        {serviceList.length > 0 && (
          <div className="lg:hidden">
            <MultiSelect
              label="Services"
              placeholder="Choose services"
              options={serviceList.map((s) => ({ value: s.id, label: `${s.name} · ${formatGHS(s.price)}` }))}
              value={[...picked.keys()]}
              onChange={setServices}
            />
          </div>
        )}
        {/* Chosen services sit on top, each with its own attendants. */}
        {serviceList
          .filter((s) => picked.has(s.id))
          .map((s) => {
            const ids = picked.get(s.id) ?? [];
            return (
              <div key={s.id} className="rise flex flex-col gap-2.5 border-[1.5px] border-blue bg-blue-50 p-3 max-lg:rounded-[10px] max-lg:border-0">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 flex-1 truncate font-bold text-ink">{s.name}</p>
                  <span className="num font-bold text-navy">{formatGHS(s.price)}</span>
                  <button type="button" aria-label={`Remove ${s.name}`} onClick={() => toggleService(s.id)} className="tap -mr-1 px-1.5 text-lg leading-none text-ink-3">
                    ✕
                  </button>
                </div>
                {people.length === 0 ? (
                  <p className="text-sm text-ink-3">No attendants yet. Add them under Staff and users.</p>
                ) : (
                  <>
                    <div className="max-lg:hidden">
                      <AttendantPicker
                        label={`Attendants for ${s.name}`}
                        options={people}
                        value={ids}
                        onChange={(next) => {
                          setPicked((m) => new Map(m).set(s.id, next));
                          setErrors({});
                        }}
                      />
                    </div>
                    <div className="lg:hidden">
                      <WasherRow
                        people={people}
                        value={ids}
                        label={s.name}
                        onToggle={(id) => {
                          setPicked((m) => new Map(m).set(s.id, ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
                          setErrors({});
                        }}
                      />
                    </div>
                  </>
                )}
                {sharedNote(ids.length) && <p className="text-xs text-ink-3">{sharedNote(ids.length)}</p>}
              </div>
            );
          })}
        {errors.lines && <p role="alert" className="text-[13px] font-semibold text-red-d">{errors.lines}</p>}

        <div className="grid grid-cols-2 gap-2 max-lg:hidden sm:grid-cols-3">
          {serviceList
            .filter((s) => !picked.has(s.id))
            .map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={false}
                onClick={() => toggleService(s.id)}
                className="flex min-h-[52px] cursor-pointer flex-col justify-center border-[1.5px] border-line-strong bg-surface px-3 py-1.5 text-left"
              >
                <span className="text-sm font-bold leading-tight text-ink">{s.name}</span>
                <span className="num text-sm font-bold text-navy">{formatGHS(s.price)}</span>
              </button>
            ))}
        </div>
      </section>

      {/* Phone: a shortcut for putting the same people on every service, and the start-now tick. */}
      <section aria-label="Same people on every service" className="flex flex-col gap-3 rounded-[14px] bg-surface p-4 shadow-card lg:hidden">
        {picked.size > 1 && people.length > 0 && (
          <>
            <h2 className="display text-lg text-navy">Same people on every service</h2>
            <WasherRow people={people} value={onAll} label="every service" onToggle={toggleCrew} />
          </>
        )}
        <Check label="Start washing now" checked={startNow} onChange={setStartNow} hint="Leave off to book the car as pending." />
      </section>

      <section aria-label="Price" className="flex flex-col gap-3 border border-line bg-surface p-4 max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card lg:gap-4 lg:p-5">
        <h2 className="display text-lg text-navy lg:text-xl">Price</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Discount in GH₵ (optional)" error={errors.discount}>
            <input
              className="input"
              inputMode="decimal"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              aria-invalid={!!errors.discount}
              autoComplete="off"
              placeholder="0.00"
            />
          </Field>
          <Field label="Note (optional)" error={errors.notes}>
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} autoComplete="off" maxLength={300} placeholder="Scratch on the left door" />
          </Field>
        </div>
        <dl className={`num flex flex-col gap-1 border-t border-line-2 pt-3 text-sm ${discountValue ? '' : 'max-lg:hidden'}`}>
          {!!discountValue && (
            <>
              <div className="flex justify-between text-ink-2">
                <dt>Subtotal</dt>
                <dd>{formatGHS(subtotal)}</dd>
              </div>
              <div className="flex justify-between text-ink-2">
                <dt>Discount</dt>
                <dd>− {formatAmount(discountValue)}</dd>
              </div>
            </>
          )}
          <div className="flex items-baseline justify-between max-lg:hidden">
            <dt className="font-bold text-ink">Total</dt>
            <dd className="display text-[24px] leading-none text-navy lg:text-[28px]">{formatGHS(total)}</dd>
          </div>
        </dl>
      </section>

      <FormError message={save.isError ? errorMessage(save.error) : (errors.form ?? null)} />
      <div className="grid grid-cols-2 gap-3 max-lg:hidden">
        <button type="button" className="btn btn-primary h-auto min-h-11 px-3 py-2 text-center leading-tight lg:min-h-12" disabled={save.isPending} onClick={() => submit(true)}>
          {save.isPending ? 'Saving…' : 'Start wash'}
        </button>
        <button type="button" className="btn h-auto min-h-11 px-3 py-2 text-center leading-tight lg:min-h-12" disabled={save.isPending} onClick={() => submit(false)}>
          Save as pending
        </button>
      </div>

      {/* Phone: the total and the one button, fixed to the bottom. */}
      <div className="sticky bottom-0 z-20 -mx-4 -mb-4 mt-auto flex items-center gap-3.5 rounded-t-[18px] bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_30px_rgba(7,31,71,0.14)] lg:hidden">
        <div className="leading-tight">
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">Total</p>
          <p className="display num whitespace-nowrap text-2xl text-navy">{formatGHS(total)}</p>
          <p className="text-xs text-ink-3">
            {plural(picked.size, 'service')}, {plural(onAny, 'washer')}
          </p>
        </div>
        <button type="button" className="btn btn-primary h-[50px] flex-1 text-[15.5px]" disabled={save.isPending} onClick={() => submit(startNow)}>
          {save.isPending ? 'Saving…' : startNow ? 'Book and start wash' : 'Book the car'}
        </button>
      </div>
    </form>
  );
}
