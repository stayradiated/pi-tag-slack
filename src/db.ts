import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { type RegisteredChannel, type QueuedMessage, type ThinkingLevel } from './types.js';

let db!: Database.Database;
let dbOpen = false;
let activeDbPath: string | undefined;

export type ScheduledTaskType = 'once' | 'recurring';

export class FinalTrustedUserError extends Error {
  constructor() {
    super('Cannot remove the final trusted user. Add another trusted user first.');
    this.name = 'FinalTrustedUserError';
  }
}

export function validateSlackId(value: string, prefixes: string): string {
  if (!new RegExp(`^[${prefixes}][A-Z0-9]+$`).test(value)) {
    throw new Error(
      `Slack ID must be a raw uppercase ${prefixes.split('').join('... or ')}... ID.`,
    );
  }
  return value;
}

export function validateTrustedUserId(userId: string): string {
  try {
    return validateSlackId(userId, 'UW');
  } catch {
    throw new Error('Slack user ID must be a raw uppercase U... or W... ID.');
  }
}

/** The sole authorization rule for rows entering the agent queue. */
export function isAuthorizedQueueSender(sender: string): boolean {
  return sender === 'scheduler' || isTrustedUser(sender);
}

export interface ScheduledTaskRow {
  id: number;
  name: string;
  type: ScheduledTaskType;
  schedule: string;
  channel_jid: string;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  created_by: string;
}

export function initDb(dbPath: string = config.dbPath): void {
  if (dbOpen) {
    if (activeDbPath === dbPath) return;
    throw new Error(`Database is already open at ${activeDbPath}; cannot open ${dbPath}.`);
  }

  let candidate: Database.Database | undefined;
  try {
    // SQLite's special in-memory path has no parent directory to create.
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    candidate = new Database(dbPath);
    candidate.pragma('journal_mode = WAL');
    candidate.pragma('busy_timeout = 5000');

    const userVersion = Number(candidate.pragma('user_version', { simple: true }));
    const hasApplicationTables = Boolean(
      candidate
        .prepare(
          "select 1 from sqlite_master where type = 'table' and name in ('channels', 'message_queue', 'message_log', 'scheduled_tasks', 'trusted_users')",
        )
        .get(),
    );
    if (userVersion > 1) {
      throw new Error(
        `Unsupported database schema version ${userVersion}; this version supports schema 1.`,
      );
    }
    if (userVersion === 0 && hasApplicationTables) {
      throw new Error(
        'Pre-release database schema detected. Delete and recreate the database before starting pi-tag-slack.',
      );
    }

    candidate.transaction(() =>
      candidate!.exec(`
    create table if not exists channels (
      jid              text primary key,
      name             text not null,
      folder           text not null unique,
      requires_trigger integer not null default 1,
      is_main          integer not null default 0,
      model_override   text not null default '',
      thinking_override text not null default '',
      cwd_override     text not null default '',
      created_at       text not null default (datetime('now'))
    );

    create table if not exists message_queue (
      rowid         integer primary key autoincrement,
      channel_jid   text not null,
      sender        text not null,
      sender_name   text not null,
      content       text not null,
      timestamp     text not null,
      status        text not null default 'pending',
      created_at    text not null default (datetime('now')),
      processed_at  text,
      attachments   text,
      event_ts      text,
      thread_ts     text
    );

    create index if not exists idx_queue_status on message_queue(status, channel_jid);

    create table if not exists message_log (
      rowid         integer primary key autoincrement,
      channel_jid   text not null,
      role          text not null,
      content       text not null,
      timestamp     text not null default (datetime('now'))
    );

    create table if not exists scheduled_tasks (
      id           integer primary key autoincrement,
      name         text not null,
      type         text not null check(type in ('once', 'recurring')),
      schedule     text not null,
      channel_jid  text not null,
      prompt       text not null,
      enabled      integer not null default 1,
      last_run_at  text,
      next_run_at  text,
      created_at   text not null default (datetime('now')),
      created_by   text not null default ''
    );

    create index if not exists idx_scheduled_tasks_due on scheduled_tasks(enabled, next_run_at);

    create table if not exists trusted_users (
      user_id    text primary key,
      created_at text not null default (datetime('now'))
    );
    pragma user_version = 1;
  `),
    )();

    // Publish only a fully validated connection.
    db = candidate;
    dbOpen = true;
    activeDbPath = dbPath;
    logger.info({ path: dbPath }, 'Database initialized');
  } catch (error) {
    try {
      candidate?.close();
    } catch {
      // Preserve the initialization failure.
    }
    dbOpen = false;
    activeDbPath = undefined;
    throw error;
  }
}

