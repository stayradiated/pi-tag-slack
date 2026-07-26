/**
 * Message processing loop.
 *
 * Polls SQLite for pending messages, dispatches to pi agent, sends response
 * back to Slack. Enforces per-channel serial processing and global
 * concurrency limit.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  channelsWithPending,
  claimNextMessage,
  clearPendingMessages,
  markMessageDone,
  markMessageFailed,
  recoverQueueForStartup,
  logMessage,
  getChannel,
  isAuthorizedQueueSender,
} from '../db.js';
import type { QueuedMessage } from '../types.js';
import { invokeAgent } from './invoke.js';
import { sendResponse, setBusy } from '../slack/client.js';
import { computeEffectiveChannelSettings } from './channel-settings.js';

/** Channels currently being processed (per-channel serial lock) */
const activeChannels = new Set<string>();
const activeTaskPromises = new Set<Promise<void>>();
const activeTaskControllers = new Map<number, AbortController>();
const activeChannelControllers = new Map<string, AbortController>();

let running = false;
let pollTimer: NodeJS.Timeout | undefined;
let stopPromise: Promise<void> | null = null;

export function isChannelProcessing(jid: string): boolean {
  return activeChannels.has(jid);
}

export function abortChannelTask(jid: string): { aborted: boolean; cleared: number } {
  const controller = activeChannelControllers.get(jid);
  const aborted = Boolean(controller);
  if (controller) {
    controller.abort();
  }
  const cleared = clearPendingMessages(jid);
  return { aborted, cleared };
}

export function startProcessingLoop(): void {
  if (running) return;

  running = true;
  stopPromise = null;

  const recovery = recoverQueueForStartup();
  if (recovery.recoveredProcessing > 0 || recovery.rejectedUnauthorized > 0) {
    logger.info(recovery, 'Recovered queue for startup');
  }

  schedulePoll(0);
}

export function stopProcessingLoop(opts: { timeoutMs?: number } = {}): Promise<void> {
  if (stopPromise) {
    return stopPromise;
  }

  running = false;
  clearPollTimer();

  stopPromise = drainActiveTasks(opts.timeoutMs ?? config.shutdownTimeoutMs);
  return stopPromise;
}

function schedulePoll(delayMs = config.pollInterval): void {
  if (!running || pollTimer) return;

  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    poll();
  }, delayMs);
}

function clearPollTimer(): void {
  if (!pollTimer) return;
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

function poll(): void {
  if (!running) return;

  try {
    dispatch();
  } catch (err: any) {
    logger.error({ err: err.message }, 'Poll error');
  } finally {
    schedulePoll();
  }
}

function dispatch(): void {
  if (activeTaskPromises.size >= config.maxConcurrency) return;

  for (const jid of channelsWithPending()) {
    if (activeChannels.has(jid)) continue;
    if (activeTaskPromises.size >= config.maxConcurrency) break;

    const msg = claimNextMessage(jid);
    if (!msg) continue;

    const controller = new AbortController();
    activeChannels.add(jid);
    activeTaskControllers.set(msg.rowid, controller);
    activeChannelControllers.set(jid, controller);

    // The promise is stored, not awaited, so it must never be left without a
    // rejection handler: an unhandled rejection would crash the whole gateway.
    const taskPromise = executeClaimedMessage(jid, msg, controller.signal)
      .catch((err: any) => {
        logger.error({ jid, rowid: msg.rowid, err: err?.message }, 'processMessage rejected');
      })
      .finally(() => {
        activeChannels.delete(jid);
        activeTaskControllers.delete(msg.rowid);
        activeChannelControllers.delete(jid);
        activeTaskPromises.delete(taskPromise);

        if (running) {
          schedulePoll(0);
        }
      });

    activeTaskPromises.add(taskPromise);
  }
}

/**
 * How long the drain waits for aborted tasks to settle. Must comfortably
 * exceed invokeAgent's SIGTERM→SIGKILL escalation (5s, see invoke.ts) plus
 * process-reaping margin, so a pi process that ignores SIGTERM is killed and
 * its task settles BEFORE shutdown proceeds to stopSlack()/closeDb().
 */
const POST_ABORT_DRAIN_MS = 8_000;

async function drainActiveTasks(timeoutMs: number): Promise<void> {
  if (activeTaskPromises.size === 0) {
    return;
  }

  const initialDrain = Promise.allSettled([...activeTaskPromises]);
  const drainedGracefully = await waitForPromise(initialDrain, timeoutMs);
  if (drainedGracefully) {
    return;
  }

  logger.warn(
    { timeoutMs, activeTasks: activeTaskPromises.size },
    'Shutdown timeout reached; aborting in-flight message processing',
  );

  for (const controller of activeTaskControllers.values()) {
    controller.abort();
  }

  if (activeTaskPromises.size > 0) {
    await Promise.race([
      Promise.allSettled([...activeTaskPromises]),
      new Promise<void>((resolve) => setTimeout(resolve, POST_ABORT_DRAIN_MS)),
    ]);
  }
}

async function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) {
    return false;
  }

  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  return activeTaskPromises.size === 0;
}

