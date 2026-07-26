/**
 * /pi slash command and its Block Kit control panel.
 *
 * Slack has no per-command autocomplete or typed subcommands, so a single
 * global /pi command carries text subcommands:
 *   status | model <ref> | models | reset-model | thinking <level> | new | stop
 * A bare `/pi` opens an interactive panel (model/thinking pickers, new-session
 * and stop buttons) instead of a text usage dump; `/pi help` prints the text
 * usage. Replies are ephemeral (respond() posts to the response_url).
 */

import type {
  App,
  BlockAction,
  BlockElementAction,
  ButtonAction,
  RespondFn,
  SlashCommand,
  StaticSelectAction,
} from '@slack/bolt';
import { buildPanelBlocks, PANEL_ACTIONS, type PanelState } from './panel.js';
import {
  getChannelSessionStatus,
  type ChannelSessionStatus,
  type SessionContextUsage,
  type SessionTokenUsage,
} from '../agent/invoke.js';
import { config } from '../config.js';
import {
  clearChannelModelOverride,
  clearPendingMessages,
  createDmChannel,
  getChannel,
  registerChannel,
  setChannelModelOverride,
  setChannelThinkingOverride,
  isTrustedUser,
} from '../db.js';
import { logger } from '../logger.js';
import {
  isThinkingLevel,
  listSelectableModels,
  resolveModelReference,
  resolveThinkingForModel,
  toModelChoiceName,
} from '../agent/model-catalog.js';
import {
  buildThinkingAdjustmentMessage,
  computeEffectiveChannelSettings,
  getDesiredThinkingLevel,
  type EffectiveChannelSettings,
} from '../agent/channel-settings.js';
import { abortChannelTask, isChannelProcessing } from '../agent/queue.js';
import { rotateChannelSessionDir } from '../session/path.js';
import { THINKING_LEVELS, type RegisteredChannel, type ThinkingLevel } from '../types.js';

export function registerCommands(app: App): void {
  app.command('/pi', async ({ command, ack, respond }) => {
    // Slash commands must be acked within 3s; respond() stays valid for 30min.
    await ack();
    if (!isTrustedUser(command.user_id)) return;

    const [rawSubcommand = '', ...args] = command.text.trim().split(/\s+/).filter(Boolean);
    const subcommand = rawSubcommand.toLowerCase();

    try {
      switch (subcommand) {
        case 'status':
          await handleStatus(command, respond);
          return;
        case 'model':
          await handleModelSet(command, respond, args.join(' '));
          return;
        case 'models':
          await handleModels(command, respond);
          return;
        case 'reset-model':
          await handleModelReset(command, respond);
          return;
        case 'thinking':
          await handleThinkingSet(command, respond, args[0] ?? '');
          return;
        case 'new':
          await handleNew(command, respond);
          return;
        case 'stop':
          await handleStop(command, respond);
          return;
        case '':
          await handlePanel(command, respond);
          return;
        case 'help':
          await respond(usageMessage());
          return;
        default:
          await respond(`Unknown subcommand: ${subcommand}\n${usageMessage()}`);
      }
    } catch (err: any) {
      logger.error({ err: err.message, command: '/pi', subcommand }, 'Slash command failed');
      try {
        await respond(`⚠️ ${err.message}`);
      } catch {
        // response_url expired or unreachable; nothing else to do.
      }
    }
  });
  registerPanelActions(app);
  logger.info('Registered /pi slash command handler');
}

// ── Block Kit panel ──

async function handlePanel(command: SlashCommand, respond: RespondFn): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  await respondWithPanel(channel, respond);
}

async function buildPanelState(
  channel: RegisteredChannel,
  notice: string | undefined,
): Promise<PanelState> {
  const effective = computeEffectiveChannelSettings(channel);
  const sessionStatus = await getChannelSessionStatus(channel.folder, effective.effectiveCwd);
  const models = await listSelectableModels({ cwd: channel.cwdOverride || config.piCwd });

  return {
    channelName: channel.name,
    model: formatModelValue(effective),
    thinking: formatThinkingValue(effective),
    workingDir: formatWorkingDirValue(effective),
    session: sessionStatus.createdAt
      ? formatSessionCreatedAt(sessionStatus.createdAt)
      : 'not started',
    tokens: formatTokenUsage(sessionStatus.tokens, sessionStatus.statsSource),
    context: formatContextUsage(sessionStatus.contextUsage),
    processing: isChannelProcessing(channel.jid),
    models: models.map((model) => ({ ref: model.ref, label: toModelChoiceName(model) })),
    currentModelRef: effective.rawModelRef || '',
    currentThinking: channel.thinkingOverride,
    notice,
  };
}

