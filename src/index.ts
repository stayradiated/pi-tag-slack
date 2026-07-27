import { closeDb, initDb, requireConfiguredDb } from './db.js';
import { loadBootstrapConfig, validateSlackTokens } from './config.js';
import { WebClient } from '@slack/web-api';
import { readGatewayConfig } from './db.js';
import { PiRpcSession } from './pi-rpc.js';
import { startSlackGateway } from './slack.js';
import { validateConfiguredConversation } from './slack-validation.js';
import { clearSlackClient, configureSlackClient, reconcileInboxReactions } from './slack-client.js';
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
  let slack: Awaited<ReturnType<typeof startSlackGateway>> | undefined;
  let pi: PiRpcSession | undefined;
  let reactionTimer: NodeJS.Timeout | undefined;
  try {
    if (!structuralPathExists(paths.db))
      throw new Error('Gateway is not configured; run pi-tag-slack setup.');
    initDb(paths.db);
    ensurePrivateFile(paths.db);
    requireConfiguredDb();
    const bootstrap = loadBootstrapConfig();
    const tokenErrors = validateSlackTokens(bootstrap);
    if (tokenErrors.length)
      throw new Error(`Invalid bootstrap configuration: ${tokenErrors.join(' ')}`);
    const config = readGatewayConfig();
    pi = new PiRpcSession({
      binary: String(config.pi_binary),
      sessionDir: paths.session,
      cwd: String(config.working_directory),
    });
    await pi.start();
    const identity = await new WebClient(bootstrap.slackBotToken).auth.test();
    if (!identity.user_id) throw new Error('Slack auth.test did not return a bot user ID.');
    const slackClient = new WebClient(bootstrap.slackBotToken);
    await validateConfiguredConversation(slackClient, String(config.channel_id));
    configureSlackClient(slackClient, String(config.channel_id));
    slack = await startSlackGateway({
      botToken: bootstrap.slackBotToken,
      appToken: bootstrap.slackAppToken,
      botId: identity.user_id,
      notifier: pi,
    });
    server = await startControlServer();
    // Reconciliation is bounded and best-effort; it never affects Slack admission.
    void reconcileInboxReactions().catch(() => undefined);
    reactionTimer = setInterval(
      () => void reconcileInboxReactions().catch(() => undefined),
      15_000,
    );
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    if (reactionTimer) clearInterval(reactionTimer);
    clearSlackClient();
    await slack?.stop();
    await pi?.stop();
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
