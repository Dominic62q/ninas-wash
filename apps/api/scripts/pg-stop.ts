import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stop a local Postgres cleanly with its own `pg_ctl stop` (finishes writes, then exits).
 *
 * `embedded-postgres` on Windows stops the server with a hard `taskkill /f /t`, which can leave
 * worker processes holding the port and gives the data folder no clean shutdown. This avoids that.
 */
const PACKAGES: Record<string, string> = {
  'win32-x64': 'windows-x64',
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};

function pgCtlPath(): string {
  const pkg = PACKAGES[`${os.platform()}-${os.arch()}`];
  if (!pkg) throw new Error(`No bundled Postgres for ${os.platform()}-${os.arch()}`);
  const exe = os.platform() === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'node_modules', '@embedded-postgres', pkg, 'native', 'bin', exe);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find the bundled pg_ctl. Run npm install.');
    dir = parent;
  }
}

/**
 * Call after a clean stop. The library registers an exit hook that waits for the server process
 * to exit, which never comes because we already stopped it, so the program hangs for 10 seconds.
 * Telling it there is nothing running makes that hook return at once.
 */
export function forgetStoppedServer(server: object): void {
  (server as { process?: unknown }).process = undefined;
}

/** Resolves true if Postgres shut down cleanly, false if it was not running or pg_ctl failed. */
export function stopPostgres(dataDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(pgCtlPath(), ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '30'], (error) => resolve(!error));
  });
}