async function respondWithPanel(
  channel: RegisteredChannel,
  respond: RespondFn,
  opts: { notice?: string; replace?: boolean } = {},
): Promise<void> {
  const state = await buildPanelState(channel, opts.notice);
  await respond({
    text: `pi-tag-slack — ${channel.name}`,
    blocks: buildPanelBlocks(state),
    ...(opts.replace ? { replace_original: true } : {}),
  });
}

function registerPanelActions(app: App): void {
  registerPanelAction<StaticSelectAction>(app, PANEL_ACTIONS.model, async (channel, action) => {
    const notes = await applyModelSelection(channel, action.selected_option?.value ?? '');
    return `✅ ${notes.join(' ')}`;
  });

  registerPanelAction<StaticSelectAction>(app, PANEL_ACTIONS.thinking, (channel, action) => {
    const level = (action.selected_option?.value ?? '').toLowerCase();
    if (!isThinkingLevel(level)) {
      return `⚠️ Invalid thinking level: ${level || '(none)'}`;
    }
    return `✅ ${applyThinkingSelection(channel, level).join(' ')}`;
  });

  registerPanelAction<ButtonAction>(app, PANEL_ACTIONS.newSession, (channel) => {
    const result = performNewSession(channel);
    return `${result.ok ? '✅' : '⚠️'} ${result.notes.join(' ')}`;
  });

  registerPanelAction<ButtonAction>(app, PANEL_ACTIONS.stop, (channel) => {
    return `✅ ${performStop(channel.jid)}`;
  });

  registerPanelAction<ButtonAction>(app, PANEL_ACTIONS.refresh, () => undefined);
}

/** Shared plumbing for panel block-actions: ack, resolve channel, re-render. */
function registerPanelAction<A extends BlockElementAction>(
  app: App,
  actionId: string,
  run: (channel: RegisteredChannel, action: A) => Promise<string | undefined> | string | undefined,
): void {
  app.action<BlockAction<A>>(actionId, async ({ ack, body, action, respond }) => {
    await ack();
    if (!isTrustedUser(body.user.id)) return;

    try {
      const channelId = body.channel?.id;
      const channel = channelId ? getChannel(`sl:${channelId}`) : undefined;
      if (!channel) {
        await respond({ text: notRegisteredMessage(), replace_original: true });
        return;
      }

      const notice = await run(channel, action);
      // Re-read: the action may have changed the channel's overrides.
      await respondWithPanel(getChannel(channel.jid) ?? channel, respond, {
        notice,
        replace: true,
      });
    } catch (err: any) {
      logger.error({ err: err.message, actionId }, 'Panel action failed');
      try {
        await respond({ text: `⚠️ ${err.message}`, replace_original: true });
      } catch {
        // response_url expired or unreachable; nothing else to do.
      }
    }
  });
}

function usageMessage(): string {
  return [
    'Usage: `/pi <subcommand>` — a bare `/pi` opens the interactive panel.',
    '• `status` — show the current model and thinking configuration',
    '• `model <ref>` — set the default model for this channel',
    '• `models` — list the models pi can currently use',
    '• `reset-model` — reset this channel to the gateway default model',
    `• \`thinking <level>\` — set thinking level (${THINKING_LEVELS.join('|')})`,
    '• `new` — start a fresh pi session for this channel',
    '• `stop` — abort the current task and clear the queue',
  ].join('\n');
}

async function handleNew(command: SlashCommand, respond: RespondFn): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  const result = performNewSession(channel);
  await respond(result.notes.join('\n'));
}

function performNewSession(channel: RegisteredChannel): { ok: boolean; notes: string[] } {
  if (isChannelProcessing(channel.jid)) {
    return {
      ok: false,
      notes: [
        'This channel is currently processing a message. Wait for it to finish, then try again.',
      ],
    };
  }

  const cleared = clearPendingMessages(channel.jid);
  const archivedSession = rotateChannelSessionDir(channel.folder);

  logger.info(
    { jid: channel.jid, cleared, archived: Boolean(archivedSession) },
    'Channel session reset',
  );

  const notes = ['Started a fresh session for this channel.'];
  if (cleared > 0) {
    notes.push(`Cleared ${cleared} queued ${cleared === 1 ? 'message' : 'messages'}.`);
  }
  if (archivedSession) {
    notes.push('Archived the previous session on disk.');
  }

  return { ok: true, notes };
}

async function handleStop(command: SlashCommand, respond: RespondFn): Promise<void> {
  await respond(performStop(`sl:${command.channel_id}`));
}

function performStop(jid: string): string {
  const result = abortChannelTask(jid);

  if (!result.aborted && result.cleared === 0) {
    return 'No active task or queued messages in this channel.';
  }

  const notes: string[] = [];
  if (result.aborted) {
    notes.push('Aborted the current task.');
  }
  if (result.cleared > 0) {
    notes.push(
      `Cleared ${result.cleared} queued ${result.cleared === 1 ? 'message' : 'messages'}.`,
    );
  }

  return notes.join(' ');
}

