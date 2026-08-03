import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  closeDb,
  createGatewayConfig,
  initDb,
  readGatewayConfig,
  updateGatewayConfig,
} from '../src/db.js';
import { dispatch } from '../src/control.js';
import { PiRpcSession } from '../src/pi-rpc.js';
import { GatewayCoordinator } from '../src/slack.js';
import { createSessionResetControls } from '../src/index.js';
import type { PiSessionStatus } from '../src/pi-rpc.js';

const directories: string[] = [];
afterEach(() => {
  closeDb();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function configured(): void {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-session-'));
  directories.push(directory);
  initDb(join(directory, 'gateway.db'));
  createGatewayConfig({
    channelId: 'C0123456789',
    channelLabel: 'gateway',
    workingDirectory: '/tmp',
    piBinary: 'pi',
    defaultModel: 'provider/default',
    defaultThinking: 'medium',
  });
}

function fakeSession(
  options: {
    streaming?: boolean;
    malformedModels?: boolean;
    rejectModel?: boolean;
    clampThinking?: boolean;
    thinkingCatalogs?: Record<string, string[]>;
  } = {},
) {
  let streaming = options.streaming ?? false;
  let model = 'provider/current';
  let thinking = 'low';
  const commands: string[] = [];
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as Record<string, string>;
    commands.push(request.type);
    let data: unknown;
    if (request.type === 'get_state')
      data = {
        isStreaming: streaming,
        sessionId: 'session',
        model: { provider: model.split('/')[0], id: model.split('/')[1] },
        thinkingLevel: thinking,
      };
    if (request.type === 'get_available_models')
      data = options.malformedModels
        ? { models: [{ provider: 'provider' }] }
        : {
            models: [
              { provider: 'provider', id: 'current' },
              { provider: 'provider', id: 'default' },
              { provider: 'provider', id: 'new' },
            ],
          };
    if (request.type === 'get_available_thinking_levels')
      data = {
        levels: options.thinkingCatalogs?.[model] ?? [
          'off',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ],
      };
    if (request.type === 'set_model' && !options.rejectModel)
      model = `${request.provider}/${request.modelId}`;
    if (request.type === 'set_thinking_level' && !options.clampThinking) thinking = request.level;
    stdout.write(
      JSON.stringify({
        id: request.id,
        type: 'response',
        command: request.type,
        success: request.type === 'set_model' && options.rejectModel ? false : true,
        ...(data === undefined ? {} : { data }),
      }) + '\n',
    );
  });
  const session = new PiRpcSession({
    binary: 'fake',
    sessionDir: '/tmp/session',
    cwd: '/tmp',
    desired: () => {
      const config = readGatewayConfig();
      return {
        model: String(config.session_model_override ?? config.default_model),
        thinking: String(config.session_thinking_override ?? config.default_thinking),
      };
    },
    spawn: (() => child) as typeof spawn,
    version: async () => '0.82.0',
  });
  return {
    session,
    commands,
    settle: () => {
      streaming = false;
      stdout.write('{"type":"agent_settled"}\n');
    },
  };
}

function services(session: PiRpcSession) {
  return {
    notifier: session,
    coordinator: new GatewayCoordinator(),
    sessionStatus: () => session.status(),
    sessionControls: session,
  };
}

const request = (
  command: string,
  params: Record<string, unknown>,
  value: ReturnType<typeof services>,
) => dispatch({ version: 1, id: 'request', command, params }, value);