function normalizeTimestamp(timestamp: string | null): string | null {
  if (timestamp === null) {
    return null;
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

// ── Trusted Slack users ──

export function addTrustedUser(userId: string): boolean {
  const result = db
    .prepare('insert into trusted_users (user_id) values (?) on conflict(user_id) do nothing')
    .run(validateTrustedUserId(userId));
  return result.changes > 0;
}

export function removeTrustedUser(userId: string): { removed: boolean; clearedPending: number } {
  const id = validateTrustedUserId(userId);
  return db.transaction(() => {
    const count = getTrustedUserCount();
    const exists = isTrustedUser(id);
    if (exists && count <= 1) throw new FinalTrustedUserError();
    const removed = db.prepare('delete from trusted_users where user_id = ?').run(id).changes > 0;
    const clearedPending = removed
      ? db.prepare("delete from message_queue where sender = ? and status = 'pending'").run(id)
          .changes
      : 0;
    return { removed, clearedPending };
  })();
}

export function getTrustedUsers(): Array<{ userId: string; createdAt: string }> {
  return db
    .prepare(
      'select user_id as userId, created_at as createdAt from trusted_users order by created_at, user_id',
    )
    .all() as Array<{ userId: string; createdAt: string }>;
}

export function isTrustedUser(userId: string): boolean {
  return Boolean(db.prepare('select 1 from trusted_users where user_id = ?').get(userId));
}

export function getTrustedUserCount(): number {
  return (db.prepare('select count(*) as count from trusted_users').get() as { count: number })
    .count;
}

// ── Channel registration ──

export function registerChannel(ch: RegisteredChannel): void {
  db.prepare(
    `
    insert into channels (jid, name, folder, requires_trigger, is_main, model_override, thinking_override, cwd_override)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(jid) do update set
      name = excluded.name,
      folder = excluded.folder,
      requires_trigger = excluded.requires_trigger,
      is_main = excluded.is_main,
      cwd_override = case
        when excluded.cwd_override != '' then excluded.cwd_override
        else channels.cwd_override
      end
  `,
  ).run(
    ch.jid,
    ch.name,
    ch.folder,
    ch.requiresTrigger ? 1 : 0,
    ch.isMain ? 1 : 0,
    ch.modelOverride || '',
    ch.thinkingOverride || '',
    ch.cwdOverride.trim(),
  );
  logger.info({ jid: ch.jid, name: ch.name }, 'Channel registered');
}

export function unregisterChannel(jid: string): boolean {
  const result = db.prepare('delete from channels where jid = ?').run(jid);
  return result.changes > 0;
}

export function getChannel(jid: string): RegisteredChannel | undefined {
  const row = db.prepare('select * from channels where jid = ?').get(jid) as any;
  return row ? rowToChannel(row) : undefined;
}

export function getAllChannels(): RegisteredChannel[] {
  const rows = db.prepare('select * from channels order by created_at').all() as any[];
  return rows.map(rowToChannel);
}

export function createDmChannel(
  jid: string,
  userId: string,
  displayName: string,
): RegisteredChannel {
  return {
    jid,
    name: `DM:${displayName}`,
    folder: `dm_${userId}`,
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  };
}

export function setChannelModelOverride(jid: string, modelOverride: string): boolean {
  const result = db
    .prepare('update channels set model_override = ? where jid = ?')
    .run(modelOverride.trim(), jid);
  return result.changes > 0;
}

export function clearChannelModelOverride(jid: string): boolean {
  const result = db.prepare("update channels set model_override = '' where jid = ?").run(jid);
  return result.changes > 0;
}

export function setChannelThinkingOverride(jid: string, thinkingOverride: ThinkingLevel): boolean {
  const result = db
    .prepare('update channels set thinking_override = ? where jid = ?')
    .run(thinkingOverride, jid);
  return result.changes > 0;
}

export function clearChannelThinkingOverride(jid: string): boolean {
  const result = db.prepare("update channels set thinking_override = '' where jid = ?").run(jid);
  return result.changes > 0;
}

function rowToChannel(row: any): RegisteredChannel {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    requiresTrigger: row.requires_trigger === 1,
    isMain: row.is_main === 1,
    modelOverride: row.model_override || '',
    thinkingOverride: (row.thinking_override || '') as ThinkingLevel | '',
    cwdOverride: row.cwd_override || '',
  };
}

// ── Message queue ──

export function enqueueMessage(msg: {
  channelJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  attachments?: string | null;
  eventTs?: string | null;
  threadTs?: string | null;
}): void {
  db.prepare(
    `
    insert into message_queue (channel_jid, sender, sender_name, content, timestamp, attachments, event_ts, thread_ts)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    msg.channelJid,
    msg.sender,
    msg.senderName,
    msg.content,
    msg.timestamp,
    msg.attachments ?? null,
    msg.eventTs ?? null,
    msg.threadTs ?? null,
  );
}

export function claimNextMessage(channelJid: string): QueuedMessage | undefined {
  const row = db
    .prepare(
      `
    with next_message as (
      select rowid
      from message_queue
      where status = 'pending' and channel_jid = ?
      order by rowid asc
      limit 1
    )
    update message_queue
    set status = 'processing'
    where rowid = (select rowid from next_message)
      and status = 'pending'
    returning rowid, channel_jid, sender, sender_name, content, timestamp, status, attachments, event_ts, thread_ts
  `,
    )
    .get(channelJid) as QueuedMessage | undefined;

  return row;
}

export function markMessageDone(rowid: number): void {
  db.prepare(
    "update message_queue set status = 'done', processed_at = datetime('now') where rowid = ?",
  ).run(rowid);
}

export function markMessageFailed(rowid: number): void {
  db.prepare(
    "update message_queue set status = 'failed', processed_at = datetime('now') where rowid = ?",
  ).run(rowid);
}

export function clearPendingMessages(channelJid: string): number {
  const result = db
    .prepare("delete from message_queue where channel_jid = ? and status = 'pending'")
    .run(channelJid);
  return result.changes;
}

export function recoverQueueForStartup(): {
  recoveredProcessing: number;
  rejectedUnauthorized: number;
} {
  return db.transaction(() => {
    const recoveredProcessing = db
      .prepare("update message_queue set status = 'pending' where status = 'processing'")
      .run().changes;
    const rejectedUnauthorized = db
      .prepare(
        `
        update message_queue set status = 'failed', processed_at = datetime('now')
        where status = 'pending' and sender != 'scheduler'
          and not exists (select 1 from trusted_users where user_id = message_queue.sender)
      `,
      )
      .run().changes;
    return { recoveredProcessing, rejectedUnauthorized };
  })();
}

/** Get channels that have pending messages */
export function channelsWithPending(): string[] {
  const rows = db
    .prepare(
      `
    select channel_jid
    from message_queue
    where status = 'pending'
    group by channel_jid
    order by min(rowid) asc
  `,
    )
    .all() as any[];
  return rows.map((r) => r.channel_jid);
}

// ── Scheduled tasks ──

export function addScheduledTask(task: {
  name: string;
  type: ScheduledTaskType;
  schedule: string;
  channelJid: string;
  prompt: string;
  createdBy?: string;
  nextRunAt: string;
}): number {
  const result = db
    .prepare(
      `
    insert into scheduled_tasks (name, type, schedule, channel_jid, prompt, created_by, next_run_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      task.name,
      task.type,
      task.schedule,
      task.channelJid,
      task.prompt,
      task.createdBy ?? '',
      normalizeTimestamp(task.nextRunAt),
    );

  return Number(result.lastInsertRowid);
}

export function removeScheduledTask(id: number): boolean {
  const result = db.prepare('delete from scheduled_tasks where id = ?').run(id);
  return result.changes > 0;
}

export function enableScheduledTask(id: number): boolean {
  const result = db.prepare('update scheduled_tasks set enabled = 1 where id = ?').run(id);
  return result.changes > 0;
}

export function disableScheduledTask(id: number): boolean {
  const result = db.prepare('update scheduled_tasks set enabled = 0 where id = ?').run(id);
  return result.changes > 0;
}

export function listScheduledTasks(): ScheduledTaskRow[] {
  return db
    .prepare(
      `
    select id, name, type, schedule, channel_jid, prompt, enabled, last_run_at, next_run_at, created_at, created_by
    from scheduled_tasks
    order by id asc
  `,
    )
    .all() as ScheduledTaskRow[];
}

export function getDueScheduledTasks(): ScheduledTaskRow[] {
  return db
    .prepare(
      `
    select id, name, type, schedule, channel_jid, prompt, enabled, last_run_at, next_run_at, created_at, created_by
    from scheduled_tasks
    where enabled = 1
      and next_run_at is not null
      and next_run_at <= datetime('now')
    order by next_run_at asc, id asc
  `,
    )
    .all() as ScheduledTaskRow[];
}

export function updateTaskAfterRun(id: number, lastRunAt: string, nextRunAt: string | null): void {
  db.prepare(
    `
    update scheduled_tasks
    set last_run_at = ?,
        next_run_at = ?,
        enabled = case when ? is null then 0 else enabled end
    where id = ?
  `,
  ).run(normalizeTimestamp(lastRunAt), normalizeTimestamp(nextRunAt), nextRunAt, id);
}

export function enqueueScheduledTask(
  taskId: number,
  msg: {
    channelJid: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
  },
  lastRunAt: string,
  nextRunAt: string | null,
): void {
  db.transaction(() => {
    enqueueMessage(msg);
    updateTaskAfterRun(taskId, lastRunAt, nextRunAt);
  })();
}

// ── Message log ──

export function logMessage(channelJid: string, role: string, content: string): void {
  db.prepare('insert into message_log (channel_jid, role, content) values (?, ?, ?)').run(
    channelJid,
    role,
    content,
  );
}

export function closeDb(): void {
  if (!dbOpen) return;
  try {
    db.close();
  } finally {
    dbOpen = false;
    activeDbPath = undefined;
  }
}
