import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { lstatSync, unlinkSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import type Database from 'better-sqlite3';
import { assertPrivateSocket, gatewayPaths, structuralPathExists } from './paths.js';
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
  type MutableConfigKey,
} from './db.js';
import type { PiNotifier, GatewayCoordinator } from './slack.js';
import { addSchedule, enableSchedule } from './scheduler.js';
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

const MAX_FRAME_BYTES = 1024 * 1024;
const IDLE_TIMEOUT_MS = 5_000;
type Request = { version: 1; id: string; command: string; params: Record<string, unknown> };
type Reply = { id: string; result?: unknown; error?: { code: string; message: string } };

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
  const row = db.prepare(`select * from ${table} where id = ?`).get(id);
  if (!row) fail('NOT_FOUND', `${value} was not found.`);
  return { ...(row as object), id: value };
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
        db.prepare(`select state from ${table} where id = ?`).get(id) as
          { state: string } | undefined,
    );
    if (found.some((row) => !row)) fail('NOT_FOUND', 'One or more work items were not found.');
    if (found.some((row) => row?.state !== 'open'))
      fail('INVALID_STATE', 'One or more work items are already resolved.');
    const stamp = new Date().toISOString();
    for (const id of numericIds) {
      const updatedAt = table === 'inbox' ? ', updated_at = ?' : '';
      const values = table === 'inbox' ? [reason, stamp, stamp, id] : [reason, stamp, id];
      const reaction =
        table === 'inbox' ? ", reaction_desired = 'white_check_mark', reaction_error = null" : '';
      db.prepare(
        `update ${table} set state = 'resolved', resolution_reason = ?, resolved_at = ?${reaction}${updatedAt} where id = ?`,
      ).run(...values);
    }
    return { resolved: values };
  })();
}

export type ControlServices = {
  notifier: PiNotifier;
  coordinator: GatewayCoordinator;
  sessionStatus?: () => Promise<unknown>;
};

export function dispatch(request: Request, services?: ControlServices): unknown {
  const db = requireConfiguredDb();
  const params = request.params;
  // Schedule definitions and scheduler ticks share the daemon serialization lane.
  const scheduleMutation = <T>(operation: () => T): T | Promise<T> =>
    services ? services.coordinator.run(operation) : operation();
  switch (request.command) {
    case 'health':
      if (!services?.sessionStatus) return { database: 'ok', control: 'ok' };
      return services
        .sessionStatus()
        .then((session) => ({ database: 'ok', control: 'ok', session }));
    case 'session.status':
      if (!services?.sessionStatus)
        fail('SESSION_UNAVAILABLE', 'Pi session status is unavailable.');
      return services.sessionStatus();
    case 'inbox.list':
      return rows(db, 'inbox', state(params.state), limit(params.limit), params.cursor);
    case 'inbox.show':
      return one(db, 'inbox', text(params.id, 'id'));
    case 'inbox.resolve': {
      const result = resolveRows(
        db,
        'inbox',
        ids(params.ids),
        text(params.reason ?? 'resolved', 'reason'),
      );
      scheduleReactionReconciliation();
      return result;
    }
    case 'inbox.working': {
      const id = parsePublicId('inbox', text(params.id, 'id'));
      const result = { ...setInboxWorking(id), id: publicId('inbox', id) };
      scheduleReactionReconciliation();
      return result;
    }
    case 'inbox.respond': {
      const idText = text(params.id, 'id');
      const id = parsePublicId('inbox', idText);
      const row = one(db, 'inbox', idText) as Record<string, unknown>;
      if (row.source_deleted_at) fail('SOURCE_DELETED', 'The Slack source message was deleted.');
      return replyToInbox(
        String(row.thread_ts),
        text(params.text, 'text'),
        filePaths(params.files),
      ).then((replyTs) => {
        try {
          recordInboxReply(id, replyTs);
        } catch {
          throw Object.assign(
            new Error(`Slack reply succeeded at ${replyTs}, but local update failed.`),
            {
              code: 'PARTIAL_SUCCESS',
            },
          );
        }
        scheduleReactionReconciliation();
        return { id: idText, replyTs, resolved: row.state === 'open' };
      });
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
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown pi RPC failure.';
          throw Object.assign(
            new Error(
              `Task ${taskId} was created and remains open, but pi notification failed: ${message}. ` +
                'Do not retry task add; inspect the task and notify pi manually if needed.',
            ),
            { code: 'PARTIAL_SUCCESS' },
          );
        }
      };
      return services.coordinator.run(add);
    }
    case 'task.resolve':
      return resolveRows(db, 'tasks', ids(params.ids), text(params.reason ?? 'resolved', 'reason'));
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
      const result = db
        .prepare(
          `select user_id as userId, label, created_at as createdAt from trusted_users ${where} order by created_at asc, user_id asc limit ?`,
        )
        .all(...values, requestedLimit + 1) as Array<{
        userId: string;
        label: string;
        createdAt: string;
      }>;
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
    case 'config.set':
      return updateGatewayConfig(
        text(params.key, 'key') as MutableConfigKey,
        text(params.value, 'value'),
      );
    case 'config.reset':
      return resetGatewayConfig(text(params.key, 'key') as MutableConfigKey);
    default:
      fail('UNKNOWN_COMMAND', `Unsupported command: ${request.command}`);
  }
}

