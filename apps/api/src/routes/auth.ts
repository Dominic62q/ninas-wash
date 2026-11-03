import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { changePasswordInput, loginInput, permissionsFor } from '@niinas/shared';
import { users } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../lib/password.js';
import { SESSION_COOKIE, createSession, deleteSession, deleteUserSessions } from '../lib/session.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const secure = app.config.NODE_ENV === 'production';

  const clearCookie = (reply: FastifyReply) =>
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure });

  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { username, password } = loginInput.parse(req.body);
      const [user] = await app.db
        .select()
        .from(users)
        .where(eq(users.username, username.toLowerCase()))
        .limit(1);

      // Same answer, and same time taken, whether the username or the password was wrong.
      const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDummy(password);

      if (!user || !ok || !user.active) {
        await writeAudit(app.db, {
          action: 'auth.login_failed',
          after: { username: username.toLowerCase() },
          ip: req.ip,
        });
        throw new HttpError(401, 'bad_credentials', 'Wrong username or password.');
      }

      const { token, expiresAt } = await createSession(app.db, user.id, app.config);
      await app.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await writeAudit(app.db, { userId: user.id, action: 'auth.login', ip: req.ip });

      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure,
        expires: expiresAt,
      });
      const me = {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      };
      return { user: me, permissions: permissionsFor(user.role) };
    },
  );

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(app.db, token);
    if (req.user) await writeAudit(app.db, { userId: req.user.id, action: 'auth.logout', ip: req.ip });
    clearCookie(reply);
    return { ok: true };
  });

  app.get('/me', async (req) => {
    if (!req.user) throw unauthorized();
    return { user: req.user, permissions: permissionsFor(req.user.role) };
  });

  // Anyone signed in can change their own password. It is also the only thing a person with a
  // temporary password is allowed to do (see the guard in app.ts).
  app.post(
    '/change-password',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      if (!req.user) throw unauthorized();
      const { currentPassword, newPassword } = changePasswordInput.parse(req.body);

      const [row] = await app.db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
      if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
        throw new HttpError(400, 'wrong_password', 'Your current password is not right.');
      }
      if (newPassword === currentPassword) {
        throw new HttpError(400, 'same_password', 'Choose a password you have not used just now.');
      }
      if (newPassword.toLowerCase() === row.username) {
        throw new HttpError(400, 'weak_password', 'Your password cannot be your username.');
      }

      const passwordHash = await hashPassword(newPassword);
      await app.db.transaction(async (tx) => {
        await tx.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, row.id));
        // Sign out every other device. This one stays signed in.
        await deleteUserSessions(tx, row.id, req.cookies[SESSION_COOKIE]);
        await writeAudit(tx, { userId: row.id, action: 'auth.change_password', recordTable: 'users', recordId: row.id, ip: req.ip });
      });
      return { ok: true };
    },
  );
};
