import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { createUserInput, updateUserInput, type TemporaryPassword, type UserDto } from '@niinas/shared';
import { users } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { HttpError, conflict, forbidden, notFound } from '../lib/errors.js';
import { changedFields, isUniqueViolation, temporaryPassword } from '../lib/helpers.js';
import { hashPassword } from '../lib/password.js';
import { idParams } from '../lib/params.js';
import { deleteUserSessions } from '../lib/session.js';

type Row = typeof users.$inferSelect;
const toDto = (row: Row): UserDto => ({
  id: row.id,
  name: row.name,
  username: row.username,
  role: row.role,
  active: row.active,
  mustChangePassword: row.mustChangePassword,
  lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
});

const editable = (row: Row) => ({ name: row.name, role: row.role, active: row.active });

/** Another active owner exists besides `exceptId`. The business must never be left with nobody in charge. */
async function otherActiveOwnerExists(db: Parameters<typeof deleteUserSessions>[0], exceptId: number) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, 'owner'), eq(users.active, true), ne(users.id, exceptId)));
  return (row?.n ?? 0) > 0;
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  // Managers can see the list too, because resetting a cashier's password starts here.
  app.get('/', { preHandler: app.requirePermission('user.reset_password') }, async () => {
    const rows = await app.db.select().from(users).orderBy(asc(users.name));
    return { users: rows.map(toDto) };
  });

  // The owner creates people. Nobody types a password for someone else: the server makes a
  // one-time one, shows it once, and the person must replace it at first sign-in.
  app.post('/', { preHandler: app.requirePermission('user.manage') }, async (req, reply) => {
    const input = createUserInput.parse(req.body);
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    try {
      const created = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({ ...input, passwordHash, mustChangePassword: true })
          .returning();
        await writeAudit(tx, {
          userId: req.user!.id,
          action: 'user.create',
          recordTable: 'users',
          recordId: row!.id,
          after: input, // never the password
          ip: req.ip,
        });
        return row!;
      });
      const body: { user: UserDto } & TemporaryPassword = { user: toDto(created), temporaryPassword: password };
      return reply.status(201).send(body);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('duplicate_username', 'That username is already taken.');
      throw e;
    }
  });

  app.patch('/:id', { preHandler: app.requirePermission('user.manage') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const patch = updateUserInput.parse(req.body);

    return app.db.transaction(async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!current) throw notFound('That person');

      const diff = changedFields(editable(current), patch);
      if (!diff) return { user: toDto(current) };

      const changesRoleOrActive = 'role' in diff.after || 'active' in diff.after;
      if (id === req.user!.id && changesRoleOrActive) {
        throw forbidden('You cannot change your own role or access.');
      }
      const losesOwnerPower =
        current.role === 'owner' && current.active && (diff.after.role === 'manager' || diff.after.role === 'cashier' || diff.after.active === false);
      if (losesOwnerPower && !(await otherActiveOwnerExists(tx, id))) {
        throw new HttpError(409, 'last_owner', 'There must always be at least one active owner.');
      }

      const [row] = await tx.update(users).set(diff.after).where(eq(users.id, id)).returning();
      if (diff.after.active === false) await deleteUserSessions(tx, id); // signed out at once
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'user.update',
        recordTable: 'users',
        recordId: id,
        before: diff.before,
        after: diff.after,
        ip: req.ip,
      });
      return { user: toDto(row!) };
    });
  });

  // A manager can reset a cashier. Only the owner can reset a manager or another owner,
  // otherwise a manager could take over a more powerful account.
  app.post('/:id/reset-password', { preHandler: app.requirePermission('user.reset_password') }, async (req) => {
    const { id } = idParams.parse(req.params);
    if (id === req.user!.id) {
      throw forbidden('Use "Change password" for your own account.');
    }

    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);

    await app.db.transaction(async (tx) => {
      const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!target) throw notFound('That person');
      if (req.user!.role === 'manager' && target.role !== 'cashier') {
        throw forbidden('A manager can only reset a cashier. Ask the owner.');
      }
      await tx.update(users).set({ passwordHash, mustChangePassword: true }).where(eq(users.id, id));
      await deleteUserSessions(tx, id); // any device that was signed in is signed out
      await writeAudit(tx, {
        userId: req.user!.id,
        action: 'user.reset_password',
        recordTable: 'users',
        recordId: id,
        ip: req.ip,
      });
    });

    const body: TemporaryPassword = { temporaryPassword: password };
    return body;
  });
};
