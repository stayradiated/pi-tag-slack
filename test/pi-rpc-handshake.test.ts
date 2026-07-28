import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { PiRpcSession, piEnvironment } from '../src/pi-rpc.js';

type Failure = 'follow-up' | 'state' | 'models' | 'thinking';

function fakeSession(
  options: {
    version?: () => Promise<string>;
    failure?: Failure;
    desired?: { model: string | null; thinking: string | null };
  } = {},
) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  let killed = false;
  const commands: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => (killed = true),
  }) as unknown as ChildProcessWithoutNullStreams;
  stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as { id: string; type: string };
    commands.push(request.type);
    const malformed = options.failure === 'follow-up' && request.type === 'set_follow_up_mode';
    const data =
      request.type === 'get_state'
        ? options.failure === 'state'
          ? { isStreaming: 'no' }
          : {
              isStreaming: false,
              sessionId: 'session-1',
              model: { provider: 'provider', id: 'model' },
              thinkingLevel: 'medium',
            }
        : request.type === 'get_available_models'
          ? options.failure === 'models'
            ? { models: [{ provider: 'provider' }] }
            : { models: [{ provider: 'provider', id: 'model' }] }
          : request.type === 'get_available_thinking_levels'
            ? options.failure === 'thinking'
              ? { levels: ['unsupported'] }
              : { levels: ['medium'] }
            : undefined;
    stdout.write(
      JSON.stringify({
        id: request.id,
        type: malformed ? 'event' : 'response',
        command: request.type,
        success: true,
        ...(data === undefined ? {} : { data }),
      }) + '\n',
    );
  });
  const session = new PiRpcSession({
    binary: 'fake-pi',
    sessionDir: '/tmp/session',
    cwd: '/tmp',
    desired: () => options.desired ?? { model: 'provider/model', thinking: 'medium' },
    spawn: (() => child) as typeof spawn,
    version: options.version ?? (async () => '0.82.0'),
  });
  return { session, commands, killed: () => killed };
}

describe('PiRpcSession startup handshake', () => {
  it('prepends an explicit EXTRA_PATH when starting pi', () => {
    expect(piEnvironment('/custom/bin')).toMatchObject({
      PATH: `/custom/bin${process.env.PATH ? `:${process.env.PATH}` : ''}`,
    });
  });
  it('runs the version check and validates the successful capability handshake', async () => {
    const fake = fakeSession();
    await expect(fake.session.start()).resolves.toBeUndefined();
    expect(fake.commands).toEqual(
      expect.arrayContaining([
        'set_follow_up_mode',
        'get_state',
        'get_available_models',
        'get_available_thinking_levels',
      ]),
    );
    await expect(fake.session.status()).resolves.toMatchObject({
      health: 'healthy',
      sessionId: 'session-1',
      effectiveModel: 'provider/model',
    });
  });

  it.each([
    [
      'missing executable',
      async () => {
        throw new Error('spawn fake-pi ENOENT');
      },
      /ENOENT/,
    ],
    ['old executable', async () => '0.81.9', /0\.82\.0 or later/],
    ['malformed version output', async () => 'pi version unknown', /Malformed pi --version/],
  ])('fails cleanly for a $0', async (_name, version, message) => {
    const fake = fakeSession({ version });
    await expect(fake.session.start()).rejects.toThrow(message);
    expect(fake.commands).toEqual([]);
    expect((await fake.session.status()).running).toBe(false);
  });

  it.each([
    ['follow-up', /Invalid set_follow_up_mode/],
    ['state', /Invalid get_state/],
    ['models', /Invalid get_available_models/],
    ['thinking', /Invalid get_available_thinking_levels/],
  ] as const)(
    'rejects malformed $0 RPC responses and cleans up the child',
    async (failure, message) => {
      const fake = fakeSession({ failure });
      await expect(fake.session.start()).rejects.toThrow(message);
      expect(fake.killed()).toBe(true);
      expect((await fake.session.status()).running).toBe(false);
    },
  );

  it.each([
    [{ model: 'provider/missing', thinking: 'medium' }, /Configured model is unavailable/],
    [{ model: 'provider/model', thinking: 'high' }, /Configured thinking level is unavailable/],
  ])('rejects desired settings absent from the handshake catalogs', async (desired, message) => {
    const fake = fakeSession({ desired });
    await expect(fake.session.start()).rejects.toThrow(message);
    expect(fake.killed()).toBe(true);
  });
});
