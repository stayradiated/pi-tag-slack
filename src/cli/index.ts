#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { TextDecoder } from 'node:util';
import { dirname } from 'node:path';
import { validateFirstTimeSetup, type SetupValidationDependencies } from '../setup-validation.js';
import { createResetBackupBundle } from '../reset-backup.js';
import { installFreshReset } from '../reset-install.js';
import {
  addTrustedUser,
  closeDb,
  createGatewayConfig,
  initDb,
  requireConfiguredDb,
} from '../db.js';
import { resolveConfigPath, validateBootstrapConfigPath } from '../config.js';
import { CONTROL_COMMAND_DEADLINE_MS, SLACK_NETWORK_DEADLINE_MS } from '../control.js';
import {
  acquireGatewayLock,
  ensurePrivateFile,
  ensurePrivateLayout,
  gatewayPaths,
  pathDiagnostic,
  pathDiagnostics,
  structuralPathExists,
} from '../paths.js';

const help = `pi-tag-slack

Usage:
  pi-tag-slack setup [--reset --yes] --channel <C...|G...> --cwd <path> --model <ref> --trusted-user <U...|W...>
  pi-tag-slack inbox list|show|working|respond|resolve ...
  pi-tag-slack slack history|message|thread|file download|send ...
  pi-tag-slack task add|list|show|resolve ...
  pi-tag-slack schedule add|list|show|enable|disable|remove ...
  pi-tag-slack trust add|list|remove ...
  pi-tag-slack config show|set|reset ...
  pi-tag-slack session status [--json]
  pi-tag-slack session reset [--confirm <session-id>:<run-sequence>]
  pi-tag-slack session archive list [--limit <n>] [--cursor <opaque>] [--json]
  pi-tag-slack session archive cleanup
  pi-tag-slack session model list [--json]|set <provider/model>|reset
  pi-tag-slack session thinking set <level>|reset
  pi-tag-slack doctor
  pi-tag-slack start

Runtime commands use the daemon control socket. Run setup before starting the daemon.`;

type Flags = Record<string, string | boolean | string[]>;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [group, verb, ...rest] = argv;
  if (!group || group === 'help' || group === '--help') {
    console.log(help);
    return 0;
  }
  if (group === 'setup')
    return setup([verb, ...rest].filter((value): value is string => Boolean(value)));
  if (group === 'start') {
    const { startGateway } = await import('../index.js');
    await startGateway();
    return 0;
  }
  if (group === 'doctor') return doctor();

  const fileDownload = group === 'slack' && verb === 'file' && rest[0] === 'download';
  const sessionNested =
    group === 'session' && (verb === 'model' || verb === 'thinking' || verb === 'archive');
  const command = fileDownload
    ? 'slack.file.download'
    : commandFor(group, verb, sessionNested ? rest[0] : undefined);
  if (!command) throw new Error(`Unsupported command.\n${help}`);
  const response = await request(
    command,
    paramsFor(command, fileDownload ? rest.slice(1) : sessionNested ? rest.slice(1) : rest),
  );
  if (response.error)
    throw Object.assign(new Error(response.error.message), { code: response.error.code });
  console.log(JSON.stringify(response.result));
  return 0;
}

async function doctor(): Promise<number> {
  const diagnostics = () => ({
    paths: pathDiagnostics(),
    bootstrapConfig: pathDiagnostic(resolveConfigPath()),
  });
  // Prefer the daemon: opening SQLite while it owns the gateway is forbidden.
  try {
    const health = await request('health', {});
    if (health.error) throw new Error(health.error.message);
    console.log(
      JSON.stringify({ ...diagnostics(), daemon: health.result, lock: 'held by daemon' }, null, 2),
    );
    return 0;
  } catch {
    // Socket absence is normal for offline inspection. Only acquire the lock;
    // this path never creates or chmods structural directories.
  }
  try {
    const lock = acquireGatewayLock(gatewayPaths(), { createLayout: false });
    lock.release();
    console.log(
      JSON.stringify(
        { ...diagnostics(), daemon: 'unavailable: offline diagnostics only', lock: 'acquired' },
        null,
        2,
      ),
    );
    return 0;
  } catch (error: unknown) {
    console.log(
      JSON.stringify(
        {
          ...diagnostics(),
          daemon: 'unavailable: offline diagnostics only',
          lock: `unavailable: ${
            (error as { code?: string }).code ?? 'LOCK_ERROR'
          }: ${(error as Error).message}`,
        },
        null,
        2,
      ),
    );
    return 1;
  }
}

