import pino, { type Logger } from 'pino';

export type DaemonLogger = Logger;
export type DaemonLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Logs only operational metadata to stderr; daemon protocol stdout stays clean. */
export function createDaemonLogger(level: DaemonLogLevel = 'info'): DaemonLogger {
  return pino({ level, base: undefined }, pino.destination({ dest: 2, sync: true }));
}

/** Do not expose subprocess, SQLite, Slack, or user-provided error text. */
export function logFailure(logger: DaemonLogger, event: string, component: string): void {
  logger.error({ event, component });
}
