import { Cron } from 'croner';
import {
  createScheduleRow,
  materializeDueScheduleTasks,
  markTaskAccepted,
  setScheduleEnabled,
  type ScheduleRow,
} from './db.js';
import type { GatewayCoordinator, PiNotifier } from './slack.js';

export type ScheduleInput =
  | { title: string; instructions: string; at: string }
  | { title: string; instructions: string; cron: string; timezone: string };

const offsetIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export function parseAt(value: string): string {
  if (!offsetIso.test(value) || Number.isNaN(Date.parse(value)))
    throw new Error('--at must be an ISO-8601 timestamp with Z or an explicit UTC offset.');
  return new Date(value).toISOString();
}

export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

export function cronFor(expression: string, timezone: string): Cron {
  if (expression.trim().split(/\s+/).length !== 5)
    throw new Error('Cron expression must contain exactly five fields.');
  validateTimezone(timezone);
  try {
    return new Cron(expression, { timezone, mode: '5-part' });
  } catch {
    throw new Error('Invalid cron expression.');
  }
}

export function nextCronOccurrence(expression: string, timezone: string, after: Date): string {
  const next = cronFor(expression, timezone).nextRun(after);
  if (!next) throw new Error('Cron expression has no future occurrence.');
  return next.toISOString();
}

export function addSchedule(input: ScheduleInput, clock: () => Date = () => new Date()): ScheduleRow {
  if (!input.title.trim() || !input.instructions.trim()) throw new Error('title and instructions must be non-empty.');
  if ('at' in input) {
    const at = parseAt(input.at);
    return createScheduleRow({ title: input.title.trim(), instructions: input.instructions.trim(), kind: 'at', at });
  }
  const expression = input.cron.trim();
  const timezone = input.timezone.trim();
  const nextRunAt = nextCronOccurrence(expression, timezone, clock());
  return createScheduleRow({ title: input.title.trim(), instructions: input.instructions.trim(), kind: 'cron', cron: expression, timezone, nextRunAt });
}

export function enableSchedule(row: ScheduleRow, clock: () => Date = () => new Date()): ScheduleRow {
  const now = clock();
  if (row.kind === 'at') {
    if (!row.at_time || new Date(row.at_time).getTime() <= now.getTime())
      throw new Error('Cannot enable a one-time schedule whose time is in the past.');
    return setScheduleEnabled(row.id, true, row.at_time);
  }
  return setScheduleEnabled(row.id, true, nextCronOccurrence(row.cron_expression!, row.timezone!, now));
}

export function materializeDueSchedules(clock: () => Date = () => new Date()) {
  const current = clock();
  return materializeDueScheduleTasks(current.toISOString(), (row, after) =>
    nextCronOccurrence(row.cron_expression!, row.timezone!, new Date(after)),
  );
}

export class SchedulerService {
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly notifier: PiNotifier,
    private readonly coordinator: GatewayCoordinator,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async tick(): Promise<void> {
    await this.coordinator.run(async () => {
      const tasks = materializeDueSchedules(this.clock);
      for (const task of tasks) {
        try {
          const acceptance = await this.notifier.notify(
            `[New scheduled task; task-${task.id}]\nTitle: ${task.title}\nInstructions follow:\n---\n${task.instructions}\n---\n` +
              `This is durable scheduled task work. Use pi-tag-slack task show task-${task.id} and task resolve task-${task.id}.`,
          );
          markTaskAccepted(Number(task.id), acceptance);
        } catch {
          // The committed open task is recovery-visible; never recreate it on failure.
        }
      }
    });
  }

  start(intervalMs = 15_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
