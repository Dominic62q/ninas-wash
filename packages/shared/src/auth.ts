import { z } from 'zod';

export const loginInput = z.object({
  username: z.string().trim().min(1, 'Enter your username').max(64),
  password: z.string().min(1, 'Enter your password').max(200),
});
export type LoginInput = z.infer<typeof loginInput>;

/** What the browser is told about the signed-in person. Never includes the password. */
export const sessionUser = z.object({
  id: z.number().int(),
  name: z.string(),
  username: z.string(),
  /** The name of their role, for showing on screen. */
  role: z.string(),
  roleId: z.number().int(),
  /** The attendant this login belongs to, if it is an attendant's own. */
  attendantId: z.number().int().nullable(),
  /** True after a first sign-in or a reset: the person must choose their own password before anything else. */
  mustChangePassword: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUser>;

export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiError>;
