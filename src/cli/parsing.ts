export type Flags = Record<string, string | boolean | string[]>;

export interface SetupOptions {
  readonly channel?: string;
  readonly cwd?: string;
  readonly piBin?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly botToken?: string;
  readonly appToken?: string;
  readonly trustedUser?: string;
  readonly reset: boolean;
  readonly yes: boolean;
}

export type ParsedCliCommand =
  | { kind: 'help' }
  | { kind: 'setup'; args: string[] }
  | { kind: 'start' }
  | { kind: 'doctor' }
  | { kind: 'daemon'; verb: string }
  | { kind: 'runtime'; command: string; params: Record<string, unknown>; json: boolean };

/** Parse argv into a command request without performing CLI side effects. */
export function parseCliCommand(argv: string[]): ParsedCliCommand {
  const [group, verb, ...rest] = argv;
  if (!group || group === 'help' || group === '--help') return { kind: 'help' };
  if (group === 'setup')
    return {
      kind: 'setup',
      args: [verb, ...rest].filter((value): value is string => Boolean(value)),
    };
  if (group === 'start') return { kind: 'start' };
  if (group === 'doctor') return { kind: 'doctor' };
  if (group === 'daemon') return { kind: 'daemon', verb: verb ?? '' };

  const json = argv.includes('--json');
  // Presentation is a CLI concern, not a control-protocol parameter. Removing
  // it here lets every runtime command support the flag consistently.
  const runtimeArgs = rest.filter((argument) => argument !== '--json');
  const fileDownload = group === 'slack' && verb === 'file' && runtimeArgs[0] === 'download';
  const sessionNested =
    group === 'session' && (verb === 'model' || verb === 'thinking' || verb === 'archive');
  const command = fileDownload
    ? 'slack.file.download'
    : commandFor(group, verb, sessionNested ? runtimeArgs[0] : undefined);
  if (!command)
    throw Object.assign(new Error('Unsupported command. Run pi-tag-slack help for usage.'), {
      code: 'UNKNOWN_COMMAND',
    });
  return {
    kind: 'runtime',
    command,
    params: paramsFor(
      command,
      fileDownload ? runtimeArgs.slice(1) : sessionNested ? runtimeArgs.slice(1) : runtimeArgs,
    ),
    json,
  };
}

export function parseSetupOptions(args: string[]): SetupOptions {
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
  return {
    channel: value('channel'),
    cwd: value('cwd'),
    piBin: value('pi-bin'),
    model: value('model'),
    thinking: value('thinking'),
    botToken: value('bot-token'),
    appToken: value('app-token'),
    trustedUser: value('trusted-user'),
    reset: options.reset === true,
    yes: options.yes === true,
  };
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
  if (command === 'slack.history' || command === 'session.archive.list') {
    const flags = parseFlags(args, new Set(['limit', 'cursor', 'json']));
    return compact({ limit: numberFlag(flags.limit), cursor: flags.cursor });
  }
  if (command === 'slack.message' || command === 'slack.file.download') {
    parseFlags(args, new Set(['json']));
    return command === 'slack.message'
      ? { messageTs: positional(args, new Set(['json']))[0] }
      : { fileId: positional(args, new Set(['json']))[0] };
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
    const flags = parseFlags(args, new Set(['thread', 'text', 'file', 'json']), new Set(['file']));
    return compact({
      threadTs: flags.thread,
      text: flags.text,
      files: typeof flags.file === 'string' ? [flags.file] : flags.file,
    });
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
  if (command === 'trust.add' || command === 'trust.remove') return { userId: args[0] };
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
  return typeof value === 'string' ? Number(value) : undefined;
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
    } else result[name] = value;
    index += 1;
  }
  return result;
}
