import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useRef, useState, type ReactNode } from 'react';
import {
  EVENT_LABEL,
  SAMPLE_VALUES,
  formatPhone,
  renderTemplate,
  sendInput,
  smsSegments,
  templateInput,
  unsupportedChars,
  creditInput,
  type CustomerRow,
  type Page,
  type SmsCreditEntryDto,
  type SmsMessageDto,
  type SmsMessagesPage,
  type SmsOverview,
  type SmsStatus,
  type SmsTemplateDto,
} from '@niinas/shared';
import { useToast } from '../components/Toast';
import { Check, EmptyRow, Field, FormError, Panel, Pill, SkeletonRows, Strip, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { newKey, plural, shortDate, shortDateTime } from '../lib/format';

const TABS = [
  { value: 'activity', label: 'Activity' },
  { value: 'wording', label: 'Wording' },
  { value: 'credits', label: 'Credits' },
] as const;
type Tab = (typeof TABS)[number]['value'];

const FILTERS: { value: SmsStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Not sent' },
];

const STEP = 30;

function StatusPill({ status }: { status: SmsStatus }) {
  if (status === 'sent') return <Pill tone="green">Sent</Pill>;
  if (status === 'skipped') return <Pill tone="grey">Not sent</Pill>;
  return <span className="inline-block whitespace-nowrap bg-red-50 px-2 py-0.5 text-xs font-bold text-red-d max-lg:rounded-md">Failed</span>;
}

function Notice({ tone, children }: { tone: 'red' | 'amber'; children: ReactNode }) {
  return (
    <p role="status" className={`border-l-4 bg-surface px-3 py-2.5 text-sm font-semibold text-ink shadow-card max-lg:rounded-[10px] ${tone === 'red' ? 'border-red' : 'border-amber'}`}>
      {children}
    </p>
  );
}

/** "123 characters · 1 text". Over 160 characters a text costs more than one credit. */
function Counter({ body }: { body: string }) {
  const segments = smsSegments(body);
  const bad = unsupportedChars(body);
  return (
    <p className={`text-xs ${bad.length ? 'font-semibold text-red-d' : 'text-ink-3'}`}>
      {bad.length ? `Not allowed: ${bad.join(' ')}. Use plain letters and symbols.` : `${body.length} characters · ${plural(segments, 'text')} (${plural(segments, 'credit')} each time)`}
    </p>
  );
}

// ---- activity -----------------------------------------------------------------

function MessageRow({ message, canResend, onResend, busy }: { message: SmsMessageDto; canResend: boolean; onResend: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate font-bold text-ink">{message.customer?.name ?? formatPhone(message.phone)}</p>
        <time dateTime={message.at} className="shrink-0 text-xs text-ink-3">
          {shortDateTime(message.at)}
        </time>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <StatusPill status={message.status} />
        <Pill tone="blue">{EVENT_LABEL[message.event]}</Pill>
        {message.plate && <span className="num text-xs text-ink-3">{message.plate}</span>}
        {message.segments > 1 && <span className="text-xs text-ink-3">{plural(message.segments, 'text')}</span>}
      </p>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`mt-1.5 block w-full cursor-pointer text-left text-sm text-ink-2 ${open ? '' : 'line-clamp-2'}`}>
        {message.body}
      </button>
      {message.error && <p className="mt-1 text-xs font-semibold text-red-d">{message.error}</p>}
      <p className="mt-0.5 text-xs text-ink-3">
        {message.customer && message.customer.name !== formatPhone(message.phone) ? `${formatPhone(message.phone)} · ` : ''}
        {message.by ? `Sent by ${message.by}` : 'Automatic'}
      </p>
      {canResend && message.status !== 'sent' && message.customer && (
        <button type="button" className="tap -mb-2 text-sm text-blue-d" disabled={busy} onClick={onResend}>
          {busy ? 'Sending…' : 'Send again'}
        </button>
      )}
    </li>
  );
}

