import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensurePrivateFile, gatewayPaths } from './paths.js';

export const SCHEMA_VERSION = 2;
let db: Database.Database | undefined;
const now = () => new Date().toISOString();

const SQL = `
create table gateway_config (
 id integer primary key check(id = 1), channel_id text not null check(length(channel_id) > 1 and channel_id glob '[CG][A-Z0-9]*' and channel_id not glob '*[^A-Z0-9]*'), channel_label text not null check(trim(channel_label) <> ''),
 working_directory text not null check(trim(working_directory) <> ''), pi_binary text not null check(trim(pi_binary) <> ''), default_model text not null check(trim(default_model) <> ''), default_thinking text not null check(default_thinking in ('off','minimal','low','medium','high','xhigh','max')),
 session_model_override text check(session_model_override is null or trim(session_model_override) <> ''), session_thinking_override text check(session_thinking_override is null or session_thinking_override in ('off','minimal','low','medium','high','xhigh','max')),
 archive_retention_days integer not null check(archive_retention_days >= 0), media_retention_hours integer not null check(media_retention_hours >= 0), max_attachment_bytes integer not null check(max_attachment_bytes >= 0), max_total_attachment_bytes integer not null check(max_total_attachment_bytes >= 0), scheduler_batch_limit integer not null check(scheduler_batch_limit > 0), log_level text not null check(log_level in ('trace','debug','info','warn','error')), created_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at), updated_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at)
) strict;
create table trusted_users (user_id text primary key check(length(user_id) > 1 and user_id glob '[UW][A-Z0-9]*' and user_id not glob '*[^A-Z0-9]*'), label text not null check(trim(label) <> ''), created_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)) strict;
create table inbox (
 id integer primary key, slack_message_id text not null unique check(trim(slack_message_id) <> ''), sender_id text not null check(trim(sender_id) <> ''), sender_label text not null check(trim(sender_label) <> ''), content text not null, revision integer not null check(revision >= 1), message_ts text not null check(trim(message_ts) <> ''), thread_ts text not null check(trim(thread_ts) <> ''), attachments text not null check(json_valid(attachments) and json_type(attachments) = 'array'), state text not null check(state in ('open','resolved')), source_deleted_at text check(source_deleted_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', source_deleted_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', source_deleted_at) = source_deleted_at), resolution_reason text check(resolution_reason is null or trim(resolution_reason) <> ''), resolved_at text check(resolved_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) = resolved_at), reaction_desired text check(reaction_desired is null or trim(reaction_desired) <> ''), reaction_actual text check(reaction_actual is null or trim(reaction_actual) <> ''), reaction_error text check(reaction_error is null or trim(reaction_error) <> ''), reaction_next_attempt_at text check(reaction_next_attempt_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', reaction_next_attempt_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', reaction_next_attempt_at) = reaction_next_attempt_at), latest_reply_ts text check(latest_reply_ts is null or trim(latest_reply_ts) <> ''), latest_reply_at text check(latest_reply_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', latest_reply_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', latest_reply_at) = latest_reply_at), created_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at), updated_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
 check((state = 'open' and resolved_at is null and resolution_reason is null) or (state = 'resolved' and resolved_at is not null and resolution_reason is not null)),
 check((latest_reply_ts is null) = (latest_reply_at is null)),
 check(source_deleted_at is null or (state = 'resolved' and content = '' and attachments = '[]' and reaction_desired is null and reaction_actual is null and reaction_error is null and reaction_next_attempt_at is null))
) strict;
create index inbox_state_created on inbox(state, created_at desc, id desc);
create trigger inbox_no_reopen before update of state on inbox
when old.state = 'resolved' and new.state <> 'resolved'
begin
 select raise(abort, 'resolved inbox items cannot be reopened');
end;
create table slack_events (
 source_identity text primary key check(source_identity glob 'slack:event:*' and length(source_identity) > 12), kind text not null check(kind in ('new-message','edit','deletion')), inbox_id integer references inbox(id), inbox_revision integer check(inbox_revision is null or inbox_revision >= 1), outcome text not null check(outcome in ('created','updated','deleted','already-represented')), rpc_accepted_at text check(rpc_accepted_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', rpc_accepted_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', rpc_accepted_at) = rpc_accepted_at), pi_session_id text check(pi_session_id is null or trim(pi_session_id) <> ''), run_sequence integer check(run_sequence is null or run_sequence >= 0), created_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
 check(inbox_id is not null and inbox_revision is not null),
 check((pi_session_id is null) = (run_sequence is null)),
 check(rpc_accepted_at is not null or (pi_session_id is null and run_sequence is null)),
 check(rpc_accepted_at is null or outcome <> 'already-represented'),
 check((kind = 'new-message' and outcome in ('created','already-represented')) or (kind = 'edit' and outcome = 'updated') or (kind = 'deletion' and outcome = 'deleted'))
) strict;
create table schedules (
 id integer primary key, title text not null check(trim(title) <> ''), instructions text not null check(trim(instructions) <> ''), kind text not null check(kind in ('at','cron')), at_time text check(at_time is null or strftime('%Y-%m-%dT%H:%M:%fZ', at_time) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', at_time) = at_time), cron_expression text check(cron_expression is null or trim(cron_expression) <> ''), timezone text check(timezone is null or trim(timezone) <> ''), enabled integer not null check(enabled in (0,1)), next_run_at text check(next_run_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', next_run_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', next_run_at) = next_run_at), created_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at), updated_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
 check((kind='at' and at_time is not null and cron_expression is null and timezone is null) or (kind='cron' and at_time is null and cron_expression is not null and timezone is not null)),
 check((enabled = 0 and next_run_at is null) or (enabled = 1 and next_run_at is not null)),
 check(kind <> 'at' or next_run_at is null or next_run_at = at_time)
) strict;
create table tasks (
 id integer primary key, source text not null check(source in ('manual','schedule')), occurrence_key text unique check(occurrence_key is null or trim(occurrence_key) <> ''), schedule_id integer references schedules(id), title text not null check(trim(title) <> ''), instructions text not null check(trim(instructions) <> ''), catch_up_first_at text check(catch_up_first_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', catch_up_first_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', catch_up_first_at) = catch_up_first_at), catch_up_last_at text check(catch_up_last_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', catch_up_last_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', catch_up_last_at) = catch_up_last_at), catch_up_count integer check(catch_up_count is null or catch_up_count >= 2), state text not null check(state in ('open','resolved')), resolution_reason text check(resolution_reason is null or trim(resolution_reason) <> ''), resolved_at text check(resolved_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) = resolved_at), rpc_accepted_at text check(rpc_accepted_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', rpc_accepted_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', rpc_accepted_at) = rpc_accepted_at), pi_session_id text check(pi_session_id is null or trim(pi_session_id) <> ''), run_sequence integer check(run_sequence is null or run_sequence >= 0), created_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
 check((source='manual' and schedule_id is null and occurrence_key is null) or (source='schedule' and schedule_id is not null and occurrence_key is not null)),
 check((catch_up_first_at is null and catch_up_last_at is null and catch_up_count is null) or (source='schedule' and catch_up_first_at is not null and catch_up_last_at is not null and catch_up_count is not null and catch_up_first_at <= catch_up_last_at)),
 check((state = 'open' and resolved_at is null and resolution_reason is null) or (state = 'resolved' and resolved_at is not null and resolution_reason is not null)),
 check((pi_session_id is null) = (run_sequence is null)),
 check(rpc_accepted_at is not null or (pi_session_id is null and run_sequence is null))
) strict;
create index tasks_state_created on tasks(state, created_at desc, id desc);
create trigger tasks_no_reopen before update of state on tasks
when old.state = 'resolved' and new.state <> 'resolved'
begin
 select raise(abort, 'resolved tasks cannot be reopened');
end;
`;

