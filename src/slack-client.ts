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

type SlackPage = { items: unknown[]; nextCursor: string | null };

export type SlackUser = { id: string; label: string };

type SlackFailure = Error & { code: 'NOT_FOUND' | 'SLACK_UNAVAILABLE' | 'SLACK_ERROR' };

function slackError(error: unknown): SlackFailure {
  const details = error as { code?: string; message?: string; data?: { error?: string } };
  const reason = details.data?.error ?? details.code;
  const message = details.message ?? `Slack request failed: ${reason ?? 'unknown error'}.`;
  const code: SlackFailure['code'] =
    reason === 'channel_not_found' ||
    reason === 'user_not_found' ||
    reason === 'message_not_found' ||
    reason === 'thread_not_found' ||
    reason === 'not_found'
      ? 'NOT_FOUND'
      : /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)$/.test(String(reason))
        ? 'SLACK_UNAVAILABLE'
        : 'SLACK_ERROR';
  return Object.assign(new Error(message), { code });
}

async function slackCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if ((error as { code?: string }).code === 'SLACK_UNAVAILABLE') throw error;
    throw slackError(error);
  }
}

function cursor(response: { response_metadata?: { next_cursor?: string } }): string | null {
  return response.response_metadata?.next_cursor || null;
}

/** Validates a Slack user and derives the non-authoritative cosmetic display label. */
export async function slackUser(userId: string): Promise<SlackUser> {
  const runtime = requireClient();
  const response = await slackCall(() => runtime.client.users.info({ user: userId }));
  if (!response.ok || !response.user) {
    throw slackError(Object.assign(new Error(`Slack user ${userId} was not found.`), response));
  }
  const user = response.user as unknown as Record<string, unknown>;
  const profile = user.profile as Record<string, unknown> | undefined;
  const label = [profile?.display_name, profile?.real_name, user.real_name, user.name, userId].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )!;
  return { id: userId, label: label.trim() };
}

/** Fetches only live messages in the configured conversation. */
export async function slackHistory(limit: number, nextCursor?: string): Promise<SlackPage> {
  const runtime = requireClient();
  const response = await slackCall(() =>
    runtime.client.conversations.history({
      channel: runtime.channelId,
      limit,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    }),
  );
  if (!response.ok)
    throw slackError(Object.assign(new Error('Slack history request failed.'), response));
  return { items: response.messages ?? [], nextCursor: cursor(response) };
}

/** Looks up an exact timestamp without ever searching another conversation. */
export async function slackMessage(messageTs: string): Promise<unknown> {
  const runtime = requireClient();
  const response = await slackCall(() =>
    runtime.client.conversations.history({
      channel: runtime.channelId,
      oldest: messageTs,
      latest: messageTs,
      inclusive: true,
      limit: 1,
    }),
  );
  if (!response.ok)
    throw slackError(Object.assign(new Error('Slack message lookup failed.'), response));
  const message = response.messages?.find((item) => item.ts === messageTs);
  if (!message) {
    throw Object.assign(new Error(`Slack message ${messageTs} was not found.`), {
      code: 'NOT_FOUND',
    });
  }
  return message;
}

/** Fetches one configured-conversation thread with Slack's cursor unchanged. */
export async function slackThread(
  threadTs: string,
  limit: number,
  nextCursor?: string,
): Promise<SlackPage> {
  const runtime = requireClient();
  const response = await slackCall(() =>
    runtime.client.conversations.replies({
      channel: runtime.channelId,
      ts: threadTs,
      limit,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    }),
  );
  if (!response.ok)
    throw slackError(Object.assign(new Error('Slack thread request failed.'), response));
  return { items: response.messages ?? [], nextCursor: cursor(response) };
}

/** Sends a message (or thread reply) without modifying any inbox/task state. */
export async function sendSlackMessage(text: string, threadTs?: string): Promise<{ ts: string }> {
  const runtime = requireClient();
  const result = await slackCall(() =>
    runtime.client.chat.postMessage({
      channel: runtime.channelId,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  );
  if (!result.ok || !result.ts)
    throw slackError(Object.assign(new Error('Slack send failed.'), result));
  return { ts: result.ts };
}

export async function replyToInbox(threadTs: string, text: string): Promise<string> {
  return (await sendSlackMessage(text, threadTs)).ts;
}