export async function setup(
  args: string[],
  validationDependencies?: SetupValidationDependencies,
): Promise<number> {
  const options = parseFlags(
    args,
    new Set([
      'channel',
      'cwd',
      'pi-bin',
      'model',
      'thinking',
      'bot-token',
      'app-token',
      'trusted-user',
      'reset',
      'yes',
    ]),
  );
  const value = (name: string) => (typeof options[name] === 'string' ? options[name] : undefined);
  const reset = options.reset === true;
  const yes = options.yes === true;
  if (yes && !reset) throw new Error('--yes is valid only with setup --reset.');
  const channel = value('channel');
  const cwd = value('cwd');
  const model = value('model');
  const botToken = value('bot-token') ?? process.env.SLACK_BOT_TOKEN?.trim();
  const appToken = value('app-token') ?? process.env.SLACK_APP_TOKEN?.trim();
  const trusted = value('trusted-user');
  if (!channel || !cwd || !model || !botToken || !appToken || !trusted) {
    throw new Error(
      'Usage: pi-tag-slack setup --channel <C...|G...> --cwd <path> --model <ref> --trusted-user <U...|W...> (--bot-token <xoxb-...> --app-token <xapp-...> | environment tokens)',
    );
  }
  const piBinary = value('pi-bin') ?? 'pi';
  const thinking = value('thinking') ?? 'medium';
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking))
    throw new Error('Invalid default thinking level.');

  // Lock/layout checks are the only structural work before validation. They
  // create no application config/database state and serialize setup attempts.
  const paths = ensurePrivateLayout();
  const lock = acquireGatewayLock(paths);
  const configPath = resolveConfigPath();
  const suffix = `.setup-${randomUUID()}`;
  const stagedDb = `${paths.db}${suffix}`;
  const stagedConfig = `${configPath}${suffix}`;
  const stagedSession = `${paths.session}${suffix}`;
  let installedConfig = false;
  let installedDb = false;
  try {
    validateBootstrapConfigPath(configPath);
    ensurePrivateFile(paths.db);
    ensurePrivateFile(configPath);
    if ((structuralPathExists(paths.db) || structuralPathExists(configPath)) && !reset) {
      throw new Error(
        'Gateway state already exists; plain setup never replaces it. Use setup --reset.',
      );
    }
    // Interactive confirmation belongs to the surrounding setup flow. This
    // non-interactive API deliberately requires explicit --yes for reset.
    if (reset && !yes) throw new Error('setup --reset requires --yes in non-interactive mode.');
    // All local, RPC, and Slack validation runs before SQLite/config staging.
    const validated = await validateFirstTimeSetup(
      {
        channelId: channel,
        workingDirectory: cwd,
        piBinary,
        model,
        thinking,
        botToken,
        appToken,
        trustedUserId: trusted,
      },
      validationDependencies,
    );
    console.warn(
      "Warning: trusted Slack users can influence an agent with this daemon account's local capabilities.",
    );

    // Build all durable state off to the side first. Nothing active is changed
    // until validation of the complete database singleton has succeeded.
    initDb(stagedDb);
    try {
      createGatewayConfig({
        channelId: channel,
        channelLabel: validated.channelLabel,
        workingDirectory: cwd,
        piBinary,
        defaultModel: model,
        defaultThinking: thinking,
      });
      addTrustedUser(trusted, validated.trustedUserLabel);
    } finally {
      closeDb();
    }
    // Reopen the staged database before any active path is replaced. This
    // catches a malformed singleton and verifies the durable SQLite image.
    initDb(stagedDb);
    try {
      requireConfiguredDb();
      const quickCheck = requireConfiguredDb().pragma('quick_check', { simple: true }) as string;
      if (quickCheck !== 'ok') throw new Error(`Staged database quick_check failed: ${quickCheck}`);
    } finally {
      closeDb();
    }

    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(configPath), 0o700);
    writeFileSync(
      stagedConfig,
      `SLACK_BOT_TOKEN=${JSON.stringify(botToken)}\nSLACK_APP_TOKEN=${JSON.stringify(appToken)}\n`,
      { mode: 0o600 },
    );
    chmodSync(stagedConfig, 0o600);
    validateBootstrapConfigPath(stagedConfig);
    const stagedBootstrap = readFileSync(stagedConfig, 'utf8');
    if (
      stagedBootstrap !==
      `SLACK_BOT_TOKEN=${JSON.stringify(botToken)}\nSLACK_APP_TOKEN=${JSON.stringify(appToken)}\n`
    )
      throw new Error('Staged bootstrap config validation failed.');
    if (reset) {
      mkdirSync(stagedSession, { mode: 0o700 });
      chmodSync(stagedSession, 0o700);
      const backup = await createResetBackupBundle({ paths, configPath, lockHeld: true });
      installFreshReset({
        paths,
        configPath,
        backup,
        staged: { config: stagedConfig, database: stagedDb, session: stagedSession },
      });
      installedConfig = true;
      installedDb = true;
    } else {
      renameSync(stagedConfig, configPath);
      installedConfig = true;
      renameSync(stagedDb, paths.db);
      installedDb = true;
    }
    console.log(`Initialized schema v2 at ${paths.db}.`);
    return 0;
  } finally {
    closeDb();
    for (const path of [
      stagedConfig,
      stagedDb,
      `${stagedDb}-wal`,
      `${stagedDb}-shm`,
      stagedSession,
    ]) {
      rmSync(path, { force: true });
    }
    if (!installedDb && installedConfig) rmSync(configPath, { force: true });
    lock.release();
  }
}