export function initDb(path = gatewayPaths().db): Database.Database {
  if (db) {
    if (db.name !== path)
      throw new Error(`Database is already open at ${db.name}; cannot open ${path}.`);
    return db;
  }
  ensurePrivateFile(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const candidate = new Database(path);
  try {
    candidate.pragma('journal_mode = WAL');
    candidate.pragma('synchronous = FULL');
    candidate.pragma('foreign_keys = ON');
    candidate.pragma('busy_timeout = 5000');
    candidate.pragma('trusted_schema = OFF');
    validateRequiredPragmas(candidate);
    const version = Number(candidate.pragma('user_version', { simple: true }));
    const tables = candidate
      .prepare(
        "select count(*) count from sqlite_master where type='table' and name not like 'sqlite_%'",
      )
      .get() as { count: number };
    if (version !== 0 && version !== SCHEMA_VERSION)
      throw new Error(
        `Unsupported database schema version ${version}; run pi-tag-slack setup --reset.`,
      );
    if (version === 0 && tables.count)
      throw new Error('Legacy or malformed database detected; run pi-tag-slack setup --reset.');
    if (version === 0) candidate.exec(`${SQL} pragma user_version = 2;`);
    validateSchema(candidate);
    chmodSync(path, 0o600);
    db = candidate;
    return candidate;
  } catch (error) {
    candidate.close();
    throw error;
  }
}
export function validateRequiredPragmas(candidate: Database.Database): void {
  const expected: Array<[string, string | number]> = [
    ['journal_mode', 'wal'],
    ['synchronous', 2],
    ['foreign_keys', 1],
    ['busy_timeout', 5000],
    ['trusted_schema', 0],
  ];
  for (const [name, value] of expected) {
    const actual = candidate.pragma(name, { simple: true }) as unknown;
    if (
      typeof value === 'string' ? String(actual).toLowerCase() !== value : Number(actual) !== value
    )
      throw new Error(`Required SQLite ${name} setting could not be enabled.`);
  }
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim().replace(/;$/, '');
}

// sqlite_master preserves CREATE statements. Comparing the canonical complete
// definitions prevents a same-name table/index/trigger with weakened checks or
// foreign keys from passing startup validation.
const schemaDefinitions = new Map(
  [...SQL.matchAll(/create\s+(?:table|index|trigger)\s+\S+[\s\S]*?;(?=\s*create\s|\s*$)/gi)].map(
    (match) => {
      const statement = match[0];
      const name = /^create\s+(?:table|index|trigger)\s+(\S+)/i.exec(statement)?.[1];
      if (!name) throw new Error('Invalid built-in gateway schema definition.');
      return [name, normalizeSql(statement)];
    },
  ),
);

const schemaColumns: Record<string, string[]> = {
  gateway_config: [
    'id',
    'channel_id',
    'channel_label',
    'working_directory',
    'pi_binary',
    'default_model',
    'default_thinking',
    'session_model_override',
    'session_thinking_override',
    'archive_retention_days',
    'media_retention_hours',
    'max_attachment_bytes',
    'max_total_attachment_bytes',
    'scheduler_batch_limit',
    'log_level',
    'created_at',
    'updated_at',
  ],
  inbox: [
    'id',
    'slack_message_id',
    'sender_id',
    'sender_label',
    'content',
    'revision',
    'message_ts',
    'thread_ts',
    'attachments',
    'state',
    'source_deleted_at',
    'resolution_reason',
    'resolved_at',
    'reaction_desired',
    'reaction_actual',
    'reaction_error',
    'reaction_next_attempt_at',
    'latest_reply_ts',
    'latest_reply_at',
    'created_at',
    'updated_at',
  ],
  slack_events: [
    'source_identity',
    'kind',
    'inbox_id',
    'inbox_revision',
    'outcome',
    'rpc_accepted_at',
    'pi_session_id',
    'run_sequence',
    'created_at',
  ],
  schedules: [
    'id',
    'title',
    'instructions',
    'kind',
    'at_time',
    'cron_expression',
    'timezone',
    'enabled',
    'next_run_at',
    'created_at',
    'updated_at',
  ],
  tasks: [
    'id',
    'source',
    'occurrence_key',
    'schedule_id',
    'title',
    'instructions',
    'catch_up_first_at',
    'catch_up_last_at',
    'catch_up_count',
    'state',
    'resolution_reason',
    'resolved_at',
    'rpc_accepted_at',
    'pi_session_id',
    'run_sequence',
    'created_at',
  ],
  trusted_users: ['user_id', 'label', 'created_at'],
};

function malformedSchema(): never {
  throw new Error('Malformed gateway schema; run pi-tag-slack setup --reset.');
}

export function validateSchema(candidate: any = requireDb()): void {
  if (Number(candidate.pragma('user_version', { simple: true })) !== SCHEMA_VERSION)
    throw new Error('Invalid gateway schema; run pi-tag-slack setup --reset.');
  const tables = candidate
    .prepare(
      "select name, strict from pragma_table_list where schema = 'main' and type = 'table' and name not like 'sqlite_%'",
    )
    .all() as Array<{ name: string; strict: number }>;
  const expected = Object.keys(schemaColumns).sort();
  if (
    tables.length !== expected.length ||
    tables.some((table) => table.strict !== 1 || !expected.includes(table.name))
  )
    malformedSchema();
  for (const [table, columns] of Object.entries(schemaColumns)) {
    const actual = candidate
      .prepare(`select name from pragma_table_xinfo(?) where hidden = 0 order by cid`)
      .all(table)
      .map((row: { name: string }) => row.name);
    if (
      actual.length !== columns.length ||
      actual.some((name: string, index: number) => name !== columns[index])
    )
      malformedSchema();
  }
  const indexes = candidate
    .prepare(
      "select name from sqlite_master where type = 'index' and name not like 'sqlite_autoindex%'",
    )
    .all()
    .map((row: { name: string }) => row.name)
    .sort();
  if (indexes.join(',') !== 'inbox_state_created,tasks_state_created') malformedSchema();
  const triggers = candidate
    .prepare("select name from sqlite_master where type = 'trigger' order by name")
    .all()
    .map((row: { name: string }) => row.name);
  if (triggers.join(',') !== 'inbox_no_reopen,tasks_no_reopen') malformedSchema();
  const definitions = candidate
    .prepare(
      "select name, sql from sqlite_master where type in ('table', 'index', 'trigger') and name not like 'sqlite_%'",
    )
    .all() as Array<{ name: string; sql: string | null }>;
  if (
    definitions.length !== schemaDefinitions.size ||
    definitions.some(
      (definition) =>
        !definition.sql || schemaDefinitions.get(definition.name) !== normalizeSql(definition.sql),
    )
  )
    malformedSchema();
  const configCount = (candidate.prepare('select count(*) count from gateway_config').get() as any)
    .count;
  if (configCount > 1) throw new Error('Malformed gateway configuration singleton.');
  validatePersistedRows(candidate);
}
export interface GatewayConfigInput {
  channelId: string;
  channelLabel: string;
  workingDirectory: string;
  piBinary: string;
  defaultModel: string;
  defaultThinking: string;
  archiveRetentionDays?: number;
  mediaRetentionHours?: number;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  schedulerBatchLimit?: number;
  logLevel?: string;
}
/** Setup is the sole creator of the configuration singleton. */
export function createGatewayConfig(input: GatewayConfigInput): void {
  const d = requireDb();
  if (!/^[CG][A-Z0-9]+$/.test(input.channelId))
    throw new Error('Configured Slack conversation must be a raw C... or G... ID.');
  if (
    !input.channelLabel.trim() ||
    !input.workingDirectory.trim() ||
    !input.piBinary.trim() ||
    !input.defaultModel.trim()
  )
    throw new Error('Gateway configuration contains an empty required value.');
  const thinking = input.defaultThinking;
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking))
    throw new Error('Invalid default thinking level.');
  const stamp = now();
  const r = d
    .prepare(
      'insert into gateway_config (id,channel_id,channel_label,working_directory,pi_binary,default_model,default_thinking,archive_retention_days,media_retention_hours,max_attachment_bytes,max_total_attachment_bytes,scheduler_batch_limit,log_level,created_at,updated_at) values (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      input.channelId,
      input.channelLabel,
      input.workingDirectory,
      input.piBinary,
      input.defaultModel,
      thinking,
      input.archiveRetentionDays ?? 30,
      input.mediaRetentionHours ?? 168,
      input.maxAttachmentBytes ?? 26214400,
      input.maxTotalAttachmentBytes ?? 52428800,
      input.schedulerBatchLimit ?? 1,
      input.logLevel ?? 'info',
      stamp,
      stamp,
    );
  if (r.changes !== 1) throw new Error('Gateway configuration already exists; use setup --reset.');
}
const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const logLevels = new Set(['trace', 'debug', 'info', 'warn', 'error']);

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function validSlackTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nullableTimestamp(value: unknown): boolean {
  return value === null || validTimestamp(value);
}

