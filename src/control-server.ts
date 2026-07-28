import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { lstatSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  MAX_CONTROL_FRAME_BYTES,
  decodeRequestFrame,
  deadlineForCommand,
  errorReply,
  isPostFlushResult,
  outcomeUnknownMessage,
  serializeReply,
  type ControlReply,
  type ControlRequest,
  type PostFlushResult,
} from './control-protocol.js';
import { assertPrivateSocket, gatewayPaths, structuralPathExists } from './paths.js';

const IDLE_TIMEOUT_MS = 5_000;

export type ControlDispatch<Services> = (request: ControlRequest, services?: Services) => unknown;

function writeReply(socket: Socket, reply: ControlReply, flushed?: () => void): void {
  try {
    socket.end(serializeReply(reply), flushed);
  } catch (error) {
    socket.end(serializeReply(errorReply(reply.id, error)));
  }
}
function serve<Services>(
  socket: Socket,
  dispatch: ControlDispatch<Services>,
  services?: Services,
): void {
  let buffer = Buffer.alloc(0);
  let answered = false;
  let request: ControlRequest | undefined;
  let pendingReset: PostFlushResult | undefined;
  let resetSettled = false;
  let requestDispatched = false;
  // This timer initially covers framing, then the command or reset receipt.
  let timer: NodeJS.Timeout | undefined = setTimeout(() => {
    finish(
      errorReply(
        '',
        Object.assign(new Error('Control request timed out.'), { code: 'DEADLINE_EXCEEDED' }),
      ),
    );
  }, IDLE_TIMEOUT_MS);

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const cancelReset = () => {
    if (!pendingReset || resetSettled) return;
    resetSettled = true;
    clearTimer();
    pendingReset.cancelPostFlush();
  };
  const finish = (reply: ControlReply) => {
    if (answered) return;
    answered = true;
    clearTimer();
    writeReply(socket, reply);
  };
  const commandDeadline = (value: ControlRequest): void => {
    clearTimer();
    const isSlackMutation = value.command === 'slack.send' || value.command === 'inbox.respond';
    timer = setTimeout(() => {
      const error = isSlackMutation
        ? Object.assign(new Error(outcomeUnknownMessage(value.id)), { code: 'OUTCOME_UNKNOWN' })
        : Object.assign(new Error('Control command deadline exceeded.'), {
            code: 'DEADLINE_EXCEEDED',
          });
      finish(errorReply(value.id, error));
    }, deadlineForCommand(value.command));
  };
  const beginResetReceipt = (value: PostFlushResult) => {
    if (answered || socket.destroyed || socket.readableEnded) {
      value.cancelPostFlush();
      // A confirmation may finish after the peer's EOF. It has no receipt
      // path, so release its reservation and close our writable half too.
      if (!socket.destroyed) socket.end();
      return;
    }
    answered = true;
    clearTimer();
    pendingReset = value;
    let frame: string;
    try {
      frame = serializeReply({ id: request!.id, result: value.result });
    } catch (error) {
      cancelReset();
      socket.end(serializeReply(errorReply(request!.id, error)));
      return;
    }
    socket.write(frame, () => {
      if (resetSettled) return;
      // A kernel write is not delivery. The client must return this one narrow,
      // correlated receipt after it has consumed and presented the response.
      timer = setTimeout(() => {
        cancelReset();
        socket.destroy();
      }, IDLE_TIMEOUT_MS);
    });
  };
  const dispatchRequest = (value: ControlRequest) => {
    // Confirmed resets dispatch on their initial frame, before EOF, so they
    // can receive the correlated receipt. EOF while that async dispatch is
    // pending must not admit the same request a second time.
    if (requestDispatched) return;
    requestDispatched = true;
    commandDeadline(value);
    try {
      Promise.resolve(dispatch(value, services))
        .then((result) => {
          if (isPostFlushResult(result)) beginResetReceipt(result);
          else finish({ id: value.id, result });
        })
        .catch((error) => finish(errorReply(value.id, error)));
    } catch (error) {
      finish(errorReply(value.id, error));
    }
  };
  const acceptReceipt = () => {
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) {
      if (buffer.length > MAX_CONTROL_FRAME_BYTES) {
        cancelReset();
        socket.destroy();
      }
      return;
    }
    if (newline !== buffer.length - 1) {
      cancelReset();
      socket.destroy();
      return;
    }
    let receipt: unknown;
    try {
      receipt = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, -1)),
      );
    } catch {
      cancelReset();
      socket.destroy();
      return;
    }
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Object.keys(receipt).length !== 1 ||
      (receipt as { receipt?: unknown }).receipt !== request?.id
    ) {
      cancelReset();
      socket.destroy();
      return;
    }
    buffer = Buffer.alloc(0);
    if (!pendingReset || resetSettled) return;
    resetSettled = true;
    clearTimer();
    socket.end();
    // Receipt is the delivery boundary. The response is already consumed by
    // the CLI; reset remains asynchronous and cannot produce a second frame.
    void pendingReset.postFlush().catch(() => undefined);
  };

  socket.on('data', (chunk: Buffer) => {
    if (resetSettled) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (pendingReset) {
      acceptReceipt();
      return;
    }
    if (request) {
      // The initial complete frame is held until EOF, except for the narrow
      // reset confirmation exchange. Any subsequent bytes are trailing data.
      finish(
        errorReply(
          request.id,
          Object.assign(new Error('Only one request frame is allowed.'), {
            code: 'TRAILING_DATA',
          }),
        ),
      );
      return;
    }
    if (buffer.length > MAX_CONTROL_FRAME_BYTES + 1) {
      finish(
        errorReply(
          '',
          Object.assign(new Error('ControlRequest exceeds frame limit.'), {
            code: 'FRAME_TOO_LARGE',
          }),
        ),
      );
      return;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) return;
    if (newline !== buffer.length - 1) {
      let id = '';
      try {
        id = decodeRequestFrame(buffer.subarray(0, newline)).id;
      } catch {
        // Preserve the uncorrelated invalid-request response for malformed
        // first frames while still attributing valid trailing-frame failures.
      }
      finish(
        errorReply(
          id,
          Object.assign(new Error('Only one request frame is allowed.'), { code: 'TRAILING_DATA' }),
        ),
      );
      return;
    }
    try {
      const value = decodeRequestFrame(buffer.subarray(0, newline));
      buffer = Buffer.alloc(0);
      request = value;
      // A confirmed reset is intentionally the one bidirectional protocol:
      // dispatch now so its response can be acknowledged on this connection.
      // Every other command waits for EOF, making one-frame rejection
      // deterministic even if a peer splits writes across data events.
      if (value.command === 'session.reset' && typeof value.params.confirm === 'string')
        dispatchRequest(value);
    } catch (error) {
      finish(errorReply('', error));
    }
  });
  socket.on('end', () => {
    const awaitingReceipt = pendingReset !== undefined;
    if (awaitingReceipt) cancelReset();
    // With allowHalfOpen, an EOF while awaiting the receipt otherwise leaves
    // the server write half alive and can retain both the socket and lane.
    if (awaitingReceipt) socket.end();
    if (request) {
      if (!answered && !requestDispatched) dispatchRequest(request);
      return;
    }
    if (answered) return;
    if (buffer.length === 0) {
      finish(
        errorReply(
          '',
          Object.assign(new Error('Control request ended before LF terminator.'), {
            code: 'INCOMPLETE_FRAME',
          }),
        ),
      );
    }
  });
  socket.on('error', () => {
    cancelReset();
    clearTimer();
  });
  socket.on('close', cancelReset);
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

