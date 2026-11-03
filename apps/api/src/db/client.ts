import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];
/** Either the main connection or a transaction. Functions that write take this so they can join a transaction. */
export type DbOrTx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export { schema };
