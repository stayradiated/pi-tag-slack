import { closeDb, initDb, requireConfiguredDb } from './db.js';
import { validateSlackTokens } from './config.js';
import { startControlServer } from './control.js';
import {
  acquireGatewayLock,
  ensurePrivateFile,
  ensurePrivateLayout,
  gatewayPaths,
  structuralPathExists,
} from './paths.js';
import { unlinkSync } from 'node:fs';

/** Starts the single configured gateway owner. */
export async function startGateway(): Promise<void> {
  const paths = ensurePrivateLayout();
  const lock = acquireGatewayLock(paths);
  let server: Awaited<ReturnType<typeof startControlServer>> | undefined;
  try {
    if (!structuralPathExists(paths.db))
      throw new Error('Gateway is not configured; run pi-tag-slack setup.');
    initDb(paths.db);
    ensurePrivateFile(paths.db);
    requireConfiguredDb();
    const tokenErrors = validateSlackTokens();
    if (tokenErrors.length)
      throw new Error(`Invalid bootstrap configuration: ${tokenErrors.join(' ')}`);
    server = await startControlServer();
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    if (server) {
      try {
        unlinkSync(gatewayPaths().socket);
      } catch {
        // Socket cleanup is best effort; preserving an earlier startup/shutdown
        // error is more important than reporting a stale socket cleanup failure.
      }
    }
    closeDb();
    lock.release();
  }
}
