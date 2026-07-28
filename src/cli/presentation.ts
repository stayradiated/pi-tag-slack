/** Stable stdout presentation for successful daemon control responses. */
export function presentSuccess(command: string, result: unknown, json: boolean): string {
  if (json) return JSON.stringify(result);
  if (isList(result)) return presentList(command, result);
  return presentValue(result);
}

/** The JSON failure envelope is deliberately separate from successful output. */
export function presentFailure(error: unknown, json: boolean): string {
  const failure = error as { code?: unknown; message?: unknown };
  const code = typeof failure.code === 'string' ? failure.code : 'INTERNAL';
  const message = typeof failure.message === 'string' ? failure.message : 'Command failed.';
  return json
    ? JSON.stringify({ error: { code, message } })
    : `Error${code === 'INTERNAL' ? '' : ` [${code}]`}: ${message}`;
}

type ListResult = { items: unknown[]; nextCursor: unknown };

function isList(value: unknown): value is ListResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items) &&
    Object.hasOwn(value, 'nextCursor')
  );
}

function presentList(command: string, result: ListResult): string {
  const label = listLabel(command);
  const lines =
    result.items.length === 0
      ? [`No ${label}.`]
      : result.items.map((item) => `- ${presentInline(item)}`);
  if (result.nextCursor !== null && result.nextCursor !== undefined)
    lines.push(`Next cursor: ${String(result.nextCursor)}`);
  return lines.join('\n');
}

function listLabel(command: string): string {
  const labels: Record<string, string> = {
    'inbox.list': 'inbox items',
    'slack.history': 'Slack messages',
    'slack.thread': 'Slack thread messages',
    'task.list': 'tasks',
    'schedule.list': 'schedules',
    'trust.list': 'trusted users',
    'session.archive.list': 'session archives',
  };
  return labels[command] ?? 'items';
}

function presentValue(value: unknown): string {
  if (!isRecord(value)) return presentScalar(value);
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return 'OK.';
  return entries.map(([key, item]) => `${key}: ${presentInline(item)}`).join('\n');
}

function presentInline(value: unknown): string {
  if (isRecord(value))
    return Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${key}=${presentInline(item)}`)
      .join('; ');
  if (Array.isArray(value)) return value.map(presentInline).join(', ');
  return presentScalar(value);
}

function presentScalar(value: unknown): string {
  if (value === null) return 'none';
  if (value === undefined) return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