export function commandFor(group: string, verb?: string, nestedVerb?: string): string | undefined {
  const allowed = new Set([
    'inbox.list',
    'inbox.show',
    'inbox.resolve',
    'inbox.working',
    'inbox.respond',
    'slack.history',
    'slack.message',
    'slack.thread',
    'slack.file.download',
    'slack.send',
    'task.list',
    'task.show',
    'task.add',
    'task.resolve',
    'schedule.add',
    'schedule.list',
    'schedule.show',
    'schedule.enable',
    'schedule.disable',
    'schedule.remove',
    'trust.list',
    'trust.add',
    'trust.remove',
    'config.show',
    'config.set',
    'config.reset',
    'session.status',
    'session.reset',
    'session.archive.list',
    'session.archive.cleanup',
    'session.model.list',
    'session.model.set',
    'session.model.reset',
    'session.thinking.set',
    'session.thinking.reset',
  ]);
  const command = nestedVerb ? `${group}.${verb ?? ''}.${nestedVerb}` : `${group}.${verb ?? ''}`;
  return allowed.has(command) ? command : undefined;
}

export function paramsFor(command: string, args: string[]): Record<string, unknown> {
  if (command === 'slack.history') {
    const flags = parseFlags(args, new Set(['limit', 'cursor', 'json']));
    return compact({ limit: numberFlag(flags.limit), cursor: flags.cursor });
  }
  if (command === 'slack.message') {
    parseFlags(args, new Set(['json']));
    return { messageTs: positional(args, new Set(['json']))[0] };
  }
  if (command === 'slack.thread') {
    const flags = parseFlags(args, new Set(['limit', 'cursor', 'json']));
    return compact({
      threadTs: positional(args, new Set(['limit', 'cursor', 'json']))[0],
      limit: numberFlag(flags.limit),
      cursor: flags.cursor,
    });
  }
  if (command === 'slack.file.download') {
    parseFlags(args, new Set(['json']));
    return { fileId: positional(args, new Set(['json']))[0] };
  }
  if (command === 'slack.send') {
    const flags = parseFlags(args, new Set(['thread', 'text', 'file', 'json']), new Set(['file']));
    return compact({
      threadTs: flags.thread,
      text: flags.text,
      files: typeof flags.file === 'string' ? [flags.file] : flags.file,
    });
  }
  if (command === 'session.archive.list') {
    const flags = parseFlags(args, new Set(['limit', 'cursor', 'json']));
    return compact({ limit: numberFlag(flags.limit), cursor: flags.cursor });
  }
  if (command === 'session.archive.cleanup') {
    parseFlags(args, new Set());
    return {};
  }
  if (command.endsWith('.list')) {
    const flags = parseFlags(args, new Set(['state', 'limit', 'cursor', 'json']));
    return compact({ state: flags.state, limit: numberFlag(flags.limit), cursor: flags.cursor });
  }
  if (command.endsWith('.show') || command === 'inbox.working') return { id: args[0] };
  if (command === 'inbox.respond') {
    const flags = parseFlags(args, new Set(['text', 'file', 'json']), new Set(['file']));
    return {
      id: positional(args, new Set(['text', 'file']))[0],
      text: flags.text,
      ...(flags.file === undefined
        ? {}
        : { files: typeof flags.file === 'string' ? [flags.file] : flags.file }),
    };
  }
  if (command.endsWith('.resolve')) {
    const flags = parseFlags(args, new Set(['reason']));
    return {
      ids: positional(args, new Set(['reason'])),
      ...(typeof flags.reason === 'string' ? { reason: flags.reason } : {}),
    };
  }
  if (command === 'task.add') {
    const flags = parseFlags(args, new Set(['title', 'instructions']));
    return { title: flags.title, instructions: flags.instructions };
  }
  if (command === 'schedule.add') {
    const flags = parseFlags(args, new Set(['title', 'instructions', 'at', 'cron', 'timezone']));
    return compact({
      title: flags.title,
      instructions: flags.instructions,
      at: flags.at,
      cron: flags.cron,
      timezone: flags.timezone,
    });
  }
  if (
    command === 'schedule.enable' ||
    command === 'schedule.disable' ||
    command === 'schedule.remove'
  )
    return { id: args[0] };
  if (command === 'trust.add') return { userId: args[0] };
  if (command === 'trust.remove') return { userId: args[0] };
  if (command === 'config.set') return { key: args[0], value: args[1] };
  if (command === 'config.reset') return { key: args[0] };
  if (command === 'session.status' || command === 'session.model.list') {
    parseFlags(args, new Set(['json']));
    return {};
  }
  if (command === 'session.reset') {
    const flags = parseFlags(args, new Set(['confirm', 'json']));
    return compact({ confirm: flags.confirm });
  }
  if (command === 'session.model.set') {
    parseFlags(args, new Set());
    return { ref: positional(args, new Set())[0] };
  }
  if (command === 'session.model.reset' || command === 'session.thinking.reset') {
    parseFlags(args, new Set());
    return {};
  }
  if (command === 'session.thinking.set') {
    parseFlags(args, new Set());
    return { level: positional(args, new Set())[0] };
  }
  return {};
}

