import { TextDecoder } from 'node:util';

export const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;
export const CONTROL_COMMAND_DEADLINE_MS = 10_000;
export const SLACK_NETWORK_DEADLINE_MS = 60_000;

const SLACK_NETWORK_COMMANDS = new Set([
  'slack.history',
  'slack.message',
  'slack.thread',
  'slack.file.download',
  'slack.send',
  'inbox.respond',
  'trust.add',
]);

export type ControlRequest = {
  version: 1;
  id: string;
  command: string;
  params: Record<string, unknown>;
};

export type ControlReply = {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
};

export type PostFlushResult = {
  result: unknown;
  postFlush: () => Promise<void>;
  cancelPostFlush: () => void;
};

export function deadlineForCommand(command: string): number {
  return SLACK_NETWORK_COMMANDS.has(command)
    ? SLACK_NETWORK_DEADLINE_MS
    : CONTROL_COMMAND_DEADLINE_MS;
}

export function outcomeUnknownMessage(requestId: string): string {
  return `The Slack operation may have completed. Request ID: ${requestId}. Inspect Slack/inbox state before retrying.`;
}

export function isPostFlushResult(value: unknown): value is PostFlushResult {
  return Boolean(
    value && typeof value === 'object' && 'postFlush' in value && 'cancelPostFlush' in value,
  );
}

export function errorReply(id: string, error: unknown): ControlReply {
  const known = error as { code?: string; message?: string };
  const safeMessages: Record<string, string> = {
    SLACK_ERROR: 'Slack request failed.',
    SLACK_UNAVAILABLE: 'Slack is currently unavailable.',
    INVALID_FILE: 'An upload file is unavailable or unsafe.',
    FILE_TOO_LARGE: 'A file exceeds the configured media limit.',
    MEDIA_LIMIT_EXCEEDED: 'The configured total media limit would be exceeded.',
    FILE_CHANGED: 'An upload file changed before it could be sent.',
    FILE_EXISTS: 'The media destination already exists.',
    UNSAFE_MEDIA_PATH: 'The local media store is unsafe.',
    ARCHIVE_UNAVAILABLE: 'Session archive storage is unavailable.',
    ARCHIVE_CREATE_FAILED: 'The current session could not be archived.',
    ARCHIVE_CLEANUP_FAILED: 'Session archive cleanup failed.',
  };
  const publicCodes = new Set([
    'INVALID_REQUEST',
    'INVALID_PARAMS',
    'INVALID_STATE',
    'NOT_FOUND',
    'NOT_CONFIGURED',
    'SOURCE_DELETED',
    'SESSION_UNAVAILABLE',
    'STALE_CONFIRMATION',
    'CONFIRMATION_REQUIRED',
    'PARTIAL_SUCCESS',
    'OUTCOME_UNKNOWN',
    'DEADLINE_EXCEEDED',
    'FRAME_TOO_LARGE',
    'INCOMPLETE_FRAME',
    'TRAILING_DATA',
    'UNKNOWN_COMMAND',
    'RESPONSE_TOO_LARGE',
    ...Object.keys(safeMessages),
  ]);
  if (
    known.code &&
    /^(?:EACCES|EPERM|ENOENT|ENOTDIR|EISDIR|ENOSPC|EROFS|EMFILE|ENFILE|EEXIST|ELOOP|ENAMETOOLONG|EDQUOT|EBUSY)$/.test(
      known.code,
    )
  ) {
    return {
      id,
      error: { code: 'FILESYSTEM_ERROR', message: 'A local filesystem operation failed.' },
    };
  }
  if (known.code && publicCodes.has(known.code)) {
    return {
      id,
      error: {
        code: known.code,
        message: safeMessages[known.code] ?? known.message ?? 'Request failed.',
      },
    };
  }
  const message = known.message ?? '';
  // Persistence deliberately throws ordinary Errors; map expected caller input
  // failures here and never expose SQLite implementation details.
  if (
    /^(Invalid (inbox|task|schedule) ID:|Slack user ID must be|Configured Slack conversation|Gateway configuration contains|Invalid (default )?thinking level:|Invalid log level:|Configuration value|Unsupported configuration key:|Configuration key cannot be reset:|Unknown (configured )?pi model:|Unsupported (configured )?pi thinking level:|--at must be|Cron expression must be|Invalid cron expression|Invalid IANA timezone:|title and instructions must be|Specify exactly|Cannot enable a one-time schedule)/.test(
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

export function serializeReply(reply: ControlReply): string {
  const frame = `${JSON.stringify(reply)}\n`;
  if (Buffer.byteLength(frame) > MAX_CONTROL_FRAME_BYTES) {
    const error = new Error('Response exceeds frame limit.') as Error & { code: string };
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }
  return frame;
}

export function decodeRequestFrame(frame: Buffer): ControlRequest {
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
    (value as ControlRequest).version !== 1 ||
    typeof (value as ControlRequest).id !== 'string' ||
    !(value as ControlRequest).id ||
    typeof (value as ControlRequest).command !== 'string' ||
    !(value as ControlRequest).command ||
    !Object.prototype.hasOwnProperty.call(value, 'params') ||
    !(value as ControlRequest).params ||
    typeof (value as ControlRequest).params !== 'object' ||
    Array.isArray((value as ControlRequest).params)
  ) {
    fail('INVALID_REQUEST', 'Invalid control request.');
  }
  return value as ControlRequest;
}

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}
