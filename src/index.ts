import { closeDb, initDb, openWorkSummary, publicId, requireConfiguredDb } from './db.js';
import { loadBootstrapConfig, validateSlackTokens } from './config.js';
import { WebClient } from '@slack/web-api';
import { readGatewayConfig } from './db.js';
import { PiRpcSession } from './pi-rpc.js';
import { GatewayCoordinator, startSlackGateway } from './slack.js';
import { validateConfiguredConversation } from './slack-validation.js';
import { clearSlackClient, configureSlackClient, reconcileInboxReactions } from './slack-client.js';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { startControlServer } from './control.js';
import { materializeDueSchedules, SchedulerService } from './scheduler.js';
import {
  acquireGatewayLock,
  ensurePrivateFile,
  ensurePrivateLayout,
  structuralPathExists,
} from './paths.js';

export function startupRecoveryPrompt(): string | undefined {
  const work = openWorkSummary();
  if (work.inboxTotal === 0 && work.taskTotal === 0) return undefined;
  const inbox = work.inbox
    .map(
      (item) =>
        `- ${publicId('inbox', Number(item.id))} from ${item.sender_label}; thread ${item.thread_ts}: ${String(item.content)}`,
    )
    .join('\n');
  const tasks = work.tasks
    .map(
      (item) =>
        `- ${publicId('task', Number(item.id))} (${item.source}): ${item.title}\n  Instructions: ${item.instructions}`,
    )
    .join('\n');
  return (
    '[Startup recovery summary]\n' +
    `Open inbox items: ${work.inboxTotal}\n${inbox || '(none)'}\n` +
    `Open tasks: ${work.taskTotal}\n${tasks || '(none)'}\n` +
    'This is a neutral summary; inspect durable work before acting. ' +
    'Use pi-tag-slack inbox list/show and pi-tag-slack task list/show to inspect all remaining work.'
  );
}

/** Starts the single configured gateway owner. */
export async function startGateway(): Promise<void> {
  const paths = ensurePrivateLayout();
  const lock = acquireGatewayLock(paths);
  let server: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let slack: Awaited<ReturnType<typeof startSlackGateway>> | undefined;
  let pi: PiRpcSession | undefined;
  let reactionTimer: NodeJS.Timeout | undefined;
  let scheduler: SchedulerService | undefined;
  const coordinator = new GatewayCoordinator();
  try {
    if (!structuralPathExists(paths.db))
      throw new Error('Gateway is not configured; run pi-tag-slack setup.');
    initDb(paths.db);
    ensurePrivateFile(paths.db);
    requireConfiguredDb();
    // Schedule work is durable before pi starts, and joins the one aggregate
    // recovery message rather than causing individual startup notifications.
    await coordinator.run(() => materializeDueSchedules());
    const bootstrap = loadBootstrapConfig();
    const tokenErrors = validateSlackTokens(bootstrap);
    if (tokenErrors.length)
      throw new Error(`Invalid bootstrap configuration: ${tokenErrors.join(' ')}`);
    const config = readGatewayConfig();
    const createPi = () => {
      const rpc = new PiRpcSession({
        binary: String(config.pi_binary),
        sessionDir: paths.session,
        cwd: String(config.working_directory),
        desired: () => {
          const current = readGatewayConfig();
          return {
            model: String(current.session_model_override ?? current.default_model),
            thinking: String(current.session_thinking_override ?? current.default_thinking),
          };
        },
      });
      rpc.setSafeBoundaryHandler(() => void coordinator.run(() => pi!.applyDesired()));
      return rpc;
    };
    pi = createPi();
    const session = {
      notify: (message: string) => pi!.notify(message),
      status: () => pi!.status(),
      availableModels: () => pi!.availableModels(),
      availableThinkingLevels: () => pi!.availableThinkingLevels(),
      applyDesired: () => pi!.applyDesired(),
      reset: async () => {
        const status = await pi!.status();
        if (status.activity === 'active') {
          const challenge = `${status.sessionId ?? 'unknown'}:${status.runSequence}`;
          throw Object.assign(
            new Error(
              `Pi is active. Confirm with: pi-tag-slack session reset --confirm ${challenge}`,
            ),
            { code: 'CONFIRMATION_REQUIRED' },
          );
        }
        const old = pi!;
        await old.stop();
        let counter = 0;
        let archivePath: string;
        do {
          archivePath = join(
            paths.archive,
            `session-${new Date().toISOString().replace(/[:.]/g, '-')}-${counter++}`,
          );
        } while (existsSync(archivePath));
        renameSync(paths.session, archivePath);
        mkdirSync(paths.session, { mode: 0o700 });
        pi = createPi();
        await pi.start();
        await pi.applyDesired();
        const recovery = startupRecoveryPrompt();
        if (recovery) await pi.notify(recovery);
        return { archivedTo: archivePath, recoverySent: Boolean(recovery) };
      },
    };
    await pi.start();
    // Restore persisted desired overrides/defaults before presenting work.
    // A failed application is retained as desired state and reflected in health.
    await coordinator.run(() => pi!.applyDesired());
    // A recovery is aggregate-only: it deliberately does not update per-item
    // RPC acceptance fields and is sent at most once per daemon startup.
    const recovery = startupRecoveryPrompt();
    if (recovery) await coordinator.run(() => pi!.notify(recovery));
    const identity = await new WebClient(bootstrap.slackBotToken).auth.test();
    if (!identity.user_id) throw new Error('Slack auth.test did not return a bot user ID.');
    const slackClient = new WebClient(bootstrap.slackBotToken);
    await validateConfiguredConversation(slackClient, String(config.channel_id));
    configureSlackClient(slackClient, String(config.channel_id));
    slack = await startSlackGateway({
      botToken: bootstrap.slackBotToken,
      appToken: bootstrap.slackAppToken,
      botId: identity.user_id,
      notifier: session,
      coordinator,
    });
    server = await startControlServer({
      notifier: session,
      coordinator,
      sessionStatus: () => session.status(),
      sessionControls: session,
    });
    // Reconciliation is bounded and best-effort; it never affects Slack admission.
    void reconcileInboxReactions().catch(() => undefined);
    reactionTimer = setInterval(
      () => void reconcileInboxReactions().catch(() => undefined),
      15_000,
    );
    scheduler = new SchedulerService(session, coordinator);
    scheduler.start();
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    if (reactionTimer) clearInterval(reactionTimer);
    scheduler?.stop();
    clearSlackClient();
    await slack?.stop();
    await pi?.stop();
    if (server) {
      try {
        await server.close();
      } catch {
        // Preserve an earlier startup/shutdown failure over best-effort cleanup.
      }
    }
    closeDb();
    lock.release();
  }
}
