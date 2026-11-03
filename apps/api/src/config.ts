import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(3001),
  /** Local dev database started by `npm run dev:db`. Change this for staging and production. */
  DATABASE_URL: z.string().default('postgres://niinas:niinas_dev@127.0.0.1:5433/niinas'),
  /**
   * Addresses the browser app is served from, comma separated. Changes from any other site are refused.
   * To try the app on a phone on the same Wi-Fi, add its address, e.g. http://192.168.1.20:5173
   */
  WEB_ORIGIN: z
    .string()
    .default('http://localhost:5173,http://127.0.0.1:5173')
    .transform((value) => value.split(',').map((o) => o.trim()).filter(Boolean)),
  /** How long a sign-in lasts without use. */
  SESSION_IDLE_HOURS: z.coerce.number().positive().default(12),
  /** The most a sign-in can last, however much it is used. */
  SESSION_MAX_HOURS: z.coerce.number().positive().default(24),
  /**
   * Nalo Solutions text messages. Both of these must be set for texts to really go out; until then they are
   * recorded as "not sent" so the rest of the system can be tried without spending credits.
   * SMS_API_URL is the full send address from the Nalo account, ending in /send-message/.
   */
  SMS_API_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  SMS_API_KEY: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  /** The name customers see the text come from. Eleven characters at most, and the sender id must be approved by Nalo. */
  SMS_SENDER_ID: z.string().trim().min(1).max(11).default('NiinasWash'),
  /** Where the owner buys more credits. */
  SMS_TOPUP_URL: z.string().url().default('https://app.nalosolutions.com'),
});

export type Config = z.infer<typeof schema>;

/**
 * Reads the settings. In production it refuses to start on the development defaults, because a wash
 * running on the dev database password or an http address is one forgotten setting away from a leak.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(env);
  if (config.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (!env.DATABASE_URL) problems.push('DATABASE_URL is not set');
    else if (config.DATABASE_URL.includes('niinas_dev')) problems.push('DATABASE_URL still uses the development password');
    if (!env.WEB_ORIGIN) problems.push('WEB_ORIGIN is not set (use the https address people open, e.g. https://wash.example.com)');
    else if (config.WEB_ORIGIN.some((o) => !o.startsWith('https://'))) problems.push('WEB_ORIGIN must be https:// addresses');
    if (problems.length > 0) throw new Error(`Cannot start in production: ${problems.join('; ')}.`);
  }
  return config;
}