export interface QueueExecutionDeps {
  isAuthorizedQueueSender: typeof isAuthorizedQueueSender;
  markMessageFailed: typeof markMessageFailed;
  markMessageDone: typeof markMessageDone;
  getChannel: typeof getChannel;
  logMessage: typeof logMessage;
  setBusy: typeof setBusy;
  invokeAgent: typeof invokeAgent;
  sendResponse: typeof sendResponse;
}

const queueExecutionDeps: QueueExecutionDeps = {
  isAuthorizedQueueSender,
  markMessageFailed,
  markMessageDone,
  getChannel,
  logMessage,
  setBusy,
  invokeAgent,
  sendResponse,
};

/** Execute one already-claimed row. Kept injectable for trust-boundary tests. */
export async function executeClaimedMessage(
  jid: string,
  msg: QueuedMessage,
  signal: AbortSignal,
  overrides: Partial<QueueExecutionDeps> = {},
): Promise<void> {
  const deps = { ...queueExecutionDeps, ...overrides };
  const { rowid, sender_name: senderName, content } = msg;

  // Revalidate after claiming, before logs, reactions, pi, or Slack I/O.
  if (!deps.isAuthorizedQueueSender(msg.sender)) {
    deps.markMessageFailed(rowid);
    logger.debug({ rowid, jid, sender: msg.sender }, 'Rejected unauthorized queued message');
    return;
  }

  const channel = deps.getChannel(jid);
  if (!channel) {
    logger.warn({ jid }, 'Channel disappeared during processing');
    deps.markMessageFailed(rowid);
    return;
  }

  logger.info({ jid, senderName, len: content.length }, 'Processing message');

  // Slack has no bot typing indicator; flag the triggering message with a busy
  // reaction instead. No-op when the message has no ts (e.g. scheduler runs).
  const busyCtx = { ts: msg.event_ts ?? undefined };
  await deps.setBusy(jid, true, busyCtx);

  // User-triggered responses always belong to the inbound message's root.
  // Scheduled tasks have neither timestamp and therefore remain top-level.
  const responseThreadTs = msg.thread_ts ?? msg.event_ts ?? undefined;
  const replyCtx = { threadTs: responseThreadTs };

  try {
    const fileSendCommand = `pi-tag-slack send --channel ${jid}${responseThreadTs ? ` --thread ${responseThreadTs}` : ''} --file <absolute-path>`;
    const prompt =
      `[Slack user: ${senderName}]\n` +
      `[To share a file with the user, run: ${fileSendCommand} ` +
      `(repeat --file for multiple). Do not paste file:// links — they are dead for Slack users.]\n` +
      content;

    deps.logMessage(jid, 'user', content);

    const effective = computeEffectiveChannelSettings(channel);

    const result = await deps.invokeAgent(channel.folder, prompt, {
      model: effective.rawModelRef || undefined,
      thinking: effective.hasManagedThinking ? effective.effectiveThinking : undefined,
      cwd: effective.effectiveCwd,
      signal,
      attachments: msg.attachments,
    });

    if (signal.aborted) {
      safeMarkMessageFailed(jid, rowid);
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

    if (result.ok) {
      const sent = await deps.sendResponse(jid, result.text, replyCtx);
      if (!sent) {
        deps.markMessageFailed(rowid);
        logger.warn({ jid }, 'Agent response generated but could not be delivered to Slack');
        return;
      }

      deps.logMessage(jid, 'assistant', result.text);
      deps.markMessageDone(rowid);
      logger.info({ jid, responseLen: result.text.length }, 'Message processed');
      return;
    }

    const errMsg = `⚠️ Agent error: ${result.error?.slice(0, 300) || 'unknown error'}`;
    await deps.sendResponse(jid, errMsg, replyCtx);
    deps.markMessageFailed(rowid);
    logger.warn({ jid, error: result.error }, 'Agent returned error');
  } catch (err: any) {
    if (signal.aborted) {
      safeMarkMessageFailed(jid, rowid);
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

    logger.error({ jid, err: err.message }, 'processMessage failed');
    safeMarkMessageFailed(jid, rowid);
    try {
      await deps.sendResponse(jid, `⚠️ Internal error: ${err.message?.slice(0, 200)}`, replyCtx);
    } catch {
      // Nothing else to do here.
    }
  } finally {
    await deps.setBusy(jid, false, busyCtx);
  }
}

/**
 * Mark a message failed, tolerating a database that shutdown already closed
 * (a task aborted mid-shutdown can outlive closeDb). The row then stays in
 * 'processing' and recoverStuckMessages resets it to pending on next start.
 */
function safeMarkMessageFailed(jid: string, rowid: number): void {
  try {
    markMessageFailed(rowid);
  } catch (err: any) {
    logger.warn({ jid, rowid, err: err.message }, 'Failed to mark message as failed');
  }
}
