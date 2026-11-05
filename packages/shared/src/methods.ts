import { z } from 'zod';

/**
 * Ways money moves in and out (cash, MoMo, a bank, a card machine, whatever the wash uses).
 * The owner adds and changes them in Settings. The only thing the rest of the app needs to know
 * about one is whether it passes through the cash drawer, because that decides what the drawer should hold.
 */

export const payMethodInput = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(30, 'Use at most 30 characters'),
  /** The money physically goes in or out of the cash drawer. Cash does; MoMo and bank transfers do not. */
  inDrawer: z.boolean(),
  /** A payment by this method must say where it came from (a MoMo or transfer reference). */
  requiresReference: z.boolean(),
  active: z.boolean().default(true),
});
export type PayMethodInput = z.infer<typeof payMethodInput>;

export const updatePayMethodInput = payMethodInput.partial();

export interface PayMethodDto {
  id: number;
  name: string;
  inDrawer: boolean;
  requiresReference: boolean;
  /** Inactive methods stay on old records but cannot be picked for new ones. */
  active: boolean;
  /** Something has already been paid or spent with it. Whether it passes through the drawer can no longer change. */
  used: boolean;
}

/** What one method took (or paid out) in a period. */
export interface MethodTotal {
  methodId: number;
  name: string;
  inDrawer: boolean;
  amount: number;
}

/** Money received, split by whether it landed in the drawer. `byMethod` has the detail, biggest first. */
export interface Takings {
  drawer: number;
  other: number;
  total: number;
  payments: number;
  byMethod: MethodTotal[];
}

/** The message to show when a method needs a reference and there is none, or null when all is well. */
export function referenceProblem(method: { name: string; requiresReference: boolean }, reference: string | null | undefined): string | null {
  return method.requiresReference && !reference?.trim() ? `Enter the ${method.name} reference` : null;
}
