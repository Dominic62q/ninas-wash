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
import { Mark } from '../components/Mark';
import { Plate } from '../components/Plate';
import { useToast } from '../components/Toast';
import { Check, EmptyRow, Field, FormError, Panel, SkeletonRows, errorMessage } from '../components/ui';
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

function StatusMark({ status }: { status: SmsStatus }) {
  if (status === 'sent') return <Mark tone="green">Sent</Mark>;
  if (status === 'skipped') return <Mark tone="grey">Not sent</Mark>;
  return <Mark tone="red">Failed</Mark>;
}

/** What the customer's phone shows: the words in a soft bubble. */
const BUBBLE = 'rounded-[12px] rounded-bl-[4px] bg-band px-4 py-3 text-sm';

function Notice({ tone, children }: { tone: 'red' | 'amber'; children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-3 border border-line bg-surface px-4 py-3 text-sm text-ink max-lg:rounded-[12px]">
      <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${tone === 'red' ? 'bg-red' : 'bg-amber'}`} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** The four headline numbers in one ruled strip: value over label on a phone, label over value on a computer. */
function Figures({ items }: { items: { label: string; short: string; value: string; tone?: 'amber' | 'red' }[] }) {
  return (
    <dl className="grid grid-cols-4 border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
      {items.map((item, i) => (
        <div key={item.label} className={`flex min-w-0 flex-col-reverse gap-1 px-2 py-3 max-lg:items-center max-lg:text-center lg:flex-col lg:px-4 lg:py-4 ${i > 0 ? 'border-l border-line' : ''}`}>
          <dt className="text-[11px] leading-tight text-ink-3 lg:text-sm">
            <span className="lg:hidden">{item.short}</span>
            <span className="hidden lg:inline">{item.label}</span>
          </dt>
          <dd className={`num text-base font-semibold leading-tight lg:text-2xl ${item.tone === 'red' ? 'text-red-d' : item.tone === 'amber' ? 'text-amber' : 'text-navy'}`}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "123 characters · 1 text". Over 160 characters a text costs more than one credit. */
function Counter({ body }: { body: string }) {
  const segments = smsSegments(body);
  const bad = unsupportedChars(body);
  return (
    <p className={`text-xs ${bad.length ? 'font-medium text-red-d' : 'text-ink-3'}`}>
      {bad.length ? `Not allowed: ${bad.join(' ')}. Use plain letters and symbols.` : `${body.length} characters · ${plural(segments, 'text')} (${plural(segments, 'credit')} each time)`}
    </p>
  );
}

// ---- activity -----------------------------------------------------------------

function MessageRow({ message, canResend, onResend, busy }: { message: SmsMessageDto; canResend: boolean; onResend: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate font-medium text-ink">{message.customer?.name ?? formatPhone(message.phone)}</p>
          {message.plate && <Plate plate={message.plate} size="sm" />}
        </div>
        <time dateTime={message.at} className="num shrink-0 text-xs text-ink-3">
          {shortDateTime(message.at)}
        </time>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
        <StatusMark status={message.status} />
        <span aria-hidden="true">·</span>
        <span>{EVENT_LABEL[message.event]}</span>
        {message.segments > 1 && (
          <>
            <span aria-hidden="true">·</span>
            <span>{plural(message.segments, 'text')}</span>
          </>
        )}
      </p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`mt-2 block w-full max-w-[560px] cursor-pointer text-left text-ink-2 transition-colors hover:bg-line-2 ${BUBBLE} ${open ? '' : 'line-clamp-2'}`}
      >
        {message.body}
      </button>
      {message.error && <p className="mt-2 text-xs font-medium text-red-d">{message.error}</p>}
      <p className="num mt-2 text-xs text-ink-3">
        {message.customer && message.customer.name !== formatPhone(message.phone) ? `${formatPhone(message.phone)} · ` : ''}
        {message.by ? `Sent by ${message.by}` : 'Automatic'}
      </p>
      {canResend && message.status !== 'sent' && message.customer && (
        <button type="button" className="tap -mb-2 text-sm font-medium text-blue-d" disabled={busy} onClick={onResend}>
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div role="radiogroup" aria-label="Show" className="flex gap-2 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={filter === f.value}
              onClick={() => { setFilter(f.value); setLimit(STEP); }}
              className={`btn h-9 shrink-0 px-3 text-sm font-medium ${filter === f.value ? 'border-blue bg-blue-50 text-blue-d' : ''}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          className="input lg:ml-auto lg:h-9 lg:max-w-[260px] lg:text-sm"
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
          <p className="num text-center text-xs text-ink-3">
            Showing {data.messages.length} of {data.total}
          </p>
          {data.messages.length < data.total && (
            <button type="button" className="btn font-medium" onClick={() => setLimit((l) => l + STEP)}>
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
        <div className="flex items-center gap-3 rounded-[10px] bg-band px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-ink">{picked.name}</p>
            <p className="num text-sm text-ink-3">{formatPhone(picked.phone)}</p>
          </div>
          <button type="button" className="tap text-sm font-medium text-blue-d" onClick={() => setPicked(null)}>
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
              <li>
                <SkeletonRows count={2} />
              </li>
            ) : customers.data && customers.data.rows.length > 0 ? (
              customers.data.rows.map((c) => {
                const why = reason(c);
                return (
                  <li key={c.id} className="border-t border-line first:border-t-0">
                    <button
                      type="button"
                      disabled={why !== null}
                      onClick={() => { setPicked(c); setError(null); }}
                      className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-band enabled:active:bg-band disabled:opacity-60"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{c.name}</span>
                        <span className="num block text-xs text-ink-3">{why ?? formatPhone(c.phone)}</span>
                      </span>
                    </button>
                  </li>
                );
              })
            ) : (
              <li className="px-4 py-3 text-sm text-ink-3">No customers found</li>
            )}
          </ul>
        </div>
      )}
      <Field label="Message">
        <textarea className="input h-auto min-h-[132px] resize-y py-3" rows={5} value={message} onChange={(e) => { setMessage(e.target.value); setError(null); }} maxLength={600} placeholder="Type your message" />
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
            <textarea ref={area} className="input h-auto min-h-[120px] resize-y py-3" rows={5} value={body} onChange={(e) => { setBody(e.target.value); setError(null); }} maxLength={600} aria-invalid={!!error} />
          </Field>
          <Counter body={body} />
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-2">Tap to add</span>
            <div className="flex flex-wrap gap-2">
              {template.placeholders.map((p) => (
                <button key={p} type="button" onClick={() => insert(p)} className="btn h-9 px-3 text-sm font-medium">
                  {`{${p}}`}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-2">What the customer sees</span>
            <p className={`whitespace-pre-wrap text-ink ${BUBBLE}`}>{renderTemplate(body, SAMPLE_VALUES) || '…'}</p>
          </div>
          <FormError message={error ?? (save.isError ? errorMessage(save.error) : reset.isError ? errorMessage(reset.error) : null)} />
          <div className="mt-auto flex flex-col gap-2">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {!template.isDefault && (
              <button type="button" className="btn font-medium" disabled={busy} onClick={() => reset.mutate()}>
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
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-2">These go out by themselves. {canManage ? 'Tap one to change the words or switch it off.' : 'Only the owner can change them.'}</p>
      <ul className="divide-y divide-line border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        {templates.map((t) => {
          const inner = (
            <>
              <span className="flex items-center justify-between gap-3">
                <span className="font-medium text-ink">{t.label}</span>
                <Mark tone={t.enabled ? 'green' : 'grey'}>{t.enabled ? 'On' : 'Off'}</Mark>
              </span>
              <span className="mt-1 block text-xs text-ink-3">{t.when}</span>
              <span className={`mt-3 block max-w-[560px] ${BUBBLE} ${t.enabled ? 'text-ink-2' : 'text-ink-3'}`}>{renderTemplate(t.body, SAMPLE_VALUES)}</span>
            </>
          );
          return (
            <li key={t.event}>
              {canManage ? (
                <button type="button" onClick={() => onEdit(t)} className="block w-full cursor-pointer px-4 py-4 text-left transition-colors hover:bg-band active:bg-band">
                  {inner}
                </button>
              ) : (
                <div className="px-4 py-4">{inner}</div>
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
          : `Open the Nalo portal, read the balance it shows, and type it here. We think there are about ${Math.max(balance, 0)} now; the difference is written down as a correction.`}
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
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">{entry.kind === 'topup' ? 'Credits bought' : 'Correction'}</p>
        <p className="truncate text-xs text-ink-3">{[entry.note, `${entry.by}, ${shortDate(entry.at)}`].filter(Boolean).join(' · ')}</p>
      </div>
      <p className={`num font-medium ${entry.credits < 0 ? 'text-red-d' : 'text-ink'}`}>
        {entry.credits < 0 ? '−' : '+'}
        {Math.abs(entry.credits)}
      </p>
    </li>
  );
}

function CreditsTab({ data, canManage, onRecord }: { data: SmsOverview; canManage: boolean; onRecord: (mode: 'topup' | 'set') => void }) {
  const { credits, gateway } = data;
  const isSet = credits.bought > 0;
  const share = isSet ? Math.min(100, Math.round((credits.used / credits.bought) * 100)) : 0;
  const fill = credits.outOfCredit ? 'bg-red' : credits.low ? 'bg-amber' : 'bg-blue';
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Credit balance" className="flex flex-col gap-4 border border-line bg-surface p-4 max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card lg:p-6">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-3">Credits left, estimated</p>
          <p className={`num text-[40px] font-semibold leading-none ${!isSet ? 'text-ink-3' : credits.balance <= 0 ? 'text-red-d' : 'text-navy'}`}>{isSet ? Math.max(credits.balance, 0) : 'Not set'}</p>
          {isSet ? (
            <>
              <div role="img" aria-label={`${share}% of recorded credits used`} className="mt-2 h-2 overflow-hidden rounded-full bg-band">
                <div className={`h-full rounded-full ${fill}`} style={{ width: `${share}%` }} />
              </div>
              <p className="num text-sm text-ink-3">
                {credits.used} used of {credits.bought} recorded
              </p>
            </>
          ) : (
            <p className="text-sm text-ink-3">
              {canManage ? 'Copy the balance from the Nalo portal with Match Nalo’s balance.' : 'The owner has not entered the balance from Nalo yet.'} {credits.used > 0 ? `${credits.used} used so far.` : ''}
            </p>
          )}
          <p className="text-xs text-ink-3">One credit is one text of up to 160 characters. Nalo does not tell us the exact figure, so check its portal now and then.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <a className="btn btn-primary no-underline" href={gateway.topUpUrl} target="_blank" rel="noopener noreferrer">
            Top up on Nalo<span className="sr-only"> (opens in a new tab)</span>
          </a>
          {canManage && (
            <>
              <button type="button" className="btn font-medium" onClick={() => onRecord('topup')}>
                Record credits bought
              </button>
              <button type="button" className="btn font-medium" onClick={() => onRecord('set')}>
                Match Nalo&apos;s balance
              </button>
            </>
          )}
        </div>
      </section>

      <dl className="grid grid-cols-2 border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <div className="px-4 py-3">
          <dt className="text-sm text-ink-3">Texts come from</dt>
          <dd className="font-medium text-ink">{gateway.senderId}</dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-sm text-ink-3">Nalo connection</dt>
          <dd className="font-medium text-ink">{gateway.configured ? 'Set up' : 'Not set up'}</dd>
        </div>
      </dl>

      <section aria-label="Credit history" className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
        <h3 className="border-b border-line px-4 py-3 text-sm font-medium text-ink-2">Credit history</h3>
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
  const creditsKnown = (data?.credits.bought ?? 0) > 0;
  const creditsTone = data?.credits.outOfCredit ? 'red' : data && (!creditsKnown || data.credits.low) ? 'amber' : undefined;

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-ink-2 max-lg:sr-only">The texts customers get when their car is booked, ready and paid for</p>
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
      {data && data.gateway.configured && !data.credits.outOfCredit && !creditsKnown && (
        <Notice tone="amber">
          The credit balance is not set, so there is no low-credit warning.{' '}
          {canManage ? (
            <button type="button" className="cursor-pointer font-medium text-blue-d underline underline-offset-2" onClick={() => setTab('credits')}>
              Set it under Credits
            </button>
          ) : (
            'Ask the owner to set it under Credits.'
          )}
        </Notice>
      )}
      {data && data.gateway.configured && !data.credits.outOfCredit && creditsKnown && data.credits.low && (
        <Notice tone="amber">Credits are running low, about {Math.max(data.credits.balance, 0)} left</Notice>
      )}

      <Figures
        items={[
          { label: 'Credits left', short: 'Credits', value: data ? (creditsKnown ? String(Math.max(data.credits.balance, 0)) : 'Not set') : '—', ...(creditsTone ? { tone: creditsTone } : {}) },
          { label: 'Sent, last 30 days', short: 'Sent', value: String(data?.last30.sent ?? 0) },
          { label: 'Failed, last 30 days', short: 'Failed', value: String(data?.last30.failed ?? 0), ...((data?.last30.failed ?? 0) > 0 ? { tone: 'red' as const } : {}) },
          { label: 'Not sent, last 30 days', short: 'Not sent', value: String(data?.last30.skipped ?? 0) },
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
              className={`-mb-px flex-1 cursor-pointer whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors ${on ? 'border-blue text-blue-d' : 'border-transparent text-ink-3 hover:text-ink'}`}
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
