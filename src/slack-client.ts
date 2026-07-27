import { WebClient } from '@slack/web-api';
import { inboxReactionsDue, recordInboxReaction } from './db.js';

let client: WebClient | undefined;
let channelId: string | undefined;

/** Runtime-only Slack operations. Control commands never construct a second client. */
export function configureSlackClient(next: WebClient, configuredChannelId: string): void {
  client = next;
  channelId = configuredChannelId;
}
export function clearSlackClient(): void {
  client = undefined;
  channelId = undefined;
}
function requireClient(): { client: WebClient; channelId: string } {
  if (!client || !channelId) {
    const error = new Error('Slack gateway is unavailable.') as Error & { code: string };
    error.code = 'SLACK_UNAVAILABLE';
    throw error;
  }
  return { client, channelId };
}
let reconciliationQueued = false;
const reactionAttempts = new Map<number, number>();

/** Reconciles only gateway-owned reactions; Slack removes only the caller's own reaction. */
export async function reconcileInboxReactions(limit = 50): Promise<void> {
  const runtime = requireClient();
  for (const inbox of inboxReactionsDue(limit)) {
    const id = Number(inbox.id);
    const desired = inbox.reaction_desired as string | null;
    const actual = inbox.reaction_actual as string | null;
    try {
      if (actual) {
        await runtime.client.reactions.remove({
          channel: String(inbox.slack_message_id).split(':', 1)[0],
          timestamp: String(inbox.message_ts),
          name: actual,
        });
      }
      if (desired) {
        await runtime.client.reactions.add({
          channel: String(inbox.slack_message_id).split(':', 1)[0],
          timestamp: String(inbox.message_ts),
          name: desired,
        });
      }
      reactionAttempts.delete(id);
      recordInboxReaction(id, { actual: desired, error: null, nextAttemptAt: null });
    } catch (error) {
      // A deleted Slack source has no reaction state left to reconcile.
      if ((error as { data?: { error?: string } }).data?.error === 'message_not_found') {
        recordInboxReaction(id, { desired: null, actual: null, error: null, nextAttemptAt: null });
        continue;
      }
      const attempts = (reactionAttempts.get(id) ?? 0) + 1;
      reactionAttempts.set(id, attempts);
      const delayMs = Math.min(60_000, 1_000 * 2 ** attempts);
      recordInboxReaction(id, {
        error: (error as Error).message,
        nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
      });
    }
  }
}

/** Coalesces post-transition reconciliation without blocking a control response. */
export function scheduleReactionReconciliation(): void {
  if (reconciliationQueued || !client) return;
  reconciliationQueued = true;
  queueMicrotask(() => {
    reconciliationQueued = false;
    void reconcileInboxReactions().catch(() => undefined);
  });
}

export async function replyToInbox(threadTs: string, text: string): Promise<string> {
  const runtime = requireClient();
  const result = await runtime.client.chat.postMessage({
    channel: runtime.channelId,
    thread_ts: threadTs,
    text,
  });
  if (!result.ok || !result.ts)
    throw new Error(`Slack reply failed: ${result.error ?? 'unknown error'}.`);
  return result.ts;
}