async function handleStatus(command: SlashCommand, respond: RespondFn): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  const effective = computeEffectiveChannelSettings(channel);
  const sessionStatus = await getChannelSessionStatus(channel.folder, effective.effectiveCwd);
  await respond(buildStatusMessage(effective, sessionStatus));
}

async function handleModels(command: SlashCommand, respond: RespondFn): Promise<void> {
  // Model availability can depend on the channel's working dir override.
  const channel = getChannel(`sl:${command.channel_id}`);
  const cwd = channel?.cwdOverride || config.piCwd;
  const models = await listSelectableModels({ cwd });

  if (models.length === 0) {
    await respond('No models available. Check pi authentication and PI_BIN on the gateway host.');
    return;
  }

  await respond(formatModelList(models.map(toModelChoiceName)));
}

async function handleModelSet(
  command: SlashCommand,
  respond: RespondFn,
  selectedRef: string,
): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  if (!selectedRef) {
    await respond('Usage: `/pi model <ref>` — run `/pi models` to list available models.');
    return;
  }

  await respond((await applyModelSelection(channel, selectedRef)).join('\n'));
}

async function applyModelSelection(
  channel: RegisteredChannel,
  selectedRef: string,
): Promise<string[]> {
  const cwd = channel.cwdOverride || config.piCwd;
  const models = await listSelectableModels({ forceRefresh: true, cwd });
  const selectedModel = resolveModelReference(selectedRef, models);
  if (!selectedModel) {
    return [
      `No available model matches: ${selectedRef}. Run \`/pi models\` to list available models.`,
    ];
  }

  setChannelModelOverride(channel.jid, selectedModel.ref);

  // Re-read channel to use the persisted override in status/effective computation.
  const updated = getChannel(channel.jid)!;
  const desiredThinking = getDesiredThinkingLevel(updated);
  const thinkingResolution = resolveThinkingForModel(selectedModel, desiredThinking);

  // Only persist the clamped value if the channel already had an explicit thinking override.
  if (updated.thinkingOverride) {
    setChannelThinkingOverride(updated.jid, thinkingResolution.effective);
  }

  const notes = [`Model set to ${selectedModel.ref} for this channel.`];
  if (thinkingResolution.adjusted) {
    notes.push(
      buildThinkingAdjustmentMessage(
        thinkingResolution.requested,
        thinkingResolution.effective,
        selectedModel,
      ),
    );
  }

  return notes;
}

async function handleModelReset(command: SlashCommand, respond: RespondFn): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  clearChannelModelOverride(channel.jid);

  const updated = getChannel(channel.jid)!;
  const effective = computeEffectiveChannelSettings(updated, { forceRefresh: true });
  const notes = ['Model reset for this channel.'];

  if (updated.thinkingOverride && effective.thinkingAdjusted) {
    setChannelThinkingOverride(updated.jid, effective.effectiveThinking);
  }

  if (effective.thinkingAdjusted) {
    const currentThinking = effective.hasManagedThinking
      ? effective.effectiveThinking
      : '(pi runtime default)';
    notes.push(
      `Current effective thinking is ${currentThinking}. ${effective.thinkingAdjustmentMessage}`,
    );
  }

  await respond(notes.join('\n'));
}

async function handleThinkingSet(
  command: SlashCommand,
  respond: RespondFn,
  rawLevel: string,
): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  const level = rawLevel.toLowerCase();
  if (!isThinkingLevel(level)) {
    await respond(
      `Invalid thinking level: ${rawLevel || '(none)'}. Valid levels: ${THINKING_LEVELS.join(', ')}.`,
    );
    return;
  }

  await respond(applyThinkingSelection(channel, level).join('\n'));
}

function applyThinkingSelection(channel: RegisteredChannel, level: ThinkingLevel): string[] {
  const effective = computeEffectiveChannelSettings(channel, { forceRefresh: true });
  const resolution = resolveThinkingForModel(effective.modelInfo, level);

  setChannelThinkingOverride(channel.jid, resolution.effective);

  const notes = [`Thinking level set to ${resolution.effective} for this channel.`];
  if (resolution.adjusted) {
    notes.push(
      buildThinkingAdjustmentMessage(
        resolution.requested,
        resolution.effective,
        effective.modelInfo,
      ),
    );
  }

  return notes;
}

function ensureManagedChannel(command: SlashCommand): RegisteredChannel | undefined {
  const jid = `sl:${command.channel_id}`;
  const channel = getChannel(jid);
  if (channel) return channel;

  // Allow slash commands to bootstrap DM channels, same as normal DM messages.
  if (command.channel_id.startsWith('D') && config.dmPolicy === 'open') {
    const reg = createDmChannel(jid, command.user_id, command.user_name);
    registerChannel(reg);
    return getChannel(jid) ?? reg;
  }

  return undefined;
}

