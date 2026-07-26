/**
 * Slack channel adapter.
 *
 * Architecture borrowed from NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Handles all Slack I/O over Socket Mode: receiving messages, sending
 * responses, busy reactions. Contains zero business logic — that lives in
 * the pi agent.
 */

import { App, LogLevel, type SlackEventMiddlewareArgs } from '@slack/bolt';
import { type AttachmentMeta, type RegisteredChannel } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  createDmChannel,
  getChannel,
  registerChannel as dbRegisterChannel,
  enqueueMessage,
  isTrustedUser,
} from '../db.js';
import {
  buildAttachmentOnlyPrompt,
  selectAttachmentsWithinLimits,
} from '../platform/attachments.js';
import { registerCommands } from './commands.js';
import {
  buildTriggerPattern,
  containsBotMention,
  resolveInboundContent,
  splitMessage,
  SLACK_MAX_MESSAGE_LENGTH,
} from './text.js';

/** Inbound message event shape as delivered by Bolt's message listener. */
type InboundMessageEvent = SlackEventMiddlewareArgs<'message'>['message'];

let app: App | null = null;
let triggerPattern: RegExp;
let botUserId: string;
let botTag: string | undefined;
let teamName: string | undefined;

/** userId → display name, populated lazily via users.info */
const USER_NAME_TTL_MS = 10 * 60 * 1000;
/** Short re-arm after a failed lookup so an outage isn't a users.info call per message. */
const USER_NAME_FAILURE_TTL_MS = 60 * 1000;
const userNameCache = new Map<string, { name: string; expiresAt: number }>();

export async function startSlack(): Promise<void> {
  const boltApp = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    // Keep Bolt's console logger out of pino's way unless we are debugging.
    logLevel:
      config.logLevel === 'debug' || config.logLevel === 'trace' ? LogLevel.DEBUG : LogLevel.WARN,
  });

  boltApp.error(async (err) => {
    logger.error({ err: err.message }, 'Slack client error');
  });

  boltApp.message(async ({ message }) => {
    try {
      await handleMessage(message);
    } catch (err: any) {
      logger.error({ err: err.message, ts: message.ts }, 'Message handler failed');
    }
  });
  registerCommands(boltApp);

  // auth.test gives us our own identity: needed for loop prevention (never
  // react to our own messages) and for mention → trigger normalization.
  const auth = await boltApp.client.auth.test();
  botUserId = auth.user_id ?? '';
  teamName = auth.team;
  botTag = `${auth.user ?? 'unknown'} (${auth.user_id ?? '?'}, ${auth.team ?? '?'})`;
  triggerPattern = buildTriggerPattern(config.triggerName);

  app = boltApp;
  try {
    await boltApp.start();
  } catch (err) {
    app = null;
    throw err;
  }

  logger.info({ tag: botTag, id: botUserId }, 'Slack bot connected');
}

