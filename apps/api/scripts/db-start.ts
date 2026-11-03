/**
 * Runs a real PostgreSQL as a plain local process (no Docker), with its data folder
 * inside the repo at .pgdata/. Leave this running while you develop; Ctrl+C stops it.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { forgetStoppedServer, stopPostgres } from './pg-stop.js';

const url = new URL(process.env.DATABASE_URL ?? 'postgres://niinas:niinas_dev@127.0.0.1:5433/niinas');
const databaseDir = fileURLToPath(new URL('../../../.pgdata', import.meta.url));
const dbName = url.pathname.slice(1);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  port: Number(url.port || 5432),
  persistent: true,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
  onLog: () => {},
  onError: (e) => console.error(String(e)),
});

const fresh = !existsSync(`${databaseDir}/PG_VERSION`);
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(dbName);

console.log(`Postgres is running on ${url.hostname}:${url.port} (database "${dbName}", data in .pgdata/)`);
console.log('Press Ctrl+C to stop it.');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const clean = await stopPostgres(databaseDir);
  if (clean) forgetStoppedServer(pg);
  else await pg.stop(); // last resort: the library's hard stop
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