describe('session reset control routing', () => {
  it('rejects malformed confirmation challenges before touching the session', () => {
    configured();
    const services = {
      notifier: {
        notify: async () => ({
          acceptedAt: '2030-01-01T00:00:00.000Z',
          sessionId: 'session',
          runSequence: 0,
        }),
      },
      coordinator: new GatewayCoordinator(),
      sessionControls: { reset: async () => ({ archivedTo: '', recoverySent: false }) },
    };
    expect(() =>
      dispatch(
        { version: 1, id: 'reset', command: 'session.reset', params: { confirm: 'bad' } },
        services,
      ),
    ).toThrow(/confirm must be/);
  });

  it('returns the active-session confirmation error unchanged', async () => {
    configured();
    const confirmation = Object.assign(
      new Error('Pi is active. Confirm with: pi-tag-slack session reset --confirm s:7'),
      { code: 'CONFIRMATION_REQUIRED' },
    );
    const controls = {
      availableModels: async () => [],
      availableThinkingLevels: async () => [],
      applyDesired: async () => ({ application: 'applied' as const }),
      reset: async () => {
        throw confirmation;
      },
    };
    await expect(
      dispatch(
        { version: 1, id: 'reset', command: 'session.reset', params: {} },
        {
          notifier: {
            notify: async () => ({
              acceptedAt: '2030-01-01T00:00:00.000Z',
              sessionId: 'session',
              runSequence: 0,
            }),
          },
          coordinator: new GatewayCoordinator(),
          sessionControls: controls,
        },
      ),
    ).rejects.toBe(confirmation);
  });
});

describe('active reset challenge', () => {
  const activeStatus = (overrides: Partial<PiSessionStatus> = {}): PiSessionStatus => ({
    running: true,
    health: 'healthy',
    sessionId: 'session',
    activity: 'active',
    runSequence: 3,
    lastError: null,
    lastFailure: null,
    desiredModel: null,
    desiredThinking: null,
    effectiveModel: null,
    effectiveThinking: null,
    pending: false,
    ...overrides,
  });

  it('rejects wrong and post-reservation stale challenges without resetting', async () => {
    let status = activeStatus();
    let epoch = 1;
    let resets = 0;
    let reserved = false;
    const failures: unknown[] = [];
    const owner = { status: async () => status, currentActivityEpoch: () => epoch };
    const controls = createSessionResetControls({
      current: () => owner,
      performReset: async () => {
        resets += 1;
        return { archivedTo: 'archive', recoverySent: true };
      },
      setReserved: (value) => {
        reserved = value;
      },
      onFailure: (error) => failures.push(error),
    });

    await expect(controls.confirmReset('session:2')).rejects.toMatchObject({
      code: 'STALE_CONFIRMATION',
    });
    expect(reserved).toBe(false);
    const confirmation = await controls.confirmReset('session:3');
    expect(reserved).toBe(true);
    status = activeStatus({ activity: 'idle' });
    epoch += 1;
    await expect(confirmation.postFlush()).rejects.toMatchObject({
      code: 'STALE_CONFIRMATION',
    });
    expect({ resets, reserved, failures: failures.length }).toEqual({
      resets: 0,
      reserved: false,
      failures: 0,
    });
  });

  it('cancels on disconnect and starts reset only after the flush boundary', async () => {
    let reserved = false;
    const events: string[] = [];
    const owner = { status: async () => activeStatus(), currentActivityEpoch: () => 1 };
    const controls = createSessionResetControls({
      current: () => owner,
      performReset: async () => {
        events.push('terminate');
        return { archivedTo: 'archive', recoverySent: false };
      },
      setReserved: (value) => {
        reserved = value;
      },
      onFailure: () => undefined,
    });

    const cancelled = await controls.confirmReset('session:3');
    cancelled.cancelPostFlush();
    expect({ reserved, events }).toEqual({ reserved: false, events: [] });

    const confirmed = await controls.confirmReset('session:3');
    events.push('response-flushed');
    await confirmed.postFlush();
    expect(events).toEqual(['response-flushed', 'terminate']);
    expect(reserved).toBe(false);
  });
});

