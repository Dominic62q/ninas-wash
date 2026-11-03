import { z } from 'zod';
import { normalizePhone } from './phone.js';

/** Customer text messages (Phase 8): the rules the browser and the server share. */

export const BUSINESS_NAME = "Niina's Wash";

/** What triggers a text. `manual` is a message someone typed and sent on purpose. */
export const SMS_EVENTS = ['job_booked', 'job_ready', 'payment_received', 'manual'] as const;
export type SmsEvent = (typeof SMS_EVENTS)[number];

/** The events that send by themselves, and so have a template that can be edited and switched off. */
export const AUTO_EVENTS = ['job_booked', 'job_ready', 'payment_received'] as const;
export type AutoEvent = (typeof AUTO_EVENTS)[number];

export const SMS_STATUSES = ['sent', 'failed', 'skipped'] as const;
export type SmsStatus = (typeof SMS_STATUSES)[number];

export const EVENT_LABEL: Record<SmsEvent, string> = {
  job_booked: 'Car booked',
  job_ready: 'Car ready',
  payment_received: 'Payment received',
  manual: 'Typed by hand',
};

export const EVENT_WHEN: Record<AutoEvent, string> = {
  job_booked: 'Sent when a car is booked in.',
  job_ready: 'Sent when the wash is finished and the car can be collected.',
  payment_received: 'Sent each time a payment is recorded.',
};

/** A `{word}` in a template is swapped for the real value when the text goes out. */
export const PLACEHOLDERS = {
  name: 'Customer first name',
  plate: 'Number plate',
  services: 'Services on the job',
  total: 'Job total',
  amount: 'Amount just paid',
  balance: 'Still to pay',
} as const;
export type Placeholder = keyof typeof PLACEHOLDERS;

/** Which placeholders each event has a value for. */
export const EVENT_PLACEHOLDERS: Record<AutoEvent, readonly Placeholder[]> = {
  job_booked: ['name', 'plate', 'services', 'total'],
  job_ready: ['name', 'plate', 'services', 'total', 'balance'],
  payment_received: ['name', 'plate', 'total', 'amount', 'balance'],
};

export const DEFAULT_TEMPLATES: Record<AutoEvent, string> = {
  job_booked: `Hi {name}, your car {plate} is booked in at ${BUSINESS_NAME}. We will text you when it is ready.`,
  job_ready: `Hi {name}, your car {plate} is ready for pickup at ${BUSINESS_NAME}. Total {total}, still to pay {balance}.`,
  payment_received: `Thank you {name}! We received {amount} for {plate}. Still to pay: {balance}. ${BUSINESS_NAME}`,
};

/** Example values, for the preview on the template editor. */
export const SAMPLE_VALUES: Record<Placeholder, string> = {
  name: 'Kofi',
  plate: 'GR 1234-26',
  services: 'Full wash',
  total: 'GHS 50.00',
  amount: 'GHS 30.00',
  balance: 'GHS 20.00',
};

// ---- text rules -------------------------------------------------------------

/**
 * Phones count 160 characters to a text when the message uses only the basic GSM alphabet, and 70 as soon as one
 * other character (like ₵ or a curly quote) sneaks in. So messages are kept to the basic alphabet.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€\f';

const LOOKALIKES: [RegExp, string][] = [
  [/[‘’ʼ]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—]/g, '-'],
  [/…/g, '...'],
  [/ /g, ' '],
  [/GH₵|₵/g, 'GHS '],
];

/** Swap the usual look-alikes (curly quotes, dashes, ₵) for plain ones. */
export function toPlainText(text: string): string {
  return LOOKALIKES.reduce((out, [from, to]) => out.replace(from, to), text).replace(/GHS {2,}/g, 'GHS ');
}

const gsmLength = (ch: string): number => (GSM_BASIC.includes(ch) ? 1 : GSM_EXTENDED.includes(ch) ? 2 : 0);

/** Characters outside the basic alphabet, if any. */
export function unsupportedChars(text: string): string[] {
  return [...new Set([...text].filter((ch) => gsmLength(ch) === 0))];
}

/** How many texts (and so how many credits) a message costs. */
export function smsSegments(text: string): number {
  if (text.length === 0) return 0;
  const chars = [...text];
  const unicode = chars.some((ch) => gsmLength(ch) === 0);
  const length = unicode ? chars.length : chars.reduce((n, ch) => n + gsmLength(ch), 0);
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return length <= single ? 1 : Math.ceil(length / multi);
}

/** `{word}` names used in a template. */
export function placeholdersIn(body: string): string[] {
  return [...body.matchAll(/\{([a-z]+)\}/gi)].map((m) => m[1]!.toLowerCase());
}

