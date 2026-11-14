import { z } from 'zod';
import { normalizePhone } from './phone.js';
import { normalizePlate } from './plate.js';

/** Input rules for Phase 1 screens. The browser and the server run the exact same checks. */

const pesewas = z.number().int('Use whole pesewas').min(0).max(100_000_000);

/** Optional phone. Empty means "none". Anything typed must be a real number. */
export const phoneField = z
  .string()
  .trim()
  .max(32)
  .nullish()
  .transform((value, ctx) => {
    if (!value) return null;
    const normalised = normalizePhone(value);
    if (!normalised) {
      ctx.addIssue({ code: 'custom', message: 'Enter a phone number like 024 551 0932' });
      return z.NEVER;
    }
    return normalised;
  });

// ---- services ------------------------------------------------------------

export const COMMISSION_KINDS = ['percent', 'fixed'] as const;
export const CAR_TYPES = ['saloon', 'suv', 'pickup', 'van', 'other'] as const;
/** A service is work on a car. An item sits on the shelf (a duster, car shine, a drink): no attendants, no commission, counted stock. */
export const SERVICE_KINDS = ['service', 'item'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

const serviceFields = z.object({
  name: z.string().trim().min(1, 'Enter the service name').max(60),
  /** Whole pesewas. */
  price: pesewas,
  commissionKind: z.enum(COMMISSION_KINDS),
  /** Basis points when percent (18% = 1800), pesewas when fixed. */
  commissionValue: pesewas,
  active: z.boolean(),
});

function checkCommission(v: { price: number; commissionKind: string; commissionValue: number }, ctx: z.RefinementCtx) {
  if (v.commissionKind === 'percent' && v.commissionValue > 10000) {
    ctx.addIssue({ code: 'custom', path: ['commissionValue'], message: 'A percentage cannot be more than 100%' });
  }
  if (v.commissionKind === 'fixed' && v.commissionValue > v.price) {
    ctx.addIssue({ code: 'custom', path: ['commissionValue'], message: 'The commission cannot be more than the price' });
  }
}

export const MAX_STOCK = 100_000;

const serviceBase = serviceFields.extend({ kind: z.enum(SERVICE_KINDS).default('service') });

function checkKind(v: { kind: string; commissionValue: number }, ctx: z.RefinementCtx) {
  if (v.kind === 'item' && v.commissionValue !== 0) {
    ctx.addIssue({ code: 'custom', path: ['commissionValue'], message: 'Items do not earn commission' });
  }
}

/** A service or item as it is saved. Whether it is an item is fixed when it is made. Items never earn commission. */
export const serviceInput = serviceBase.superRefine((v, ctx) => {
  checkCommission(v, ctx);
  checkKind(v, ctx);
});
export type ServiceInput = z.infer<typeof serviceInput>;

/** A new service or item. An item can start with some on the shelf, recorded as its first delivery. */
export const serviceCreate = serviceBase
  .extend({ openingStock: z.number({ message: 'Enter how many are on the shelf' }).int('Use a whole number').min(0, 'Cannot be below 0').max(MAX_STOCK).default(0) })
  .superRefine((v, ctx) => {
    checkCommission(v, ctx);
    checkKind(v, ctx);
    if (v.kind !== 'item' && v.openingStock > 0) {
      ctx.addIssue({ code: 'custom', path: ['openingStock'], message: 'Only items have stock' });
    }
  });
export type ServiceCreate = z.infer<typeof serviceCreate>;
/** For edits: send only what changed. The server merges it with the saved service and checks the whole. */
export const serviceUpdate = serviceFields.partial();
export type ServiceUpdate = z.infer<typeof serviceUpdate>;

// ---- item stock ----------------------------------------------------------

/** A delivery adds to the shelf. A count sets the shelf to what was actually counted, and needs a reason. */
export const stockInput = z.discriminatedUnion('reason', [
  z.object({
    reason: z.literal('delivery'),
    quantity: z.number().int('Use a whole number').min(1, 'At least 1').max(MAX_STOCK),
    note: z.string().trim().max(200).nullish().transform((v) => v || null),
  }),
  z.object({
    reason: z.literal('count'),
    count: z.number().int('Use a whole number').min(0, 'Cannot be below 0').max(MAX_STOCK),
    note: z.string().trim().min(3, 'Say why the count changed').max(200),
  }),
]);
export type StockInput = z.infer<typeof stockInput>;

// ---- attendants ----------------------------------------------------------

export const attendantInput = z.object({
  name: z.string().trim().min(1, 'Enter the name').max(80),
  phone: phoneField,
});
export type AttendantInput = z.infer<typeof attendantInput>;
export const attendantUpdate = z.object({
  name: z.string().trim().min(1, 'Enter the name').max(80).optional(),
  phone: phoneField.optional(),
  active: z.boolean().optional(),
});
export type AttendantUpdate = z.infer<typeof attendantUpdate>;

// ---- users ---------------------------------------------------------------

export const usernameField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, 'Use 3 to 32 letters, numbers, dots, dashes or underscores');

export const createUserInput = z.object({
  name: z.string().trim().min(1, 'Enter the name').max(80),
  username: usernameField,
  roleId: z.number().int().positive('Pick a role'),
  /** Set when the login is for an attendant, so they can see their own work. */
  attendantId: z.number().int().positive().nullish().transform((v) => v ?? null),
});
export type CreateUserInput = z.infer<typeof createUserInput>;

export const updateUserInput = z.object({
  name: z.string().trim().min(1, 'Enter the name').max(80).optional(),
  roleId: z.number().int().positive('Pick a role').optional(),
  active: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserInput>;

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: z.string().min(8, 'Use at least 8 characters').max(200),
});
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

// ---- customers and vehicles ----------------------------------------------

export const plateField = z
  .string()
  .trim()
  .max(20)
  .refine((v) => normalizePlate(v).length >= 3, 'Enter the number plate');

export const vehicleInput = z.object({
  plate: plateField,
  makeModel: z.string().trim().max(60).nullish().transform((v) => v || null),
  carType: z.enum(CAR_TYPES).nullish().transform((v) => v ?? null),
});
export type VehicleInput = z.infer<typeof vehicleInput>;

export const vehicleUpdate = z.object({
  plate: plateField.optional(),
  makeModel: z.string().trim().max(60).nullish().transform((v) => v || null).optional(),
  carType: z.enum(CAR_TYPES).nullish().transform((v) => v ?? null).optional(),
});
export type VehicleUpdate = z.infer<typeof vehicleUpdate>;

export const customerInput = z.object({
  name: z.string().trim().min(1, 'Enter the name').max(80),
  phone: phoneField,
  okToText: z.boolean().default(false),
  /** Optional first car, saved together with the customer. */
  vehicle: vehicleInput.optional(),
});
export type CustomerInput = z.infer<typeof customerInput>;

export const customerUpdate = z.object({
  name: z.string().trim().min(1, 'Enter the name').max(80).optional(),
  phone: phoneField.optional(),
  okToText: z.boolean().optional(),
});
export type CustomerUpdate = z.infer<typeof customerUpdate>;
