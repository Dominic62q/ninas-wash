import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { purgeExpiredSessions } from './lib/session.js';

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const app = await buildApp({ db, config, logger: true });

await purgeExpiredSessions(db);
const sweep = setInterval(() => void purgeExpiredSessions(db), 60 * 60 * 1000);
sweep.unref();

async function shutdown() {
  clearInterval(sweep);
  await app.close();
  await pool.end();
  process.exit(0);
}
// A forgotten promise should be loud in the log, not silent. systemd restarts the process if it dies.
process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled rejection'));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
