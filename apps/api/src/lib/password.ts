import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Passwords are stored as scrypt hashes (a deliberately slow, memory-hungry one-way function),
 * never as text. Format: scrypt$N$r$p$salt$hash
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const MAX_MEM = 128 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const options: ScryptOptions = { N: n, r, p, maxmem: MAX_MEM };
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, KEY_LEN, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;

/**
 * Burn the same time as a real check when the username does not exist,
 * so response time does not reveal which usernames are real.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummy);
  return false;
}
