import { z } from 'zod';
import { PAY_METHODS } from './jobs.js';

/** Input rules for Phase 5 (expenses and the daily close). The browser and the server run the exact same checks. */

const amount = z.number().int('Use whole pesewas').positive('Enter an amount').max(100_000_000);
const idemKey = z.string().trim().min(8).max(64);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');

export const EXPENSE_CATEGORIES = [
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
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** An expense can be written down up to this many days late. Older than that, ask the owner. */
export const EXPENSE_BACKDATE_DAYS = 7;

export const expenseInput = z
  .object({
    category: z.enum(EXPENSE_CATEGORIES),
    amount,
    method: z.enum(PAY_METHODS),
    /** The day it was spent. Empty means today. */
    spentOn: day.nullish().transform((v) => v ?? null),
    /** A receipt number, or where the paper is kept. Empty means there is no receipt. */
    receipt: z.string().trim().max(80).nullish().transform((v) => v || null),
    note: z.string().trim().max(200).nullish().transform((v) => v || null),
    /** Made once per form. A double-tap or a retry carries the same key, so it saves once. */
    idemKey,
  })
  .refine((e) => e.category !== 'Other' || e.note !== null, { path: ['note'], message: 'Say what it was for' });
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
  category: ExpenseCategory | string;
  amount: number;
  method: 'cash' | 'momo';
  spentOn: string;
  /** A receipt number or where the paper is kept. Null means no receipt, and the screen says so. */
  receipt: string | null;
  note: string | null;
  by: string;
  at: string;
  voided: { at: string; by: string; reason: string } | null;
}

export interface ExpensesOverview {
  from: string;
  to: string;
  expenses: ExpenseDto[];
  /** Voided ones left out. */
  sum: number;
  cashSum: number;
  momoSum: number;
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
  momoTotal: number;
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
  takings: { cash: number; momo: number; total: number; payments: number };
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
  /** Money that left by MoMo today. Not part of the drawer. */
  momoOut: { expenses: number; payouts: number };
  /** Cars finished but not fully paid for. */
  unpaid: { count: number; amount: number };
  /** Cars still being washed or waiting. */
  notFinished: number;
  /** The last counted cash, which is the usual opening float. Null if there is no earlier close. */
  suggestedFloat: number | null;
}

export interface DailyCloseHistory {
  closes: DailyCloseRow[];
}
