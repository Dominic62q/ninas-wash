import type { Role } from './roles.js';

/** What the API sends back for Phase 1 screens. Dates are ISO text. Money is whole pesewas. */

export interface ServiceDto {
  id: number;
  name: string;
  price: number;
  commissionKind: 'percent' | 'fixed';
  /** Basis points when percent (1800 = 18%), pesewas when fixed. */
  commissionValue: number;
  active: boolean;
  /** Times sold in the last 7 days. */
  sold7d: number;
  updatedAt: string;
}

export interface ChangeEntry {
  id: number;
  at: string;
  by: string | null;
  action: string;
  changes: { field: string; from: unknown; to: unknown }[];
}

export interface AttendantDto {
  id: number;
  name: string;
  phone: string | null;
  active: boolean;
  /** The day they were set inactive, if they were. */
  leftOn: string | null;
  jobsThisWeek: number;
}

export interface UserDto {
  id: number;
  name: string;
  username: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

/** Returned once, when a password is created or reset. It is never stored in readable form. */
export interface TemporaryPassword {
  temporaryPassword: string;
}

export interface VehicleDto {
  id: number;
  plate: string;
  makeModel: string | null;
  carType: 'saloon' | 'suv' | 'pickup' | 'van' | 'other' | null;
}

/** A car found while typing a plate on the new-job screen. */
export interface VehicleMatch {
  vehicle: VehicleDto;
  /** Owner's name, or null for a walk-in car. */
  owner: string | null;
  /** Already pending or in progress, so it cannot be booked again yet. */
  onBoard: boolean;
}

export interface CustomerRow {
  id: number;
  name: string;
  phone: string | null;
  okToText: boolean;
  createdAt: string;
  vehicles: VehicleDto[];
  visits: number;
  lastVisit: string | null;
  /** Total paid, in pesewas. */
  spent: number;
}

export interface CustomerStats {
  total: number;
  newThisWeek: number;
  /** Of customers seen this month, the share who had also visited before. Null when nobody was seen. */
  cameBackThisMonthPct: number | null;
  okToTextPct: number | null;
}

export interface VisitDto {
  jobId: number;
  at: string;
  services: string[];
  total: number;
  status: 'pending' | 'in_progress' | 'completed' | 'dispatched';
  voided: boolean;
}

export interface CustomerDetail {
  customer: CustomerRow;
  /** Money still owed across their jobs, in pesewas. */
  owes: number;
  recentVisits: VisitDto[];
}

export interface Page<T> {
  rows: T[];
  total: number;
}

// ---- jobs (Phase 2) ---------------------------------------------------------

/** One card on the job board. */
export interface JobCard {
  id: number;
  status: 'pending' | 'in_progress' | 'completed' | 'dispatched';
  plate: string;
  makeModel: string | null;
  carType: VehicleDto['carType'];
  customerName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  services: string[];
  /** Names of everyone working on it. */
  attendants: string[];
  /** At least one service has nobody on it yet, so the job cannot start. */
  needsAttendant: boolean;
  /** After discount, in pesewas. */
  total: number;
  /** Payments received so far (voided ones left out), in pesewas. */
  paid: number;
}

/** One row in the job history list. */
export interface JobListRow extends JobCard {
  voided: boolean;
}

export interface JobListResult {
  jobs: JobListRow[];
  /** Jobs matching the filters, not just the ones returned. */
  total: number;
  /** Value of those jobs in pesewas. Voided jobs are not counted, unless voided is the filter. */
  sum: number;
}

export interface JobLineDto {
  id: number;
  serviceId: number;
  name: string;
  /** The price when it was sold. Later price changes never touch it. */
  price: number;
  attendants: { id: number; name: string; shareBp: number }[];
}

export interface JobHistoryEntry {
  id: number;
  at: string;
  by: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** The reason, when the person had to give one (a void, or a dispatch with a balance). */
  note: string | null;
}

export interface PaymentDto {
  id: number;
  method: 'cash' | 'momo';
  amount: number;
  momoReference: string | null;
  at: string;
  by: string;
  voided: { at: string; by: string; reason: string } | null;
}

// ---- commissions and tips (Phase 4) -----------------------------------------

export interface CommissionAttendantRow {
  attendantId: number;
  name: string;
  active: boolean;
  /** Earned and not yet paid out, in pesewas. Can be negative if a paid-out job was later voided. */
  owed: number;
  /** Earned in the last 7 days, reversed ones left out. */
  earned7d: number;
}

export interface CommissionOverview {
  attendants: CommissionAttendantRow[];
  totalOwed: number;
}

export type LedgerEntry =
  | {
      type: 'earned';
      id: number;
      at: string;
      amount: number;
      jobId: number;
      plate: string;
      service: string;
      /** Their share of the line, in percent. */
      sharePct: number;
      /** The job was voided, so this was taken back. */
      reversed: boolean;
    }
  | {
      type: 'payout';
      id: number;
      at: string;
      amount: number;
      method: 'cash' | 'momo';
      by: string;
      note: string | null;
      voided: { at: string; by: string; reason: string } | null;
    };

export interface CommissionLedger {
  attendant: { id: number; name: string; active: boolean };
  owed: number;
  earned: number;
  paidOut: number;
  /** Newest first. */
  entries: LedgerEntry[];
}

export interface TipDto {
  id: number;
  at: string;
  attendantId: number;
  attendant: string;
  jobId: number | null;
  plate: string | null;
  amount: number;
  kind: 'direct' | 'held';
  /** Held tips only: given to the attendant already. */
  handedOut: boolean;
  by: string;
  voided: { at: string; by: string; reason: string } | null;
}

export interface TipsOverview {
  /** Still in our hands, per attendant. Only attendants who are owed something. */
  held: { attendantId: number; name: string; amount: number; count: number }[];
  totalHeld: number;
  /** Newest first. */
  tips: TipDto[];
  total: number;
}

export interface JobDetail {
  id: number;
  /** Like J-20261029-031: the day, and which job of that day it was. */
  number: string;
  status: 'pending' | 'in_progress' | 'completed' | 'dispatched';
  vehicle: VehicleDto;
  customer: CustomerRow | null;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  notes: string | null;
  lines: JobLineDto[];
  subtotal: number;
  discount: number;
  total: number;
  /** Payments received, voided ones left out. */
  paid: number;
  /** What is still owed: total minus paid. */
  balance: number;
  payments: PaymentDto[];
  dispatchedAt: string | null;
  /** Set when a manager let the car go with a balance still owed. */
  dispatchOverride: { by: string; note: string } | null;
  voided: { at: string; by: string; reason: string } | null;
  history: JobHistoryEntry[];
}
