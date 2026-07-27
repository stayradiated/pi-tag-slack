import { WebClient } from '@slack/web-api';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { inboxReactionsDue, readGatewayConfig, recordInboxReaction } from './db.js';
import { ensurePrivateLayout, gatewayPaths } from './paths.js';

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

type SlackFile = {
  id?: unknown;
  name?: unknown;
  size?: unknown;
  mimetype?: unknown;
  deleted?: unknown;
  channels?: unknown;
  groups?: unknown;
  shares?: unknown;
  url_private_download?: unknown;
  url_private?: unknown;
};

function fileError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Produces one safe leaf name; the file ID is kept separately in the destination. */
export function sanitizeSlackFilename(value: unknown): string {
  const input = typeof value === 'string' ? value : '';
  // Do not use basename alone: Windows separators and control characters are
  // meaningful on other hosts and make diagnostics/logs unsafe.
  let name = input
    // eslint-disable-next-line no-control-regex -- filenames must not retain terminal/control bytes.
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+$/, '')
    .replace(/^\.+(?=_)/, '')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') name = 'file';
  // Keep paths and control frames bounded even when Slack accepts an enormous name.
  return name.slice(0, 180);
}

function fileSharedInConversation(file: SlackFile, configuredChannel: string): boolean {
  if (
    [file.channels, file.groups].some(
      (ids) => Array.isArray(ids) && ids.includes(configuredChannel),
    )
  )
    return true;
  if (!file.shares || typeof file.shares !== 'object') return false;
  for (const visibility of Object.values(file.shares as Record<string, unknown>)) {
    if (visibility && typeof visibility === 'object' && configuredChannel in visibility)
      return true;
  }
  return false;
}

function existingMediaBytes(media: string): number {
  let total = 0;
  for (const entry of readdirSync(media, { withFileTypes: true })) {
    const path = join(media, entry.name);
    // A symlink is never safe to count, replace, or leave in a media store.
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw fileError('UNSAFE_MEDIA_PATH', `Media entry is a symlink: ${path}`);
    if (!stat.isFile())
      throw fileError('UNSAFE_MEDIA_PATH', `Media entry is not a regular file: ${path}`);
    total += stat.size;
  }
  return total;
}

function exceeds(limit: number, value: number): boolean {
  return limit !== 0 && value > limit;
}

/**
 * Fetches a Slack file only after its live metadata proves it is shared in the
 * configured conversation. File content is written directly to private disk;
 * it never enters the control-socket response.
 */
export async function downloadSlackFile(fileId: string): Promise<{
  fileId: string;
  localPath: string;
  name: string;
  size: number;
  mediaType: string;
}> {
  const runtime = requireClient();
  const response = await slackCall(() => runtime.client.files.info({ file: fileId }));
  const file = response.file as SlackFile | undefined;
  if (!response.ok || !file || file.deleted || file.id !== fileId)
    throw fileError('NOT_FOUND', `Slack file ${fileId} was not found.`);
  if (!fileSharedInConversation(file, runtime.channelId))
    throw fileError(
      'NOT_FOUND',
      `Slack file ${fileId} is not shared in the configured conversation.`,
    );

  const metadataSize =
    typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0
      ? file.size
      : undefined;
  const config = readGatewayConfig();
  const perFileLimit = Number(config.max_attachment_bytes);
  const totalLimit = Number(config.max_total_attachment_bytes);
  if (metadataSize !== undefined && exceeds(perFileLimit, metadataSize))
    throw fileError(
      'FILE_TOO_LARGE',
      `Slack file ${fileId} exceeds the configured per-file media limit.`,
    );

  const paths = ensurePrivateLayout(gatewayPaths());
  const usedBytes = existingMediaBytes(paths.media);
  if (metadataSize !== undefined && exceeds(totalLimit, usedBytes + metadataSize))
    throw fileError(
      'MEDIA_LIMIT_EXCEEDED',
      `Slack file ${fileId} exceeds the configured total media limit.`,
    );

  const name = sanitizeSlackFilename(file.name);
  const destination = join(paths.media, `${fileId}-${name}`);
  // The safe filename is a leaf, but retain this invariant if the sanitizer changes.
  if (!destination.startsWith(`${paths.media}/`))
    throw fileError('UNSAFE_MEDIA_PATH', 'Sanitized Slack filename escaped the media directory.');
  const staging = join(paths.media, `.${fileId}-${crypto.randomUUID()}.part`);
  let fd: number | undefined;
  try {
    // Exclusive staging and destination creation mean a retry never overwrites
    // an earlier download, even if Slack supplies the same name.
    fd = openSync(staging, 'wx', 0o600);
    const url =
      typeof file.url_private_download === 'string' ? file.url_private_download : file.url_private;
    if (typeof url !== 'string' || !url)
      throw fileError('NOT_FOUND', `Slack file ${fileId} is unavailable for download.`);
    let download: Response;
    try {
      download = await fetch(url, {
        headers: runtime.client.token ? { Authorization: `Bearer ${runtime.client.token}` } : {},
      });
    } catch (error) {
      throw slackError(error);
    }
    if (!download.ok) {
      const code =
        download.status === 404 || download.status === 410
          ? 'NOT_FOUND'
          : download.status >= 500
            ? 'SLACK_UNAVAILABLE'
            : 'SLACK_ERROR';
      throw fileError(code, `Slack file ${fileId} download failed (${download.status}).`);
    }
    if (!download.body)
      throw fileError('SLACK_ERROR', `Slack file ${fileId} returned no download stream.`);

    let size = 0;
    const reader = download.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      // This deliberately ignores both metadata and Content-Length.
      if (exceeds(perFileLimit, size))
        throw fileError(
          'FILE_TOO_LARGE',
          `Slack file ${fileId} exceeds the configured per-file media limit.`,
        );
      if (exceeds(totalLimit, usedBytes + size))
        throw fileError(
          'MEDIA_LIMIT_EXCEEDED',
          `Slack file ${fileId} exceeds the configured total media limit.`,
        );
      writeSync(fd, chunk.value);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      // hard-link creation is atomic and fails with EEXIST: unlike rename(),
      // it can never replace a racing existing destination.
      linkSync(staging, destination);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw fileError('FILE_EXISTS', `Media destination already exists: ${destination}`);
      throw error;
    }
    unlinkSync(staging);
    return {
      fileId,
      localPath: destination,
      name,
      size,
      mediaType:
        typeof file.mimetype === 'string' && file.mimetype
          ? file.mimetype
          : 'application/octet-stream',
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Includes stream, metadata, collision, and rename failures.
    rmSync(staging, { force: true });
  }
}
