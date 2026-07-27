import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { PiRpcSession } from '../src/pi-rpc.js';
import { GatewayLifecycle } from '../src/lifecycle.js';
import type { DaemonLogger } from '../src/logging.js';

function child(respondPrompt = true) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const commands: string[] = [];
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => undefined,
    commands,
  }) as unknown as ChildProcessWithoutNullStreams & { commands: string[] };
  stdin.on('data', (raw: Buffer) => {
    const request = JSON.parse(String(raw)) as { id: string; type: string };
    commands.push(request.type);
    if (request.type === 'prompt' && !respondPrompt) return;
    const data =
      request.type === 'get_state'
        ? {
            isStreaming: false,
            sessionId: 's',
            model: { provider: 'p', id: 'm' },
            thinkingLevel: 'medium',
          }
        : request.type === 'get_available_models'
          ? { models: [{ provider: 'p', id: 'm' }] }
          : request.type === 'get_available_thinking_levels'
            ? { levels: ['medium'] }
            : undefined;
    stdout.write(
      JSON.stringify({
        id: request.id,
        type: 'response',
        command: request.type,
        success: true,
        ...(data ? { data } : {}),
      }) + '\n',
    );
  });
  return process;
}

afterEach(() => vi.useRealTimers());

describe('PiRpcSession restart supervision', () => {
  it('degrades on exit, backs off with a cap, and stops at its threshold', async () => {
    vi.useFakeTimers();
    const first = child();
    let versionCalls = 0;
    const session = new PiRpcSession({
      binary: 'pi',
      sessionDir: '/tmp/s',
      cwd: '/tmp',
      version: async () =>
        ++versionCalls === 1 ? '0.82.0' : Promise.reject(new Error('unavailable')),
      spawn: (() => first) as typeof spawn,
      restartBaseMs: 10,
      restartMaxMs: 15,
      restartFailureThreshold: 3,
    });
    await session.start();
    first.emit('exit', 1, null);
    expect(await session.status()).toMatchObject({ running: false, health: 'degraded' });
    await vi.advanceTimersByTimeAsync(9);
    expect(versionCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(versionCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(14);
    expect(versionCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(versionCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(versionCalls).toBe(3);
  });

  it('restores health after an automatic restart without sending a prompt', async () => {
    vi.useFakeTimers();
    const first = child();
    const second = child();
    let spawns = 0;
    const session = new PiRpcSession({
      binary: 'pi',
      sessionDir: '/tmp/s',
      cwd: '/tmp',
      version: async () => '0.82.0',
      spawn: (() => [first, second][spawns++]!) as typeof spawn,
      restartBaseMs: 1,
    });
    await session.start();
    first.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1);
    expect(await session.status()).toMatchObject({ running: true, health: 'healthy' });
    // A restart performs only the handshake; it never presents recovery work.
    expect((second as unknown as { commands: string[] }).commands).not.toContain('prompt');
  });

  it('does not overlap child spawns for concurrent new notifications', async () => {
    const first = child();
    const replacement = child();
    let spawns = 0;
    const session = new PiRpcSession({
      binary: 'pi',
      sessionDir: '/tmp/s',
      cwd: '/tmp',
      version: async () => '0.82.0',
      spawn: (() => [first, replacement][spawns++]!) as typeof spawn,
      restartFailureThreshold: 1,
    });
    await session.start();
    first.emit('exit', 1, null);
    await Promise.all([session.notify('first new work'), session.notify('second new work')]);
    expect(spawns).toBe(2);
  });

  it('escalates a hung child from stdin close through terminate and kill', async () => {
    vi.useFakeTimers();
    const hung = child();
    const signals: string[] = [];
    (hung as unknown as { kill: (signal: string) => void }).kill = (signal) => signals.push(signal);
    const session = new PiRpcSession({
      binary: 'pi',
      sessionDir: '/tmp/s',
      cwd: '/tmp',
      version: async () => '0.82.0',
      spawn: (() => hung) as typeof spawn,
      stopGraceMs: 10,
      stopTerminateMs: 10,
    });
    await session.start();
    const stopping = session.stop();
    await vi.advanceTimersByTimeAsync(30);
    await stopping;
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('keeps database and lock cleanup behind complete hung-pi escalation', async () => {
    vi.useFakeTimers();
    const hung = child();
    const signals: string[] = [];
    (hung as unknown as { kill: (signal: string) => void }).kill = (signal) => signals.push(signal);
    const session = new PiRpcSession({
      binary: 'pi',
      sessionDir: '/tmp/s',
      cwd: '/tmp',
      version: async () => '0.82.0',
      spawn: (() => hung) as typeof spawn,
      stopGraceMs: 10,
      stopTerminateMs: 10,
    });
    await session.start();
    const finalizers: string[] = [];
    const lifecycle = new GatewayLifecycle({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as DaemonLogger,
      stopPi: () => session.stop(),
      piTimeoutMs: 31,
      closeDatabase: () => finalizers.push('database'),
      releaseLock: () => finalizers.push('lock'),
    });
    const shutdown = lifecycle.shutdown();
    await vi.advanceTimersByTimeAsync(29);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(finalizers).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(finalizers).toEqual(['database', 'lock']);
  });

  it('lets new work reopen an exhausted window, rejects pending RPC, and never restarts after stop', async () => {
    vi.useFakeTimers();
    const first = child(false);
    const replacement = child();
    let spawns = 0;
    const session = new PiRpcSession({
      binary: 'pi',
      sessionDir: '/tmp/s',
      cwd: '/tmp',
      version: async () => '0.82.0',
      spawn: (() => [first, replacement][spawns++]!) as typeof spawn,
      restartFailureThreshold: 1,
      restartBaseMs: 1,
    });
    await session.start();
    const pending = session.notify('durable work');
    first.emit('exit', 1, null);
    await expect(pending).rejects.toThrow(/exited/);
    await vi.advanceTimersByTimeAsync(10);
    expect(spawns).toBe(1);
    await expect(session.notify('new work')).resolves.toMatchObject({ runSequence: 1 });
    expect(spawns).toBe(2);
    replacement.emit('exit', 1, null);
    await session.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(spawns).toBe(2);
  });
});
