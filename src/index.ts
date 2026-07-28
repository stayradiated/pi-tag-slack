import {
  closeDb,
  initDb,
  openWorkSummary,
  publicId,
  requireConfiguredDb,
  revertOpenInboxWorkingReactions,
} from './db.js';
import { loadBootstrapConfig, validateSlackTokens } from './config.js';
import { WebClient } from '@slack/web-api';
import { readGatewayConfig } from './db.js';
import { PiRpcSession, piEnvironment, type PiSessionStatus } from './pi-rpc.js';
import { GatewayCoordinator, startSlackGateway } from './slack.js';
import { validateConfiguredConversation } from './slack-validation.js';
import {
  clearSlackClient,
  configureSlackClient,
  reconcileInboxReactions,
  scheduleReactionReconciliation,
} from './slack-client.js';
import { createDaemonLogger, logFailure } from './logging.js';
import { GatewayLifecycle } from './lifecycle.js';
import { mkdirSync } from 'node:fs';
import { startControlServer } from './control.js';
import { materializeDueSchedules, SchedulerService } from './scheduler.js';
import { archiveActiveSession } from './session-archive.js';
import { readResetJournal } from './reset-install.js';
import {
  acquireGatewayLock,
  ensurePrivateFile,
  ensurePrivateLayout,
  structuralPathExists,
} from './paths.js';

export function restoreOpenInboxReceiptsAfterSessionLoss(): number {
  const changed = revertOpenInboxWorkingReactions();
  scheduleReactionReconciliation();
  return changed;
}

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

type ResetSession = {
  status(): Promise<PiSessionStatus>;
  currentActivityEpoch(): number;
};

/** Build stale-safe reset controls around the daemon's replaceable session owner. */
export function createSessionResetControls(options: {
  current(): ResetSession;
  performReset(): Promise<{ archivedTo: string; recoverySent: boolean }>;
  setReserved(reserved: boolean): void;
  onFailure(error: unknown): void;
}) {
  const stale = (message = 'The session reset confirmation is stale.') =>
    Object.assign(new Error(message), { code: 'STALE_CONFIRMATION' });
  return {
    reset: async () => {
      const status = await options.current().status();
      if (status.activity === 'active') {
        const challenge = `${status.sessionId ?? 'unknown'}:${status.runSequence}`;
        throw Object.assign(
          new Error(
            `Pi is active. Confirm with: pi-tag-slack session reset --confirm ${challenge}`,
          ),
          { code: 'CONFIRMATION_REQUIRED' },
        );
      }
      return options.performReset();
    },
    confirmReset: async (challenge: string) => {
      const reservedPi = options.current();
      const status = await reservedPi.status();
      const exact = `${status.sessionId ?? 'unknown'}:${status.runSequence}`;
      if (status.activity !== 'active' || challenge !== exact) throw stale();
      const activityEpoch = reservedPi.currentActivityEpoch();
      options.setReserved(true);
      return {
        result: { confirmed: true },
        cancelPostFlush: () => options.setReserved(false),
        postFlush: async () => {
          try {
            const current = await reservedPi.status();
            const currentExact = `${current.sessionId ?? 'unknown'}:${current.runSequence}`;
            if (
              options.current() !== reservedPi ||
              current.activity !== 'active' ||
              currentExact !== challenge ||
              reservedPi.currentActivityEpoch() !== activityEpoch
            )
              throw stale('The session reset confirmation became stale.');
            try {
              await options.performReset();
            } catch (error) {
              options.onFailure(error);
              throw error;
            }
          } finally {
            options.setReserved(false);
          }
        },
      };
    },
  };
}

/** Starts the single configured gateway owner. */
export async function startGateway(): Promise<void> {
  const logger = createDaemonLogger();
  logger.info({ event: 'startup_started' });
  try {
    await startGatewayOwned(logger);
  } catch (error) {
    logFailure(logger, 'startup_failed', 'gateway');
    throw error;
  }
}

