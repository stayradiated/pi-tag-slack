import { PI_STOP_LIFECYCLE_TIMEOUT_MS } from './pi-rpc.js';
import type { DaemonLogger } from './logging.js';

export const SHUTDOWN_COMPONENT_TIMEOUT_MS = 5_000;
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

type Stoppable = { stop(): void | Promise<void> };
type Closable = { close(): void | Promise<void> };

export type GatewayShutdownDependencies = {
  logger: DaemonLogger;
  stopAccepting?: Stoppable;
  stopControl?: Closable;
  stopTimers?: Stoppable;
  drainCoordinator?: () => Promise<void>;
  stopPi?: () => Promise<void>;
  closeDatabase?: () => void;
  releaseLock?: () => void;
  /** Test seam and fixed upper bound for every asynchronous cleanup component. */
  componentTimeoutMs?: number;
  drainTimeoutMs?: number;
  /** Must exceed PiRpcSession's complete stdin/TERM/KILL escalation window. */
  piTimeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

class ShutdownTimeoutError extends Error {}

function bounded<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  schedule: typeof setTimeout,
  cancel: typeof clearTimeout,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = schedule(() => reject(new ShutdownTimeoutError()), timeoutMs);
    operation().then(
      (value) => {
        cancel(timer);
        resolve(value);
      },
      (error: unknown) => {
        cancel(timer);
        reject(error);
      },
    );
  });
}

/** Idempotent ordered shutdown; cleanup always reaches database and lock release. */
export class GatewayLifecycle {
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly dependencies: GatewayShutdownDependencies) {}

  shutdown(reason = 'signal'): Promise<void> {
    return (this.shutdownPromise ??= this.performShutdown(reason));
  }

  private async component(
    name: string,
    operation: (() => void | Promise<void>) | undefined,
    timeoutMs: number,
    schedule: typeof setTimeout,
    cancel: typeof clearTimeout,
  ): Promise<void> {
    if (!operation) return;
    try {
      await bounded(() => Promise.resolve().then(operation), timeoutMs, schedule, cancel);
    } catch (error) {
      if (error instanceof ShutdownTimeoutError) {
        this.dependencies.logger.warn({ event: 'shutdown_component_timeout', component: name });
      } else {
        this.dependencies.logger.error({ event: 'shutdown_component_failed', component: name });
      }
    }
  }

  private async performShutdown(reason: string): Promise<void> {
    const { logger } = this.dependencies;
    const schedule = this.dependencies.setTimeout ?? setTimeout;
    const cancel = this.dependencies.clearTimeout ?? clearTimeout;
    const componentTimeout = this.dependencies.componentTimeoutMs ?? SHUTDOWN_COMPONENT_TIMEOUT_MS;
    logger.info({ event: 'shutdown_started', reason });
    // First prevent new work; coordinator work accepted before this point may drain.
    await this.component(
      'slack',
      () => this.dependencies.stopAccepting?.stop(),
      componentTimeout,
      schedule,
      cancel,
    );
    await this.component(
      'control',
      () => this.dependencies.stopControl?.close(),
      componentTimeout,
      schedule,
      cancel,
    );
    await this.component(
      'timers',
      () => this.dependencies.stopTimers?.stop(),
      componentTimeout,
      schedule,
      cancel,
    );
    await this.component(
      'coordinator',
      this.dependencies.drainCoordinator,
      this.dependencies.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS,
      schedule,
      cancel,
    );
    await this.component(
      'pi',
      this.dependencies.stopPi,
      this.dependencies.piTimeoutMs ?? PI_STOP_LIFECYCLE_TIMEOUT_MS,
      schedule,
      cancel,
    );
    // These are synchronous finalizers: neither is skipped when an earlier component failed/timed out.
    try {
      this.dependencies.closeDatabase?.();
    } catch {
      logger.error({ event: 'shutdown_component_failed', component: 'database' });
    }
    try {
      this.dependencies.releaseLock?.();
    } catch {
      logger.error({ event: 'shutdown_component_failed', component: 'lock' });
    }
    logger.info({ event: 'shutdown_complete' });
  }
}
