function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

export function limit(value: unknown): number {
  const number = Number(value ?? 50);
  if (!Number.isInteger(number) || number < 1 || number > 200) {
    fail('INVALID_PARAMS', 'limit must be an integer from 1 to 200.');
  }
  return number;
}

export function state(value: unknown): 'open' | 'resolved' | 'all' {
  if (value === undefined) return 'open';
  if (value === 'open' || value === 'resolved' || value === 'all') return value;
  fail('INVALID_PARAMS', 'state must be open, resolved, or all.');
}

export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    fail('INVALID_PARAMS', `${name} must be non-empty.`);
  return value.trim();
}

export function filePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
    fail('INVALID_PARAMS', 'files must be an array of non-empty paths.');
  return value as string[];
}

export function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    fail('INVALID_PARAMS', 'ids must be a non-empty string array.');
  }
  return value as string[];
}

export type ListCursor = { createdAt: string; id: number };

export function decodeCursor(value: unknown): ListCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    fail('INVALID_PARAMS', 'cursor must be a non-empty string.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as ListCursor).createdAt !== 'string' ||
      !Number.isInteger((parsed as ListCursor).id) ||
      (parsed as ListCursor).id < 1
    ) {
      throw new Error('invalid cursor');
    }
    return parsed as ListCursor;
  } catch {
    fail('INVALID_PARAMS', 'cursor is invalid.');
  }
}

export function fileId(value: unknown): string {
  const id = text(value, 'fileId');
  if (!/^F[A-Z0-9]+$/.test(id))
    fail('INVALID_PARAMS', 'Slack file ID must be a raw uppercase F... ID.');
  return id;
}

export function optionalCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return text(value, 'cursor');
}

export type TrustCursor = { createdAt: string; userId: string };

export function decodeTrustCursor(value: unknown): TrustCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    fail('INVALID_PARAMS', 'cursor must be a non-empty string.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as TrustCursor).createdAt !== 'string' ||
      !/^[UW][A-Z0-9]+$/.test(String((parsed as TrustCursor).userId))
    )
      throw new Error('invalid');
    return parsed as TrustCursor;
  } catch {
    fail('INVALID_PARAMS', 'cursor is invalid.');
  }
}

export function encodeTrustCursor(row: { createdAt: string; userId: string }): string {
  return Buffer.from(JSON.stringify(row)).toString('base64url');
}

export function trustUserId(value: unknown): string {
  const userId = text(value, 'userId');
  if (!/^[UW][A-Z0-9]+$/.test(userId))
    fail('INVALID_PARAMS', 'Slack user ID must be a raw uppercase U... or W... ID.');
  return userId;
}

export function encodeCursor(row: { created_at: string; id: number }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString(
    'base64url',
  );
}
