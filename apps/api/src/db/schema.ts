import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/*
 * Money columns are whole pesewas (GH₵12.50 = 1250). Nothing here is ever stored as a decimal.
 * Rows that matter are voided, not deleted: see the *_voided columns and the no-delete trigger
 * in the custom migration.
 */

// ---- enums ---------------------------------------------------------------

export const carTypeEnum = pgEnum('car_type', ['saloon', 'suv', 'pickup', 'van', 'other']);
export const jobStatusEnum = pgEnum('job_status', ['pending', 'in_progress', 'completed', 'dispatched']);
export const commissionKindEnum = pgEnum('commission_kind', ['percent', 'fixed']);
export const commissionStatusEnum = pgEnum('commission_status', ['earned', 'reversed']);
export const tipKindEnum = pgEnum('tip_kind', ['direct', 'held']);
export const closeStatusEnum = pgEnum('close_status', ['closed', 'reopened']);
export const smsEventEnum = pgEnum('sms_event', ['job_booked', 'job_ready', 'payment_received', 'manual']);
export const smsStatusEnum = pgEnum('sms_status', ['sent', 'failed', 'skipped']);
export const smsCreditKindEnum = pgEnum('sms_credit_kind', ['topup', 'adjust']);

// ---- column helpers ------------------------------------------------------

const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const ref = (name: string) => bigint(name, { mode: 'number' });
/** Raw bytes, such as a photo. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const stamp = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => stamp('created_at').notNull().defaultNow();

// ---- people --------------------------------------------------------------

/**
 * A named set of permissions. The owner role is `locked`: it can do everything, and cannot be changed or removed,
 * so there is always someone who can fix a mistake in the others. Permissions are keys from the shared catalog.
 */
export const roles = pgTable(
  'roles',
  {
    id: id(),
    name: text('name').notNull().unique(),
    locked: boolean('locked').notNull().default(false),
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: stamp('updated_at').notNull().defaultNow(),
  },
  (t) => [check('roles_name_not_blank', sql`length(btrim(${t.name})) > 0`)],
);

/** Someone who signs in. Never deleted; set inactive instead. */
export const users = pgTable(
  'users',
  {
    id: id(),
    name: text('name').notNull(),
    username: text('username').notNull().unique(),
    roleId: ref('role_id').notNull().references(() => roles.id),
    passwordHash: text('password_hash').notNull(),
    /** Set when an admin created or reset the password, so the person must choose their own next. */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    lastLoginAt: stamp('last_login_at'),
  },
  (t) => [index('users_role_idx').on(t.roleId), check('users_username_lowercase', sql`${t.username} = lower(${t.username})`)],
);

/** Server-side sign-in sessions. `id` is the SHA-256 of the cookie token, never the token itself. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: ref('user_id').notNull().references(() => users.id),
    createdAt: createdAt(),
    lastSeenAt: stamp('last_seen_at').notNull().defaultNow(),
    expiresAt: stamp('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/** A person who comes back. Phone is optional. `ok_to_text` records consent only. */
export const customers = pgTable('customers', {
  id: id(),
  name: text('name').notNull(),
  phone: text('phone'),
  okToText: boolean('ok_to_text').notNull().default(false),
  createdAt: createdAt(),
});

/** A car. `plate_key` is the plate with spaces and dashes removed, and is the unique key. */
export const vehicles = pgTable(
  'vehicles',
  {
    id: id(),
    plate: text('plate').notNull(),
    plateKey: text('plate_key').notNull().unique(),
    customerId: ref('customer_id').references(() => customers.id),
    makeModel: text('make_model'),
    carType: carTypeEnum('car_type'),
    createdAt: createdAt(),
  },
  (t) => [
    index('vehicles_customer_idx').on(t.customerId),
    check('vehicles_plate_key_clean', sql`${t.plateKey} ~ '^[A-Z0-9]+$'`),
  ],
);

/** A washer who earns commission. Attendants do not sign in, so they are kept apart from users. */
export const attendants = pgTable('attendants', {
  id: id(),
  name: text('name').notNull(),
  phone: text('phone'),
  active: boolean('active').notNull().default(true),
  /** When they were set inactive ("Left 12 Oct"). Empty while active. */
  deactivatedAt: stamp('deactivated_at'),
  createdAt: createdAt(),
});