export function renderTemplate(body: string, values: Partial<Record<Placeholder, string>>): string {
  return body
    .replace(/\{([a-z]+)\}/gi, (whole, key: string) => values[key.toLowerCase() as Placeholder] ?? whole)
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** The first name only, so "Mr Kofi Mensah" becomes "Kofi". Falls back to "there" when there is no name. */
export function firstName(full: string | null | undefined): string {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  const titles = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'madam', 'mad', 'sir']);
  const first = parts.find((p) => !titles.has(p.toLowerCase().replace(/\.$/, ''))) ?? parts[0];
  return first && first.length <= 20 ? first : 'there';
}

/** "GHS 50.00": ₵ is not in the basic alphabet, so texts spell the currency out. */
export function smsMoney(pesewas: number): string {
  const abs = Math.abs(pesewas);
  return `${pesewas < 0 ? '-' : ''}GHS ${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A Ghana number as the gateway wants it (233245510932), or null when it is not a number we can text. */
export function gatewayNumber(stored: string | null | undefined): string | null {
  const phone = stored ? normalizePhone(stored) : undefined;
  if (!phone) return null;
  if (/^0\d{9}$/.test(phone)) return `233${phone.slice(1)}`;
  return phone.replace(/\D/g, '');
}

// ---- input ------------------------------------------------------------------

const MAX_MESSAGE = 480; // three texts

const plainMessage = z
  .string()
  .trim()
  .min(1, 'Write the message')
  .max(MAX_MESSAGE * 2)
  .transform(toPlainText)
  .pipe(z.string().max(MAX_MESSAGE, 'Keep it to three texts (480 characters)'))
  .refine((s) => unsupportedChars(s).length === 0, { message: 'Use plain letters and symbols only (no emoji)' });

export const templateInput = z.object({
  body: plainMessage,
  enabled: z.boolean(),
});
export type TemplateInput = z.infer<typeof templateInput>;

export const sendInput = z.object({
  customerId: z.number().int().positive('Pick a customer'),
  message: plainMessage,
  /** Made once per form. A double-tap or a retry carries the same key, so the text goes once. */
  idemKey: z.string().trim().min(8).max(64),
});
export type SendInput = z.infer<typeof sendInput>;

export const creditInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('topup'),
    credits: z.number().int('Whole credits only').positive('Enter how many credits').max(10_000_000),
    note: z.string().trim().max(120).nullish().transform((v) => v || null),
  }),
  z.object({
    type: z.literal('set'),
    /** What the Nalo portal shows right now. */
    balance: z.number().int('Whole credits only').min(0, 'Enter the balance').max(10_000_000),
  }),
]);
export type CreditInput = z.infer<typeof creditInput>;

export const messagesQuery = z.object({
  status: z.enum(SMS_STATUSES).optional(),
  event: z.enum(SMS_EVENTS).optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- what the API sends back -------------------------------------------------

export const LOW_CREDITS = 50;

export interface SmsTemplateDto {
  event: AutoEvent;
  label: string;
  when: string;
  body: string;
  enabled: boolean;
  /** True while the wording is the one we ship with. */
  isDefault: boolean;
  placeholders: Placeholder[];
  updatedAt: string | null;
}

export interface SmsMessageDto {
  id: number;
  event: SmsEvent;
  status: SmsStatus;
  phone: string;
  body: string;
  segments: number;
  /** Why it did not go, in words a person can act on. */
  error: string | null;
  customer: { id: number; name: string } | null;
  jobId: number | null;
  plate: string | null;
  /** Who sent it by hand. Null when it went out automatically. */
  by: string | null;
  at: string;
}

export interface SmsCreditEntryDto {
  id: number;
  kind: 'topup' | 'adjust';
  credits: number;
  note: string | null;
  by: string;
  at: string;
}

export interface SmsOverview {
  gateway: {
    /** False until the gateway details are in the server settings. Texts are then recorded but not sent. */
    configured: boolean;
    senderId: string;
    topUpUrl: string;
  };
  credits: {
    /** An estimate: credits recorded here minus texts sent from here. The Nalo portal has the exact figure. */
    balance: number;
    bought: number;
    used: number;
    low: boolean;
    /** The gateway said the account is out of credit, and nothing has been added since. */
    outOfCredit: boolean;
    entries: SmsCreditEntryDto[];
  };
  templates: SmsTemplateDto[];
  last30: { sent: number; failed: number; skipped: number };
}

export interface SmsMessagesPage {
  messages: SmsMessageDto[];
  total: number;
}
