import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { roles } from '../src/db/schema.js';

/** The id of one of the roles every database starts with: 'owner', 'manager' or 'cashier'. */
export async function roleIdFor(db: Db, name: 'cashier' | 'manager' | 'owner'): Promise<number> {
  const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name[0]!.toUpperCase() + name.slice(1)));
  return row!.id;
}
