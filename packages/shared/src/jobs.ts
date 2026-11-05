import { z } from 'zod';
import { phoneField, plateField, CAR_TYPES } from './setup.js';

/** Input rules for Phase 2 (jobs). The browser and the server run the exact same checks. */

export const JOB_STATUSES = ['pending', 'in_progress', 'completed', 'dispatched'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const id = z.number().int().positive();
const discountField = z.number().int('Use whole pesewas').min(0).max(100_000_000);

export const jobLineInput = z.object({
  serviceId: id,
  /** Who washes it. Can be empty at first ("Assign" later), but a job cannot start until every line has someone. */
  attendantIds: z
    .array(id)
    .max(6)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, 'Pick each attendant once'),
});
export type JobLineInput = z.infer<typeof jobLineInput>;

export const createJobInput = z.object({
  plate: plateField,
  /** Only used when the car is new to us (or has no make or type saved yet). */
  makeModel: z.string().trim().max(60).nullish().transform((v) => v || null),
  carType: z.enum(CAR_TYPES).nullish().transform((v) => v ?? null),
  /** Optional: save the owner as a regular when the car has no owner yet. */
  customer: z
    .object({
      name: z.string().trim().min(1, 'Enter the name').max(80),
      phone: phoneField,
      okToText: z.boolean().default(false),
    })
    .optional(),
  lines: z
    .array(jobLineInput)
    .min(1, 'Choose at least one service')
    .max(10)
    .refine((lines) => new Set(lines.map((l) => l.serviceId)).size === lines.length, 'Each service can be added once'),
  discount: discountField.default(0),
  notes: z.string().trim().max(300).nullish().transform((v) => v || null),
  /** "Save and start wash" (true) or "Save as pending" (false). */
  start: z.boolean().default(false),
});
export type CreateJobInput = z.infer<typeof createJobInput>;

export const addLineInput = jobLineInput;

export const assignInput = z.object({
  attendantIds: z.array(id).min(1, 'Pick at least one attendant').max(6).refine((ids) => new Set(ids).size === ids.length, 'Pick each attendant once'),
});

export const discountInput = z.object({ discount: discountField });

/** Jobs only move forward. Handing the car over is its own step (dispatch), below. */
export const statusInput = z.object({ to: z.enum(['in_progress', 'completed']) });

/** One payment. Several can be taken on a job (part cash, part MoMo). Whether a reference is needed depends on the method. */
export const paymentInput = z.object({
  methodId: z.number().int().positive('Pick how it was paid'),
  /** Pesewas. */
  amount: z.number().int('Use whole pesewas').positive('Enter an amount').max(100_000_000),
  reference: z.string().trim().max(40).nullish().transform((v) => v || null),
  /** Made once per payment form. A double-tap or a retry carries the same key, so it saves once. */
  idemKey: z.string().trim().min(8).max(64),
});
export type PaymentInput = z.infer<typeof paymentInput>;

/** The note is only needed when the car leaves with money still owed. */
export const dispatchInput = z.object({
  note: z.string().trim().max(200).nullish().transform((v) => v || null),
});

export const voidInput = z.object({
  reason: z.string().trim().min(3, 'Say why the job is being voided').max(200),
});
