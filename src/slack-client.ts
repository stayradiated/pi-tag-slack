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
import { basename, join } from 'node:path';
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
let reconciliationRunning: Promise<void> | undefined;
const reactionAttempts = new Map<number, number>();

function slackReactionError(error: unknown): string | undefined {
  return (error as { data?: { error?: string } }).data?.error;
}

function reactionFailure(id: number, error: unknown): void {
  const attempts = (reactionAttempts.get(id) ?? 0) + 1;
  reactionAttempts.set(id, attempts);
  const delayMs = Math.min(60_000, 1_000 * 2 ** attempts);
  recordInboxReaction(id, {
    error: error instanceof Error ? error.message : String(error),
    nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
  });
}

function reactionSourceGone(id: number): void {
  reactionAttempts.delete(id);
  recordInboxReaction(id, { desired: null, actual: null, error: null, nextAttemptAt: null });
}

async function runReactionReconciliation(limit: number): Promise<void> {
  const runtime = requireClient();
  for (const inbox of inboxReactionsDue(limit)) {
    const id = Number(inbox.id);
    const desired = inbox.reaction_desired as string | null;
    let actual = inbox.reaction_actual as string | null;
    const target = {
      channel: String(inbox.slack_message_id).split(':', 1)[0],
      timestamp: String(inbox.message_ts),
    };

    // Persist a confirmed removal before attempting the independent addition.
    // Slack's no_reaction means the same desired absence and is therefore success.
    if (actual) {
      try {
        await runtime.client.reactions.remove({ ...target, name: actual });
      } catch (error) {
        const code = slackReactionError(error);
        if (code === 'message_not_found') {
          reactionSourceGone(id);
          continue;
        }
        if (code !== 'no_reaction') {
          reactionFailure(id, error);
          continue;
        }
      }
      actual = null;
      recordInboxReaction(id, { actual: null, error: null, nextAttemptAt: null });
    }

    if (desired) {
      try {
        await runtime.client.reactions.add({ ...target, name: desired });
      } catch (error) {
        const code = slackReactionError(error);
        if (code === 'message_not_found') {
          reactionSourceGone(id);
          continue;
        }
        // The add may have committed at Slack before a lost response or local
        // crash. already_reacted confirms the gateway's own desired presence.
        if (code !== 'already_reacted') {
          reactionFailure(id, error);
          continue;
        }
      }
      actual = desired;
    }

    reactionAttempts.delete(id);
    recordInboxReaction(id, { actual, error: null, nextAttemptAt: null });
  }
}

/** Reconciles only gateway-owned reactions; Slack removes only the caller's own reaction. */
export function reconcileInboxReactions(limit = 50): Promise<void> {
  if (reconciliationRunning) return reconciliationRunning;
  const operation = runReactionReconciliation(limit);
  reconciliationRunning = operation;
  return operation.finally(() => {
    if (reconciliationRunning === operation) reconciliationRunning = undefined;
  });
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

/** Leaves framing/error-envelope headroom beneath the 1 MiB control limit. */
export const SLACK_RESPONSE_BUDGET_BYTES = 900 * 1024;

function budgetSlackResult<T>(value: T): T {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw Object.assign(new Error('Slack response could not be encoded safely.'), {
      code: 'SLACK_ERROR',
    });
  }
  if (bytes > SLACK_RESPONSE_BUDGET_BYTES)
    throw Object.assign(new Error('Slack response exceeds the control response budget.'), {
      code: 'RESPONSE_TOO_LARGE',
    });
  return value;
}

export type SlackUser = { id: string; label: string };

type SlackFailure = Error & { code: 'NOT_FOUND' | 'SLACK_UNAVAILABLE' | 'SLACK_ERROR' };

function slackError(error: unknown): SlackFailure {
  const details = error as { code?: string; message?: string; data?: { error?: string } };
  const reason = details.data?.error ?? details.code;
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
  const message =
    code === 'NOT_FOUND'
      ? 'The requested Slack resource was not found.'
      : code === 'SLACK_UNAVAILABLE'
        ? 'Slack is currently unavailable.'
        : 'Slack request failed.';
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
  return budgetSlackResult({ items: response.messages ?? [], nextCursor: cursor(response) });
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
  return budgetSlackResult(message);
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
  return budgetSlackResult({ items: response.messages ?? [], nextCursor: cursor(response) });
}

