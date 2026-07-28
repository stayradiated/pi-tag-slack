import type Database from 'better-sqlite3';
import {
  addTrustedUser,
  createManualTask,
  listScheduleRows,
  removeScheduleRow,
  scheduleRow,
  setScheduleEnabled,
  markTaskAccepted,
  parsePublicId,
  publicId,
  readGatewayConfig,
  removeTrustedUser,
  requireConfiguredDb,
  recordInboxReply,
  setInboxWorking,
  resetGatewayConfig,
  updateGatewayConfig,
  validateInboxRow,
  validateTaskRow,
  validateTrustedUserRow,
  type MutableConfigKey,
} from './db.js';
import type { PiNotifier, GatewayCoordinator } from './slack.js';
import type { PiApplyResult, PiModel } from './pi-rpc.js';
import { addSchedule, enableSchedule } from './scheduler.js';
import { cleanupSessionArchives, listSessionArchives } from './session-archive.js';
import {
  replyToInbox,
  scheduleReactionReconciliation,
  sendSlackMessage,
  downloadSlackFile,
  slackHistory,
  slackMessage,
  slackThread,
  slackUser,
} from './slack-client.js';

import { type ControlRequest, type PostFlushResult } from './control-protocol.js';
import { startControlSocketServer } from './control-server.js';
export {
  CONTROL_COMMAND_DEADLINE_MS,
  SLACK_NETWORK_DEADLINE_MS,
  deadlineForCommand,
  errorReply,
} from './control-protocol.js';
export type { ControlServer, ControlServerOptions } from './control-server.js';

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

function limit(value: unknown): number {
  const number = Number(value ?? 50);
  if (!Number.isInteger(number) || number < 1 || number > 200) {
    fail('INVALID_PARAMS', 'limit must be an integer from 1 to 200.');
  }
  return number;
}

function state(value: unknown): 'open' | 'resolved' | 'all' {
  if (value === undefined) return 'open';
  if (value === 'open' || value === 'resolved' || value === 'all') return value;
  fail('INVALID_PARAMS', 'state must be open, resolved, or all.');
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    fail('INVALID_PARAMS', `${name} must be non-empty.`);
  return value.trim();
}

function filePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
    fail('INVALID_PARAMS', 'files must be an array of non-empty paths.');
  return value as string[];
}

function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    fail('INVALID_PARAMS', 'ids must be a non-empty string array.');
  }
  return value as string[];
}

type ListCursor = { createdAt: string; id: number };

function decodeCursor(value: unknown): ListCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    fail('INVALID_PARAMS', 'cursor must be a non-empty string.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as ListCursor).createdAt !== 'string' ||
      !Number.isInteger((parsed as ListCursor).id) ||
      (parsed as ListCursor).id < 1
    ) {
      throw new Error('invalid cursor');
    }
    return parsed as ListCursor;
  } catch {
    fail('INVALID_PARAMS', 'cursor is invalid.');
  }
}

function fileId(value: unknown): string {
  const id = text(value, 'fileId');
  if (!/^F[A-Z0-9]+$/.test(id))
    fail('INVALID_PARAMS', 'Slack file ID must be a raw uppercase F... ID.');
  return id;
}

function optionalCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return text(value, 'cursor');
}

type TrustCursor = { createdAt: string; userId: string };
function decodeTrustCursor(value: unknown): TrustCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    fail('INVALID_PARAMS', 'cursor must be a non-empty string.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as TrustCursor).createdAt !== 'string' ||
      !/^[UW][A-Z0-9]+$/.test(String((parsed as TrustCursor).userId))
    )
      throw new Error('invalid');
    return parsed as TrustCursor;
  } catch {
    fail('INVALID_PARAMS', 'cursor is invalid.');
  }
}
function encodeTrustCursor(row: { createdAt: string; userId: string }): string {
  return Buffer.from(JSON.stringify(row)).toString('base64url');
}
function trustUserId(value: unknown): string {
  const userId = text(value, 'userId');
  if (!/^[UW][A-Z0-9]+$/.test(userId))
    fail('INVALID_PARAMS', 'Slack user ID must be a raw uppercase U... or W... ID.');
  return userId;
}

function encodeCursor(row: { created_at: string; id: number }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString(
    'base64url',
  );
}

