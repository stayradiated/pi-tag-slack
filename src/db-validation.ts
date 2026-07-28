import type Database from 'better-sqlite3';

export const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const logLevels = new Set(['trace', 'debug', 'info', 'warn', 'error']);

export function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

export function validSlackTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+$/.test(value);
}

export function nonempty(value: unknown): value is string {
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

export function validateGatewayConfigRow(row: Record<string, unknown>): void {
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
  const acceptanceMetadata =
    (row.rpc_accepted_at === null && row.pi_session_id === null && row.run_sequence === null) ||
    (row.rpc_accepted_at !== null && row.pi_session_id !== null && row.run_sequence !== null);
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
    !acceptanceMetadata ||
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
    !(
      (row.rpc_accepted_at === null && row.pi_session_id === null && row.run_sequence === null) ||
      (row.rpc_accepted_at !== null && row.pi_session_id !== null && row.run_sequence !== null)
    ) ||
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