type UploadFile = { path: string; dev: number; ino: number; size: number; mtimeMs: number };

function uploadError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function inspectUploadFile(path: string): UploadFile {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw uploadError('INVALID_FILE', `Upload file does not exist: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    throw uploadError('INVALID_FILE', `Upload path must be a regular non-symlink file: ${path}`);
  return { path, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Validates local upload paths before any Slack operation is started. */
export function validateUploadFiles(paths: string[]): UploadFile[] {
  const config = readGatewayConfig();
  const perFileLimit = Number(config.max_attachment_bytes);
  const totalLimit = Number(config.max_total_attachment_bytes);
  let total = 0;
  const files = paths.map((path) => {
    if (typeof path !== 'string' || !path)
      throw uploadError('INVALID_FILE', 'Upload path must be non-empty.');
    const file = inspectUploadFile(path);
    if (exceeds(perFileLimit, file.size))
      throw uploadError(
        'FILE_TOO_LARGE',
        `Upload file exceeds the configured per-file media limit: ${path}`,
      );
    total += file.size;
    return file;
  });
  if (exceeds(totalLimit, total))
    throw uploadError(
      'MEDIA_LIMIT_EXCEEDED',
      'Upload files exceed the configured total media limit.',
    );
  return files;
}

/** Re-checks identity and size at the last point before Slack opens the paths. */
function revalidateUploadFiles(files: UploadFile[]): void {
  for (const file of files) {
    const current = inspectUploadFile(file.path);
    if (
      current.dev !== file.dev ||
      current.ino !== file.ino ||
      current.size !== file.size ||
      current.mtimeMs !== file.mtimeMs
    )
      throw uploadError('FILE_CHANGED', `Upload file changed before upload: ${file.path}`);
  }
}

type UploadResult = { timestamp?: string; fileIds?: string[] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function slackTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+\.\d+$/.test(value) ? value : undefined;
}

function fileShareTimestamps(
  file: Record<string, unknown>,
  channel: string,
  threadTs?: string,
): string[] {
  const timestamps: string[] = [];
  const shares = record(file.shares);
  if (!shares) return timestamps;
  for (const visibility of Object.values(shares)) {
    const entries = record(visibility)?.[channel];
    if (!Array.isArray(entries)) continue;
    for (const entryValue of entries) {
      const entry = record(entryValue);
      const ts = slackTimestamp(entry?.ts);
      if (!entry || !ts) continue;
      const entryThread = slackTimestamp(entry.thread_ts);
      if (threadTs ? entryThread === threadTs : entryThread === undefined) timestamps.push(ts);
    }
  }
  return timestamps;
}

/**
 * Models both uploadV2's v8 wrapper (`files` is an array of
 * files.completeUploadExternal responses) and the older flat file-array shape.
 * A direct `ts` is retained for compatibility with Web API mocks/older wrappers.
 */
function parseUploadResult(
  value: unknown,
  channel: string,
  threadTs: string | undefined,
  expectedFiles: number,
): UploadResult | undefined {
  const result = record(value);
  if (!result || result.ok !== true) return undefined;
  const directTimestamp = slackTimestamp(result.ts);
  if (directTimestamp) return { timestamp: directTimestamp };
  if (!Array.isArray(result.files) || result.files.length === 0) return {};

  const outer = result.files.map(record);
  if (outer.some((item) => !item)) return {};
  const nested = outer.some((item) => Object.hasOwn(item!, 'files') || Object.hasOwn(item!, 'ok'));
  let files: Record<string, unknown>[];
  if (nested) {
    if (
      outer.some(
        (completion) =>
          completion!.ok !== true ||
          !Array.isArray(completion!.files) ||
          completion!.files.length === 0,
      )
    )
      return {};
    files = outer.flatMap((completion) =>
      (completion!.files as unknown[]).map(record).filter((file) => file !== undefined),
    );
    if (
      files.length !==
      outer.reduce((total, completion) => total + (completion!.files as unknown[]).length, 0)
    )
      return {};
  } else {
    files = outer as Record<string, unknown>[];
  }
  if (files.length !== expectedFiles) return {};

  const timestamps = new Set<string>();
  const fileIds = new Set<string>();
  for (const file of files) {
    // Some older flat responses used a string timestamp on the file itself.
    const legacyTimestamp = slackTimestamp(file.timestamp);
    if (legacyTimestamp) timestamps.add(legacyTimestamp);
    for (const ts of fileShareTimestamps(file, channel, threadTs)) timestamps.add(ts);
    if (typeof file.id === 'string' && file.id) fileIds.add(file.id);
  }
  if (timestamps.size === 1) return { timestamp: [...timestamps][0] };
  if (timestamps.size > 1) return {};
  return fileIds.size === expectedFiles ? { fileIds: [...fileIds] } : {};
}

function messageHasExactlyFiles(message: Record<string, unknown>, fileIds: Set<string>): boolean {
  if (!Array.isArray(message.files)) return false;
  const ids = message.files.map((file) => record(file)?.id);
  return (
    ids.length === fileIds.size &&
    new Set(ids).size === fileIds.size &&
    ids.every((id): id is string => typeof id === 'string' && fileIds.has(id))
  );
}

/** A bounded fallback can identify only the message containing the exact new file-ID set. */
async function lookupUploadTimestamp(
  runtime: { client: WebClient; channelId: string },
  fileIds: string[],
  threadTs?: string,
): Promise<string | undefined> {
  try {
    const response = threadTs
      ? await runtime.client.conversations.replies({
          channel: runtime.channelId,
          ts: threadTs,
          limit: 100,
        })
      : await runtime.client.conversations.history({ channel: runtime.channelId, limit: 100 });
    if (!response.ok || !Array.isArray(response.messages)) return undefined;
    const expected = new Set(fileIds);
    const matches = response.messages.filter((message) => {
      const item = record(message);
      return item && slackTimestamp(item.ts) && messageHasExactlyFiles(item, expected);
    });
    return matches.length === 1 ? slackTimestamp(matches[0]?.ts) : undefined;
  } catch {
    // Completion has already succeeded. A failed diagnostic lookup must not be
    // presented as a definite upload failure or leak its transport details.
    return undefined;
  }
}

function uncertainUpload(): Error & { code: string } {
  return uploadError(
    'OUTCOME_UNKNOWN',
    'Slack may have completed the upload; inspect the conversation before retrying.',
  );
}

/** Sends text and, when supplied, one Slack V2 multi-file message. */
export async function sendSlackMessage(
  text: string,
  threadTs?: string,
  paths: string[] = [],
): Promise<{ ts: string }> {
  const runtime = requireClient();
  const files = validateUploadFiles(paths);
  if (files.length === 0) {
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
  revalidateUploadFiles(files);
  let result: unknown;
  try {
    result = await runtime.client.files.uploadV2({
      channel_id: runtime.channelId,
      initial_comment: text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      file_uploads: files.map((file) => ({ file: file.path, filename: basename(file.path) })),
    });
  } catch (error) {
    const details = error as { data?: { error?: unknown } };
    // uploadV2 has already started its multi-step mutation. Only an explicit
    // Slack API rejection is definite; transport/library failures are ambiguous.
    if (typeof details.data?.error !== 'string') throw uncertainUpload();
    throw slackError(error);
  }
  const parsed = parseUploadResult(result, runtime.channelId, threadTs, files.length);
  if (!parsed) throw slackError(result);
  const ts =
    parsed.timestamp ??
    (parsed.fileIds ? await lookupUploadTimestamp(runtime, parsed.fileIds, threadTs) : undefined);
  if (!ts) throw uncertainUpload();
  return { ts };
}

export async function replyToInbox(
  threadTs: string,
  text: string,
  paths: string[] = [],
): Promise<string> {
  return (await sendSlackMessage(text, threadTs, paths)).ts;
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