function notRegisteredMessage(): string {
  return 'This channel is not registered yet. Send a regular message in this channel first — the gateway will auto-register it (if channel policy is `open` or `open-trigger`).';
}

function formatModelList(lines: string[]): string {
  // Keep the ephemeral reply within one Slack message (~4k chars).
  const maxBodyLength = 3500;
  let body = '';
  let shown = 0;
  for (const line of lines) {
    if (body.length + line.length + 1 > maxBodyLength) break;
    body += `${line}\n`;
    shown += 1;
  }

  const parts = [
    `Available models (${lines.length}) — set one with \`/pi model <ref>\`:`,
    `\`\`\`text\n${body.trimEnd()}\n\`\`\``,
  ];
  if (shown < lines.length) {
    parts.push(`…and ${lines.length - shown} more. \`/pi model <ref>\` matches fuzzily.`);
  }
  return parts.join('\n');
}

function buildStatusMessage(
  effective: EffectiveChannelSettings,
  sessionStatus: ChannelSessionStatus,
): string {
  const rows: Array<[string, string]> = [
    ['Model', formatModelValue(effective)],
    ['Thinking', formatThinkingValue(effective)],
    ['Working dir', formatWorkingDirValue(effective)],
  ];

  if (effective.thinkingAdjusted) {
    rows.push(['Fallback', formatThinkingFallback(effective)]);
  }

  rows.push(
    ['Reasoning', effective.modelInfo ? (effective.modelInfo.reasoning ? 'yes' : 'no') : 'unknown'],
    [
      'Session',
      sessionStatus.createdAt ? formatSessionCreatedAt(sessionStatus.createdAt) : 'not started',
    ],
    ['Tokens', formatTokenUsage(sessionStatus.tokens, sessionStatus.statsSource)],
    ['Context', formatContextUsage(sessionStatus.contextUsage)],
  );

  return `\`\`\`text\n${formatTwoColumnRows(rows)}\n\`\`\``;
}

function formatModelValue(effective: EffectiveChannelSettings): string {
  if (effective.modelSource === 'pi runtime default') {
    return 'pi runtime default';
  }

  return `${effective.displayModel} (${formatSettingSource(effective.modelSource)})`;
}

function formatThinkingValue(effective: EffectiveChannelSettings): string {
  if (!effective.hasManagedThinking || effective.thinkingSource === 'pi runtime default') {
    return 'pi runtime default';
  }

  return `${effective.effectiveThinking} (${formatSettingSource(effective.thinkingSource)})`;
}

function formatThinkingFallback(effective: EffectiveChannelSettings): string {
  if (
    effective.modelInfo &&
    !effective.modelInfo.reasoning &&
    effective.requestedThinking !== 'off'
  ) {
    return `${effective.requestedThinking} -> off (no reasoning)`;
  }

  if (effective.requestedThinking === 'xhigh' && effective.effectiveThinking === 'high') {
    return 'xhigh -> high (unsupported)';
  }

  return `${effective.requestedThinking} -> ${effective.effectiveThinking}`;
}

function formatWorkingDirValue(effective: EffectiveChannelSettings): string {
  return `${effective.effectiveCwd} (${effective.cwdSource === 'override' ? 'channel' : 'gateway'})`;
}

function formatSettingSource(source: EffectiveChannelSettings['modelSource']): string {
  switch (source) {
    case 'override':
      return 'channel';
    case 'default':
      return 'gateway';
    case 'pi runtime default':
      return 'pi';
  }
}

function formatSessionCreatedAt(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function formatTokenUsage(
  tokens: SessionTokenUsage | undefined,
  statsSource: ChannelSessionStatus['statsSource'],
): string {
  if (!tokens) {
    return statsSource === 'none' ? '0 total' : '?';
  }

  const cache = tokens.cacheRead + tokens.cacheWrite;
  const details = [`${formatNumber(tokens.input)} in`, `${formatNumber(tokens.output)} out`];
  if (cache > 0) {
    details.push(`${formatNumber(cache)} cache`);
  }

  const showDetails = tokens.input > 0 || tokens.output > 0 || cache > 0;
  return `${formatNumber(tokens.total)} total${showDetails ? ` (${details.join(' / ')})` : ''}`;
}

function formatContextUsage(contextUsage: SessionContextUsage | undefined): string {
  if (!contextUsage) {
    return '?';
  }

  const tokens = contextUsage.tokens == null ? '?' : formatNumber(contextUsage.tokens);
  const window =
    contextUsage.contextWindow == null ? '?' : formatNumber(contextUsage.contextWindow);
  const percent = contextUsage.percent == null ? '?' : `${formatPercent(contextUsage.percent)}%`;
  return `${tokens} / ${window} (${percent})`;
}

function formatTwoColumnRows(rows: Array<[string, string]>): string {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}
