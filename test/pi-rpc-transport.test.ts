import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiRpcSession } from '../src/pi-rpc.js';

type Request = { id: string; type: string };
type FakeChild = ChildProcessWithoutNullStreams & {
  commands: string[];
  kills: number;
};

function response(request: Request, overrides: Record<string, unknown> = {}): string {
  const data =
    request.type === 'get_state'
      ? {
          isStreaming: false,
          sessionId: 'session',
          model: { provider: 'provider', id: 'model' },
          thinkingLevel: 'medium',
        }
      : request.type === 'get_available_models'
        ? { models: [{ provider: 'provider', id: 'model' }] }
        : request.type === 'get_available_thinking_levels'
          ? { levels: ['medium'] }
          : undefined;
  return `${JSON.stringify({
    id: request.id,
    type: 'response',
    command: request.type,
    success: true,
    ...(data === undefined ? {} : { data }),
    ...overrides,
  })}\n`;
}

function fakeChild(
  handle: (request: Request, child: FakeChild) => string | Buffer | undefined = (request) =>
    response(request),
): FakeChild {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
  };
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    commands: [] as string[],
    kills: 0,
    kill: () => {
      child.kills += 1;
      exit();
      return true;
    },
  }) as unknown as FakeChild;
  stdin.on('finish', exit);
  stdin.on('data', (raw: Buffer) => {
    const request = JSON.parse(String(raw)) as Request;
    child.commands.push(request.type);
    const output = handle(request, child);
    if (output !== undefined) stdout.write(output);
  });
  return child;
}

function sessionFor(
  children: FakeChild[],
  options: Partial<ConstructorParameters<typeof PiRpcSession>[0]> = {},
): { session: PiRpcSession; spawns: () => number } {
  let spawns = 0;
  const session = new PiRpcSession({
    binary: 'pi',
    sessionDir: '/tmp/session',
    cwd: '/tmp',
    version: async () => '0.82.0',
    spawn: (() => children[spawns++]!) as typeof spawn,
    restartBaseMs: 1,
    restartMaxMs: 1,
    commandTimeoutMs: 100,
    ...options,
  });
  return { session, spawns: () => spawns };
}

async function waitForRestart(session: PiRpcSession, spawns: () => number): Promise<void> {
  await vi.waitFor(() => expect(spawns()).toBe(2));
  await vi.waitFor(async () => expect((await session.status()).running).toBe(true));
}

afterEach(() => vi.useRealTimers());

describe('PiRpcSession hardened transport', () => {
  it('continuously drains large stderr while bounding safe log metadata', async () => {
    const child = fakeChild();
    const activity: Array<{ bytes: number; suppressed: boolean }> = [];
    const { session } = sessionFor([child], {
      stderrLogMaxBytes: 1024,
      stderrLogMaxEvents: 2,
      onStderrActivity: (entry) => activity.push(entry),
    });
    await session.start();
    child.stderr.write(Buffer.alloc(2 * 1024 * 1024, 0x78));
    await expect(session.notify('work')).resolves.toMatchObject({ runSequence: 1 });
    expect(activity.length).toBeLessThanOrEqual(3);
    expect(activity.some((entry) => entry.suppressed)).toBe(true);
    expect(activity.reduce((total, entry) => total + entry.bytes, 0)).toBeLessThanOrEqual(1024);
    await session.stop();
  });

  it.each([
    ['unterminated', Buffer.alloc(300, 0x20), { maxIncompleteBytes: 256, maxFrameBytes: 512 }],
    [
      'terminated',
      Buffer.concat([Buffer.alloc(300, 0x20), Buffer.from('\n')]),
      { maxIncompleteBytes: 512, maxFrameBytes: 256 },
    ],
  ])(
    'kills and automatically restarts after an oversized %s frame',
    async (_name, frame, bounds) => {
      const first = fakeChild();
      const second = fakeChild();
      const { session, spawns } = sessionFor([first, second], bounds);
      await session.start();
      first.stdout.write(frame);
      await waitForRestart(session, spawns);
      expect(first.kills).toBe(1);
      await session.stop();
    },
  );

  it('treats Unicode separators as data and invalid UTF-8 as fatal', async () => {
    const first = fakeChild();
    const second = fakeChild();
    const { session, spawns } = sessionFor([first, second]);
    await session.start();
    first.stdout.write(
      `${JSON.stringify({ type: 'message_update', text: 'left middle right' })}\n`,
    );
    await expect(session.notify('after separators')).resolves.toMatchObject({ runSequence: 1 });

    first.stdout.write(Buffer.from([0xc3, 0x0a]));
    await waitForRestart(session, spawns);
    expect(first.kills).toBe(1);
    await session.stop();
  });

  it.each([
    ['malformed JSON', Buffer.from('{not-json}\n')],
    ['invalid protocol object', Buffer.from('{"value":true}\n')],
  ])('kills and restarts after %s', async (_name, frame) => {
    const first = fakeChild();
    const second = fakeChild();
    const { session, spawns } = sessionFor([first, second]);
    await session.start();
    first.stdout.write(frame);
    await waitForRestart(session, spawns);
    expect(first.kills).toBe(1);
    await session.stop();
  });

  it.each([
    ['wrong command', { command: 'follow_up' }],
    ['non-boolean success', { success: 'yes' }],
    ['non-response frame', { type: 'agent_start' }],
  ])(
    'rejects a %s carrying the same command id and degrades the child',
    async (_name, override) => {
      const first = fakeChild((request) =>
        request.type === 'prompt' ? response(request, override) : response(request),
      );
      const { session } = sessionFor([first]);
      await session.start();
      await expect(session.notify('work')).rejects.toThrow(/Invalid pi RPC frame/);
      expect(first.kills).toBe(1);
      expect(await session.status()).toMatchObject({ running: false, health: 'degraded' });
      await session.stop();
    },
  );

  it('times out a nonresponding command, removes it, and restarts for later commands', async () => {
    const first = fakeChild((request) =>
      request.type === 'prompt' ? undefined : response(request),
    );
    const second = fakeChild();
    const { session, spawns } = sessionFor([first, second], { commandTimeoutMs: 10 });
    await session.start();
    await expect(session.notify('never answered')).rejects.toThrow(/prompt command timed out/);
    await waitForRestart(session, spawns);
    await expect(session.notify('later work')).resolves.toMatchObject({ runSequence: 1 });
    await session.stop();
  });

  it('rejects pending work once and schedules one restart across error/exit races', async () => {
    const first = fakeChild((request) =>
      request.type === 'prompt' ? undefined : response(request),
    );
    const second = fakeChild();
    let unexpectedExits = 0;
    const { session, spawns } = sessionFor([first, second], {
      commandTimeoutMs: 1_000,
      onUnexpectedExit: () => {
        unexpectedExits += 1;
      },
    });
    await session.start();
    const pending = session.notify('pending');
    first.emit('error', new Error('spawn failure'));
    first.emit('exit', 1, null);
    await expect(pending).rejects.toThrow('spawn failure');
    await waitForRestart(session, spawns);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(unexpectedExits).toBe(1);
    expect(spawns()).toBe(2);
    await session.stop();
  });
});