type SocketIdentity = { dev: number; ino: number };

function socketIdentity(path: string): SocketIdentity {
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino };
}

function isOwnedSocket(path: string, identity: SocketIdentity): boolean {
  try {
    const current = socketIdentity(path);
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

function unlinkOwnedSocket(path: string, identity: SocketIdentity): void {
  if (isOwnedSocket(path, identity)) unlinkSync(path);
}

export interface ControlServer {
  /** Closes the listener and removes only the socket inode this server bound. */
  close(): Promise<void>;
  lastError(): Error | null;
}

export type ControlServerOptions = {
  path?: string;
  /** Test/embedding hook for reporting an asynchronous listener failure. */
  onRuntimeError?: (error: Error) => void;
  /** Internal validation seam used to exercise post-bind cleanup. */
  validateBoundSocket?: (path: string) => void;
  /** Internal seam for observing a listener's runtime error handling. */
  onServerCreated?: (server: Server) => void;
};

/**
 * Move a replacement aside while Node closes its Unix listener: Node's own
 * close implementation unlinks by pathname, so identity checking only after
 * close would be too late to protect a replacement.
 */
function protectReplacement(path: string, identity: SocketIdentity): string | undefined {
  if (!structuralPathExists(path) || isOwnedSocket(path, identity)) return undefined;
  const parked = join(dirname(path), `.${basename(path)}.closing-${randomUUID()}`);
  renameSync(path, parked);
  return parked;
}

async function closeOwnedServer(
  server: Server,
  path: string,
  identity: SocketIdentity,
): Promise<void> {
  const parked = protectReplacement(path, identity);
  let closeError: Error | undefined;
  await new Promise<void>((resolve) => {
    server.close((error) => {
      closeError = error ?? undefined;
      resolve();
    });
  });
  try {
    unlinkOwnedSocket(path, identity);
  } finally {
    if (parked && !structuralPathExists(path)) renameSync(parked, path);
  }
  if (closeError) throw closeError;
}

export async function startControlSocketServer<Services>(
  dispatch: ControlDispatch<Services>,
  services?: Services,
  options: ControlServerOptions = {},
): Promise<ControlServer> {
  const path = options.path ?? gatewayPaths().socket;
  // lstat-based structuralPathExists deliberately treats dangling symlinks as
  // existing so neither bind nor stale-socket cleanup can follow one.
  if (structuralPathExists(path)) {
    assertPrivateSocket(path);
    const staleIdentity = socketIdentity(path);
    if (!(await staleSocket(path))) throw new Error(`Control socket is already live: ${path}`);
    unlinkOwnedSocket(path, staleIdentity);
  }
  // Clients half-close after their one LF-terminated frame. Keep the writable
  // half open while asynchronous commands complete so their response is not
  // discarded by Node's default allowHalfOpen=false behavior.
  const server = createServer({ allowHalfOpen: true }, (socket) =>
    serve(socket, dispatch, services),
  );
  let listening = false;
  let runtimeError: Error | null = null;
  server.on('error', (error) => {
    if (!listening) return;
    runtimeError = error;
    if (options.onRuntimeError) options.onRuntimeError(error);
    else console.error(`Control server runtime error: ${error.message}`);
  });
  options.onServerCreated?.(server);
  let identity: SocketIdentity | undefined;
  let closePromise: Promise<void> | undefined;
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
    listening = true;
    // Capture immediately after listen, before any validation can fail.
    identity = socketIdentity(path);
    assertPrivateSocket(path);
    options.validateBoundSocket?.(path);
    return {
      close: () => (closePromise ??= closeOwnedServer(server, path, identity!)),
      lastError: () => runtimeError,
    };
  } catch (error) {
    // Post-bind validation failures use precisely the same identity-safe close
    // path as ordinary shutdown, including protection for replacement paths.
    if (identity) {
      try {
        await closeOwnedServer(server, path, identity);
      } catch {
        // Preserve the startup failure as the useful operator diagnostic.
      }
    } else {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    throw error;
  }
}
