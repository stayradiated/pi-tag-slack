import { afterEach, describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControlServer } from '../src/control.js';
import { closeDb, createGatewayConfig, initDb } from '../src/db.js';
import { GatewayCoordinator } from '../src/slack.js';

const roots: string[] = [];
const previousDataDir = process.env.PI_TAG_SLACK_DATA_DIR;

afterEach(() => {
  closeDb();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
  else process.env.PI_TAG_SLACK_DATA_DIR = previousDataDir;
});

function configured() {
  const root = mkdtempSync(join(tmpdir(), 'pi-tag-slack-reset-receipt-'));
  roots.push(root);
  process.env.PI_TAG_SLACK_DATA_DIR = root;
  initDb(join(root, 'gateway.db'));
  createGatewayConfig({
    channelId: 'C0123456789',
    channelLabel: 'gateway',
    workingDirectory: '/tmp',
    piBinary: 'pi',
    defaultModel: 'provider/model',
    defaultThinking: 'medium',
  });
  return join(root, 'control.sock');
}

function response(socket: Socket): Promise<{ id: string; result?: unknown; error?: unknown }> {
  return new Promise((resolve, reject) => {
    let output = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline === -1) return;
      try {
        resolve(JSON.parse(output.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function close(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

describe('active reset receipt protocol', () => {
  it('rejects a trailing ordinary frame before dispatching it', async () => {
    const path = configured();
    const server = await startControlServer(undefined, { path });
    try {
      const socket = connect(path);
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write('{"version":1,"id":"first","command":"health","params":{}}\n');
      socket.end('{"version":1,"id":"second","command":"health","params":{}}\n');
      await expect(response(socket)).resolves.toEqual({
        id: 'first',
        error: { code: 'TRAILING_DATA', message: 'Only one request frame is allowed.' },
      });
    } finally {
      await server.close();
    }
  });

  it('cancels a reserved reset when the peer closes after response receipt but before acknowledgement', async () => {
    const path = configured();
    let cancellations = 0;
    let resets = 0;
    const coordinator = new GatewayCoordinator();
    const server = await startControlServer(
      {
        notifier: {
          notify: async () => ({
            acceptedAt: '2030-01-01T00:00:00.000Z',
            sessionId: 'session',
            runSequence: 0,
          }),
        },
        coordinator,
        sessionControls: {
          availableModels: async () => [],
          availableThinkingLevels: async () => [],
          applyDesired: async () => ({ application: 'applied' as const }),
          reset: async () => ({ archivedTo: '', recoverySent: false }),
          confirmReset: async () => ({
            result: { confirmed: true },
            cancelPostFlush: () => {
              cancellations += 1;
            },
            postFlush: async () => {
              resets += 1;
            },
          }),
        },
      },
      { path },
    );
    try {
      const socket = connect(path);
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(
        '{"version":1,"id":"reset","command":"session.reset","params":{"confirm":"session:1"}}\n',
      );
      await response(socket);
      const closed = close(socket);
      socket.destroy();
      await closed;
      await new Promise((resolve) => setImmediate(resolve));
      let laterWorkRan = false;
      await coordinator.run(() => {
        laterWorkRan = true;
      });
      expect({ cancellations, resets, laterWorkRan }).toEqual({
        cancellations: 1,
        resets: 0,
        laterWorkRan: true,
      });
    } finally {
      await server.close();
    }
  });

  it('does not dispatch a confirmed reset twice when EOF arrives while its reservation is pending', async () => {
    const path = configured();
    let confirmations = 0;
    let cancellations = 0;
    const coordinator = new GatewayCoordinator();
    let releaseBlock!: () => void;
    const blocker = coordinator.run(() => new Promise<void>((resolve) => (releaseBlock = resolve)));
    const server = await startControlServer(
      {
        notifier: {
          notify: async () => ({
            acceptedAt: '2030-01-01T00:00:00.000Z',
            sessionId: 'session',
            runSequence: 0,
          }),
        },
        coordinator,
        sessionControls: {
          availableModels: async () => [],
          availableThinkingLevels: async () => [],
          applyDesired: async () => ({ application: 'applied' as const }),
          reset: async () => ({ archivedTo: '', recoverySent: false }),
          confirmReset: async () => {
            confirmations += 1;
            return {
              result: { confirmed: true },
              cancelPostFlush: () => {
                cancellations += 1;
              },
              postFlush: async () => undefined,
            };
          },
        },
      },
      { path },
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const socket = connect(path);
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      const closed = close(socket);
      socket.on('data', () => undefined);
      socket.write(
        '{"version":1,"id":"reset","command":"session.reset","params":{"confirm":"session:1"}}\n',
      );
      socket.end();
      await new Promise((resolve) => setImmediate(resolve));
      releaseBlock();
      await blocker;
      await closed;
      await coordinator.drain();
      expect({ confirmations, cancellations }).toEqual({ confirmations: 1, cancellations: 1 });
    } finally {
      await server.close();
    }
  });

  it('starts reset only after the client has consumed and acknowledged its response', async () => {
    const path = configured();
    const events: string[] = [];
    const server = await startControlServer(
      {
        notifier: {
          notify: async () => ({
            acceptedAt: '2030-01-01T00:00:00.000Z',
            sessionId: 'session',
            runSequence: 0,
          }),
        },
        coordinator: new GatewayCoordinator(),
        sessionControls: {
          availableModels: async () => [],
          availableThinkingLevels: async () => [],
          applyDesired: async () => ({ application: 'applied' as const }),
          reset: async () => ({ archivedTo: '', recoverySent: false }),
          confirmReset: async () => ({
            result: { confirmed: true },
            cancelPostFlush: () => events.push('cancelled'),
            postFlush: async () => {
              events.push('reset');
            },
          }),
        },
      },
      { path },
    );
    try {
      const socket = connect(path);
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(
        '{"version":1,"id":"reset","command":"session.reset","params":{"confirm":"session:1"}}\n',
      );
      await response(socket);
      events.push('response-consumed');
      expect(events).toEqual(['response-consumed']);
      const closed = close(socket);
      socket.end('{"receipt":"reset"}\n');
      await closed;
      await new Promise((resolve) => setImmediate(resolve));
      expect(events).toEqual(['response-consumed', 'reset']);
    } finally {
      await server.close();
    }
  });
});
