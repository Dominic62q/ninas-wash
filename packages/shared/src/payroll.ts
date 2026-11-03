import { z } from 'zod';
import { PAY_METHODS } from './jobs.js';

/** Input rules for Phase 4 (commissions and tips). The browser and the server run the exact same checks. */

const id = z.number().int().positive();
const amount = z.number().int('Use whole pesewas').positive('Enter an amount').max(100_000_000);
const idemKey = z.string().trim().min(8).max(64);

/** Direct: the customer handed it to the attendant, we only write it down. Held: we took it and keep it until handout. */
export const TIP_KINDS = ['direct', 'held'] as const;
export type TipKind = (typeof TIP_KINDS)[number];

export const tipInput = z.object({
  attendantId: id,
  /** The car it was for. Optional: a tip is sometimes not tied to one car. */
  jobId: id.nullish().transform((v) => v ?? null),
  amount,
  kind: z.enum(TIP_KINDS),
  /** Made once per form. A double-tap or a retry carries the same key, so it saves once. */
  idemKey,
});
export type TipInput = z.infer<typeof tipInput>;

/** One handout clears everything held for that attendant. */
export const handoutInput = z.object({ attendantId: id });

export const payoutInput = z.object({
  attendantId: id,
  amount,
  method: z.enum(PAY_METHODS),
  note: z.string().trim().max(200).nullish().transform((v) => v || null),
  idemKey,
});
export type PayoutInput = z.infer<typeof payoutInput>;

/** Used for every void and reopen: a few words on why. */
export const reasonInput = z.object({
  reason: z.string().trim().min(3, 'Say why').max(200),
});
