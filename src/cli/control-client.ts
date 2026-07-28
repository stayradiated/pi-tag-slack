import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { TextDecoder } from 'node:util';
import {
  CONTROL_COMMAND_DEADLINE_MS,
  MAX_CONTROL_FRAME_BYTES,
  SLACK_NETWORK_DEADLINE_MS,
} from '../control-protocol.js';
import { gatewayPaths } from '../paths.js';

export type ControlResponse = {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
};

export interface ControlClientOptions {
  /** Test seams for a temporary socket and deterministic deadlines. */
  socketPath?: () => string;
  controlDeadlineMs?: number;
  slackNetworkDeadlineMs?: number;
  requestId?: () => string;
}

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

/** Send one control request over the daemon's Unix-domain socket. */
export function request(
  command: string,
  params: Record<string, unknown>,
  options: ControlClientOptions = {},
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const id = options.requestId?.() ?? randomUUID();
    const socket = connect(options.socketPath?.() ?? gatewayPaths().socket);
    const mutation = SLACK_MUTATIONS.has(command);
    const needsReceipt = command === 'session.reset' && typeof params.confirm === 'string';
    let output = Buffer.alloc(0);
    let settled = false;
    let deliveryStarted = false;
    const ambiguous = (fallback: Error): Error =>
      mutation && deliveryStarted ? timeoutError(command, id) : fallback;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const invalidResponse = (message: string) => rejectOnce(ambiguous(protocolError(message)));
    const parseResponse = () => {
      if (settled) return;
      const newline = output.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== output.length - 1 || output.length > MAX_CONTROL_FRAME_BYTES) {
        invalidResponse('Daemon response must contain exactly one LF-terminated frame.');
        return;
      }
      let response: unknown;
      try {
        response = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, -1)),
        );
      } catch {
        invalidResponse('Daemon response must be valid UTF-8 JSON.');
        return;
      }
      if (!response || typeof response !== 'object' || (response as ControlResponse).id !== id) {
        invalidResponse('Daemon response has an invalid correlation ID.');
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
        invalidResponse('Daemon response has an invalid schema.');
        return;
      }
      settled = true;
      socket.setTimeout(0);
      resolve(value);
      if (needsReceipt && hasResult) {
        // Promise continuations present the confirmation response before this
        // macrotask acknowledges delivery and permits reset termination.
        setImmediate(() => socket.end(`${JSON.stringify({ receipt: id })}\n`));
      } else {
        socket.end();
      }
    };
    socket.setTimeout(
      SLACK_NETWORK_COMMANDS.has(command)
        ? (options.slackNetworkDeadlineMs ?? SLACK_NETWORK_DEADLINE_MS)
        : (options.controlDeadlineMs ?? CONTROL_COMMAND_DEADLINE_MS),
    );
    socket.once('error', () =>
      rejectOnce(
        ambiguous(
          Object.assign(new Error('pi-tag-slack daemon is unavailable.'), {
            code: 'DAEMON_UNAVAILABLE',
          }),
        ),
      ),
    );
    socket.once('timeout', () => rejectOnce(timeoutError(command, id)));
    socket.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_CONTROL_FRAME_BYTES + 1) {
        invalidResponse('Daemon response exceeds frame limit.');
        return;
      }
      parseResponse();
    });
    socket.on('end', () => {
      if (settled) return;
      parseResponse();
      if (!settled)
        invalidResponse('Daemon response must contain exactly one LF-terminated frame.');
    });
    socket.on('connect', () => {
      deliveryStarted = true;
      const frame = `${JSON.stringify({ version: 1, id, command, params })}\n`;
      // Ordinary commands half-close after their sole frame, allowing the
      // daemon to reject trailing frames before dispatch. Confirmed reset is
      // the sole bidirectional exchange: it retains the write half for its
      // correlated delivery receipt.
      if (needsReceipt) socket.write(frame);
      else socket.end(frame);
    });
  });
}
