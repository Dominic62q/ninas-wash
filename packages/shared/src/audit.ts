import { formatGHS } from './money.js';

/** One line of the activity log, as the screen receives it. */
export interface AuditEntryDto {
  id: number;
  at: string;
  /** `thing.verb`, such as `payment.record`. */
  action: string;
  recordTable: string | null;
  recordId: number | null;
  before: unknown;
  after: unknown;
  note: string | null;
  /** Empty for events with no signed-in person, such as a failed sign-in. */
  userId: number | null;
  userName: string | null;
}

export interface AuditPage {
  entries: AuditEntryDto[];
  /** Pass as `before` to get the next, older page. Null when this was the last one. */
  next: number | null;
  /** Everyone who has an entry, for the "Who" filter. */
  people: { id: number; name: string }[];
}

/** What the "Area" filter offers: a name for people, and the action prefixes it covers. */
export const AUDIT_AREAS = [
  { value: 'sales', label: 'Jobs and payments', prefixes: ['job.', 'payment.', 'vehicle.'] },
  { value: 'money', label: 'Money out', prefixes: ['expense.', 'commission.', 'tip.', 'dailyclose.'] },
  { value: 'people', label: 'People and sign-ins', prefixes: ['user.', 'role.', 'attendant.', 'auth.', 'customer.'] },
  { value: 'setup', label: 'Settings', prefixes: ['service.', 'setting.', 'sms.', 'paymethod.', 'category.'] },
] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number]['value'];

const LABELS: Record<string, string> = {
  'attendant.create': 'Added an attendant',
  'attendant.update': 'Changed an attendant',
  'auth.change_password': 'Changed a password',
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'category.create': 'Added an expense category',
  'category.update': 'Changed an expense category',
  'commission.payout': 'Paid out commission',
  'commission.payout_void': 'Voided a commission payout',
  'customer.create': 'Added a customer',
  'customer.export': 'Exported customers',
  'customer.update': 'Changed a customer',
  'dailyclose.close': 'Closed the day',
  'dailyclose.reclose': 'Closed the day again',
  'dailyclose.reopen': 'Reopened a day',
  'expense.create': 'Recorded an expense',
  'expense.void': 'Voided an expense',
  'job.add_line': 'Added a service to a job',
  'job.assign': 'Changed who worked on a job',
  'job.create': 'Booked a car',
  'job.discount': 'Changed a discount',
  'job.dispatch': 'Released a car',
  'job.status': 'Moved a job along',
  'job.void': 'Voided a job',
  'paymethod.create': 'Added a payment method',
  'paymethod.update': 'Changed a payment method',
  'payment.record': 'Took a payment',
  'payment.void': 'Voided a payment',
  'role.create': 'Added a role',
  'role.update': 'Changed a role',
  'service.create': 'Added a service',
  'service.update': 'Changed a service',
  'sms.credits': 'Changed text credits',
  'sms.send': 'Sent a text',
  'sms.template': 'Changed a text wording',
  'tip.handout': 'Handed over tips',
  'tip.record': 'Recorded a tip',
  'tip.void': 'Voided a tip',
  'user.create': 'Added a user',
  'user.reset_password': 'Reset a password',
  'user.update': 'Changed a user',
  'vehicle.claim': 'Linked a car to a customer',
  'vehicle.create': 'Added a car',
  'vehicle.update': 'Changed a car',
};

export function auditLabel(action: string): string {
  return LABELS[action] ?? action.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Keys whose number is money in whole pesewas. */
const MONEY_KEYS = new Set(['amount', 'price', 'discount', 'openingFloat', 'expected', 'counted', 'difference', 'momo', 'total', 'balance']);
/** Keys that add nothing to a one-line summary. */
const QUIET_KEYS = new Set(['passwordHash', 'password', 'token', 'idemKey']);

const words = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase();

function show(key: string, value: unknown): string {
  if (typeof value === 'number' && MONEY_KEYS.has(key)) return formatGHS(value);
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' ? '…' : String(v))).join(', ') || 'none';
  if (typeof value === 'object') return '…';
  return String(value);
}

/** The details of one record as `[name, value]` pairs a person can read. Nothing secret is ever included. */
export function auditFields(record: unknown): [string, string][] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  return Object.entries(record as Record<string, unknown>)
    .filter(([k]) => !QUIET_KEYS.has(k))
    .map(([k, v]) => [words(k), show(k, v)]);
}

/** A short summary for the list: what it was about, in a handful of words. */
export function auditSummary(entry: Pick<AuditEntryDto, 'before' | 'after' | 'note'>): string {
  const record = entry.after ?? entry.before;
  const pairs = auditFields(record).filter(([, v]) => v !== 'empty').slice(0, 3);
  const text = pairs.map(([k, v]) => `${k} ${v}`).join(' · ');
  return [text, entry.note].filter(Boolean).join(' · ');
}
