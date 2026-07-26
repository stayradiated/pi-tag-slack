import { config, validateSlackTokens } from './config.js';
import { logger } from './logger.js';
import { initDb, closeDb, getAllChannels, getTrustedUserCount } from './db.js';
import { startSlack, stopSlack, getBotTag } from './slack/client.js';
import { startArchiveCleanup } from './session/archive-cleanup.js';
import { startMediaCleanup } from './session/media.js';
import { listAvailableModels } from './agent/model-catalog.js';
import { startProcessingLoop, stopProcessingLoop } from './agent/queue.js';
import { startScheduler } from './agent/scheduler.js';

/**
 * pi-tag-slack - Lightweight Slack gateway for pi coding agent.
 *
 * Architecture inspired by NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Slack messages (Socket Mode) -> SQLite queue -> pi subprocess -> Slack response.
 */
export async function startGateway(): Promise<void> {
  const tokenProblems = validateSlackTokens(config);
  if (tokenProblems.length > 0) {
    throw new Error(tokenProblems.join(' '));
  }

  initDb();
  if (getTrustedUserCount() === 0) {
    closeDb();
    throw new Error('No trusted Slack users configured. Run: pi-tag-slack trust add <user-id>');
  }

  let stopArchiveCleanup = () => {};
  let stopMediaCleanup = () => {};
  let stopScheduler = () => {};
  let processingStarted = false;
  let shutdownPromise: Promise<void> | null = null;

  let resolveSignalWait!: () => void;
  const signalWait = new Promise<void>((resolve) => {
    resolveSignalWait = resolve;
  });

  const onSignal = (sig: NodeJS.Signals) => {
    void shutdown(`received ${sig}`).then(resolveSignalWait, resolveSignalWait);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const shutdown = (reason: string) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);

      logger.info({ reason }, 'Shutting down gateway');

      stopScheduler();
      stopArchiveCleanup();
      stopMediaCleanup();

      if (processingStarted) {
        await stopProcessingLoop({ timeoutMs: config.shutdownTimeoutMs });
      }

      stopSlack();
      closeDb();
      logger.info('Gateway stopped');
    })();

    return shutdownPromise;
  };

  try {
    logger.info('Starting pi-tag-slack...');
    warmModelCatalogs();

    await startSlack();
    if (shutdownPromise) {
      // A signal arrived while startSlack was still connecting: shutdown()
      // already ran to completion and its stopSlack() was a no-op (the app
      // reference was not set yet). Undo the now-finished start so the
      // Socket Mode WebSocket does not keep the process alive against a
      // closed database.
      stopSlack();
      await shutdownPromise;
      return;
    }

    startProcessingLoop();
    processingStarted = true;
    stopScheduler = startScheduler();
    stopArchiveCleanup = startArchiveCleanup();
    stopMediaCleanup = startMediaCleanup();

    logger.info(
      {
        bot: getBotTag(),
        trigger: `@${config.triggerName}`,
        concurrency: config.maxConcurrency,
        scheduledConcurrency: config.maxScheduledConcurrency,
        sessionsDir: config.sessionsDir,
      },
      'Gateway running',
    );

    await signalWait;
  } catch (err) {
    await shutdown('startup failure');
    throw err;
  }
}

function warmModelCatalogs(): void {
  const workingDirectories = new Set([
    config.piCwd,
    ...getAllChannels()
      .map((channel) => channel.cwdOverride)
      .filter(Boolean),
  ]);

  for (const cwd of workingDirectories) {
    try {
      const models = listAvailableModels({ forceRefresh: true, cwd });
      logger.info({ cwd, models: models.length }, 'Model catalog warmed');
    } catch (err: any) {
      logger.warn({ cwd, err: err.message }, 'Failed to warm model catalog');
    }
  }
}