async function handleMessage(event: InboundMessageEvent): Promise<void> {
  // Loop prevention: ignore anything authored by a bot (including ourselves
  // and cross-bot loops), and only process plain user messages, file shares
  // and thread replies broadcast to the channel. Edits, deletions, joins,
  // etc. arrive as other subtypes and are dropped.
  if ('bot_id' in event && event.bot_id) return;
  if (event.subtype === 'bot_message') return;
  if (
    event.subtype !== undefined &&
    event.subtype !== 'file_share' &&
    event.subtype !== 'thread_broadcast'
  ) {
    return;
  }
  if (!event.user || event.user === botUserId) return;
  if (!isTrustedUser(event.user)) {
    logger.debug({ userId: event.user }, 'Ignored message from untrusted Slack user');
    return;
  }

  const isDM = event.channel_type === 'im';
  const channelId = event.channel;
  const jid = `sl:${channelId}`;

  if (isDM && config.dmPolicy === 'disabled') {
    logger.debug({ jid }, 'DM policy is disabled, ignoring');
    return;
  }

  // ── Build content ──
  // Translate a real <@bot> mention → trigger format, then undo Slack's
  // HTML-entity escaping and link syntax so pi sees what the human typed.
  // Mention handling runs on the RAW text (before entity decoding) so a
  // user-typed literal like `&lt;@U…&gt;` can never false-trigger the bot;
  // see resolveInboundContent.
  let content = resolveInboundContent(event.text ?? '', {
    botUserId,
    triggerName: config.triggerName,
  });
  const sender = event.user;
  const senderName = await resolveUserName(sender);
  const timestamp = slackTsToIso(event.ts);

  // Attachments → extract metadata for downstream download (url_private
  // requires a Bearer header; session/media.ts injects it for slack.com hosts)
  let acceptedAttachments: AttachmentMeta[] = [];
  let attachmentsJson: string | null = null;
  // thread_broadcast events carry no files field in the SDK types.
  const files = 'files' in event ? (event.files ?? []) : [];
  if (files.length > 0) {
    const metas: AttachmentMeta[] = files.flatMap((file) =>
      file.url_private
        ? [
            {
              url: file.url_private,
              name: file.name || 'file',
              contentType: file.mimetype || '',
              size: file.size || 0,
            },
          ]
        : [],
    );

    const selection = selectAttachmentsWithinLimits(metas, {
      maxFileBytes: config.maxAttachmentBytes,
      maxTotalBytes: config.maxTotalAttachmentBytes,
    });

    acceptedAttachments = selection.accepted;
    if (selection.rejected.length > 0) {
      logger.info(
        {
          jid,
          skipped: selection.rejected.map(({ attachment, reason, limitBytes }) => ({
            name: attachment.name,
            size: attachment.size,
            reason,
            limitBytes,
          })),
        },
        'Skipped oversized Slack attachments before enqueue',
      );
    }

    if (acceptedAttachments.length > 0) {
      attachmentsJson = JSON.stringify(acceptedAttachments);
    }
  }

  // ── Channel registration check ──
  let channel = getChannel(jid);

  // Auto-register DMs
  if (!channel && isDM && config.dmPolicy === 'open') {
    const reg = createDmChannel(jid, sender, senderName);
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, senderName }, 'Auto-registered DM channel');
  }

  // Auto-register channels/groups/mpims based on policy
  if (!channel && !isDM && config.channelPolicy !== 'allowlist') {
    if (config.excludedChannels.has(channelId)) {
      return;
    }

    const channelName = await resolveChannelName(channelId);
    const name = `${teamName || 'Workspace'} #${channelName}`;
    const reg: RegisteredChannel = {
      jid,
      name,
      folder: `ch_${channelId}`,
      requiresTrigger: config.channelPolicy === 'open-trigger',
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    };
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, name, policy: config.channelPolicy }, 'Auto-registered channel');
  }

  if (!channel) {
    // Deliberate summons deserve feedback instead of silence: an explicit
    // @mention in an unregistered channel (or any DM under allowlist) gets a
    // rate-limited registration hint. Ambient chatter stays ignored.
    if (isDM || containsBotMention(event.text ?? '', botUserId)) {
      await sendUnregisteredNotice(jid, channelId, isDM, event.thread_ts);
    } else {
      logger.debug({ jid }, 'Message from unregistered channel, ignoring');
    }
    return;
  }

  // ── Trigger check ──
  if (channel.requiresTrigger && !triggerPattern.test(content)) {
    logger.debug({ jid }, 'Message does not match trigger, ignoring');
    return;
  }

  // Strip trigger prefix from content sent to agent
  content = content.replace(triggerPattern, '').trim();
  if (!content && acceptedAttachments.length > 0) {
    content = buildAttachmentOnlyPrompt(acceptedAttachments.length);
  }
  if (!content) return;

  // ── Enqueue ──
  // Sessions stay channel-based (MVP), but the ts/thread_ts context rides
  // along so the response lands in the triggering message's thread.
  enqueueMessage({
    channelJid: jid,
    sender,
    senderName,
    content,
    timestamp,
    attachments: attachmentsJson,
    eventTs: event.ts,
    threadTs: event.thread_ts ?? null,
  });
  logger.info({ jid, sender: senderName, len: content.length }, 'Message enqueued');
}

// ── Outbound ──

const SEND_INTERVAL_MS = 1000;

/** channelId → next allowed outbound send time (epoch ms) */
const nextSendAt = new Map<string, number>();

export async function sendResponse(
  jid: string,
  text: string,
  ctx?: { threadTs?: string },
): Promise<boolean> {
  if (!app) return false;
  const client = app.client;

  const channelId = jid.replace(/^sl:/, '');
  const threadTs = ctx?.threadTs;

  try {
    const chunks =
      text.length <= SLACK_MAX_MESSAGE_LENGTH
        ? [text]
        : splitMessage(text, SLACK_MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await paceOutbound(channelId);
      // markdown_text takes standard Markdown, so no mrkdwn conversion needed.
      await client.chat.postMessage({
        channel: channelId,
        markdown_text: chunk,
        thread_ts: threadTs,
      });
    }
    logger.info({ jid, length: text.length }, 'Response sent');
    return true;
  } catch (err: any) {
    logger.error({ jid, err: err.message }, 'Failed to send message');
    return false;
  }
}