describe('coordinator reset reservation', () => {
  it('holds later daemon mutations until post-flush work or cancellation releases it', async () => {
    configured();
    const coordinator = new GatewayCoordinator();
    const events: string[] = [];
    const controls = {
      availableModels: async () => [],
      availableThinkingLevels: async () => [],
      applyDesired: async () => ({ application: 'applied' as const }),
      reset: async () => ({ archivedTo: '', recoverySent: false }),
      confirmReset: async () => ({
        result: { confirmed: true },
        cancelPostFlush: () => events.push('cancelled'),
        postFlush: async () => {
          events.push('post-flush');
        },
      }),
    };
    const service = {
      notifier: {
        notify: async () => ({
          acceptedAt: '2030-01-01T00:00:00.000Z',
          sessionId: 'session',
          runSequence: 0,
        }),
      },
      coordinator,
      sessionControls: controls,
    };
    const reserved = (await dispatch(
      {
        version: 1,
        id: 'reset',
        command: 'session.reset',
        params: { confirm: 'session:1' },
      },
      service,
    )) as { postFlush(): Promise<void>; cancelPostFlush(): void };
    const mutation = dispatch(
      {
        version: 1,
        id: 'config',
        command: 'config.set',
        params: { key: 'archiveRetentionDays', value: '7' },
      },
      service,
    ) as Promise<unknown>;
    await new Promise((resolve) => setImmediate(resolve));
    expect(readGatewayConfig().archive_retention_days).toBe(30);
    await reserved.postFlush();
    await mutation;
    expect(events).toEqual(['post-flush']);
    expect(readGatewayConfig().archive_retention_days).toBe(7);
  });
});

