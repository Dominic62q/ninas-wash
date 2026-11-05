/**
 * Makes the first owner sign-in on a new server (the dev seed makes sample staff, which a real wash does not want).
 *
 *   npm run db:create-owner -w @niinas/api -- "Full Name" username
 *
 * The one-time password is printed once, here, and never stored anywhere readable.
 * The owner must choose their own password at first sign-in.
 */
import { createUserInput } from '@niinas/shared';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { roles, users } from '../src/db/schema.js';
import { writeAudit } from '../src/lib/audit.js';
import { temporaryPassword } from '../src/lib/helpers.js';
import { hashPassword } from '../src/lib/password.js';

const [name, username] = process.argv.slice(2);
const parsed = createUserInput.safeParse({ name, username, roleId: 1 });
if (!parsed.success) {
  console.error('Usage: npm run db:create-owner -w @niinas/api -- "Full Name" username');
  console.error(parsed.error.issues[0]?.message ?? '');
  process.exit(1);
}

const { db, pool } = createDb(loadConfig().DATABASE_URL);
const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.username, parsed.data.username));
if (taken) {
  console.error(`"${parsed.data.username}" already exists. Nothing was changed.`);
  await pool.end();
  process.exit(1);
}

const [ownerRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.locked, true));
if (!ownerRole) {
  console.error('The owner role is missing. Run the migrations first.');
  await pool.end();
  process.exit(1);
}

const password = temporaryPassword();
await db.transaction(async (tx) => {
  const [created] = await tx
    .insert(users)
    .values({ name: parsed.data.name, username: parsed.data.username, roleId: ownerRole.id, passwordHash: await hashPassword(password), mustChangePassword: true })
    .returning({ id: users.id });
  await writeAudit(tx, {
    action: 'user.create',
    recordTable: 'users',
    recordId: created!.id,
    after: { username: parsed.data.username, role: 'owner' },
    note: 'first owner, created on the server',
  });
});
await pool.end();

console.log(`Owner "${parsed.data.username}" created.`);
console.log(`One-time password: ${password}`);
console.log('Shown once. They will be asked to choose their own at first sign-in.');
