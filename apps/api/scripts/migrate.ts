import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';

const { db, pool } = createDb(loadConfig().DATABASE_URL);
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
await pool.end();
console.log('Database is up to date.');
