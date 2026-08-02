import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayLifecycle } from '../src/lifecycle.js';
import type { DaemonLogger } from '../src/logging.js';
import { SchedulerService } from '../src/scheduler.js';
import { GatewayCoordinator } from '../src/slack.js';

function logger(): DaemonLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as DaemonLogger;
}

afterEach(() => vi.useRealTimers());

describe('GatewayLifecycle', () => {
  it('stops intake and timers, drains accepted work, then closes pi, database, and lock', async () => {
    const calls: string[] = [];
    const lifecycle = new GatewayLifecycle({
      logger: logger(),
      stopAccepting: { stop: () => calls.push('slack') },
      stopControl: { close: () => calls.push('control') },
      stopTimers: { stop: () => calls.push('timers') },
      drainCoordinator: async () => calls.push('drain'),
      stopPi: async () => calls.push('pi'),
      closeDatabase: () => calls.push('database'),
      releaseLock: () => calls.push('lock'),
    });
    await lifecycle.shutdown();
    expect(calls).toEqual(['slack', 'control', 'timers', 'drain', 'pi', 'database', 'lock']);
  });

  it('waits for active Slack, control, scheduler, coordinator, and pi work in order', async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    const active = (name: string) => async () => {
      calls.push(`${name}:start`);
      await new Promise<void>((resolve) => releases.push(resolve));
      calls.push(`${name}:done`);
    };
    const lifecycle = new GatewayLifecycle({
      logger: logger(),
      stopAccepting: { stop: active('slack') },
      stopControl: { close: active('control') },
      stopTimers: { stop: active('scheduler') },
      drainCoordinator: active('coordinator'),
      stopPi: active('pi'),
      closeDatabase: () => calls.push('database'),
      releaseLock: () => calls.push('lock'),
    });
    const shutdown = lifecycle.shutdown();
    for (const name of ['slack', 'control', 'scheduler', 'coordinator', 'pi']) {
      await vi.waitFor(() => expect(calls.at(-1)).toBe(`${name}:start`));
      expect(releases).toHaveLength(1);
      releases.shift()!();
      await vi.waitFor(() => expect(calls).toContain(`${name}:done`));
    }
    await shutdown;
    expect(calls).toEqual([
      'slack:start',
      'slack:done',
      'control:start',
      'control:done',
      'scheduler:start',
      'scheduler:done',
      'coordinator:start',
      'coordinator:done',
      'pi:start',
      'pi:done',
      'database',
      'lock',
    ]);
  });

  it('absorbs an interval tick rejected after coordinator shutdown and completes orderly cleanup', async () => {
    vi.useFakeTimers();
    const logs = logger();
    const coordinator = new GatewayCoordinator();
    const scheduler = new SchedulerService(
      { notify: async () => ({ acceptedAt: '', sessionId: '', runSequence: 0 }) },
      coordinator,
      undefined,
      logs,
    );
    const closeDatabase = vi.fn();
    const releaseLock = vi.fn();
    scheduler.start(1);
    const lifecycle = new GatewayLifecycle({
      logger: logs,
      stopAccepting: {
        stop: async () => {
          coordinator.close();
          await vi.advanceTimersByTimeAsync(1);
        },
      },
      stopTimers: scheduler,
      drainCoordinator: () => coordinator.drain(),
      closeDatabase,
      releaseLock,
    });

    await lifecycle.shutdown('SIGTERM');

    expect(logs.warn).toHaveBeenCalledWith({ event: 'scheduler_tick_failed' });
    expect(logs.info).toHaveBeenCalledWith({ event: 'shutdown_complete' });
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('continues through cleanup failure and shares one shutdown for repeated signals', async () => {
    let releases = 0;
    const stop = vi.fn(async () => {
      throw new Error('unavailable');
    });
    const lifecycle = new GatewayLifecycle({
      logger: logger(),
      stopAccepting: { stop },
      closeDatabase: vi.fn(),
      releaseLock: () => releases++,
    });
    await Promise.all([lifecycle.shutdown('SIGTERM'), lifecycle.shutdown('SIGINT')]);
    expect(stop).toHaveBeenCalledOnce();
    expect(releases).toBe(1);
  });

  it.each([
    ['slack', (hung: () => Promise<void>) => ({ stopAccepting: { stop: hung } })],
    ['control', (hung: () => Promise<void>) => ({ stopControl: { close: hung } })],
    ['pi', (hung: () => Promise<void>) => ({ stopPi: hung })],
  ])(
    'bounds a hung %s cleanup and still closes database and releases lock',
    async (_, component) => {
      vi.useFakeTimers();
      const logs = logger();
      const closeDatabase = vi.fn();
      const releaseLock = vi.fn();
      const lifecycle = new GatewayLifecycle({
        logger: logs,
        ...component(() => new Promise<void>(() => undefined)),
        closeDatabase,
        releaseLock,
        componentTimeoutMs: 10,
        piTimeoutMs: 10,
      });
      const shutdown = lifecycle.shutdown();
      await vi.advanceTimersByTimeAsync(10);
      await shutdown;
      expect(logs.warn).toHaveBeenCalledWith({ event: 'shutdown_component_timeout', component: _ });
      expect(closeDatabase).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalledOnce();
    },
  );

  it('logs an ordinary drain failure rather than a timeout and still releases the lock', async () => {
    const logs = logger();
    const releaseLock = vi.fn();
    const lifecycle = new GatewayLifecycle({
      logger: logs,
      drainCoordinator: async () => {
        throw new Error('failed');
      },
      releaseLock,
    });
    await lifecycle.shutdown();
    expect(logs.error).toHaveBeenCalledWith({
      event: 'shutdown_component_failed',
      component: 'coordinator',
    });
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
