/**
 * Starts a throwaway real PostgreSQL for the tests (its own port and temp folder, no Docker),
 * applies every migration, and hands the connection string to the tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { forgetStoppedServer, stopPostgres } from '../scripts/pg-stop.js';

const PORT = 5544;

export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'niinas-test-pg-'));
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'test',
    password: 'test',
    port: PORT,
    persistent: false,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off'],
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('niinas_test');

  const url = `postgres://test:test@127.0.0.1:${PORT}/niinas_test`;
  const pool = new pg.Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  await pool.end();

  project.provide('dbUrl', url);

  return async () => {
    const clean = await stopPostgres(dir);
    if (clean) forgetStoppedServer(server);
    else await server.stop(); // last resort: the library's hard stop
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
  }
}
