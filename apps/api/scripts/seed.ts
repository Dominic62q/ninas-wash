/**
 * Creates the first three sign-ins for local development: an owner, a manager and a cashier.
 * Passwords are random, and written to .dev-credentials.txt at the repo root (git-ignored).
 * Existing users are left alone, so it is safe to run twice.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { roles, users } from '../src/db/schema.js';
import { writeAudit } from '../src/lib/audit.js';
import { hashPassword } from '../src/lib/password.js';

const people = [
  { name: 'Owner', username: 'owner', role: 'owner' },
  { name: 'Kwabena Asare', username: 'kwabena.asare', role: 'manager' },
  { name: 'Esi Mensah', username: 'esi.cashier', role: 'cashier' },
] as const;

const credentialsFile = fileURLToPath(new URL('../../../.dev-credentials.txt', import.meta.url));
const { db, pool } = createDb(loadConfig().DATABASE_URL);

const roleIds = {} as Record<'owner' | 'manager' | 'cashier', number>;
for (const key of ['owner', 'manager', 'cashier'] as const) {
  const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, key[0]!.toUpperCase() + key.slice(1)));
  roleIds[key] = r!.id;
}

for (const person of people) {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, person.username));
  if (existing) {
    console.log(`  ${person.username}: already exists, left alone`);
    continue;
  }
  const password = randomBytes(9).toString('base64url');
  await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({ name: person.name, username: person.username, roleId: roleIds[person.role], passwordHash: await hashPassword(password) })
      .returning({ id: users.id });
    await writeAudit(tx, {
      action: 'user.create',
      recordTable: 'users',
      recordId: created!.id,
      after: { username: person.username, role: person.role },
      note: 'dev seed',
    });
  });
  appendFileSync(credentialsFile, `${person.role.padEnd(8)} ${person.username.padEnd(16)} ${password}\n`);
  console.log(`  ${person.username}: created (${person.role})`);
}

await pool.end();
console.log('Passwords for new users are in .dev-credentials.txt at the repo root.');
