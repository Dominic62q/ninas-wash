import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PERMISSION_KEYS, can, permissionsOf, withNeeded, type RoleDto } from '@niinas/shared';
import { roles, users } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { changedFields, isUniqueViolation } from '../lib/helpers.js';
import { idParams } from '../lib/params.js';

const roleInput = z.object({
  name: z.string().trim().min(1, 'Enter a name for the role').max(40, 'Use at most 40 characters'),
  permissions: z.array(z.string()).max(PERMISSION_KEYS.length + 10),
});

type Row = typeof roles.$inferSelect;
const toDto = (row: Row, members: number): RoleDto => ({
  id: row.id,
  name: row.name,
  locked: row.locked,
  permissions: permissionsOf(row),
  members,
});

/** Roles are the owner's tool: a name plus a tick-list of what that role may do. */
export const roleRoutes: FastifyPluginAsync = async (app) => {
  async function list(): Promise<RoleDto[]> {
    const rows = await app.db
      .select({ r: roles, members: sql<number>`count(${users.id}) filter (where ${users.active})::int` })
      .from(roles)
      .leftJoin(users, eq(users.roleId, roles.id))
      .groupBy(roles.id)
      .orderBy(sql`${roles.locked} desc`, asc(roles.name));
    return rows.map(({ r, members }) => toDto(r, members));
  }

  // The user form needs the list to offer a role, so anyone who can add users or reset passwords may read it.
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    const p = req.user!.permissions;
    if (!can(p, 'user.manage') && !can(p, 'user.reset_password') && !can(p, 'role.manage')) throw forbidden();
    return { roles: await list() };
  });

  app.post('/', { preHandler: app.requirePermission('role.manage') }, async (req, reply) => {
    const input = roleInput.parse(req.body);
    const permissions = withNeeded(input.permissions);
    // Nobody can hand out more than they have themselves.
    if (!permissions.every((p) => can(req.user!.permissions, p))) throw forbidden('You cannot give a role more than you can do yourself.');
    try {
      const row = await app.db.transaction(async (tx) => {
        const [created] = await tx.insert(roles).values({ name: input.name, permissions }).returning();
        await writeAudit(tx, { userId: req.user!.id, action: 'role.create', recordTable: 'roles', recordId: created!.id, after: { name: input.name, permissions }, ip: req.ip });
        return created!;
      });
      return reply.status(201).send({ role: toDto(row, 0) });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('duplicate_role', 'There is already a role with that name.');
      throw e;
    }
  });

  app.patch('/:id', { preHandler: app.requirePermission('role.manage') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const input = roleInput.partial().parse(req.body);
    try {
      await app.db.transaction(async (tx) => {
        const [current] = await tx.select().from(roles).where(eq(roles.id, id)).for('update');
        if (!current) throw notFound('That role');
        if (current.locked) throw forbidden('The owner role can always do everything, so it cannot be changed.');
        const next = { name: input.name ?? current.name, permissions: input.permissions ? withNeeded(input.permissions) : current.permissions };
        // You cannot give a role something you do not have, and you cannot change a role you hold (no lifting your own access).
        if (!next.permissions.every((p) => can(req.user!.permissions, p as never))) throw forbidden('You cannot give a role more than you can do yourself.');
        if (id === req.user!.roleId) throw forbidden('You cannot change your own role. Ask the owner.');
        const diff = changedFields({ name: current.name, permissions: current.permissions }, next);
        if (!diff) return;
        await tx.update(roles).set({ ...diff.after, updatedAt: new Date() }).where(eq(roles.id, id));
        await writeAudit(tx, { userId: req.user!.id, action: 'role.update', recordTable: 'roles', recordId: id, before: diff.before, after: diff.after, ip: req.ip });
      });
      return { role: (await list()).find((r) => r.id === id)! };
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('duplicate_role', 'There is already a role with that name.');
      throw e;
    }
  });

  // Only a role nobody has ever held can go. Otherwise the history of who could do what would be lost.
  app.delete('/:id', { preHandler: app.requirePermission('role.manage') }, async (req) => {
    const { id } = idParams.parse(req.params);
    await app.db.transaction(async (tx) => {
      const [current] = await tx.select().from(roles).where(eq(roles.id, id)).for('update');
      if (!current) throw notFound('That role');
      if (current.locked) throw forbidden('The owner role cannot be removed.');
      const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.roleId, id));
      if ((used?.n ?? 0) > 0) throw conflict('role_in_use', 'People still have this role. Give them another role first.');
      await tx.delete(roles).where(eq(roles.id, id));
      await writeAudit(tx, { userId: req.user!.id, action: 'role.delete', recordTable: 'roles', recordId: id, before: { name: current.name, permissions: current.permissions }, ip: req.ip });
    });
    return { ok: true };
  });
};
