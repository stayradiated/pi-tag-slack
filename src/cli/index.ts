#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { TextDecoder } from 'node:util';
import { dirname } from 'node:path';
import {
  addTrustedUser,
  closeDb,
  createGatewayConfig,
  initDb,
  requireConfiguredDb,
} from '../db.js';
import { resolveConfigPath, validateBootstrapConfigPath } from '../config.js';
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
  pi-tag-slack setup --channel <C...|G...> --label <name> --cwd <path> --model <ref>
  pi-tag-slack inbox list|show|working|respond|resolve ...
  pi-tag-slack slack history|message|thread|send ...
  pi-tag-slack task add|list|show|resolve ...
  pi-tag-slack schedule add|list|show|enable|disable|remove ...
  pi-tag-slack trust add|list|remove ...
  pi-tag-slack config show|set|reset ...
  pi-tag-slack doctor
  pi-tag-slack start

Runtime commands use the daemon control socket. Run setup before starting the daemon.`;

type Flags = Record<string, string | boolean>;

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

  const command = commandFor(group, verb);
  if (!command) throw new Error(`Unsupported command.\n${help}`);
  const response = await request(command, paramsFor(command, rest));
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
          lock: `unavailable: ${(error as Error).message}`,
        },
        null,
        2,
      ),
    );
    return 1;
  }
}

function setup(args: string[]): number {
  const options = parseFlags(
    args,
    new Set([
      'channel',
      'label',
      'cwd',
      'pi-bin',
      'model',
      'thinking',
      'bot-token',
      'app-token',
      'trusted-user',
    ]),
  );
  const value = (name: string) => (typeof options[name] === 'string' ? options[name] : undefined);
  const channel = value('channel');
  const label = value('label');
  const cwd = value('cwd');
  const model = value('model');
  const botToken = value('bot-token') ?? process.env.SLACK_BOT_TOKEN?.trim();
  const appToken = value('app-token') ?? process.env.SLACK_APP_TOKEN?.trim();
  if (!channel || !label || !cwd || !model || !botToken || !appToken) {
    throw new Error(
      'Usage: pi-tag-slack setup --channel <C...|G...> --label <name> --cwd <path> --model <ref> (--bot-token <xoxb-...> --app-token <xapp-...> | environment tokens)',
    );
  }
  if (!botToken.startsWith('xoxb-') || !appToken.startsWith('xapp-'))
    throw new Error('Setup requires xoxb- bot and xapp- app tokens.');

  const trusted = value('trusted-user');
  if (trusted && !/^[UW][A-Z0-9]+$/.test(trusted))
    throw new Error('Setup requires a raw uppercase U... or W... trusted user ID.');

  const paths = ensurePrivateLayout();
  const lock = acquireGatewayLock(paths);
  const configPath = resolveConfigPath();
  validateBootstrapConfigPath(configPath);
  const suffix = `.setup-${randomUUID()}`;
  const stagedDb = `${paths.db}${suffix}`;
  const stagedConfig = `${configPath}${suffix}`;
  let installedConfig = false;
  let installedDb = false;
  try {
    ensurePrivateFile(paths.db);
    ensurePrivateFile(configPath);
    if (structuralPathExists(paths.db) || structuralPathExists(configPath)) {
      throw new Error(
        'Gateway state already exists; plain setup never replaces it. Use setup --reset.',
      );
    }

    // Build all durable state off to the side first. Nothing active is changed
    // until validation of the complete database singleton has succeeded.
    initDb(stagedDb);
    try {
      createGatewayConfig({
        channelId: channel,
        channelLabel: label,
        workingDirectory: cwd,
        piBinary: value('pi-bin') ?? 'pi',
        defaultModel: model,
        defaultThinking: value('thinking') ?? 'medium',
      });
      if (trusted) addTrustedUser(trusted);
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
    renameSync(stagedConfig, configPath);
    installedConfig = true;
    renameSync(stagedDb, paths.db);
    installedDb = true;
    console.log(`Initialized schema v2 at ${paths.db}.`);
    return 0;
  } finally {
    closeDb();
    for (const path of [stagedConfig, stagedDb, `${stagedDb}-wal`, `${stagedDb}-shm`]) {
      rmSync(path, { force: true });
    }
    if (!installedDb && installedConfig) rmSync(configPath, { force: true });
    lock.release();
  }
}

function commandFor(group: string, verb?: string): string | undefined {
  const allowed = new Set([
    'inbox.list',
    'inbox.show',
    'inbox.resolve',
    'inbox.working',
    'inbox.respond',
    'slack.history',
    'slack.message',
    'slack.thread',
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
  ]);
  const command = `${group}.${verb ?? ''}`;
  return allowed.has(command) ? command : undefined;
}

function paramsFor(command: string, args: string[]): Record<string, unknown> {
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
  if (command === 'slack.send') {
    const flags = parseFlags(args, new Set(['thread', 'text']));
    return compact({ threadTs: flags.thread, text: flags.text });
  }
  if (command.endsWith('.list')) {
    const flags = parseFlags(args, new Set(['state', 'limit', 'cursor', 'json']));
    return compact({ state: flags.state, limit: numberFlag(flags.limit), cursor: flags.cursor });
  }
  if (command.endsWith('.show') || command === 'inbox.working') return { id: args[0] };
  if (command === 'inbox.respond') {
    const flags = parseFlags(args, new Set(['text']));
    return { id: positional(args, new Set(['text']))[0], text: flags.text };
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
    return compact({ title: flags.title, instructions: flags.instructions, at: flags.at, cron: flags.cron, timezone: flags.timezone });
  }
  if (command === 'schedule.enable' || command === 'schedule.disable' || command === 'schedule.remove') return { id: args[0] };
  if (command === 'trust.add') return { userId: args[0] };
  if (command === 'trust.remove') return { userId: args[0] };
  if (command === 'config.set') return { key: args[0], value: args[1] };
  if (command === 'config.reset') return { key: args[0] };
  return {};
}

function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function numberFlag(value: string | boolean | undefined): number | undefined {
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

function parseFlags(args: string[], names: Set<string>): Flags {
  const result: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2);
    if (!names.has(name)) throw new Error(`Unknown option: ${argument}`);
    if (name === 'json') {
      result[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option ${argument} requires a value.`);
    result[name] = value;
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

function request(command: string, params: Record<string, unknown>): Promise<ControlResponse> {
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
    socket.setTimeout(10_000);
    socket.once('error', () =>
      rejectOnce(
        Object.assign(new Error('pi-tag-slack daemon is unavailable.'), {
          code: 'DAEMON_UNAVAILABLE',
        }),
      ),
    );
    socket.once('timeout', () => {
      socket.destroy();
      rejectOnce(
        Object.assign(new Error('Control request timed out.'), { code: 'DEADLINE_EXCEEDED' }),
      );
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
  void main().catch((error) => {
    console.error(`Error${error.code ? ` [${error.code}]` : ''}: ${error.message}`);
    process.exitCode = 1;
  });
}