async function startGatewayOwned(logger: ReturnType<typeof createDaemonLogger>): Promise<void> {
  // SQLite configuration is unavailable until after the private layout and lock exist.
  const paths = ensurePrivateLayout();
  const lock = acquireGatewayLock(paths);
  let server: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let slack: Awaited<ReturnType<typeof startSlackGateway>> | undefined;
  let pi: PiRpcSession | undefined;
  let reactionTimer: NodeJS.Timeout | undefined;
  let scheduler: SchedulerService | undefined;
  const coordinator = new GatewayCoordinator();
  const lifecycle = new GatewayLifecycle({
    logger,
    stopAccepting: {
      stop: async () => {
        coordinator.close();
        try {
          await slack?.stop();
        } finally {
          clearSlackClient();
        }
      },
    },
    stopControl: { close: async () => server?.close() },
    stopTimers: {
      stop: () => {
        if (reactionTimer) clearInterval(reactionTimer);
        reactionTimer = undefined;
        scheduler?.stop();
      },
    },
    drainCoordinator: () => coordinator.drain(),
    stopPi: async () => pi?.stop(),
    closeDatabase: closeDb,
    releaseLock: () => lock.release(),
  });
  let signalHandler: (() => void) | undefined;
  try {
    const journal = readResetJournal(paths.journal);
    if (journal && journal.phase !== 'complete') {
      logger.warn({ event: 'reset_journal_refusal' });
      throw new Error(
        'An incomplete reset journal exists; stop here and run plain pi-tag-slack setup to recover it.',
      );
    }
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
    const environment = piEnvironment(bootstrap.extraPath);
    logger.level = String(config.log_level);
    logger.info({ event: 'configuration_loaded' });
    const createPi = () => {
      const rpc = new PiRpcSession({
        binary: String(config.pi_binary),
        environment,
        sessionDir: paths.session,
        cwd: String(config.working_directory),
        onRuntimeFailure: () => logFailure(logger, 'pi_runtime_failure', 'pi'),
        onStderrActivity: ({ bytes, suppressed }) => {
          logger.warn({ event: 'pi_stderr', component: 'pi', bytes, suppressed });
        },
        onUnexpectedExit: () => {
          void coordinator.run(restoreOpenInboxReceiptsAfterSessionLoss).catch(() => undefined);
        },
        desired: () => {
          const current = readGatewayConfig();
          return {
            model: String(current.session_model_override ?? current.default_model),
            thinking: String(current.session_thinking_override ?? current.default_thinking),
          };
        },
      });
      rpc.setSafeBoundaryHandler(
        () => void coordinator.run(() => pi!.applyDesired()).catch(() => undefined),
      );
      return rpc;
    };
    pi = createPi();
    let resetReserved = false;
    const performReset = async () => {
      const old = pi!;
      restoreOpenInboxReceiptsAfterSessionLoss();
      await old.stop();
      const archivePath = archiveActiveSession(paths);
      mkdirSync(paths.session, { mode: 0o700 });
      pi = createPi();
      await pi.start();
      await pi.applyDesired();
      const recovery = startupRecoveryPrompt();
      if (recovery) await pi.notify(recovery);
      return { archivedTo: archivePath, recoverySent: Boolean(recovery) };
    };
    const resetControls = createSessionResetControls({
      current: () => pi!,
      performReset,
      setReserved: (reserved) => {
        resetReserved = reserved;
      },
      onFailure: () => logFailure(logger, 'session_reset_failed', 'pi'),
    });
    const session = {
      notify: (message: string) => {
        if (resetReserved) return Promise.reject(new Error('Session reset is reserved.'));
        return pi!.notify(message);
      },
      status: () => pi!.status(),
      availableModels: () => pi!.availableModels(),
      availableThinkingLevels: () => pi!.availableThinkingLevels(),
      applyDesired: () => pi!.applyDesired(),
      ...resetControls,
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
      logger,
    });
    server = await startControlServer(
      {
        notifier: session,
        coordinator,
        sessionStatus: () => session.status(),
        runtimeStatus: () => {
          const runtimeError = server?.lastError();
          return {
            control: runtimeError ? 'degraded' : 'ok',
            // Keep listener diagnostics visible but sanitized at the control boundary.
            lastError: runtimeError ? 'Control server runtime error.' : null,
          };
        },
        sessionControls: session,
        archivePath: paths.archive,
      },
      {
        onRuntimeError: () => logFailure(logger, 'control_runtime_failure', 'control'),
      },
    );
    // Reconciliation is bounded and best-effort; it never affects Slack admission.
    void reconcileInboxReactions().catch(() => undefined);
    reactionTimer = setInterval(
      () => void reconcileInboxReactions().catch(() => undefined),
      15_000,
    );
    scheduler = new SchedulerService(session, coordinator);
    scheduler.start();
    logger.info({ event: 'gateway_ready' });
    await new Promise<void>((resolve) => {
      signalHandler = () => void lifecycle.shutdown('signal').then(resolve);
      process.on('SIGINT', signalHandler);
      process.on('SIGTERM', signalHandler);
    });
  } finally {
    if (signalHandler) {
      process.off('SIGINT', signalHandler);
      process.off('SIGTERM', signalHandler);
    }
    await lifecycle.shutdown('cleanup');
  }
}