const BUSY_REACTION = 'hourglass_flowing_sand';

/**
 * Busy indicator: Slack has no bot typing indicator, so react to the
 * triggering message instead. No-ops when there is no message ts (scheduler
 * runs) and never rejects — a missing reactions:write scope must not break
 * the processing pipeline.
 */
export async function setBusy(jid: string, on: boolean, ctx?: { ts?: string }): Promise<void> {
  if (!app || !ctx?.ts) return;

  const channelId = jid.replace(/^sl:/, '');
  try {
    if (on) {
      await app.client.reactions.add({
        channel: channelId,
        timestamp: ctx.ts,
        name: BUSY_REACTION,
      });
    } else {
      await app.client.reactions.remove({
        channel: channelId,
        timestamp: ctx.ts,
        name: BUSY_REACTION,
      });
    }
  } catch (err: any) {
    logger.debug({ jid, err: err.message }, 'Busy reaction update failed');
  }
}

const UNREGISTERED_NOTICE_INTERVAL_MS = 10 * 60 * 1000;

/** jid → last time a registration hint was posted (epoch ms) */
const lastUnregisteredNoticeAt = new Map<string, number>();

/** Rate-limited registration hint for deliberate summons in unregistered places. */
async function sendUnregisteredNotice(
  jid: string,
  channelId: string,
  isDM: boolean,
  threadTs?: string,
): Promise<void> {
  const now = Date.now();
  const last = lastUnregisteredNoticeAt.get(jid) ?? 0;
  if (now - last < UNREGISTERED_NOTICE_INTERVAL_MS) return;
  lastUnregisteredNoticeAt.set(jid, now);

  const where = isDM ? 'This DM is' : 'This channel is';
  await sendResponse(
    jid,
    `${where} not registered with the pi gateway, so messages here are ignored. ` +
      `Ask the gateway admin to run:\n\`pi-tag-slack register ${channelId} "<name>"\``,
    { threadTs },
  );
  logger.info({ jid }, 'Sent unregistered-channel notice');
}

export function stopSlack(): void {
  if (!app) return;

  const stopping = app;
  app = null;
  botTag = undefined;
  void stopping.stop().catch((err: any) => {
    logger.debug({ err: err.message }, 'Slack app stop failed');
  });
  logger.info('Slack bot stopped');
}

export function getBotTag(): string | undefined {
  return botTag;
}

// ── Helpers ──

/** Resolve a user's display name via users.info, cached with a short TTL so
 * display-name changes propagate into the prompt prefix. */
async function resolveUserName(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  if (!app) return cached?.name ?? userId;

  try {
    const res = await app.client.users.info({ user: userId });
    const name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name || userId;
    userNameCache.set(userId, { name, expiresAt: Date.now() + USER_NAME_TTL_MS });
    return name;
  } catch (err: any) {
    // Transient failure or missing users:read scope: prefer the expired
    // cached name over the raw user id, and re-arm the entry with a short
    // expiry so the next lookup retries soon without hammering users.info.
    logger.debug({ userId, err: err.message }, 'users.info lookup failed');
    const fallback = cached?.name ?? userId;
    userNameCache.set(userId, {
      name: fallback,
      expiresAt: Date.now() + USER_NAME_FAILURE_TTL_MS,
    });
    return fallback;
  }
}

/** Resolve a channel's name for registration labels; best-effort. */
async function resolveChannelName(channelId: string): Promise<string> {
  if (!app) return channelId;

  try {
    const res = await app.client.conversations.info({ channel: channelId });
    return res.channel?.name_normalized || res.channel?.name || channelId;
  } catch (err: any) {
    // Missing channels:read/groups:read/mpim:read scope: fall back to the raw id.
    logger.debug({ channelId, err: err.message }, 'conversations.info lookup failed');
    return channelId;
  }
}

/** Reserve the next outbound slot for a channel (~1 msg/s per channel). */
async function paceOutbound(channelId: string): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSendAt.get(channelId) ?? 0);
  nextSendAt.set(channelId, slot + SEND_INTERVAL_MS);

  const waitMs = slot - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Slack ts ("1712345678.123456") → ISO timestamp. */
function slackTsToIso(ts: string): string {
  const ms = Number.parseFloat(ts) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}
