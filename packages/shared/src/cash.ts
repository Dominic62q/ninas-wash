import { z } from 'zod';
import type { Takings } from './methods.js';

/** Input rules for Phase 5 (expenses and the daily close). The browser and the server run the exact same checks. */

const amount = z.number().int('Use whole pesewas').positive('Enter an amount').max(100_000_000);
const idemKey = z.string().trim().min(8).max(64);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');

/** What the expense categories start as. After that the owner adds and switches them off in Settings. */
export const STARTING_EXPENSE_CATEGORIES = [
  'Water',
  'Electricity',
  'Soap & chemicals',
  'Cloths & brushes',
  'Fuel',
  'Repairs',
  'Transport',
  'Food',
  'Airtime & data',
  'Wages',
  'Rent',
  'Other',
] as const;

export const expenseCategoryInput = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(40, 'Keep the name under 40 letters'),
  /** The person must say what it was for, like with "Other". */
  needsNote: z.boolean().default(false),
  active: z.boolean().default(true),
});
export type ExpenseCategoryInput = z.infer<typeof expenseCategoryInput>;
/** A name never changes, because old expenses carry it. Add a new category and switch the old one off. */
export const updateExpenseCategoryInput = z
  .object({ needsNote: z.boolean(), active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export interface ExpenseCategoryDto {
  id: number;
  name: string;
  needsNote: boolean;
  active: boolean;
  /** Some expense already uses it. */
  used: boolean;
}

/** The most receipt photos one expense can carry. */
export const MAX_RECEIPT_PHOTOS = 5;
/** The biggest photo the server takes, after the phone has shrunk it. */
export const MAX_RECEIPT_BYTES = 2_500_000;

/** An expense can be written down up to this many days late. Older than that, ask the owner. */
export const EXPENSE_BACKDATE_DAYS = 7;

export const expenseInput = z.object({
    /** One of the categories in Settings. The server checks it exists and is switched on. */
    category: z.string().trim().min(1, 'Pick a category').max(40),
    amount,
    methodId: z.number().int().positive('Pick how it was paid'),
    /** The day it was spent. Empty means today. */
    spentOn: day.nullish().transform((v) => v ?? null),
    /** A receipt number, or where the paper is kept. Empty means there is no receipt. */
    receipt: z.string().trim().max(80).nullish().transform((v) => v || null),
    note: z.string().trim().max(200).nullish().transform((v) => v || null),
    /** Made once per form. A double-tap or a retry carries the same key, so it saves once. */
    idemKey,
  });
export type ExpenseInput = z.infer<typeof expenseInput>;

export const closeInput = z.object({
  /** The day to close. Empty means today. */
  day: day.nullish().transform((v) => v ?? null),
  /** Cash that was in the drawer when the day started. */
  openingFloat: z.number().int('Use whole pesewas').min(0, 'Enter an amount').max(100_000_000),
  /** What the person actually counted. */
  countedCash: z.number().int('Use whole pesewas').min(0, 'Enter an amount').max(1_000_000_000),
  /** Needed when the count is different from what the drawer should hold. */
  note: z.string().trim().max(300).nullish().transform((v) => v || null),
});
export type CloseInput = z.infer<typeof closeInput>;

export interface ExpenseDto {
  id: number;
  category: string;
  amount: number;
  methodId: number;
  /** The method's name. */
  method: string;
  spentOn: string;
  /** A receipt number or where the paper is kept. */
  receipt: string | null;
  /** Ids of the receipt photos. With no number and no photo, the screen says there is no receipt. */
  photos: number[];
  note: string | null;
  by: string;
  at: string;
  voided: { at: string; by: string; reason: string } | null;
}

export interface ExpensesOverview {
  from: string;
  to: string;
  expenses: ExpenseDto[];
  /** How many there are in the dates, voided ones too. The list above may hold fewer. */
  total: number;
  /** Voided ones left out. */
  sum: number;
  /** Spent through the cash drawer. */
  drawerSum: number;
  /** Spent some other way (MoMo, a bank). */
  otherSum: number;
  /** Not voided, and nothing to show for it. */
  withoutReceipt: number;
  /** Days nobody can add or void expenses on, because the day was closed. */
  closedDays: string[];
}

export interface DailyCloseRow {
  day: string;
  status: 'closed' | 'reopened';
  openingFloat: number;
  expectedCash: number;
  countedCash: number;
  /** Counted minus expected. Negative is a shortage. */
  difference: number;
  otherTotal: number;
  note: string | null;
  closedBy: string;
  closedAt: string;
  reopened: { at: string; by: string; reason: string } | null;
}

/** What went in and out of the drawer on one day. */
export interface DaySummary {
  day: string;
  isToday: boolean;
  /** The close for this day, if there is one (closed or reopened). */
  close: DailyCloseRow | null;
  /** The day is closed, so nothing can be added to it or voided on it. */
  locked: boolean;
  takings: Takings;
  /**
   * The drawer's maths. Null for a cashier who has not closed yet, who counts without being told the answer.
   * `expectedBeforeFloat` is what comes into the drawer minus what goes out. Add the opening float to get the cash that should be there.
   */
  cash: {
    paymentsIn: number;
    heldTipsIn: number;
    expensesOut: number;
    payoutsOut: number;
    handoutsOut: number;
    expectedBeforeFloat: number;
  } | null;
  /** Money that left some way other than the drawer today (MoMo, a bank). Not part of the drawer. */
  otherOut: { expenses: number; payouts: number };
  /** Cars finished but not fully paid for. */
  unpaid: { count: number; amount: number };
  /** Cars still being washed or waiting. */
  notFinished: number;
  /** The last counted cash, which is the usual opening float. Null if there is no earlier close. */
  suggestedFloat: number | null;
}

export interface DailyCloseHistory {
  /** Newest first. */
  closes: DailyCloseRow[];
  /** How many days have been closed, reopened ones too. `closes` may hold fewer. */
  total: number;
}