describe('session desired/effective controls', () => {
  it('lists a validated catalog and rejects a malformed catalog without persistence', async () => {
    configured();
    const valid = fakeSession();
    await valid.session.start();
    await expect(request('session.model.list', {}, services(valid.session))).resolves.toEqual({
      models: expect.arrayContaining([expect.objectContaining({ ref: 'provider/new' })]),
    });
    const malformed = fakeSession({ malformedModels: true });
    await expect(malformed.session.start()).rejects.toThrow(/Invalid get_available_models/);
    expect(readGatewayConfig().session_model_override).toBeNull();
  });

  it('validates live default catalogs before persistence and applies effective idle defaults', async () => {
    configured();
    const fake = fakeSession();
    await fake.session.start();
    const service = services(fake.session);

    await expect(
      request('config.set', { key: 'defaultModel', value: 'provider/missing' }, service),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      request('config.set', { key: 'defaultThinking', value: 'unsupported' }, service),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(readGatewayConfig()).toMatchObject({
      default_model: 'provider/default',
      default_thinking: 'medium',
    });

    await expect(
      request('config.set', { key: 'defaultModel', value: 'provider/new' }, service),
    ).resolves.toMatchObject({ default_model: 'provider/new', application: 'applied' });
    await expect(
      request('config.set', { key: 'defaultThinking', value: 'high' }, service),
    ).resolves.toMatchObject({ default_thinking: 'high', application: 'applied' });
    await expect(fake.session.status()).resolves.toMatchObject({
      effectiveModel: 'provider/new',
      effectiveThinking: 'high',
    });
  });

  it('leaves settings unchanged when a live catalog is unavailable', async () => {
    configured();
    const coordinator = new GatewayCoordinator();
    const unavailable = Object.assign(new Error('catalog unavailable'), {
      code: 'SESSION_UNAVAILABLE',
    });
    const controls = {
      availableModels: async () => {
        throw unavailable;
      },
      availableThinkingLevels: async () => {
        throw unavailable;
      },
      applyDesired: async () => ({ application: 'applied' as const }),
    };
    const service = {
      notifier: {
        notify: async () => ({
          acceptedAt: '2030-01-01T00:00:00.000Z',
          sessionId: 'session',
          runSequence: 0,
        }),
      },
      coordinator,
      sessionControls: controls,
    };
    await expect(
      dispatch(
        {
          version: 1,
          id: 'default',
          command: 'config.set',
          params: { key: 'defaultModel', value: 'provider/new' },
        },
        service,
      ),
    ).rejects.toBe(unavailable);
    expect(readGatewayConfig().default_model).toBe('provider/default');
  });

  it('rejects unknown models, applies idle selections, and accepts every supported thinking level', async () => {
    configured();
    const fake = fakeSession();
    await fake.session.start();
    const service = services(fake.session);
    await expect(
      request('session.model.set', { ref: 'provider/missing' }, service),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(readGatewayConfig().session_model_override).toBeNull();
    await expect(
      request('session.model.set', { ref: 'provider/new' }, service),
    ).resolves.toMatchObject({ application: 'applied' });
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      await expect(request('session.thinking.set', { level }, service)).resolves.toMatchObject({
        application: 'applied',
      });
    expect((await fake.session.status()).effectiveModel).toBe('provider/new');
    expect((await fake.session.status()).effectiveThinking).toBe('max');
  });

  it('reapplies a persisted override when a fresh RPC session starts', async () => {
    configured();
    updateGatewayConfig('sessionModelOverride', 'provider/new');
    const fake = fakeSession();
    await fake.session.start();
    await expect(fake.session.applyDesired()).resolves.toMatchObject({ application: 'applied' });
    expect((await fake.session.status()).effectiveModel).toBe('provider/new');
  });

  it('keeps desired state when application fails while effective state remains unchanged', async () => {
    configured();
    const fake = fakeSession({ rejectModel: true });
    await fake.session.start();
    const service = services(fake.session);
    await expect(
      request('session.model.set', { ref: 'provider/new' }, service),
    ).resolves.toMatchObject({ application: 'failed' });
    expect(readGatewayConfig().session_model_override).toBe('provider/new');
    await expect(fake.session.status()).resolves.toMatchObject({
      health: 'degraded',
      desiredModel: 'provider/new',
      effectiveModel: 'provider/current',
    });
  });

  it('fails and degrades when pi acknowledges but clamps desired thinking', async () => {
    configured();
    const fake = fakeSession({ clampThinking: true });
    await fake.session.start();

    await expect(
      request('session.thinking.set', { level: 'high' }, services(fake.session)),
    ).resolves.toMatchObject({ desiredThinking: 'high', application: 'failed' });
    expect(readGatewayConfig().session_thinking_override).toBe('high');
    await expect(fake.session.status()).resolves.toMatchObject({
      health: 'degraded',
      desiredThinking: 'high',
      effectiveModel: 'provider/default',
      effectiveThinking: 'low',
    });
  });

  it('validates thinking against the selected target model catalog', async () => {
    configured();
    updateGatewayConfig('sessionModelOverride', 'provider/new');
    updateGatewayConfig('sessionThinkingOverride', 'max');
    const fake = fakeSession({
      thinkingCatalogs: {
        'provider/current': ['low'],
        'provider/new': ['max'],
      },
    });

    await expect(fake.session.start()).resolves.toBeUndefined();
    await expect(fake.session.applyDesired()).resolves.toEqual({ application: 'applied' });
    await expect(fake.session.status()).resolves.toMatchObject({
      health: 'healthy',
      effectiveModel: 'provider/new',
      effectiveThinking: 'max',
    });
    expect(
      fake.commands.filter((command) => command === 'get_available_thinking_levels'),
    ).toHaveLength(2);
  });

  it('keeps active changes pending, applies model before thinking, and reset selects defaults', async () => {
    configured();
    const fake = fakeSession({ streaming: true });
    await fake.session.start();
    const service = services(fake.session);
    await expect(
      request('session.model.set', { ref: 'provider/new' }, service),
    ).resolves.toMatchObject({ application: 'pending' });
    await expect(request('session.thinking.set', { level: 'max' }, service)).resolves.toMatchObject(
      { application: 'pending' },
    );
    await expect(fake.session.status()).resolves.toMatchObject({
      desiredModel: 'provider/new',
      effectiveModel: 'provider/current',
      pending: true,
    });
    fake.session.setSafeBoundaryHandler(() => {
      void service.coordinator.run(() => fake.session.applyDesired());
    });
    fake.settle();
    await new Promise((resolve) => setImmediate(resolve));
    const applied = fake.commands.filter(
      (command) => command === 'set_model' || command === 'set_thinking_level',
    );
    expect(applied).toEqual(['set_model', 'set_thinking_level']);
    await expect(request('session.model.reset', {}, service)).resolves.toMatchObject({
      desiredModel: 'provider/default',
      application: 'applied',
    });
    await expect(request('session.thinking.reset', {}, service)).resolves.toMatchObject({
      desiredThinking: 'medium',
      application: 'applied',
    });
  });
});