// ---- selling -------------------------------------------------------------

/**
 * Something we sell. `commission_value` is basis points when kind = percent (18% = 1800)
 * and pesewas when kind = fixed. A change applies to new jobs only.
 */
export const services = pgTable(
  'services',
  {
    id: id(),
    name: text('name').notNull().unique(),
    price: integer('price').notNull(),
    commissionKind: commissionKindEnum('commission_kind').notNull(),
    commissionValue: integer('commission_value').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: stamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('services_price_not_negative', sql`${t.price} >= 0`),
    check(
      'services_commission_in_range',
      sql`${t.commissionValue} >= 0 AND (${t.commissionKind} <> 'percent' OR ${t.commissionValue} <= 10000)`,
    ),
  ],
);

/** One car's visit. Everything sold and paid for hangs off it. */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    vehicleId: ref('vehicle_id').notNull().references(() => vehicles.id),
    createdBy: ref('created_by').notNull().references(() => users.id),
    status: jobStatusEnum('status').notNull().default('pending'),
    /** Whole-job discount in pesewas. It sits on the job, not on a line. */
    discount: integer('discount').notNull().default(0),
    notes: text('notes'),
    createdAt: createdAt(),
    startedAt: stamp('started_at'),
    completedAt: stamp('completed_at'),
    dispatchedAt: stamp('dispatched_at'),
    /** Set only when a manager released the car while a balance was still owed. */
    dispatchOverrideBy: ref('dispatch_override_by').references(() => users.id),
    dispatchOverrideNote: text('dispatch_override_note'),
    voidedAt: stamp('voided_at'),
    voidedBy: ref('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
  },
  (t) => [
    index('jobs_status_idx').on(t.status),
    index('jobs_created_idx').on(t.createdAt),
    index('jobs_vehicle_idx').on(t.vehicleId),
    check('jobs_discount_not_negative', sql`${t.discount} >= 0`),
    check(
      'jobs_void_complete',
      sql`(${t.voidedAt} IS NULL) = (${t.voidedBy} IS NULL) AND (${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`,
    ),
    check(
      'jobs_override_complete',
      sql`(${t.dispatchOverrideBy} IS NULL) = (${t.dispatchOverrideNote} IS NULL)`,
    ),
  ],
);

/** One service on a job. Copies the price and commission rule at the moment of sale. */
export const jobLines = pgTable(
  'job_lines',
  {
    id: id(),
    jobId: ref('job_id').notNull().references(() => jobs.id),
    serviceId: ref('service_id').notNull().references(() => services.id),
    /** How many of this service: three seats cleaned, two bags of laundry. */
    quantity: integer('quantity').notNull().default(1),
    /** The whole line: the service price at the time of sale times the quantity. */
    priceAtSale: integer('price_at_sale').notNull(),
    commissionKindAtSale: commissionKindEnum('commission_kind_at_sale').notNull(),
    commissionValueAtSale: integer('commission_value_at_sale').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('job_lines_job_idx').on(t.jobId),
    check('job_lines_quantity_range', sql`${t.quantity} between 1 and 50`),
    check('job_lines_price_not_negative', sql`${t.priceAtSale} >= 0`),
    check('job_lines_commission_not_negative', sql`${t.commissionValueAtSale} >= 0`),
  ],
);

/** Who worked on a line. `share_bp` is their share in basis points (10000 = the whole line). */
export const jobLineAttendants = pgTable(
  'job_line_attendants',
  {
    id: id(),
    jobLineId: ref('job_line_id').notNull().references(() => jobLines.id),
    attendantId: ref('attendant_id').notNull().references(() => attendants.id),
    shareBp: integer('share_bp').notNull(),
  },
  (t) => [
    unique('job_line_attendants_once').on(t.jobLineId, t.attendantId),
    index('job_line_attendants_attendant_idx').on(t.attendantId),
    check('job_line_attendants_share_range', sql`${t.shareBp} BETWEEN 1 AND 10000`),
  ],
);