function nullableNonempty(value: unknown): boolean {
  return value === null || nonempty(value);
}

function validOptionalString(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

function validateGatewayConfigRow(row: Record<string, unknown>): void {
  if (
    row.id !== 1 ||
    typeof row.channel_id !== 'string' ||
    !/^[CG][A-Z0-9]+$/.test(row.channel_id) ||
    ['channel_label', 'working_directory', 'pi_binary', 'default_model'].some(
      (key) => typeof row[key] !== 'string' || !String(row[key]).trim(),
    ) ||
    typeof row.default_thinking !== 'string' ||
    !thinkingLevels.has(row.default_thinking) ||
    !validOptionalString(row.session_model_override) ||
    (row.session_thinking_override !== null &&
      (typeof row.session_thinking_override !== 'string' ||
        !thinkingLevels.has(row.session_thinking_override))) ||
    ![
      'archive_retention_days',
      'media_retention_hours',
      'max_attachment_bytes',
      'max_total_attachment_bytes',
    ].every((key) => Number.isInteger(row[key]) && Number(row[key]) >= 0) ||
    !Number.isInteger(row.scheduler_batch_limit) ||
    Number(row.scheduler_batch_limit) <= 0 ||
    typeof row.log_level !== 'string' ||
    !logLevels.has(row.log_level) ||
    !validTimestamp(row.created_at) ||
    !validTimestamp(row.updated_at)
  ) {
    throw new Error('Malformed gateway configuration singleton.');
  }
}

export function validateTrustedUserRow(row: Record<string, unknown>): void {
  if (
    typeof row.user_id !== 'string' ||
    !/^[UW][A-Z0-9]+$/.test(row.user_id) ||
    !nonempty(row.label) ||
    !validTimestamp(row.created_at)
  )
    throw new Error('Malformed persisted trusted-user data.');
}

export function validateInboxRow(row: Record<string, unknown>): void {
  let attachments: unknown;
  try {
    attachments = typeof row.attachments === 'string' ? JSON.parse(row.attachments) : undefined;
  } catch {
    attachments = undefined;
  }
  const resolved = row.state === 'resolved';
  const deleted = row.source_deleted_at !== null;
  if (
    !Number.isSafeInteger(row.id) ||
    Number(row.id) < 1 ||
    !nonempty(row.slack_message_id) ||
    !nonempty(row.sender_id) ||
    !nonempty(row.sender_label) ||
    typeof row.content !== 'string' ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    !validSlackTimestamp(row.message_ts) ||
    !validSlackTimestamp(row.thread_ts) ||
    !Array.isArray(attachments) ||
    (row.state !== 'open' && !resolved) ||
    !nullableTimestamp(row.source_deleted_at) ||
    !nullableNonempty(row.resolution_reason) ||
    !nullableTimestamp(row.resolved_at) ||
    !nullableNonempty(row.reaction_desired) ||
    !nullableNonempty(row.reaction_actual) ||
    !nullableNonempty(row.reaction_error) ||
    !nullableTimestamp(row.reaction_next_attempt_at) ||
    (row.latest_reply_ts !== null && !validSlackTimestamp(row.latest_reply_ts)) ||
    !nullableTimestamp(row.latest_reply_at) ||
    (row.latest_reply_ts === null) !== (row.latest_reply_at === null) ||
    !validTimestamp(row.created_at) ||
    !validTimestamp(row.updated_at) ||
    (resolved
      ? row.resolved_at === null || !nonempty(row.resolution_reason)
      : row.resolved_at !== null || row.resolution_reason !== null) ||
    (deleted &&
      (!resolved ||
        row.content !== '' ||
        row.attachments !== '[]' ||
        row.reaction_desired !== null ||
        row.reaction_actual !== null ||
        row.reaction_error !== null ||
        row.reaction_next_attempt_at !== null))
  )
    throw new Error('Malformed persisted inbox data.');
}

export function validateSlackEventRow(row: Record<string, unknown>): void {
  const acceptancePair = (row.pi_session_id === null) === (row.run_sequence === null);
  const kindOutcome =
    (row.kind === 'new-message' &&
      (row.outcome === 'created' || row.outcome === 'already-represented')) ||
    (row.kind === 'edit' && row.outcome === 'updated') ||
    (row.kind === 'deletion' && row.outcome === 'deleted');
  if (
    typeof row.source_identity !== 'string' ||
    !/^slack:event:[A-Za-z0-9_-]+$/.test(row.source_identity) ||
    !kindOutcome ||
    !Number.isSafeInteger(row.inbox_id) ||
    Number(row.inbox_id) < 1 ||
    !Number.isSafeInteger(row.inbox_revision) ||
    Number(row.inbox_revision) < 1 ||
    !nullableTimestamp(row.rpc_accepted_at) ||
    !nullableNonempty(row.pi_session_id) ||
    (row.run_sequence !== null &&
      (!Number.isSafeInteger(row.run_sequence) || Number(row.run_sequence) < 0)) ||
    !acceptancePair ||
    (row.rpc_accepted_at === null && row.pi_session_id !== null) ||
    (row.rpc_accepted_at !== null && row.outcome === 'already-represented') ||
    !validTimestamp(row.created_at)
  )
    throw new Error('Malformed persisted Slack-event data.');
}

export type ScheduleRow = {
  id: number;
  title: string;
  instructions: string;
  kind: 'at' | 'cron';
  at_time: string | null;
  cron_expression: string | null;
  timezone: string | null;
  enabled: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export function validateScheduleRow(row: Record<string, unknown>): asserts row is ScheduleRow {
  const at = row.kind === 'at';
  const cron = row.kind === 'cron';
  let timezoneValid = true;
  if (cron && typeof row.timezone === 'string') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: row.timezone });
    } catch {
      timezoneValid = false;
    }
  }
  if (
    !Number.isSafeInteger(row.id) ||
    Number(row.id) < 1 ||
    !nonempty(row.title) ||
    !nonempty(row.instructions) ||
    (!at && !cron) ||
    !nullableTimestamp(row.at_time) ||
    !nullableNonempty(row.cron_expression) ||
    !nullableNonempty(row.timezone) ||
    (row.enabled !== 0 && row.enabled !== 1) ||
    !nullableTimestamp(row.next_run_at) ||
    !validTimestamp(row.created_at) ||
    !validTimestamp(row.updated_at) ||
    (at &&
      (row.at_time === null ||
        row.cron_expression !== null ||
        row.timezone !== null ||
        (row.next_run_at !== null && row.next_run_at !== row.at_time))) ||
    (cron &&
      (row.at_time !== null ||
        !nonempty(row.cron_expression) ||
        row.cron_expression.trim().split(/\s+/).length !== 5 ||
        !nonempty(row.timezone) ||
        !timezoneValid)) ||
    (row.enabled === 0) !== (row.next_run_at === null)
  )
    throw new Error('Malformed persisted schedule data.');
}

