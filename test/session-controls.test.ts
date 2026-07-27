import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { closeDb, createGatewayConfig, initDb, readGatewayConfig } from '../src/db.js';
import { dispatch } from '../src/control.js';
import { PiRpcSession } from '../src/pi-rpc.js';
import { GatewayCoordinator } from '../src/slack.js';

const directories: string[] = [];
afterEach(() => {
  closeDb();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configured(): void {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-session-'));
  directories.push(directory);
  initDb(join(directory, 'gateway.db'));
  createGatewayConfig({
    channelId: 'C0123456789', channelLabel: 'gateway', workingDirectory: '/tmp', piBinary: 'pi',
    defaultModel: 'provider/default', defaultThinking: 'medium',
  });
}

function fakeSession(options: { streaming?: boolean; malformedModels?: boolean; rejectModel?: boolean } = {}) {
  let streaming = options.streaming ?? false;
  let model = 'provider/current';
  let thinking = 'low';
  const commands: string[] = [];
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr: new PassThrough(), kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as Record<string, string>;
    commands.push(request.type);
    let data: unknown;
    if (request.type === 'get_state') data = {
      isStreaming: streaming, sessionId: 'session',
      model: { provider: model.split('/')[0], id: model.split('/')[1] }, thinkingLevel: thinking,
    };
    if (request.type === 'get_available_models') data = options.malformedModels
      ? { models: [{ provider: 'provider' }] }
      : { models: [{ provider: 'provider', id: 'current' }, { provider: 'provider', id: 'default' }, { provider: 'provider', id: 'new' }] };
    if (request.type === 'get_available_thinking_levels')
      data = { levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };
    if (request.type === 'set_model' && !options.rejectModel) model = `${request.provider}/${request.modelId}`;
    if (request.type === 'set_thinking_level') thinking = request.level;
    stdout.write(JSON.stringify({
      id: request.id, type: 'response', command: request.type,
      success: request.type === 'set_model' && options.rejectModel ? false : true,
      ...(data === undefined ? {} : { data }),
    }) + '\n');
  });
  const session = new PiRpcSession({
    binary: 'fake', sessionDir: '/tmp/session', cwd: '/tmp',
    desired: () => {
      const config = readGatewayConfig();
      return {
        model: String(config.session_model_override ?? config.default_model),
        thinking: String(config.session_thinking_override ?? config.default_thinking),
      };
    },
    spawn: (() => child) as typeof spawn,
  });
  return { session, commands, settle: () => { streaming = false; stdout.write('{"type":"agent_settled"}\n'); } };
}

function services(session: PiRpcSession) {
  return { notifier: session, coordinator: new GatewayCoordinator(), sessionStatus: () => session.status(), sessionControls: session };
}

const request = (command: string, params: Record<string, unknown>, value: ReturnType<typeof services>) =>
  dispatch({ version: 1, id: 'request', command, params }, value);

describe('session desired/effective controls', () => {
  it('lists a validated catalog and rejects a malformed catalog without persistence', async () => {
    configured();
    const valid = fakeSession(); await valid.session.start();
    await expect(request('session.model.list', {}, services(valid.session))).resolves.toEqual({
      models: expect.arrayContaining([expect.objectContaining({ ref: 'provider/new' })]),
    });
    const malformed = fakeSession({ malformedModels: true }); await malformed.session.start();
    await expect(request('session.model.set', { ref: 'provider/new' }, services(malformed.session))).rejects.toThrow(/Invalid get_available_models/);
    expect(readGatewayConfig().session_model_override).toBeNull();
  });

  it('rejects unknown models, applies idle selections, and accepts every supported thinking level', async () => {
    configured(); const fake = fakeSession(); await fake.session.start(); const service = services(fake.session);
    await expect(request('session.model.set', { ref: 'provider/missing' }, service)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(readGatewayConfig().session_model_override).toBeNull();
    await expect(request('session.model.set', { ref: 'provider/new' }, service)).resolves.toMatchObject({ application: 'applied' });
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      await expect(request('session.thinking.set', { level }, service)).resolves.toMatchObject({ application: 'applied' });
    expect((await fake.session.status()).effectiveModel).toBe('provider/new');
    expect((await fake.session.status()).effectiveThinking).toBe('max');
  });

  it('reapplies a persisted override when a fresh RPC session starts', async () => {
    configured();
    dispatch({ version: 1, id: 'persist', command: 'config.set', params: { key: 'sessionModelOverride', value: 'provider/new' } });
    const fake = fakeSession(); await fake.session.start();
    await expect(fake.session.applyDesired()).resolves.toMatchObject({ application: 'applied' });
    expect((await fake.session.status()).effectiveModel).toBe('provider/new');
  });

  it('keeps desired state when application fails while effective state remains unchanged', async () => {
    configured(); const fake = fakeSession({ rejectModel: true }); await fake.session.start(); const service = services(fake.session);
    await expect(request('session.model.set', { ref: 'provider/new' }, service)).resolves.toMatchObject({ application: 'failed' });
    expect(readGatewayConfig().session_model_override).toBe('provider/new');
    await expect(fake.session.status()).resolves.toMatchObject({
      health: 'degraded', desiredModel: 'provider/new', effectiveModel: 'provider/current',
    });
  });

  it('keeps active changes pending, applies model before thinking, and reset selects defaults', async () => {
    configured();
    const fake = fakeSession({ streaming: true }); await fake.session.start(); const service = services(fake.session);
    await expect(request('session.model.set', { ref: 'provider/new' }, service)).resolves.toMatchObject({ application: 'pending' });
    await expect(request('session.thinking.set', { level: 'max' }, service)).resolves.toMatchObject({ application: 'pending' });
    await expect(fake.session.status()).resolves.toMatchObject({
      desiredModel: 'provider/new', effectiveModel: 'provider/current', pending: true,
    });
    fake.session.setSafeBoundaryHandler(() => { void service.coordinator.run(() => fake.session.applyDesired()); });
    fake.settle(); await new Promise((resolve) => setImmediate(resolve));
    const applied = fake.commands.filter((command) => command === 'set_model' || command === 'set_thinking_level');
    expect(applied).toEqual(['set_model', 'set_thinking_level']);
    await expect(request('session.model.reset', {}, service)).resolves.toMatchObject({ desiredModel: 'provider/default', application: 'applied' });
    await expect(request('session.thinking.reset', {}, service)).resolves.toMatchObject({ desiredThinking: 'medium', application: 'applied' });
  });
});