// ---- money in ------------------------------------------------------------

/**
 * A way money moves (cash, MoMo, a bank...). The owner adds them in Settings. Old records keep pointing at a method
 * that has been switched off, so a method is never deleted. `inDrawer` says whether the money passes through the
 * cash drawer, which is what the daily close counts.
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: id(),
    name: text('name').notNull(),
    inDrawer: boolean('in_drawer').notNull().default(false),
    requiresReference: boolean('requires_reference').notNull().default(false),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: stamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_methods_name_unique').on(sql`lower(${t.name})`),
    check('payment_methods_name_not_blank', sql`length(btrim(${t.name})) > 0`),
  ],
);

/** Money received against a job. Voided, never edited or deleted. */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    jobId: ref('job_id').notNull().references(() => jobs.id),
    methodId: ref('method_id').notNull().references(() => paymentMethods.id),
    amount: integer('amount').notNull(),
    /** Where the money came from, such as a MoMo or transfer reference. Needed only for methods that ask for one. */
    reference: text('reference'),
    /** Unique, so a double-tap or a retry saves once (idempotency). */
    idemKey: text('idem_key').notNull().unique(),
    recordedBy: ref('recorded_by').notNull().references(() => users.id),
    createdAt: createdAt(),
    voidedAt: stamp('voided_at'),
    voidedBy: ref('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
  },
  (t) => [
    index('payments_job_idx').on(t.jobId),
    index('payments_created_idx').on(t.createdAt),
    check('payments_amount_positive', sql`${t.amount} > 0`),
    check('payments_reference_not_blank', sql`${t.reference} IS NULL OR length(btrim(${t.reference})) > 0`),
    check(
      'payments_void_complete',
      sql`(${t.voidedAt} IS NULL) = (${t.voidedBy} IS NULL) AND (${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`,
    ),
  ],
);

// ---- money owed or out ---------------------------------------------------