function configuredRow(d = requireDb()): Record<string, unknown> {
  const row = d.prepare('select * from gateway_config where id=1').get() as
    Record<string, unknown> | undefined;
  if (!row) throw new Error('Gateway is not configured; run pi-tag-slack setup.');
  validateGatewayConfigRow(row);
  return row;
}

export function requireConfiguredDb(): Database.Database {
  const d = requireDb();
  configuredRow(d);
  return d;
}

/** Validates schema v2 and the complete configuration singleton on an injected connection. */
export function validateConfiguredDatabase(candidate: Database.Database): void {
  validateSchema(candidate);
  configuredRow(candidate);
}

const mutableConfigColumns = {
  defaultModel: 'default_model',
  defaultThinking: 'default_thinking',
  sessionModelOverride: 'session_model_override',
  sessionThinkingOverride: 'session_thinking_override',
  archiveRetentionDays: 'archive_retention_days',
  mediaRetentionHours: 'media_retention_hours',
  maxAttachmentBytes: 'max_attachment_bytes',
  maxTotalAttachmentBytes: 'max_total_attachment_bytes',
  schedulerBatchLimit: 'scheduler_batch_limit',
  logLevel: 'log_level',
} as const;

export type MutableConfigKey = keyof typeof mutableConfigColumns;

