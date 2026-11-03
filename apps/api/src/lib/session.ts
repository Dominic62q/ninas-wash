import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt, ne, sql } from 'drizzle-orm';
import type { Role } from '@niinas/shared';
import type { Config } from '../config.js';
import type { Db, DbOrTx } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

export const SESSION_COOKIE = 'niinas_session';

/** The cookie holds a random token. The database holds only its hash, so a leaked database cannot sign anyone in. */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const HOUR = 3_600_000;
const TOUCH_EVERY_MS = 60_000;

export interface AuthedUser {
  id: number;
  name: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

export async function createSession(db: Db, userId: number, config: Config) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.SESSION_MAX_HOURS * HOUR);
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

/** Returns the signed-in person, or null if the token is unknown, expired, idle too long, or the user is inactive. */
export async function findSession(db: Db, token: string, config: Config): Promise<AuthedUser | null> {
  const id = hashToken(token);
  const now = new Date();
  const idleCutoff = new Date(now.getTime() - config.SESSION_IDLE_HOURS * HOUR);

  const [row] = await db
    .select({
      lastSeenAt: sessions.lastSeenAt,
      id: users.id,
      name: users.name,
      username: users.username,
      role: users.role,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now), gt(sessions.lastSeenAt, idleCutoff), eq(users.active, true)))
    .limit(1);
  if (!row) return null;

  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
  }
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
  };
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

/** Sign someone out everywhere, optionally keeping the session they are using right now. */
export async function deleteUserSessions(db: DbOrTx, userId: number, keepToken?: string) {
  const keep = keepToken ? hashToken(keepToken) : null;
  await db.delete(sessions).where(and(eq(sessions.userId, userId), keep ? ne(sessions.id, keep) : undefined));
}

/** Tidy up sessions that can never be used again. Safe to run any time. */
export async function purgeExpiredSessions(db: Db) {
  await db.delete(sessions).where(lt(sessions.expiresAt, sql`now()`));
}
