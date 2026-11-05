import { z } from 'zod';
import type { Takings } from './methods.js';

/** Shapes for Phase 6: the dashboard everyone sees, and the reports only the owner sees. */

/** Reports cover at most this many days at a time. */
export const REPORT_MAX_DAYS = 366;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');
export const reportQuery = z.object({ from: day, to: day }).refine((r) => r.from <= r.to, { path: ['to'], message: 'The end date is before the start date.' });

export interface DashboardDto {
  day: string;
  /** Money received today, voided payments left out. */
  takings: Takings;
  /** Today's cars by where they are. */
  cars: { waiting: number; washing: number; ready: number; dispatched: number; total: number };
  /** Finished cars not fully paid for, from any day. */
  owing: { count: number; amount: number };
  /** Today's close, or null if the person has no business with it. */
  close: { status: 'open' | 'closed' | 'reopened'; difference: number | null } | null;
  /** Takings for the last 7 days, oldest first, today last. Null for a cashier, who counts the drawer blind. */
  last7: { day: string; drawer: number; other: number; total: number }[] | null;
  /** What was sold today, biggest first, at most 6. */
  services: { name: string; count: number; sales: number }[];
  /** Cars each attendant worked on today, most first, at most 6. */
  attendants: { name: string; cars: number }[];
  /** Days in the last week that had money moving but were never closed. */
  unclosedDays: string[] | null;
  /** Null when the person cannot write down expenses. */
  expenses: { total: number; withoutReceipt: number } | null;
  /** Tips we are holding for attendants. Null when the person cannot work with tips. */
  heldTips: { total: number; attendants: number } | null;
  /** Commission earned and not yet paid out. Managers and owners only. */
  commissionOwed: number | null;
}

export interface ReportDto {
  from: string;
  to: string;
  days: number;
  /** Money received in the period, voided payments left out. */
  takings: Takings;
  byDay: { day: string; drawer: number; other: number; total: number }[];
  /** Cars booked in the period, voided ones left out. `net` is after discounts. */
  jobs: { count: number; sales: number; discounts: number; net: number; average: number; owing: { count: number; amount: number } };
  byService: { name: string; count: number; sales: number }[];
  byAttendant: { name: string; cars: number; earned: number }[];
  expenses: { total: number; drawer: number; other: number; withoutReceipt: number; byCategory: { category: string; amount: number; count: number }[] };
  commission: { earned: number; paidOut: number };
  /** Tips are the attendants' money. They are shown, never counted as takings. */
  tips: { held: number; direct: number };
  cash: {
    closedDays: number;
    balanced: number;
    short: number;
    over: number;
    /** Closed days that were off, newest first. */
    differences: { day: string; difference: number }[];
    /** Past days with money moving that were never closed. */
    notClosed: string[];
  };
  /** Takings minus expenses minus commission earned. */
  net: number;
}