function errorReply(id: string, error: unknown): Reply {
  const known = error as { code?: string; message?: string };
  if (known.code)
    return { id, error: { code: known.code, message: known.message ?? 'Request failed.' } };
  const message = known.message ?? '';
  // Persistence deliberately throws ordinary Errors; map expected caller input
  // failures here and never expose SQLite implementation details.
  if (
    /^(Invalid (inbox|task|schedule) ID:|Slack user ID must be|Configured Slack conversation|Gateway configuration contains|Invalid (default )?thinking level:|Invalid log level:|Configuration value|Unsupported configuration key:|Configuration key cannot be reset:|--at must be|Cron expression must be|Invalid cron expression|Invalid IANA timezone:|title and instructions must be|Specify exactly|Cannot enable a one-time schedule)/.test(
      message,
    )
  ) {
    return { id, error: { code: 'INVALID_PARAMS', message } };
  }
  if (/was not found|One or more work items were not found/.test(message))
    return { id, error: { code: 'NOT_FOUND', message } };
  if (/already resolved|cannot be reopened/.test(message))
    return { id, error: { code: 'INVALID_STATE', message } };
  if (/Gateway is not configured/.test(message))
    return { id, error: { code: 'NOT_CONFIGURED', message } };
  return { id, error: { code: 'INTERNAL', message: 'Internal gateway error.' } };
}

function writeReply(socket: Socket, reply: Reply): void {
  const frame = `${JSON.stringify(reply)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
    socket.end(
      JSON.stringify(
        errorReply(
          reply.id,
          Object.assign(new Error('Response exceeds frame limit.'), { code: 'RESPONSE_TOO_LARGE' }),
        ),
      ) + '\n',
    );
    return;
  }
  socket.end(frame);
}

function decodeFrame(frame: Buffer): Request {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(frame);
  } catch {
    fail('INVALID_REQUEST', 'Control request must be valid UTF-8.');
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    fail('INVALID_REQUEST', 'Control request must be valid JSON.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (value as Request).version !== 1 ||
    typeof (value as Request).id !== 'string' ||
    !(value as Request).id ||
    typeof (value as Request).command !== 'string' ||
    !(value as Request).command ||
    !Object.prototype.hasOwnProperty.call(value, 'params') ||
    !(value as Request).params ||
    typeof (value as Request).params !== 'object' ||
    Array.isArray((value as Request).params)
  ) {
    fail('INVALID_REQUEST', 'Invalid control request.');
  }
  return value as Request;
}

function serve(socket: Socket, services?: ControlServices): void {
  let buffer = Buffer.alloc(0);
  let answered = false;
  const timer = setTimeout(() => {
    finish(
      errorReply(
        '',
        Object.assign(new Error('Control request timed out.'), { code: 'DEADLINE_EXCEEDED' }),
      ),
    );
  }, IDLE_TIMEOUT_MS);
  const finish = (reply: Reply) => {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    writeReply(socket, reply);
  };
  socket.on('data', (chunk: Buffer) => {
    if (answered) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES + 1) {
      finish(
        errorReply(
          '',
          Object.assign(new Error('Request exceeds frame limit.'), { code: 'FRAME_TOO_LARGE' }),
        ),
      );
    }
  });
  // Dispatch only after the client write-half-closes. This makes it possible
  // to reject a second frame even when its bytes arrive in a later data event.
  // The client can still read the response after socket.end(requestFrame).
  socket.on('end', () => {
    if (answered) return;
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) {
      finish(
        errorReply(
          '',
          Object.assign(new Error('Control request ended before LF terminator.'), {
            code: 'INCOMPLETE_FRAME',
          }),
        ),
      );
      return;
    }
    if (newline !== buffer.length - 1) {
      finish(
        errorReply(
          '',
          Object.assign(new Error('Only one request frame is allowed.'), { code: 'TRAILING_DATA' }),
        ),
      );
      return;
    }
    try {
      const request = decodeFrame(buffer.subarray(0, newline));
      try {
        Promise.resolve(dispatch(request, services))
          .then((result) => finish({ id: request.id, result }))
          .catch((error) => finish(errorReply(request.id, error)));
      } catch (error) {
        finish(errorReply(request.id, error));
      }
    } catch (error) {
      finish(errorReply('', error));
    }
  });
  socket.on('error', () => clearTimeout(timer));
}

async function staleSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    const finish = (stale: boolean) => {
      probe.destroy();
      resolve(stale);
    };
    probe.setTimeout(IDLE_TIMEOUT_MS);
    probe.once('connect', () => finish(false));
    probe.once('error', () => finish(true));
    probe.once('timeout', () => finish(false));
  });
}

export async function startControlServer(services?: ControlServices): Promise<Server> {
  const path = gatewayPaths().socket;
  // existsSync deliberately returns false for dangling symlinks; lstat-based
  // structuralPathExists makes those unsafe paths a startup failure instead.
  if (structuralPathExists(path)) {
    assertPrivateSocket(path);
    if (!(await staleSocket(path))) throw new Error(`Control socket is already live: ${path}`);
    unlinkSync(path);
  }
  const server = createServer((socket) => serve(socket, services));
  // Keep a runtime handler after bind. Without one, a later server error is an
  // unhandled EventEmitter error that can terminate the daemon unexpectedly.
  server.on('error', () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(path);
    });
    assertPrivateSocket(path);
    return server;
  } catch (error) {
    // A post-bind validation failure must not leave a listening server/socket.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const stat = lstatSync(path);
      if (stat.isSocket()) unlinkSync(path);
    } catch {
      // Preserve the bind/validation failure; cleanup is best effort.
    }
    throw error;
  }
}