function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function numberFlag(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  return Number(value);
}

function positional(args: string[], flagNames: Set<string>): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) {
      if (flagNames.has(args[index].slice(2))) index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function parseFlags(args: string[], names: Set<string>, repeatable = new Set<string>()): Flags {
  const result: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2);
    if (!names.has(name)) throw new Error(`Unknown option: ${argument}`);
    if (name === 'json' || name === 'reset' || name === 'yes') {
      result[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option ${argument} requires a value.`);
    if (repeatable.has(name)) {
      const current = result[name];
      result[name] = current === undefined ? [value] : [...(current as string[]), value];
    } else {
      result[name] = value;
    }
    index += 1;
  }
  return result;
}

const MAX_RESPONSE_FRAME_BYTES = 1024 * 1024;
type ControlResponse = {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
};

function protocolError(message: string): Error {
  return Object.assign(new Error(message), { code: 'INVALID_RESPONSE' });
}

const SLACK_NETWORK_COMMANDS = new Set([
  'slack.history',
  'slack.message',
  'slack.thread',
  'slack.file.download',
  'slack.send',
  'inbox.respond',
  'trust.add',
]);
const SLACK_MUTATIONS = new Set(['slack.send', 'inbox.respond']);

function timeoutError(command: string, id: string): Error & { code: string; requestId: string } {
  const mutation = SLACK_MUTATIONS.has(command);
  return Object.assign(
    new Error(
      mutation
        ? `The Slack operation may have completed. Request ID: ${id}. Inspect Slack/inbox state before retrying.`
        : `Control command deadline exceeded. Request ID: ${id}.`,
    ),
    { code: mutation ? 'OUTCOME_UNKNOWN' : 'DEADLINE_EXCEEDED', requestId: id },
  );
}

export function request(
  command: string,
  params: Record<string, unknown>,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = connect(gatewayPaths().socket);
    let output = Buffer.alloc(0);
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.setTimeout(
      SLACK_NETWORK_COMMANDS.has(command) ? SLACK_NETWORK_DEADLINE_MS : CONTROL_COMMAND_DEADLINE_MS,
    );
    socket.once('error', () =>
      rejectOnce(
        Object.assign(new Error('pi-tag-slack daemon is unavailable.'), {
          code: 'DAEMON_UNAVAILABLE',
        }),
      ),
    );
    socket.once('timeout', () => {
      socket.destroy();
      // Keep the generated ID available to callers: a mutation may have reached
      // Slack even though this client did not receive the daemon's response.
      rejectOnce(timeoutError(command, id));
    });
    socket.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_RESPONSE_FRAME_BYTES + 1) {
        socket.destroy();
        rejectOnce(protocolError('Daemon response exceeds frame limit.'));
      }
    });
    socket.on('end', () => {
      if (settled) return;
      settled = true;
      if (
        output.length === 0 ||
        output.length > MAX_RESPONSE_FRAME_BYTES ||
        output.at(-1) !== 0x0a ||
        output.indexOf(0x0a) !== output.length - 1
      ) {
        reject(protocolError('Daemon response must contain exactly one LF-terminated frame.'));
        return;
      }
      let response: unknown;
      try {
        response = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, -1)),
        );
      } catch {
        reject(protocolError('Daemon response must be valid UTF-8 JSON.'));
        return;
      }
      if (!response || typeof response !== 'object' || (response as ControlResponse).id !== id) {
        reject(protocolError('Daemon response has an invalid correlation ID.'));
        return;
      }
      const value = response as ControlResponse;
      const hasResult = Object.hasOwn(value, 'result');
      const hasError = Object.hasOwn(value, 'error');
      if (
        hasResult === hasError ||
        (hasError &&
          (!value.error ||
            typeof value.error.code !== 'string' ||
            typeof value.error.message !== 'string'))
      ) {
        reject(protocolError('Daemon response has an invalid schema.'));
        return;
      }
      resolve(value);
    });
    socket.on('connect', () =>
      socket.end(`${JSON.stringify({ version: 1, id, command, params })}\n`),
    );
  });
}

if (process.argv[1]?.endsWith('/cli/index.js') || process.argv[1]?.endsWith('/cli/index.ts')) {
  void main().catch((error: unknown) => {
    const failure = error as { code?: unknown; message?: unknown };
    const code = typeof failure.code === 'string' ? failure.code : 'INTERNAL';
    const message = typeof failure.message === 'string' ? failure.message : 'Command failed.';
    if (process.argv.slice(2).includes('--json')) {
      // A failed JSON invocation writes one machine-readable value, and nothing
      // else, so an agent never needs to parse diagnostics from stderr.
      console.log(JSON.stringify({ error: { code, message } }));
    } else {
      console.error(`Error${code === 'INTERNAL' ? '' : ` [${code}]`}: ${message}`);
    }
    process.exitCode = 1;
  });
}