function ActivityTab({ canSend }: { canSend: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<SmsStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(STEP);
  const q = useDeferredValue(search.trim());

  const list = useQuery({
    queryKey: ['sms', 'messages', filter, q, limit],
    queryFn: () => api<SmsMessagesPage>(`/sms/messages?limit=${limit}${filter === 'all' ? '' : `&status=${filter}`}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });
  const resend = useMutation({
    mutationFn: (id: number) => api<{ message: SmsMessageDto }>(`/sms/messages/${id}/resend`, { method: 'POST', body: { idemKey: newKey() } }),
    onSuccess: async ({ message }) => {
      await queryClient.invalidateQueries({ queryKey: ['sms'] });
      if (message.status === 'sent') toast.success('Text sent');
      else toast.error(message.error ?? 'The text did not go');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const data = list.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div role="radiogroup" aria-label="Show" className="flex gap-2 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={filter === f.value}
              onClick={() => { setFilter(f.value); setLimit(STEP); }}
              className={`btn h-9 shrink-0 px-3 text-sm ${filter === f.value ? 'border-blue bg-blue-50 text-blue-d' : ''}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          className="input lg:ml-auto lg:max-w-[260px]"
          type="search"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setLimit(STEP); }}
          placeholder="Search texts"
          aria-label="Search texts"
          autoComplete="off"
        />
      </div>

      <FormError message={list.isError ? errorMessage(list.error) : null} />

      <section aria-label="Texts" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        {list.isPending ? (
          <SkeletonRows count={4} />
        ) : data && data.messages.length > 0 ? (
          <ul className="divide-y divide-line">
            {data.messages.map((m) => (
              <MessageRow key={m.id} message={m} canResend={canSend} busy={resend.isPending && resend.variables === m.id} onResend={() => resend.mutate(m.id)} />
            ))}
          </ul>
        ) : (
          <EmptyRow>{filter === 'all' && !q ? 'No texts yet. They appear here as cars are booked, finished and paid for.' : 'No texts match.'}</EmptyRow>
        )}
      </section>
      {data && data.messages.length > 0 && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-center text-xs text-ink-3">
            Showing {data.messages.length} of {data.total}
          </p>
          {data.messages.length < data.total && (
            <button type="button" className="btn" onClick={() => setLimit((l) => l + STEP)}>
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---- send by hand ---------------------------------------------------------------

function SendPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<CustomerRow | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  // One key per form: a double-tap or a retry after a bad connection sends the text once.
  const [idemKey, setIdemKey] = useState(newKey);
  const q = useDeferredValue(search.trim());

  const customers = useQuery({
    queryKey: ['customers', 'sms-pick', q],
    queryFn: () => api<Page<CustomerRow>>(`/customers?limit=8&q=${encodeURIComponent(q)}`),
    enabled: open && !picked,
  });
  const send = useMutation({
    mutationFn: (body: unknown) => api<{ message: SmsMessageDto }>('/sms/send', { method: 'POST', body }),
    onSuccess: async ({ message: sent }) => {
      await queryClient.invalidateQueries({ queryKey: ['sms'] });
      if (sent.status === 'sent') toast.success(`Text sent to ${picked?.name ?? 'the customer'}`);
      else toast.error(sent.error ?? 'The text did not go');
      setMessage('');
      setPicked(null);
      setSearch('');
      setIdemKey(newKey());
      onClose();
    },
  });

  function submit() {
    if (!picked) return setError('Pick who to text');
    const parsed = sendInput.safeParse({ customerId: picked.id, message, idemKey });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the message');
    setError(null);
    send.mutate(parsed.data);
  }

  const reason = (c: CustomerRow) => (!c.phone ? 'No phone number' : !c.okToText ? 'Has not agreed to texts' : null);

  return (
    <Panel open={open} onClose={onClose} title="Send a text" tall>
      {picked ? (
        <div className="flex items-center gap-3 rounded-[10px] bg-band px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold text-ink">{picked.name}</p>
            <p className="num text-sm text-ink-3">{formatPhone(picked.phone)}</p>
          </div>
          <button type="button" className="tap text-sm text-blue-d" onClick={() => setPicked(null)}>
            Change
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Field label="Who is it for?">
            <input className="input" type="search" value={search} onChange={(e) => { setSearch(e.target.value); setError(null); }} placeholder="Name, phone or plate" autoComplete="off" />
          </Field>
          <ul className="overflow-hidden rounded-[10px] border border-line">
            {customers.isPending ? (
              <li className="px-3.5 py-3 text-sm text-ink-3">Loading…</li>
            ) : customers.data && customers.data.rows.length > 0 ? (
              customers.data.rows.map((c) => {
                const why = reason(c);
                return (
                  <li key={c.id} className="border-t border-line first:border-t-0">
                    <button type="button" disabled={why !== null} onClick={() => { setPicked(c); setError(null); }} className="flex min-h-14 w-full items-center gap-3 px-3.5 py-2 text-left enabled:cursor-pointer enabled:active:bg-band disabled:opacity-60">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-ink">{c.name}</span>
                        <span className="num block text-xs text-ink-3">{why ?? formatPhone(c.phone)}</span>
                      </span>
                      {why === null && <span aria-hidden="true" className="text-ink-3">›</span>}
                    </button>
                  </li>
                );
              })
            ) : (
              <li className="px-3.5 py-3 text-sm text-ink-3">No customers found.</li>
            )}
          </ul>
        </div>
      )}
      <Field label="Message">
        <textarea className="input h-auto min-h-[130px] resize-y py-2.5" rows={5} value={message} onChange={(e) => { setMessage(e.target.value); setError(null); }} maxLength={600} placeholder="Type your message" />
      </Field>
      <Counter body={message} />
      <FormError message={error ?? (send.isError ? errorMessage(send.error) : null)} />
      <button type="button" className="btn btn-primary mt-auto" disabled={send.isPending} onClick={submit}>
        {send.isPending ? 'Sending…' : 'Send text'}
      </button>
    </Panel>
  );
}

// ---- wording ----------------------------------------------------------------------

function TemplatePanel({ template, onClose }: { template: SmsTemplateDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState(template?.body ?? '');
  const [enabled, setEnabled] = useState(template?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const done = async (message: string) => {
    await queryClient.invalidateQueries({ queryKey: ['sms'] });
    toast.success(message);
    onClose();
  };
  const save = useMutation({
    mutationFn: (payload: unknown) => api(`/sms/templates/${template?.event}`, { method: 'PUT', body: payload }),
    onSuccess: () => done(`${template?.label} text saved`),
  });
  const reset = useMutation({
    mutationFn: () => api(`/sms/templates/${template?.event}/reset`, { method: 'POST' }),
    onSuccess: () => done('Back to the standard wording'),
  });

  function insert(word: string) {
    const el = area.current;
    const tag = `{${word}}`;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? start;
    setBody(body.slice(0, start) + tag + body.slice(end));
    setError(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  function submit() {
    const parsed = templateInput.safeParse({ body, enabled });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the message');
    setError(null);
    save.mutate(parsed.data);
  }

  const busy = save.isPending || reset.isPending;
  return (
    <Panel open={template !== null} onClose={onClose} title={template ? `${template.label} text` : 'Text'}>
      {template && (
        <>
          <p className="text-sm text-ink-2">{template.when}</p>
          <Check label="Send this text automatically" hint="Only customers with a phone number who agreed to texts get it." checked={enabled} onChange={setEnabled} />
          <Field label="Message">
            <textarea ref={area} className="input h-auto min-h-[120px] resize-y py-2.5" rows={5} value={body} onChange={(e) => { setBody(e.target.value); setError(null); }} maxLength={600} aria-invalid={!!error} />
          </Field>
          <Counter body={body} />
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold text-ink-2">Tap to add</span>
            <div className="flex flex-wrap gap-2">
              {template.placeholders.map((p) => (
                <button key={p} type="button" onClick={() => insert(p)} className="btn h-9 px-3 text-sm">
                  {`{${p}}`}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold text-ink-2">What the customer sees</span>
            <p className="whitespace-pre-wrap rounded-[14px] rounded-bl-[4px] bg-band px-3.5 py-2.5 text-sm text-ink">{renderTemplate(body, SAMPLE_VALUES) || '…'}</p>
          </div>
          <FormError message={error ?? (save.isError ? errorMessage(save.error) : reset.isError ? errorMessage(reset.error) : null)} />
          <div className="mt-auto flex flex-col gap-2">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {!template.isDefault && (
              <button type="button" className="btn" disabled={busy} onClick={() => reset.mutate()}>
                {reset.isPending ? 'Resetting…' : 'Use the standard wording'}
              </button>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

function WordingTab({ templates, canManage, onEdit }: { templates: SmsTemplateDto[]; canManage: boolean; onEdit: (t: SmsTemplateDto) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-2">These go out by themselves. {canManage ? 'Tap one to change the words or switch it off.' : 'Only the owner can change them.'}</p>
      <ul className="divide-y divide-line border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        {templates.map((t) => {
          const inner = (
            <>
              <span className="flex items-center justify-between gap-3">
                <span className="font-bold text-ink">{t.label}</span>
                <Pill tone={t.enabled ? 'green' : 'grey'}>{t.enabled ? 'On' : 'Off'}</Pill>
              </span>
              <span className="mt-0.5 block text-xs text-ink-3">{t.when}</span>
              <span className={`mt-1.5 block text-sm ${t.enabled ? 'text-ink-2' : 'text-ink-3'}`}>{renderTemplate(t.body, SAMPLE_VALUES)}</span>
            </>
          );
          return (
            <li key={t.event}>
              {canManage ? (
                <button type="button" onClick={() => onEdit(t)} className="block w-full cursor-pointer px-4 py-3 text-left active:bg-band">
                  {inner}
                </button>
              ) : (
                <div className="px-4 py-3">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-ink-3">Words in curly brackets, like {'{name}'}, are filled in for each customer. The examples above use made-up details.</p>
    </div>
  );
}

// ---- credits ----------------------------------------------------------------------

function CreditPanel({ mode, balance, onClose }: { mode: 'topup' | 'set' | null; balance: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api('/sms/credits', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sms'] });
      toast.success(mode === 'topup' ? 'Credits recorded' : 'Balance updated');
      onClose();
    },
  });

  function submit() {
    const n = Number(value.replace(/[,\s]/g, ''));
    if (!value.trim() || !Number.isFinite(n)) return setError(mode === 'topup' ? 'Enter how many credits you bought' : 'Enter the balance Nalo shows');
    const parsed = creditInput.safeParse(mode === 'topup' ? { type: 'topup', credits: n, note } : { type: 'set', balance: n });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the number');
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <Panel open={mode !== null} onClose={onClose} title={mode === 'topup' ? 'Record credits bought' : "Match Nalo's balance"}>
      <p className="text-sm text-ink-2">
        {mode === 'topup'
          ? 'After you buy credits on the Nalo portal, write down how many here so the balance stays right.'
          : `Open the Nalo portal, read the balance it shows, and type it here. We think there are about ${balance} now; the difference is written down as a correction.`}
      </p>
      <Field label={mode === 'topup' ? 'Credits bought' : 'Balance on Nalo'} error={error ?? undefined}>
        <input className="input" inputMode="numeric" value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} autoComplete="off" aria-invalid={!!error} placeholder="500" />
      </Field>
      {mode === 'topup' && (
        <Field label="Note (optional)">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} autoComplete="off" placeholder="Paid by MoMo" />
        </Field>
      )}
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
    </Panel>
  );
}

function EntryRow({ entry }: { entry: SmsCreditEntryDto }) {
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="font-bold text-ink">{entry.kind === 'topup' ? 'Credits bought' : 'Correction'}</p>
        <p className="truncate text-xs text-ink-3">
          {[entry.note, `${entry.by}, ${shortDate(entry.at)}`].filter(Boolean).join(' · ')}
        </p>
      </div>
      <p className={`num font-bold ${entry.credits < 0 ? 'text-red-d' : 'text-ink'}`}>
        {entry.credits > 0 ? '+' : ''}
        {entry.credits}
      </p>
    </li>
  );
}

function CreditsTab({ data, canManage, onRecord }: { data: SmsOverview; canManage: boolean; onRecord: (mode: 'topup' | 'set') => void }) {
  const { credits, gateway } = data;
  return (
    <div className="flex flex-col gap-3">
      <section aria-label="Credit balance" className="flex flex-col gap-3 border border-line bg-surface p-4 max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <div>
          <p className="text-[13px] font-bold text-ink-3">Credits left (estimate)</p>
          <p className={`display num text-[40px] leading-tight ${credits.balance <= 0 ? 'text-red-d' : 'text-navy'}`}>{credits.balance}</p>
          <p className="text-sm text-ink-3">
            {credits.bought} recorded, {credits.used} used. One credit is one text of up to 160 characters. Nalo does not tell us the exact figure, so check its portal now and then.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <a className="btn btn-primary no-underline" href={gateway.topUpUrl} target="_blank" rel="noopener noreferrer">
            Top up on Nalo ↗
          </a>
          {canManage && (
            <>
              <button type="button" className="btn" onClick={() => onRecord('topup')}>
                Record credits bought
              </button>
              <button type="button" className="btn" onClick={() => onRecord('set')}>
                Match Nalo&apos;s balance
              </button>
            </>
          )}
        </div>
      </section>

      <dl className="grid grid-cols-2 border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <div className="px-4 py-2.5">
          <dt className="text-[13px] font-bold text-ink-3">Texts come from</dt>
          <dd className="font-bold text-ink">{gateway.senderId}</dd>
        </div>
        <div className="px-4 py-2.5">
          <dt className="text-[13px] font-bold text-ink-3">Nalo connection</dt>
          <dd className="font-bold text-ink">{gateway.configured ? 'Set up' : 'Not set up'}</dd>
        </div>
      </dl>

      <section aria-label="Credit history" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <h3 className="border-b border-line px-4 py-2.5 text-[13px] font-bold uppercase tracking-[0.06em] text-ink-3">Credit history</h3>
        {credits.entries.length > 0 ? (
          <ul className="divide-y divide-line">
            {credits.entries.map((e) => (
              <EntryRow key={e.id} entry={e} />
            ))}
          </ul>
        ) : (
          <EmptyRow>Nothing recorded yet. Add the credits you already have on Nalo with “Match Nalo’s balance”.</EmptyRow>
        )}
      </section>
    </div>
  );
}

// ---- the page ---------------------------------------------------------------------

export function Texts() {
  const { can } = useAuth();
  const canSend = can('sms.send');
  const canManage = can('sms.manage');
  const [tab, setTab] = useState<Tab>('activity');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<SmsTemplateDto | null>(null);
  const [credit, setCredit] = useState<'topup' | 'set' | null>(null);

  const overview = useQuery({
    queryKey: ['sms', 'overview'],
    queryFn: () => api<SmsOverview>('/sms/overview'),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });
  const data = overview.data;

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="display text-2xl text-navy max-lg:sr-only">Customer texts</h2>
        {canSend && (
          <button type="button" className="btn btn-primary ml-auto shrink-0 px-4" onClick={() => setSending(true)}>
            Send a text
          </button>
        )}
      </div>

      <FormError message={overview.isError ? errorMessage(overview.error) : null} />

      {data && !data.gateway.configured && (
        <Notice tone="amber">Texting is not switched on yet. Texts are written down here but not sent until the Nalo details are added to the server settings.</Notice>
      )}
      {data?.credits.outOfCredit && <Notice tone="red">Nalo says there are no credits left, so texts are failing. Top up, then record it under Credits.</Notice>}
      {data && !data.credits.outOfCredit && data.credits.low && data.gateway.configured && (
        <Notice tone="amber">Credits are running low: about {Math.max(data.credits.balance, 0)} left.</Notice>
      )}

      <Strip
        compact
        items={[
          { label: 'Credits left', short: 'Credits', value: data ? String(data.credits.balance) : '—' },
          { label: 'Sent, 30 days', short: 'Sent', value: String(data?.last30.sent ?? 0) },
          { label: 'Failed, 30 days', short: 'Failed', value: String(data?.last30.failed ?? 0) },
          { label: 'Not sent, 30 days', short: 'Not sent', value: String(data?.last30.skipped ?? 0) },
        ]}
      />

      <div role="tablist" aria-label="Texts" className="flex border-b border-line">
        {TABS.map((t, i) => {
          const on = t.value === tab;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              id={`texts-tab-${t.value}`}
              aria-selected={on}
              aria-controls="texts-panel"
              tabIndex={on ? 0 : -1}
              onClick={() => setTab(t.value)}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = TABS[(i + step + TABS.length) % TABS.length]!;
                setTab(next.value);
                document.getElementById(`texts-tab-${next.value}`)?.focus();
              }}
              className={`-mb-px flex-1 cursor-pointer whitespace-nowrap border-b-[3px] px-0.5 py-2.5 text-[13px] font-bold lg:px-3.5 lg:text-sm ${on ? 'border-blue text-blue-d' : 'border-transparent text-ink-3 hover:text-ink'}`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="texts-panel" aria-labelledby={`texts-tab-${tab}`}>
        {tab === 'activity' && <ActivityTab canSend={canSend} />}
        {tab === 'wording' && (data ? <WordingTab templates={data.templates} canManage={canManage} onEdit={setEditing} /> : <SkeletonRows count={3} />)}
        {tab === 'credits' && (data ? <CreditsTab data={data} canManage={canManage} onRecord={setCredit} /> : <SkeletonRows count={3} />)}
      </div>

      <SendPanel open={sending} onClose={() => setSending(false)} />
      <TemplatePanel key={editing?.event ?? 'none'} template={editing} onClose={() => setEditing(null)} />
      <CreditPanel key={credit ?? 'none'} mode={credit} balance={data?.credits.balance ?? 0} onClose={() => setCredit(null)} />
    </div>
  );
}