function rows(
  db: Database.Database,
  table: 'inbox' | 'tasks',
  requestedState: 'open' | 'resolved' | 'all',
  requestedLimit: number,
  requestedCursor: unknown,
) {
  const cursor = decodeCursor(requestedCursor);
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (requestedState !== 'all') {
    clauses.push('state = ?');
    args.push(requestedState);
  }
  if (cursor) {
    clauses.push('(created_at < ? or (created_at = ? and id < ?))');
    args.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const prefix = table === 'inbox' ? 'inbox' : 'task';
  const results = db
    .prepare(`select * from ${table} ${where} order by created_at desc, id desc limit ?`)
    .all(...args, requestedLimit + 1) as Array<
    Record<string, unknown> & { created_at: string; id: number }
  >;
  for (const row of results) {
    if (table === 'inbox') validateInboxRow(row);
    else validateTaskRow(row);
  }
  const hasNext = results.length > requestedLimit;
  const page = hasNext ? results.slice(0, requestedLimit) : results;
  return {
    items: page.map((row) => ({ ...row, id: publicId(prefix, row.id) })),
    nextCursor: hasNext ? encodeCursor(page[page.length - 1]) : null,
  };
}

function one(db: Database.Database, table: 'inbox' | 'tasks', value: string) {
  const prefix = table === 'inbox' ? 'inbox' : 'task';
  const id = parsePublicId(prefix, value);
  const row = db.prepare(`select * from ${table} where id = ?`).get(id) as
    Record<string, unknown> | undefined;
  if (!row) fail('NOT_FOUND', `${value} was not found.`);
  if (table === 'inbox') validateInboxRow(row);
  else validateTaskRow(row);
  return { ...row, id: value };
}

function resolveRows(
  db: Database.Database,
  table: 'inbox' | 'tasks',
  values: string[],
  reason: string,
) {
  const prefix = table === 'inbox' ? 'inbox' : 'task';
  const numericIds = values.map((value) => parsePublicId(prefix, value));
  if (new Set(numericIds).size !== numericIds.length)
    fail('INVALID_PARAMS', 'ids must not contain duplicates.');
  return db.transaction(() => {
    const found = numericIds.map(
      (id) =>
        db.prepare(`select * from ${table} where id = ?`).get(id) as
          Record<string, unknown> | undefined,
    );
    if (found.some((row) => !row)) fail('NOT_FOUND', 'One or more work items were not found.');
    for (const row of found) {
      if (table === 'inbox') validateInboxRow(row!);
      else validateTaskRow(row!);
    }
    if (found.some((row) => row?.state !== 'open'))
      fail('INVALID_STATE', 'One or more work items are already resolved.');
    const stamp = new Date().toISOString();
    for (const id of numericIds) {
      const updatedAt = table === 'inbox' ? ', updated_at = ?' : '';
      const values = table === 'inbox' ? [reason, stamp, stamp, id] : [reason, stamp, id];
      const reaction =
        table === 'inbox'
          ? ", reaction_desired = 'white_check_mark', reaction_error = null, reaction_next_attempt_at = null"
          : '';
      db.prepare(
        `update ${table} set state = 'resolved', resolution_reason = ?, resolved_at = ?${reaction}${updatedAt} where id = ?`,
      ).run(...values);
    }
    return { resolved: values };
  })();
}

export type DaemonRuntimeStatus = {
  control: 'ok' | 'degraded';
  lastError: string | null;
};

export type ControlServices = {
  notifier: PiNotifier;
  coordinator: GatewayCoordinator;
  sessionStatus?: () => Promise<unknown>;
  /** Daemon-owned runtime state; never inspect persistence to produce this value. */
  runtimeStatus?: () => DaemonRuntimeStatus;
  archivePath?: string;
  sessionControls?: {
    availableModels(): Promise<PiModel[]>;
    availableThinkingLevels(): Promise<string[]>;
    applyDesired(): Promise<PiApplyResult>;
    reset?(): Promise<{ archivedTo: string; recoverySent: boolean }>;
    confirmReset?(challenge: string): Promise<PostFlushResult>;
  };
};

export function dispatch(request: ControlRequest, services?: ControlServices): unknown {
  const db = requireConfiguredDb();
  const params = request.params;
  // Schedule definitions and scheduler ticks share the daemon serialization lane.
  const scheduleMutation = <T>(operation: () => T): T | Promise<T> =>
    services ? services.coordinator.run(operation) : operation();
  switch (request.command) {
    case 'health': {
      if (!services?.sessionStatus) return { database: 'ok', control: 'ok' };
      return services.sessionStatus().then((session) => ({
        database: 'ok',
        ...(services.runtimeStatus?.() ?? { control: 'ok' as const }),
        session,
      }));
    }
    case 'session.status':
      if (!services?.sessionStatus)
        fail('SESSION_UNAVAILABLE', 'Pi session status is unavailable.');
      return services.coordinator.run(async () => {
        const session = await services.sessionStatus!();
        const runtime = services.runtimeStatus?.();
        return runtime && session && typeof session === 'object'
          ? { ...(session as Record<string, unknown>), daemon: runtime }
          : session;
      });
    case 'session.reset': {
      if (!services?.sessionControls?.reset)
        fail('SESSION_UNAVAILABLE', 'Pi session reset is unavailable.');
      if (params.confirm === undefined)
        return services.coordinator.run(() => services.sessionControls!.reset!());
      if (typeof params.confirm !== 'string' || !/^.+:[1-9]\d*$/.test(params.confirm))
        fail('INVALID_PARAMS', 'confirm must be a <session-id>:<run-sequence> challenge.');
      if (!services.sessionControls.confirmReset)
        fail('SESSION_UNAVAILABLE', 'Pi session confirmation is unavailable.');
      return services.coordinator
        .reserve(() => services.sessionControls!.confirmReset!(params.confirm as string))
        .then(({ value, release }) => {
          let completed = false;
          return {
            result: value.result,
            cancelPostFlush: () => {
              if (completed) return;
              completed = true;
              try {
                value.cancelPostFlush();
              } finally {
                release();
              }
            },
            postFlush: async () => {
              if (completed) return;
              completed = true;
              try {
                await value.postFlush();
              } finally {
                release();
              }
            },
          };
        });
    }
    case 'session.archive.list': {
      if (!services?.archivePath)
        fail('SESSION_UNAVAILABLE', 'Session archive controls are unavailable.');
      const requestedLimit = limit(params.limit);
      return services.coordinator.run(() =>
        listSessionArchives(services.archivePath!, {
          limit: requestedLimit,
          cursor: params.cursor,
        }),
      );
    }
    case 'session.archive.cleanup': {
      if (!services?.archivePath)
        fail('SESSION_UNAVAILABLE', 'Session archive controls are unavailable.');
      return services.coordinator.run(() => {
        const retentionDays = Number(readGatewayConfig().archive_retention_days);
        return cleanupSessionArchives(services.archivePath!, retentionDays);
      });
    }
    case 'session.model.list':
      if (!services?.sessionControls)
        fail('SESSION_UNAVAILABLE', 'Pi session controls are unavailable.');
      return services.coordinator.run(async () => ({
        models: await services.sessionControls!.availableModels(),
      }));
    case 'session.model.set': {
      if (!services?.sessionControls)
        fail('SESSION_UNAVAILABLE', 'Pi session controls are unavailable.');
      const ref = text(params.ref ?? params.model, 'ref');
      return services.coordinator.run(async () => {
        const models = await services.sessionControls!.availableModels();
        if (!models.some((model) => model.ref === ref))
          fail('INVALID_PARAMS', `Unknown pi model: ${ref}.`);
        updateGatewayConfig('sessionModelOverride', ref);
        return {
          desiredModel: ref,
          ...(await services.sessionControls!.applyDesired()),
        };
      });
    }
    case 'session.model.reset': {
      if (!services?.sessionControls)
        fail('SESSION_UNAVAILABLE', 'Pi session controls are unavailable.');
      return services.coordinator.run(async () => {
        const config = readGatewayConfig();
        const desiredModel = String(config.default_model);
        const models = await services.sessionControls!.availableModels();
        if (!models.some((model) => model.ref === desiredModel))
          fail('INVALID_PARAMS', `Unknown configured pi model: ${desiredModel}.`);
        resetGatewayConfig('sessionModelOverride');
        return { desiredModel, ...(await services.sessionControls!.applyDesired()) };
      });
    }
    case 'session.thinking.set': {
      if (!services?.sessionControls)
        fail('SESSION_UNAVAILABLE', 'Pi session controls are unavailable.');
      const level = text(params.level, 'level');
      return services.coordinator.run(async () => {
        const levels = await services.sessionControls!.availableThinkingLevels();
        if (!levels.includes(level))
          fail('INVALID_PARAMS', `Unsupported pi thinking level: ${level}.`);
        updateGatewayConfig('sessionThinkingOverride', level);
        return { desiredThinking: level, ...(await services.sessionControls!.applyDesired()) };
      });
    }
    case 'session.thinking.reset': {
      if (!services?.sessionControls)
        fail('SESSION_UNAVAILABLE', 'Pi session controls are unavailable.');
      return services.coordinator.run(async () => {
        const config = readGatewayConfig();
        const desiredThinking = String(config.default_thinking);
        const levels = await services.sessionControls!.availableThinkingLevels();
        if (!levels.includes(desiredThinking))
          fail('INVALID_PARAMS', `Unsupported configured pi thinking level: ${desiredThinking}.`);
        resetGatewayConfig('sessionThinkingOverride');
        return { desiredThinking, ...(await services.sessionControls!.applyDesired()) };
      });
    }
    case 'inbox.list':
      return rows(db, 'inbox', state(params.state), limit(params.limit), params.cursor);
    case 'inbox.show':
      return one(db, 'inbox', text(params.id, 'id'));
    case 'inbox.resolve': {
      const operation = () => {
        const result = resolveRows(
          db,
          'inbox',
          ids(params.ids),
          text(params.reason ?? 'resolved', 'reason'),
        );
        scheduleReactionReconciliation();
        return result;
      };
      return services ? services.coordinator.run(operation) : operation();
    }
    case 'inbox.working': {
      const operation = () => {
        const id = parsePublicId('inbox', text(params.id, 'id'));
        const result = { ...setInboxWorking(id), id: publicId('inbox', id) };
        scheduleReactionReconciliation();
        return result;
      };
      return services ? services.coordinator.run(operation) : operation();
    }
    case 'inbox.respond': {
      const operation = async () => {
        const idText = text(params.id, 'id');
        const id = parsePublicId('inbox', idText);
        const row = one(db, 'inbox', idText) as Record<string, unknown>;
        if (row.source_deleted_at) fail('SOURCE_DELETED', 'The Slack source message was deleted.');
        const replyTs = await replyToInbox(
          String(row.thread_ts),
          text(params.text, 'text'),
          filePaths(params.files),
        );
        try {
          recordInboxReply(id, replyTs);
        } catch {
          throw Object.assign(
            new Error(`Slack reply succeeded at ${replyTs}, but local update failed.`),
            { code: 'PARTIAL_SUCCESS' },
          );
        }
        scheduleReactionReconciliation();
        return { id: idText, replyTs, resolved: row.state === 'open' };
      };
      return services ? services.coordinator.run(operation) : operation();
    }
    case 'slack.history':
      return slackHistory(limit(params.limit), optionalCursor(params.cursor));
    case 'slack.message':
      return slackMessage(text(params.messageTs ?? params.ts, 'messageTs'));
    case 'slack.thread':
      return slackThread(
        text(params.threadTs ?? params.ts, 'threadTs'),
        limit(params.limit),
        optionalCursor(params.cursor),
      );
    case 'slack.file.download':
      return downloadSlackFile(fileId(params.fileId ?? params.id));
    case 'slack.send':
      return sendSlackMessage(
        text(params.text, 'text'),
        params.threadTs === undefined ? undefined : text(params.threadTs, 'threadTs'),
        filePaths(params.files),
      );
    case 'task.list':
      return rows(db, 'tasks', state(params.state), limit(params.limit), params.cursor);
    case 'task.show':
      return one(db, 'tasks', text(params.id, 'id'));
    case 'task.add': {
      const title = text(params.title, 'title');
      const instructions = text(params.instructions, 'instructions');
      // The direct dispatch fallback is useful to offline unit tests. Runtime
      // control-server task creation always receives daemon services below.
      if (!services) {
        const task = createManualTask(title, instructions);
        return { id: publicId('task', Number(task.id)) };
      }
      const add = async () => {
        // The durable row is deliberately committed before RPC: an RPC error is
        // partial success, not a reason to lose work or retry task creation.
        const task = createManualTask(title, instructions);
        const id = Number(task.id);
        const taskId = publicId('task', id);
        try {
          const acceptance = await services.notifier.notify(
            `[New task; ${taskId}]\n` +
              `Title: ${title}\nInstructions follow:\n---\n${instructions}\n---\n` +
              'This is durable task work. Use pi-tag-slack task list, task show ' +
              `${taskId}, and task resolve ${taskId} [--reason <text>] to inspect and complete it. ` +
              'Other open inbox items or tasks may also exist.',
          );
          markTaskAccepted(id, acceptance);
          return { id: taskId, notified: true };
        } catch {
          throw Object.assign(
            new Error(
              `Task ${taskId} was created and remains open, but pi notification failed. ` +
                'Do not retry task add; inspect the task and notify pi manually if needed.',
            ),
            { code: 'PARTIAL_SUCCESS' },
          );
        }
      };
      return services.coordinator.run(add);
    }
    case 'task.resolve': {
      const operation = () =>
        resolveRows(db, 'tasks', ids(params.ids), text(params.reason ?? 'resolved', 'reason'));
      return services ? services.coordinator.run(operation) : operation();
    }
    case 'schedule.add':
      return scheduleMutation(() => {
        const title = text(params.title, 'title');
        const instructions = text(params.instructions, 'instructions');
        const at = params.at === undefined ? undefined : text(params.at, 'at');
        const cron = params.cron === undefined ? undefined : text(params.cron, 'cron');
        const timezone =
          params.timezone === undefined ? undefined : text(params.timezone, 'timezone');
        if ((at ? 1 : 0) + (cron ? 1 : 0) !== 1 || (cron && !timezone) || (at && timezone))
          fail('INVALID_PARAMS', 'Specify exactly --at, or --cron with --timezone.');
        const row = at
          ? addSchedule({ title, instructions, at })
          : addSchedule({ title, instructions, cron: cron!, timezone: timezone! });
        return { ...row, id: publicId('schedule', row.id) };
      });
    case 'schedule.list': {
      const requestedLimit = limit(params.limit);
      const cursor = decodeCursor(params.cursor);
      const result = listScheduleRows(requestedLimit + 1, cursor);
      const hasNext = result.length > requestedLimit;
      const page = hasNext ? result.slice(0, requestedLimit) : result;
      return {
        items: page.map((row) => ({ ...row, id: publicId('schedule', row.id) })),
        nextCursor: hasNext ? encodeCursor(page[page.length - 1]) : null,
      };
    }
    case 'schedule.show': {
      const value = text(params.id, 'id');
      const row = scheduleRow(parsePublicId('schedule', value));
      if (!row) fail('NOT_FOUND', `${value} was not found.`);
      return { ...row, id: value };
    }
    case 'schedule.disable':
      return scheduleMutation(() => {
        const id = parsePublicId('schedule', text(params.id, 'id'));
        const row = scheduleRow(id);
        if (!row) fail('NOT_FOUND', `schedule-${id} was not found.`);
        // A disabled schedule has no pending occurrence; enable recomputes it.
        const updated = setScheduleEnabled(id, false, null);
        return { ...updated, id: publicId('schedule', id) };
      });
    case 'schedule.enable':
      return scheduleMutation(() => {
        const id = parsePublicId('schedule', text(params.id, 'id'));
        const row = scheduleRow(id);
        if (!row) fail('NOT_FOUND', `schedule-${id} was not found.`);
        const updated = enableSchedule(row);
        return { ...updated, id: publicId('schedule', id) };
      });
    case 'schedule.remove':
      return scheduleMutation(() => {
        const id = parsePublicId('schedule', text(params.id, 'id'));
        if (!removeScheduleRow(id)) fail('NOT_FOUND', `schedule-${id} was not found.`);
        return { removed: true };
      });
    case 'trust.list': {
      const requestedLimit = limit(params.limit);
      const cursor = decodeTrustCursor(params.cursor);
      const values: unknown[] = [];
      const where = cursor ? 'where (created_at > ? or (created_at = ? and user_id > ?))' : '';
      if (cursor) values.push(cursor.createdAt, cursor.createdAt, cursor.userId);
      const stored = db
        .prepare(
          `select * from trusted_users ${where} order by created_at asc, user_id asc limit ?`,
        )
        .all(...values, requestedLimit + 1) as Array<Record<string, unknown>>;
      for (const row of stored) validateTrustedUserRow(row);
      const result = stored.map((row) => ({
        userId: String(row.user_id),
        label: String(row.label),
        createdAt: String(row.created_at),
      }));
      const hasNext = result.length > requestedLimit;
      const items = hasNext ? result.slice(0, requestedLimit) : result;
      return { items, nextCursor: hasNext ? encodeTrustCursor(items[items.length - 1]) : null };
    }
    case 'trust.add': {
      const userId = trustUserId(params.userId); // Validate locally before contacting Slack.
      const add = async () => {
        const user = await slackUser(userId);
        return { added: addTrustedUser(userId, user.label), label: user.label };
      };
      return services ? services.coordinator.run(add) : add();
    }
    case 'trust.remove': {
      const userId = trustUserId(params.userId);
      const remove = () => ({ removed: removeTrustedUser(userId) });
      return services ? services.coordinator.run(remove) : remove();
    }
    case 'config.show':
      return readGatewayConfig();
    case 'config.set': {
      const key = text(params.key, 'key') as MutableConfigKey;
      const value = text(params.value, 'value');
      const sessionSetting =
        key === 'defaultModel' ||
        key === 'defaultThinking' ||
        key === 'sessionModelOverride' ||
        key === 'sessionThinkingOverride';
      if (!sessionSetting) {
        const operation = () => updateGatewayConfig(key, value);
        return services ? services.coordinator.run(operation) : operation();
      }
      if (!services?.sessionControls)
        fail('SESSION_UNAVAILABLE', 'Live pi catalogs are required for session settings.');
      return services.coordinator.run(async () => {
        if (key === 'defaultModel' || key === 'sessionModelOverride') {
          const models = await services.sessionControls!.availableModels();
          if (!models.some((model) => model.ref === value))
            fail('INVALID_PARAMS', `Unknown pi model: ${value}.`);
        } else {
          const levels = await services.sessionControls!.availableThinkingLevels();
          if (!levels.includes(value))
            fail('INVALID_PARAMS', `Unsupported pi thinking level: ${value}.`);
        }
        const config = updateGatewayConfig(key, value);
        return { ...config, ...(await services.sessionControls!.applyDesired()) };
      });
    }
    case 'config.reset': {
      const key = text(params.key, 'key') as MutableConfigKey;
      const sessionSetting = key === 'sessionModelOverride' || key === 'sessionThinkingOverride';
      if (!sessionSetting) {
        const operation = () => resetGatewayConfig(key);
        return services ? services.coordinator.run(operation) : operation();
      }
      if (!services?.sessionControls)
        fail('SESSION_UNAVAILABLE', 'Live pi catalogs are required for session settings.');
      return services.coordinator.run(async () => {
        if (key === 'sessionModelOverride') {
          const desired = String(readGatewayConfig().default_model);
          const models = await services.sessionControls!.availableModels();
          if (!models.some((model) => model.ref === desired))
            fail('INVALID_PARAMS', `Unknown configured pi model: ${desired}.`);
        } else {
          const desired = String(readGatewayConfig().default_thinking);
          const levels = await services.sessionControls!.availableThinkingLevels();
          if (!levels.includes(desired))
            fail('INVALID_PARAMS', `Unsupported configured pi thinking level: ${desired}.`);
        }
        const config = resetGatewayConfig(key);
        return { ...config, ...(await services.sessionControls!.applyDesired()) };
      });
    }
    default:
      fail('UNKNOWN_COMMAND', `Unsupported command: ${request.command}`);
  }
}

export function startControlServer(
  services?: ControlServices,
  options?: import('./control-server.js').ControlServerOptions,
): Promise<import('./control-server.js').ControlServer> {
  return startControlSocketServer(dispatch, services, options);
}