/** Money handed to an attendant for commission. Part payouts are allowed. */
export const commissionPayouts = pgTable(
  'commission_payouts',
  {
    id: id(),
    attendantId: ref('attendant_id').notNull().references(() => attendants.id),
    amount: integer('amount').notNull(),
    methodId: ref('method_id').notNull().references(() => paymentMethods.id),
    paidBy: ref('paid_by').notNull().references(() => users.id),
    note: text('note'),
    /** Unique, so a double-tap or a retry pays once. */
    idemKey: text('idem_key').unique(),
    createdAt: createdAt(),
    voidedAt: stamp('voided_at'),
    voidedBy: ref('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
  },
  (t) => [
    index('commission_payouts_attendant_idx').on(t.attendantId),
    check('commission_payouts_amount_positive', sql`${t.amount} > 0`),
    check(
      'commission_payouts_void_complete',
      sql`(${t.voidedAt} IS NULL) = (${t.voidedBy} IS NULL) AND (${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`,
    ),
  ],
);

/** What one attendant earned on one line. Created when the job is marked Completed. */
export const commissions = pgTable(
  'commissions',
  {
    id: id(),
    lineAttendantId: ref('line_attendant_id').notNull().unique().references(() => jobLineAttendants.id),
    amount: integer('amount').notNull(),
    status: commissionStatusEnum('status').notNull().default('earned'),
    /** Empty until the commission is paid out. */
    payoutId: ref('payout_id').references(() => commissionPayouts.id),
    createdAt: createdAt(),
    reversedAt: stamp('reversed_at'),
  },
  (t) => [
    index('commissions_payout_idx').on(t.payoutId),
    check('commissions_amount_not_negative', sql`${t.amount} >= 0`),
    check('commissions_reversal_consistent', sql`(${t.status} = 'reversed') = (${t.reversedAt} IS NOT NULL)`),
  ],
);

/** Held tips handed over to an attendant. One handout clears all held tips for that attendant. */
export const tipHandouts = pgTable(
  'tip_handouts',
  {
    id: id(),
    attendantId: ref('attendant_id').notNull().references(() => attendants.id),
    amount: integer('amount').notNull(),
    givenBy: ref('given_by').notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('tip_handouts_attendant_idx').on(t.attendantId),
    check('tip_handouts_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** Money a customer gave for an attendant. Tips never mix into commission. */
export const tips = pgTable(
  'tips',
  {
    id: id(),
    attendantId: ref('attendant_id').notNull().references(() => attendants.id),
    jobId: ref('job_id').references(() => jobs.id),
    amount: integer('amount').notNull(),
    kind: tipKindEnum('kind').notNull(),
    handoutId: ref('handout_id').references(() => tipHandouts.id),
    recordedBy: ref('recorded_by').notNull().references(() => users.id),
    /** Unique, so a double-tap or a retry saves the tip once. */
    idemKey: text('idem_key').unique(),
    createdAt: createdAt(),
    voidedAt: stamp('voided_at'),
    voidedBy: ref('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
  },
  (t) => [
    index('tips_attendant_idx').on(t.attendantId),
    index('tips_job_idx').on(t.jobId),
    check('tips_amount_positive', sql`${t.amount} > 0`),
    check('tips_only_held_are_handed_out', sql`${t.handoutId} IS NULL OR ${t.kind} = 'held'`),
    check(
      'tips_void_complete',
      sql`(${t.voidedAt} IS NULL) = (${t.voidedBy} IS NULL) AND (${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`,
    ),
  ],
);

/** Money the business spent. Voided, never deleted. A missing receipt is flagged on screen. */
export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    category: text('category').notNull(),
    amount: integer('amount').notNull(),
    methodId: ref('method_id').notNull().references(() => paymentMethods.id),
    /** A receipt number, or where the paper is kept. Photos can come later. Empty means "no receipt". */
    receiptFile: text('receipt_file'),
    /** Unique, so a double-tap or a retry saves the expense once. */
    idemKey: text('idem_key').unique(),
    spentOn: date('spent_on', { mode: 'string' }).notNull().default(sql`current_date`),
    note: text('note'),
    enteredBy: ref('entered_by').notNull().references(() => users.id),
    createdAt: createdAt(),
    voidedAt: stamp('voided_at'),
    voidedBy: ref('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
  },
  (t) => [
    index('expenses_spent_on_idx').on(t.spentOn),
    check('expenses_amount_positive', sql`${t.amount} > 0`),
    check(
      'expenses_void_complete',
      sql`(${t.voidedAt} IS NULL) = (${t.voidedBy} IS NULL) AND (${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`,
    ),
  ],
);

/**
 * The kinds of expense. Expenses keep the category's name as text, so a name is never changed afterwards and a
 * category that is switched off still reads correctly on old records.
 */
export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: id(),
    name: text('name').notNull(),
    needsNote: boolean('needs_note').notNull().default(false),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: stamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('expense_categories_name_unique').on(sql`lower(${t.name})`),
    check('expense_categories_name_not_blank', sql`length(btrim(${t.name})) > 0`),
  ],
);

/** Photos of the paper receipt. Kept in the database so one backup holds everything. Added, never changed. */
export const expenseReceipts = pgTable(
  'expense_receipts',
  {
    id: id(),
    expenseId: ref('expense_id').notNull().references(() => expenses.id),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    data: bytea('data').notNull(),
    uploadedBy: ref('uploaded_by').notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('expense_receipts_expense_idx').on(t.expenseId), check('expense_receipts_size_positive', sql`${t.size} > 0`)],
);

/** The link behind "Share receipt": one unguessable token per job, so the customer can open their receipt without signing in. */
export const jobReceiptLinks = pgTable(
  'job_receipt_links',
  {
    id: id(),
    jobId: ref('job_id').notNull().unique().references(() => jobs.id),
    token: text('token').notNull().unique(),
    createdBy: ref('created_by').notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [check('job_receipt_links_token_long', sql`length(${t.token}) >= 20`)],
);

// ---- control -------------------------------------------------------------

/** The end-of-day cash-up. One per day. A shortage or surplus is recorded, never hidden. */
export const dailyCloses = pgTable(
  'daily_closes',
  {
    id: id(),
    day: date('day', { mode: 'string' }).notNull().unique(),
    openingFloat: integer('opening_float').notNull(),
    expectedCash: integer('expected_cash').notNull(),
    countedCash: integer('counted_cash').notNull(),
    /** Counted minus expected. Negative is a shortage. */
    difference: integer('difference').generatedAlwaysAs(sql`counted_cash - expected_cash`),
    /** What came in some way other than the drawer (MoMo, a bank) that day. */
    otherTotal: integer('other_total').notNull(),
    status: closeStatusEnum('status').notNull().default('closed'),
    /** Why the count was off, when it was. */
    note: text('note'),
    closedBy: ref('closed_by').notNull().references(() => users.id),
    closedAt: stamp('closed_at').notNull().defaultNow(),
    reopenedBy: ref('reopened_by').references(() => users.id),
    reopenedAt: stamp('reopened_at'),
    reopenReason: text('reopen_reason'),
  },
  (t) => [
    check('daily_closes_amounts_not_negative', sql`${t.openingFloat} >= 0 AND ${t.countedCash} >= 0 AND ${t.otherTotal} >= 0`),
    check(
      'daily_closes_reopen_complete',
      sql`(${t.reopenedAt} IS NULL) = (${t.reopenedBy} IS NULL) AND (${t.reopenedAt} IS NULL) = (${t.reopenReason} IS NULL)`,
    ),
  ],
);

// ---- customer texts --------------------------------------------------------

/** Wording the owner changed. An event with no row here uses the wording that ships with the app. */
export const smsTemplates = pgTable('sms_templates', {
  event: smsEventEnum('event').primaryKey(),
  body: text('body').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  updatedBy: ref('updated_by').references(() => users.id),
  updatedAt: stamp('updated_at').notNull().defaultNow(),
});

/** Every text we tried to send, and what happened. A record, never edited or deleted. */
export const smsMessages = pgTable(
  'sms_messages',
  {
    id: id(),
    event: smsEventEnum('event').notNull(),
    status: smsStatusEnum('status').notNull(),
    /** The number as saved on the customer ("0245510932"). */
    phone: text('phone').notNull(),
    body: text('body').notNull(),
    /** How many credits it cost: one per 160 characters. */
    segments: integer('segments').notNull(),
    /** The gateway's own answer: 1701 is success, anything else is why it did not go. */
    gatewayCode: text('gateway_code'),
    gatewayRef: text('gateway_ref'),
    /** In words a person can act on. */
    error: text('error'),
    customerId: ref('customer_id').references(() => customers.id),
    jobId: ref('job_id').references(() => jobs.id),
    /** Empty for automatic texts. */
    sentBy: ref('sent_by').references(() => users.id),
    /** Unique, so a double-tap on "Send" texts the customer once. */
    idemKey: text('idem_key').unique(),
    createdAt: createdAt(),
  },
  (t) => [
    index('sms_messages_created_idx').on(t.createdAt),
    index('sms_messages_customer_idx').on(t.customerId),
    index('sms_messages_job_idx').on(t.jobId),
    check('sms_messages_segments_not_negative', sql`${t.segments} >= 0`),
  ],
);

/** Credits bought (or a correction to match the Nalo portal). Added up, they are the balance we show. */
export const smsCreditEntries = pgTable('sms_credit_entries', {
  id: id(),
  kind: smsCreditKindEnum('kind').notNull(),
  /** Positive when credits were added, negative when a correction takes some off. */
  credits: integer('credits').notNull(),
  note: text('note'),
  createdBy: ref('created_by').notNull().references(() => users.id),
  createdAt: createdAt(),
});

/** A diary of every change. Nothing can edit or delete it (see the custom migration). */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    /** Empty for events with no signed-in person, such as a failed sign-in. */
    userId: ref('user_id').references(() => users.id),
    action: text('action').notNull(),
    recordTable: text('record_table'),
    recordId: ref('record_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    note: text('note'),
    ip: text('ip'),
    at: stamp('at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_record_idx').on(t.recordTable, t.recordId),
    index('audit_logs_at_idx').on(t.at),
    index('audit_logs_user_idx').on(t.userId),
    uniqueIndex('audit_logs_id_idx').on(t.id),
  ],
);
