import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { createUserInput, isWithin, outranks, permissionsOf, updateUserInput, type TemporaryPassword, type UserDto } from '@niinas/shared';
import { attendants, roles, users } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { HttpError, conflict, forbidden, notFound } from '../lib/errors.js';
import { changedFields, isUniqueViolation, temporaryPassword } from '../lib/helpers.js';
import { hashPassword } from '../lib/password.js';
import { idParams } from '../lib/params.js';
import { deleteUserSessions } from '../lib/session.js';

type Row = { u: typeof users.$inferSelect; r: typeof roles.$inferSelect };
const toDto = ({ u, r }: Row): UserDto => ({
  id: u.id,
  name: u.name,
  username: u.username,
  roleId: r.id,
  role: r.name,
  roleLocked: r.locked,
  active: u.active,
  attendantId: u.attendantId,
  mustChangePassword: u.mustChangePassword,
  lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
});

const editable = ({ u }: Row) => ({ name: u.name, roleId: u.roleId, active: u.active });

type Db = Parameters<typeof deleteUserSessions>[0];

async function loadUser(db: Db, id: number, lock = false): Promise<Row | undefined> {
  const q = db.select({ u: users, r: roles }).from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(eq(users.id, id));
  const [row] = await (lock ? q.for('update', { of: users }) : q);
  return row;
}

async function loadRole(db: Db, id: number) {
  const [row] = await db.select().from(roles).where(eq(roles.id, id));
  if (!row) throw notFound('That role');
  return row;
}

/** Another active owner exists besides `exceptId`. The business must never be left with nobody in charge. */
async function otherActiveOwnerExists(db: Parameters<typeof deleteUserSessions>[0], exceptId: number) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(roles.locked, true), eq(users.active, true), ne(users.id, exceptId)));
  return (row?.n ?? 0) > 0;
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  // Managers can see the list too, because resetting a cashier's password starts here.
  app.get('/', { preHandler: app.requirePermission('user.reset_password') }, async () => {
    const rows = await app.db.select({ u: users, r: roles }).from(users).innerJoin(roles, eq(roles.id, users.roleId)).orderBy(asc(users.name));
    return { users: rows.map(toDto) };
  });

  // The owner creates people. Nobody types a password for someone else: the server makes a
  // one-time one, shows it once, and the person must replace it at first sign-in.
  app.post('/', { preHandler: app.requirePermission('user.manage') }, async (req, reply) => {
    const input = createUserInput.parse(req.body);
    const role = await loadRole(app.db, input.roleId);
    if (!isWithin(permissionsOf(role), req.user!.permissions)) throw forbidden('You cannot give someone more access than you have.');
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    try {
      const created = await app.db.transaction(async (tx) => {
        if (input.attendantId !== null) {
          const [attendant] = await tx.select().from(attendants).where(eq(attendants.id, input.attendantId)).for('update');
          if (!attendant) throw notFound('That attendant');
          if (!attendant.active) throw conflict('attendant_left', 'That attendant no longer works here.');
          const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.attendantId, input.attendantId));
          if (taken) throw conflict('attendant_has_login', 'That attendant already has a login.');
        }
        const [row] = await tx
          .insert(users)
          .values({ name: input.name, username: input.username, roleId: input.roleId, attendantId: input.attendantId, passwordHash, mustChangePassword: true })
          .returning();
        await writeAudit(tx, {
          userId: req.user!.id,
          action: 'user.create',
          recordTable: 'users',
          recordId: row!.id,
          after: { name: input.name, username: input.username, role: role.name, ...(input.attendantId !== null ? { attendantId: input.attendantId } : {}) }, // never the password
          ip: req.ip,
        });
        return row!;
      });
      const body: { user: UserDto } & TemporaryPassword = { user: toDto({ u: created, r: role }), temporaryPassword: password };
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
      const current = await loadUser(tx, id, true);
      if (!current) throw notFound('That person');

      const diff = changedFields(editable(current), patch);
      if (!diff) return { user: toDto(current) };

      const changesRoleOrActive = 'roleId' in diff.after || 'active' in diff.after;
      if (id === req.user!.id && changesRoleOrActive) {
        throw forbidden('You cannot change your own role or access.');
      }
      if (id !== req.user!.id && !outranks(req.user!.permissions, permissionsOf(current.r))) {
        throw forbidden('You can only change people who have less access than you.');
      }
      const nextRole = diff.after.roleId !== undefined ? await loadRole(tx, diff.after.roleId) : current.r;
      if (diff.after.roleId !== undefined && !isWithin(permissionsOf(nextRole), req.user!.permissions)) {
        throw forbidden('You cannot give someone more access than you have.');
      }
      const losesOwnerPower = current.r.locked && current.u.active && (!nextRole.locked || diff.after.active === false);
      if (losesOwnerPower && !(await otherActiveOwnerExists(tx, id))) {
        throw new HttpError(409, 'last_owner', 'There must always be at least one active owner.');
      }

      await tx.update(users).set(diff.after).where(eq(users.id, id));
      const row = (await loadUser(tx, id))!;
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
      return { user: toDto(row) };
    });
  });

  // You can reset anyone with less access than you (whoever can do everything can reset anyone),
  // otherwise someone could take over a more powerful account.
  app.post('/:id/reset-password', { preHandler: app.requirePermission('user.reset_password') }, async (req) => {
    const { id } = idParams.parse(req.params);
    if (id === req.user!.id) {
      throw forbidden('Use "Change password" for your own account.');
    }

    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);

    await app.db.transaction(async (tx) => {
      const target = await loadUser(tx, id, true);
      if (!target) throw notFound('That person');
      if (!outranks(req.user!.permissions, permissionsOf(target.r))) {
        throw forbidden('You can only reset people who have less access than you. Ask the owner.');
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