function configValue(key: MutableConfigKey, value: unknown): string | number {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Configuration value for ${key} must be non-empty.`);
  const trimmed = value.trim();
  if (key === 'defaultModel' || key === 'sessionModelOverride') return trimmed;
  if (key === 'defaultThinking' || key === 'sessionThinkingOverride') {
    if (!thinkingLevels.has(trimmed)) throw new Error(`Invalid thinking level: ${trimmed}.`);
    return trimmed;
  }
  if (key === 'logLevel') {
    if (!logLevels.has(trimmed)) throw new Error(`Invalid log level: ${trimmed}.`);
    return trimmed;
  }
  if (!/^\d+$/.test(trimmed))
    throw new Error(`Configuration value for ${key} must be a non-negative integer.`);
  const numeric = Number(trimmed);
  if (!Number.isSafeInteger(numeric) || (key === 'schedulerBatchLimit' && numeric < 1))
    throw new Error(`Configuration value for ${key} is out of range.`);
  return numeric;
}

export function readGatewayConfig(): Record<string, unknown> {
  return { ...configuredRow() };
}

/** Updates only non-structural settings after validating the complete resulting row. */
export function updateGatewayConfig(
  key: MutableConfigKey,
  value: unknown,
): Record<string, unknown> {
  const d = requireDb();
  const column = mutableConfigColumns[key];
  if (!column) throw new Error(`Unsupported configuration key: ${key}`);
  const next = { ...configuredRow(d), [column]: configValue(key, value), updated_at: now() };
  validateGatewayConfigRow(next);
  d.prepare(`update gateway_config set ${column} = ?, updated_at = ? where id = 1`).run(
    next[column],
    next.updated_at,
  );
  return { ...next };
}

/** Clears one of the optional session overrides. */
export function resetGatewayConfig(key: MutableConfigKey): Record<string, unknown> {
  if (key !== 'sessionModelOverride' && key !== 'sessionThinkingOverride')
    throw new Error(`Configuration key cannot be reset: ${key}`);
  const d = requireDb();
  const column = mutableConfigColumns[key];
  const next = { ...configuredRow(d), [column]: null, updated_at: now() };
  validateGatewayConfigRow(next);
  d.prepare(`update gateway_config set ${column} = null, updated_at = ? where id = 1`).run(
    next.updated_at,
  );
  return { ...next };
}
function requireDb(): Database.Database {
  if (!db) throw new Error('Database is not open.');
  return db;
}
export function closeDb(): void {
  db?.close();
  db = undefined;
}
export function publicId(kind: 'inbox' | 'task' | 'schedule', id: number): string {
  return `${kind}-${id}`;
}
export function parsePublicId(kind: 'inbox' | 'task' | 'schedule', value: string): number {
  const match = new RegExp(`^${kind}-(\\d+)$`).exec(value);
  const id = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 1)
    throw Object.assign(new Error(`Invalid ${kind} ID.`), { code: 'INVALID_PARAMS' });
  return id;
}
export function addTrustedUser(userId: string, label = userId): boolean {
  if (!/^[UW][A-Z0-9]+$/.test(userId))
    throw Object.assign(new Error('Slack user ID must be a raw uppercase U... or W... ID.'), {
      code: 'INVALID_PARAMS',
    });
  if (!label.trim())
    throw Object.assign(new Error('Slack user label must be non-empty.'), {
      code: 'INVALID_PARAMS',
    });
  return (
    requireConfiguredDb()
      .prepare('insert into trusted_users values (?, ?, ?) on conflict(user_id) do nothing')
      .run(userId, label, now()).changes > 0
  );
}
export function removeTrustedUser(userId: string): boolean {
  return (
    requireConfiguredDb().prepare('delete from trusted_users where user_id=?').run(userId).changes >
    0
  );
}
export function isTrustedUser(userId: string): boolean {
  return Boolean(
    requireConfiguredDb().prepare('select 1 from trusted_users where user_id=?').get(userId),
  );
}

export type SlackMutation = {
  eventId: string;
  kind: 'new-message' | 'edit' | 'deletion';
  messageId: string;
  senderId: string;
  senderLabel: string;
  content?: string;
  messageTs: string;
  threadTs?: string;
  attachments?: unknown[];
};
/** Atomically records a delivery and mutates an open source snapshot. Ignored mutations are deliberately not ledgered. */
export function markSlackEventAccepted(
  eventId: string,
  metadata: { acceptedAt: string; sessionId?: string; runSequence?: number },
): void {
  requireConfiguredDb()
    .prepare(
      'update slack_events set rpc_accepted_at=?, pi_session_id=?, run_sequence=? where source_identity=?',
    )
    .run(
      metadata.acceptedAt,
      metadata.sessionId ?? null,
      metadata.runSequence ?? null,
      `slack:event:${eventId}`,
    );
}

export function inboxSnapshot(id: number): Record<string, unknown> | undefined {
  const row = requireConfiguredDb().prepare('select * from inbox where id=?').get(id) as
    Record<string, unknown> | undefined;
  if (row) validateInboxRow(row);
  return row;
}

/** Creates a manual task before attempting its intentionally non-atomic pi delivery. */
export type TaskRow = {
  id: number;
  source: 'manual' | 'schedule';
  occurrence_key: string | null;
  schedule_id: number | null;
  title: string;
  instructions: string;
  catch_up_first_at: string | null;
  catch_up_last_at: string | null;
  catch_up_count: number | null;
  state: 'open' | 'resolved';
  resolution_reason: string | null;
  resolved_at: string | null;
  rpc_accepted_at: string | null;
  pi_session_id: string | null;
  run_sequence: number | null;
  created_at: string;
};

export function validateTaskRow(row: Record<string, unknown>): asserts row is TaskRow {
  const scheduled = row.source === 'schedule';
  const resolved = row.state === 'resolved';
  const catchUp =
    row.catch_up_first_at === null && row.catch_up_last_at === null && row.catch_up_count === null;
  if (
    !Number.isSafeInteger(row.id) ||
    Number(row.id) < 1 ||
    (row.source !== 'manual' && !scheduled) ||
    !nonempty(row.title) ||
    !nonempty(row.instructions) ||
    !nullableNonempty(row.occurrence_key) ||
    (scheduled
      ? !Number.isSafeInteger(row.schedule_id) || Number(row.schedule_id) < 1 || !row.occurrence_key
      : row.schedule_id !== null || row.occurrence_key !== null) ||
    (row.state !== 'open' && !resolved) ||
    !nullableNonempty(row.resolution_reason) ||
    !nullableTimestamp(row.resolved_at) ||
    (resolved
      ? row.resolved_at === null || !nonempty(row.resolution_reason)
      : row.resolved_at !== null || row.resolution_reason !== null) ||
    !nullableTimestamp(row.rpc_accepted_at) ||
    !nullableNonempty(row.pi_session_id) ||
    (row.run_sequence !== null &&
      (!Number.isSafeInteger(row.run_sequence) || Number(row.run_sequence) < 0)) ||
    (row.pi_session_id === null) !== (row.run_sequence === null) ||
    (row.rpc_accepted_at === null && row.pi_session_id !== null) ||
    !validTimestamp(row.created_at) ||
    (!catchUp &&
      (!scheduled ||
        !validTimestamp(row.catch_up_first_at) ||
        !validTimestamp(row.catch_up_last_at) ||
        row.catch_up_first_at > row.catch_up_last_at ||
        !Number.isInteger(row.catch_up_count) ||
        Number(row.catch_up_count) < 2))
  )
    throw new Error('Malformed persisted task data.');
}

export function validatePersistedRows(candidate: Database.Database): void {
  const validators: Array<[string, (row: Record<string, unknown>) => void]> = [
    ['gateway_config', validateGatewayConfigRow],
    ['trusted_users', validateTrustedUserRow],
    ['inbox', validateInboxRow],
    ['slack_events', validateSlackEventRow],
    ['schedules', validateScheduleRow],
    ['tasks', validateTaskRow],
  ];
  for (const [table, validate] of validators) {
    for (const row of candidate.prepare(`select * from ${table}`).all() as Array<
      Record<string, unknown>
    >)
      validate(row);
  }
  if (candidate.prepare('pragma foreign_key_check').all().length)
    throw new Error('Malformed persisted relationship data.');
}

export function createManualTask(title: string, instructions: string): Record<string, unknown> {
  const result = requireConfiguredDb()
    .prepare(
      "insert into tasks (source, title, instructions, state, created_at) values ('manual', ?, ?, 'open', ?)",
    )
    .run(title, instructions, now());
  const row = requireConfiguredDb()
    .prepare('select * from tasks where id=?')
    .get(result.lastInsertRowid) as Record<string, unknown>;
  validateTaskRow(row);
  return row;
}

export function createScheduleRow(input: {
  title: string;
  instructions: string;
  kind: 'at' | 'cron';
  at?: string;
  cron?: string;
  timezone?: string;
  nextRunAt?: string;
}): ScheduleRow {
  const d = requireConfiguredDb();
  const stamp = now();
  const result = d
    .prepare(
      'insert into schedules (title,instructions,kind,at_time,cron_expression,timezone,enabled,next_run_at,created_at,updated_at) values (?,?,?,?,?,?,1,?,?,?)',
    )
    .run(
      input.title,
      input.instructions,
      input.kind,
      input.at ?? null,
      input.cron ?? null,
      input.timezone ?? null,
      input.kind === 'at' ? input.at : input.nextRunAt,
      stamp,
      stamp,
    );
  const row = d.prepare('select * from schedules where id=?').get(result.lastInsertRowid) as Record<
    string,
    unknown
  >;
  validateScheduleRow(row);
  return row;
}

export function scheduleRow(id: number): ScheduleRow | undefined {
  const row = requireConfiguredDb().prepare('select * from schedules where id=?').get(id) as
    Record<string, unknown> | undefined;
  if (row) validateScheduleRow(row);
  return row;
}

export function listScheduleRows(
  limit: number,
  cursor?: { createdAt: string; id: number },
): ScheduleRow[] {
  const d = requireConfiguredDb();
  const rows = (
    cursor
      ? d
          .prepare(
            'select * from schedules where created_at < ? or (created_at = ? and id < ?) order by created_at desc, id desc limit ?',
          )
          .all(cursor.createdAt, cursor.createdAt, cursor.id, limit)
      : d.prepare('select * from schedules order by created_at desc, id desc limit ?').all(limit)
  ) as Array<Record<string, unknown>>;
  for (const row of rows) validateScheduleRow(row);
  return rows as ScheduleRow[];
}

export function setScheduleEnabled(
  id: number,
  enabled: boolean,
  nextRunAt: string | null,
): ScheduleRow {
  const d = requireConfiguredDb();
  if (
    d
      .prepare('update schedules set enabled=?, next_run_at=?, updated_at=? where id=?')
      .run(enabled ? 1 : 0, nextRunAt, now(), id).changes !== 1
  )
    throw new Error(`Schedule schedule-${id} was not found.`);
  return scheduleRow(id)!;
}

export function removeScheduleRow(id: number): boolean {
  try {
    return requireConfiguredDb().prepare('delete from schedules where id=?').run(id).changes === 1;
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY')
      throw Object.assign(new Error('A schedule with durable tasks cannot be removed.'), {
        code: 'INVALID_STATE',
      });
    throw error;
  }
}

/** Atomically creates one task per due definition and advances it. Recurring downtime is coalesced. */
export function materializeDueScheduleTasks(
  current: string,
  nextCron: (row: ScheduleRow, after: string) => string,
): Array<Record<string, unknown>> {
  const d = requireConfiguredDb();
  const batch = Number((configuredRow(d) as any).scheduler_batch_limit);
  return d.transaction(() => {
    const due = d
      .prepare(
        'select * from schedules where enabled=1 and next_run_at is not null and next_run_at <= ? order by next_run_at, id limit ?',
      )
      .all(current, batch) as Array<Record<string, unknown>>;
    for (const row of due) validateScheduleRow(row);
    const created: Array<Record<string, unknown>> = [];
    for (const row of due as ScheduleRow[]) {
      const occurrence = row.next_run_at!;
      let last = occurrence;
      let count = 1;
      let next: string | undefined;
      if (row.kind === 'cron') {
        next = nextCron(row, last);
        while (next <= current) {
          last = next;
          count += 1;
          next = nextCron(row, last);
        }
      }
      const catchUp = row.kind === 'cron' && count > 1;
      const key = catchUp
        ? `schedule:${row.id}:through:${last}`
        : `schedule:${row.id}:at:${occurrence}`;
      const inserted = d
        .prepare(
          "insert into tasks (source,occurrence_key,schedule_id,title,instructions,catch_up_first_at,catch_up_last_at,catch_up_count,state,created_at) values ('schedule',?,?,?,?,?,?,?, 'open', ? ) on conflict(occurrence_key) do nothing",
        )
        .run(
          key,
          row.id,
          row.title,
          row.instructions,
          catchUp ? occurrence : null,
          catchUp ? last : null,
          catchUp ? count : null,
          current,
        );
      if (inserted.changes) {
        const task = d
          .prepare('select * from tasks where id=?')
          .get(inserted.lastInsertRowid) as Record<string, unknown>;
        validateTaskRow(task);
        created.push(task);
      }
      if (row.kind === 'at') {
        d.prepare('update schedules set enabled=0, next_run_at=null, updated_at=? where id=?').run(
          current,
          row.id,
        );
      } else {
        d.prepare('update schedules set next_run_at=?, updated_at=? where id=?').run(
          next!,
          current,
          row.id,
        );
      }
    }
    return created;
  })();
}

/** Records only an RPC command that pi has explicitly accepted. */
export function markTaskAccepted(
  id: number,
  metadata: { acceptedAt: string; sessionId?: string; runSequence?: number },
): void {
  requireConfiguredDb()
    .prepare('update tasks set rpc_accepted_at=?, pi_session_id=?, run_sequence=? where id=?')
    .run(metadata.acceptedAt, metadata.sessionId ?? null, metadata.runSequence ?? null, id);
}

/** Existing work for a single startup/reset recovery message; this never changes acceptance metadata. */
export function openWorkSummary(): {
  inboxTotal: number;
  inbox: Array<Record<string, unknown>>;
  taskTotal: number;
  tasks: Array<Record<string, unknown>>;
} {
  const d = requireConfiguredDb();
  const recent = (table: 'inbox' | 'tasks') => {
    const result = d
      .prepare(
        `select * from ${table} where state='open' order by created_at desc, id desc limit 3`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of result) {
      if (table === 'inbox') validateInboxRow(row);
      else validateTaskRow(row);
    }
    return result;
  };
  return {
    inboxTotal: (
      d.prepare("select count(*) count from inbox where state='open'").get() as { count: number }
    ).count,
    inbox: recent('inbox'),
    taskTotal: (
      d.prepare("select count(*) count from tasks where state='open'").get() as { count: number }
    ).count,
    tasks: recent('tasks'),
  };
}

/** Records best-effort gateway reaction reconciliation without changing inbox lifecycle. */
export function setInboxWorking(id: number): Record<string, unknown> {
  const d = requireConfiguredDb();
  const row = inboxSnapshot(id);
  if (!row) throw new Error(`Inbox item inbox-${id} was not found.`);
  if (row.state !== 'open') throw new Error('Inbox item is already resolved.');
  d.prepare(
    "update inbox set reaction_desired='hourglass_flowing_sand', reaction_error=null, reaction_next_attempt_at=null, updated_at=? where id=?",
  ).run(now(), id);
  return inboxSnapshot(id)!;
}

/** Returns abandoned in-progress markers to the open-work receipt state. */
export function revertOpenInboxWorkingReactions(): number {
  const stamp = now();
  return requireConfiguredDb()
    .prepare(
      "update inbox set reaction_desired='eyes', reaction_error=null, reaction_next_attempt_at=null, updated_at=? where state='open' and reaction_desired='hourglass_flowing_sand'",
    )
    .run(stamp).changes;
}

/** Resolves an open inbox after a confirmed Slack reply, preserving terminal snapshots. */
export function recordInboxReply(id: number, replyTs: string): void {
  const d = requireConfiguredDb();
  d.transaction(() => {
    const row = inboxSnapshot(id);
    if (!row) throw new Error(`Inbox item inbox-${id} was not found.`);
    if (row.source_deleted_at) {
      const error = new Error('The Slack source message was deleted.') as Error & { code: string };
      error.code = 'SOURCE_DELETED';
      throw error;
    }
    const stamp = now();
    if (row.state === 'open') {
      d.prepare(
        "update inbox set state='resolved', resolution_reason='replied', resolved_at=?, latest_reply_ts=?, latest_reply_at=?, reaction_desired=null, reaction_error=null, reaction_next_attempt_at=null, updated_at=? where id=?",
      ).run(stamp, replyTs, stamp, stamp, id);
    } else {
      d.prepare(
        'update inbox set latest_reply_ts=?, latest_reply_at=?, updated_at=? where id=?',
      ).run(replyTs, stamp, stamp, id);
    }
  })();
}

export function recordInboxReaction(
  id: number,
  state: {
    desired?: string | null;
    actual?: string | null;
    error?: string | null;
    nextAttemptAt?: string | null;
  },
): void {
  const d = requireConfiguredDb();
  const fields: string[] = ['updated_at=?'];
  const values: unknown[] = [now()];
  if (Object.hasOwn(state, 'desired')) {
    fields.push('reaction_desired=?');
    values.push(state.desired);
  }
  if (Object.hasOwn(state, 'actual')) {
    fields.push('reaction_actual=?');
    values.push(state.actual);
  }
  if (Object.hasOwn(state, 'error')) {
    fields.push('reaction_error=?');
    values.push(state.error);
  }
  if (Object.hasOwn(state, 'nextAttemptAt')) {
    fields.push('reaction_next_attempt_at=?');
    values.push(state.nextAttemptAt);
  }
  values.push(id);
  d.prepare(`update inbox set ${fields.join(', ')} where id=?`).run(...values);
}

export function inboxReactionsDue(limit: number): Array<Record<string, unknown>> {
  const rows = requireConfiguredDb()
    .prepare(
      'select * from inbox where (reaction_desired is not reaction_actual) and (reaction_next_attempt_at is null or reaction_next_attempt_at <= ?) order by updated_at, id limit ?',
    )
    .all(now(), limit) as Array<Record<string, unknown>>;
  for (const row of rows) validateInboxRow(row);
  return rows;
}

export function ingestSlackEvent(event: SlackMutation): {
  duplicate: boolean;
  ignored: boolean;
  inboxId?: number;
  revision?: number;
  outcome: string;
} {
  if (!event.eventId || !/^[A-Za-z0-9_-]+$/.test(event.eventId))
    throw new Error('Missing or invalid Slack top-level event_id.');
  if (!event.messageId || !event.senderId || !event.senderLabel || !event.messageTs)
    throw new Error('Slack mutation lacks required message identity fields.');
  const d = requireConfiguredDb();
  const identity = `slack:event:${event.eventId}`;
  return d.transaction(() => {
    if (d.prepare('select 1 from slack_events where source_identity=?').get(identity))
      return { duplicate: true, ignored: false, outcome: 'duplicate' };
    const existing = d
      .prepare('select * from inbox where slack_message_id=?')
      .get(event.messageId) as Record<string, unknown> | undefined;
    if (existing) validateInboxRow(existing);
    if (event.kind === 'new-message') {
      if (existing) {
        d.prepare('insert into slack_events values (?, ?, ?, ?, ?, null, null, null, ?)').run(
          identity,
          event.kind,
          existing.id,
          existing.revision,
          'already-represented',
          now(),
        );
        return {
          duplicate: false,
          ignored: false,
          inboxId: Number(existing.id),
          revision: Number(existing.revision),
          outcome: 'already-represented',
        };
      }
      const stamp = now();
      const result = d
        .prepare(
          "insert into inbox (slack_message_id,sender_id,sender_label,content,revision,message_ts,thread_ts,attachments,state,created_at,updated_at,reaction_desired) values (?,?,?,?,1,?,?,? ,'open',?,?,'eyes')",
        )
        .run(
          event.messageId,
          event.senderId,
          event.senderLabel,
          event.content ?? '',
          event.messageTs,
          event.threadTs ?? event.messageTs,
          JSON.stringify(event.attachments ?? []),
          stamp,
          stamp,
        );
      const id = Number(result.lastInsertRowid);
      d.prepare('insert into slack_events values (?, ?, ?, 1, ?, null, null, null, ?)').run(
        identity,
        event.kind,
        id,
        'created',
        stamp,
      );
      return { duplicate: false, ignored: false, inboxId: id, revision: 1, outcome: 'created' };
    }
    if (!existing || existing.state !== 'open')
      return { duplicate: false, ignored: true, outcome: 'ignored' };
    const stamp = now();
    if (event.kind === 'edit') {
      const rev = Number(existing.revision) + 1;
      d.prepare(
        'update inbox set content=?, attachments=?, revision=?, updated_at=? where id=?',
      ).run(event.content ?? '', JSON.stringify(event.attachments ?? []), rev, stamp, existing.id);
      d.prepare('insert into slack_events values (?, ?, ?, ?, ?, null, null, null, ?)').run(
        identity,
        event.kind,
        existing.id,
        rev,
        'updated',
        stamp,
      );
      return {
        duplicate: false,
        ignored: false,
        inboxId: Number(existing.id),
        revision: rev,
        outcome: 'updated',
      };
    }
    d.prepare(
      "update inbox set content='', attachments='[]', state='resolved', source_deleted_at=?, resolution_reason='source-deleted', resolved_at=?, updated_at=?, reaction_desired=null, reaction_actual=null, reaction_error=null, reaction_next_attempt_at=null where id=?",
    ).run(stamp, stamp, stamp, existing.id);
    d.prepare('insert into slack_events values (?, ?, ?, ?, ?, null, null, null, ?)').run(
      identity,
      event.kind,
      existing.id,
      existing.revision,
      'deleted',
      stamp,
    );
    return {
      duplicate: false,
      ignored: false,
      inboxId: Number(existing.id),
      revision: Number(existing.revision),
      outcome: 'deleted',
    };
  })();
}
