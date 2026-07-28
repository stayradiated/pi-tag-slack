/**
 * Complete SQLite schema plus immutable metadata used to verify it at startup.
 * Keeping this declarative data separate makes db.ts easier to navigate.
 */

export const SQL = `
create table gateway_config (
 id integer primary key check(id = 1), channel_id text not null check(length(channel_id) > 1 and channel_id glob '[CG][A-Z0-9]*' and channel_id not glob '*[^A-Z0-9]*'), channel_label text not null check(trim(channel_label) <> ''),
 working_directory text not null check(trim(working_directory) <> ''), pi_binary text not null check(trim(pi_binary) <> ''), default_model text not null check(trim(default_model) <> ''), default_thinking text not null check(default_thinking in ('off','minimal','low','medium','high','xhigh','max')),
 session_model_override text check(session_model_override is null or trim(session_model_override) <> ''), session_thinking_override text check(session_thinking_override is null or session_thinking_override in ('off','minimal','low','medium','high','xhigh','max')),
 archive_retention_days integer not null check(archive_retention_days >= 0), media_retention_hours integer not null check(media_retention_hours >= 0), max_attachment_bytes integer not null check(max_attachment_bytes >= 0), max_total_attachment_bytes integer not null check(max_total_attachment_bytes >= 0), scheduler_batch_limit integer not null check(scheduler_batch_limit > 0), log_level text not null check(log_level in ('trace','debug','info','warn','error')), created_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at), updated_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at)
) strict;
create table trusted_users (user_id text primary key check(length(user_id) > 1 and user_id glob '[UW][A-Z0-9]*' and user_id not glob '*[^A-Z0-9]*'), label text not null check(trim(label) <> ''), created_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)) strict;
create table inbox (
 id integer primary key, slack_message_id text not null unique check(trim(slack_message_id) <> ''), sender_id text not null check(trim(sender_id) <> ''), sender_label text not null check(trim(sender_label) <> ''), content text not null, revision integer not null check(revision >= 1), message_ts text not null check(length(message_ts) >= 3 and message_ts not glob '*[^0-9.]*' and instr(message_ts, '.') > 1 and instr(message_ts, '.') < length(message_ts) and length(message_ts) - length(replace(message_ts, '.', '')) = 1), thread_ts text not null check(length(thread_ts) >= 3 and thread_ts not glob '*[^0-9.]*' and instr(thread_ts, '.') > 1 and instr(thread_ts, '.') < length(thread_ts) and length(thread_ts) - length(replace(thread_ts, '.', '')) = 1), attachments text not null check(json_valid(attachments) and json_type(attachments) = 'array'), state text not null check(state in ('open','resolved')), source_deleted_at text check(source_deleted_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', source_deleted_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', source_deleted_at) = source_deleted_at), resolution_reason text check(resolution_reason is null or trim(resolution_reason) <> ''), resolved_at text check(resolved_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) = resolved_at), reaction_desired text check(reaction_desired is null or trim(reaction_desired) <> ''), reaction_actual text check(reaction_actual is null or trim(reaction_actual) <> ''), reaction_error text check(reaction_error is null or trim(reaction_error) <> ''), reaction_next_attempt_at text check(reaction_next_attempt_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', reaction_next_attempt_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', reaction_next_attempt_at) = reaction_next_attempt_at), latest_reply_ts text check(latest_reply_ts is null or (length(latest_reply_ts) >= 3 and latest_reply_ts not glob '*[^0-9.]*' and instr(latest_reply_ts, '.') > 1 and instr(latest_reply_ts, '.') < length(latest_reply_ts) and length(latest_reply_ts) - length(replace(latest_reply_ts, '.', '')) = 1)), latest_reply_at text check(latest_reply_at is null or strftime('%Y-%m-%dT%H:%M:%fZ', latest_reply_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', latest_reply_at) = latest_reply_at), created_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at), updated_at text not null check(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) is not null and strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
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
 check((rpc_accepted_at is null and pi_session_id is null and run_sequence is null) or (rpc_accepted_at is not null and pi_session_id is not null and run_sequence is not null)),
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
 check((rpc_accepted_at is null and pi_session_id is null and run_sequence is null) or (rpc_accepted_at is not null and pi_session_id is not null and run_sequence is not null))
) strict;
create index tasks_state_created on tasks(state, created_at desc, id desc);
create trigger tasks_no_reopen before update of state on tasks
when old.state = 'resolved' and new.state <> 'resolved'
begin
 select raise(abort, 'resolved tasks cannot be reopened');
end;
`;

export function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim().replace(/;$/, '');
}

// sqlite_master preserves CREATE statements. Comparing the canonical complete
// definitions prevents a same-name table/index/trigger with weakened checks or
// foreign keys from passing startup validation.
export const schemaDefinitions = new Map(
  [...SQL.matchAll(/create\s+(?:table|index|trigger)\s+\S+[\s\S]*?;(?=\s*create\s|\s*$)/gi)].map(
    (match) => {
      const statement = match[0];
      const name = /^create\s+(?:table|index|trigger)\s+(\S+)/i.exec(statement)?.[1];
      if (!name) throw new Error('Invalid built-in gateway schema definition.');
      return [name, normalizeSql(statement)];
    },
  ),
);

export const schemaColumns: Record<string, string[]> = {
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
