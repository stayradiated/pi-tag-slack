import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, renameSync, rmSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { GatewayPaths } from './paths.js';

const ARCHIVE_NAME =
  /^session-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(0|[1-9]\d*)$/;

export type SessionArchiveItem = { name: string; createdAt: string };
type InternalArchiveItem = SessionArchiveItem & {
  path: string;
  timestamp: number;
  sequence: number;
  dev: number;
  ino: number;
};
type ArchiveCursor = { v: 1; t: number; s: number; n: string };

function archiveError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function parsedName(
  name: string,
): { createdAt: string; timestamp: number; sequence: number } | null {
  const match = ARCHIVE_NAME.exec(name);
  if (!match) return null;
  const createdAt =
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.` + `${match[7]}Z`;
  const timestamp = Date.parse(createdAt);
  const sequence = Number(match[8]);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== createdAt ||
    !Number.isSafeInteger(sequence)
  )
    return null;
  return { createdAt, timestamp, sequence };
}

function assertArchiveRoot(path: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw archiveError('ARCHIVE_UNAVAILABLE', 'Session archive storage is unavailable.', error);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw archiveError('ARCHIVE_UNAVAILABLE', 'Session archive storage is unavailable.');
}

function scan(path: string): InternalArchiveItem[] {
  assertArchiveRoot(path);
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (error) {
    throw archiveError('ARCHIVE_UNAVAILABLE', 'Session archives could not be read.', error);
  }
  const items: InternalArchiveItem[] = [];
  for (const name of names) {
    const parsed = parsedName(name);
    if (!parsed) continue;
    const entryPath = join(path, name);
    try {
      const stat = lstatSync(entryPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      items.push({ name, path: entryPath, ...parsed, dev: stat.dev, ino: stat.ino });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
  }
  return items.sort(compareArchives);
}

function compareArchives(
  a: Pick<InternalArchiveItem, 'timestamp' | 'sequence' | 'name'>,
  b: Pick<InternalArchiveItem, 'timestamp' | 'sequence' | 'name'>,
): number {
  return b.timestamp - a.timestamp || b.sequence - a.sequence || b.name.localeCompare(a.name);
}

function decodeCursor(value: unknown): ArchiveCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    throw archiveError('INVALID_PARAMS', 'cursor must be a non-empty opaque string.');
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const cursor = JSON.parse(decoded) as ArchiveCursor;
    const parsed = cursor && parsedName(cursor.n);
    if (
      !cursor ||
      cursor.v !== 1 ||
      !Number.isSafeInteger(cursor.t) ||
      !Number.isSafeInteger(cursor.s) ||
      !parsed ||
      parsed.timestamp !== cursor.t ||
      parsed.sequence !== cursor.s ||
      Buffer.from(decoded).toString('base64url') !== value
    )
      throw new Error('invalid');
    return cursor;
  } catch {
    throw archiveError('INVALID_PARAMS', 'cursor is invalid.');
  }
}

function encodeCursor(item: InternalArchiveItem): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: item.timestamp, s: item.sequence, n: item.name }),
  ).toString('base64url');
}

export function listSessionArchives(
  archivePath: string,
  options: { limit?: number; cursor?: unknown } = {},
): { items: SessionArchiveItem[]; nextCursor: string | null } {
  const requestedLimit = options.limit ?? 50;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200)
    throw archiveError('INVALID_PARAMS', 'limit must be an integer from 1 to 200.');
  const cursor = decodeCursor(options.cursor);
  const cursorKey = cursor
    ? { timestamp: cursor.t, sequence: cursor.s, name: cursor.n }
    : undefined;
  const eligible = scan(archivePath).filter(
    (item) => !cursorKey || compareArchives(item, cursorKey) > 0,
  );
  const hasNext = eligible.length > requestedLimit;
  const page = eligible.slice(0, requestedLimit);
  return {
    items: page.map(({ name, createdAt }) => ({ name, createdAt })),
    nextCursor: hasNext ? encodeCursor(page[page.length - 1]) : null,
  };
}

/** Moves the active session into the canonical archive using a listable name. */
export function archiveActiveSession(
  paths: Pick<GatewayPaths, 'session' | 'archive'>,
  now: Date = new Date(),
): string {
  assertArchiveRoot(paths.archive);
  const createdAt = now.toISOString();
  const stem = `session-${createdAt.replace(/[:.]/g, '-')}`;
  for (let sequence = 0; Number.isSafeInteger(sequence); sequence += 1) {
    const destination = join(paths.archive, `${stem}-${sequence}`);
    try {
      lstatSync(destination);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw archiveError(
          'ARCHIVE_CREATE_FAILED',
          'The current session could not be archived.',
          error,
        );
    }
    try {
      renameSync(paths.session, destination);
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw archiveError(
        'ARCHIVE_CREATE_FAILED',
        'The current session could not be archived.',
        error,
      );
    }
  }
  throw archiveError('ARCHIVE_CREATE_FAILED', 'The current session could not be archived.');
}

export type ArchiveCleanupResult = { deleted: string[]; retained: number; skipped: number };

/**
 * Deletes only valid reset-created directories strictly older than the retention
 * boundary. A zero retention disables cleanup. Entries are identity-checked,
 * atomically parked beneath the archive root, and lstat-checked again directly
 * before recursive removal. fs.rm removes symlink nodes rather than following
 * them, including symlinks found inside an archived session.
 */
export function cleanupSessionArchives(
  archivePath: string,
  retentionDays: number,
  options: {
    now?: Date;
    beforeDelete?: (path: string) => void;
    remove?: (path: string) => void;
  } = {},
): ArchiveCleanupResult {
  if (!Number.isInteger(retentionDays) || retentionDays < 0)
    throw archiveError('ARCHIVE_CLEANUP_FAILED', 'Session archive retention is invalid.');
  if (retentionDays === 0) return { deleted: [], retained: 0, skipped: 0 };
  const candidates = scan(archivePath);
  const cutoff = (options.now ?? new Date()).getTime() - retentionDays * 86_400_000;
  const deleted: string[] = [];
  let retained = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (candidate.timestamp >= cutoff) {
      retained += 1;
      continue;
    }
    options.beforeDelete?.(candidate.path);
    let current: Stats;
    try {
      current = lstatSync(candidate.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        skipped += 1;
        continue;
      }
      throw archiveError('ARCHIVE_CLEANUP_FAILED', 'Session archive cleanup failed.', error);
    }
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== candidate.dev ||
      current.ino !== candidate.ino
    ) {
      skipped += 1;
      continue;
    }
    const parked = join(archivePath, `.deleting-${candidate.name}-${randomUUID()}`);
    try {
      renameSync(candidate.path, parked);
      const parkedStat = lstatSync(parked);
      if (
        parkedStat.isSymbolicLink() ||
        !parkedStat.isDirectory() ||
        parkedStat.dev !== candidate.dev ||
        parkedStat.ino !== candidate.ino
      ) {
        try {
          renameSync(parked, candidate.path);
        } catch {
          // A raced replacement is preserved; leave the parked entry for inspection.
        }
        skipped += 1;
        continue;
      }
      if (options.remove) options.remove(parked);
      else rmSync(parked, { recursive: true, force: false });
      deleted.push(candidate.name);
    } catch (error) {
      try {
        lstatSync(parked);
        try {
          lstatSync(candidate.path);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === 'ENOENT')
            renameSync(parked, candidate.path);
        }
      } catch {
        // Nothing safe to restore.
      }
      throw archiveError('ARCHIVE_CLEANUP_FAILED', 'Session archive cleanup failed.', error);
    }
  }
  return { deleted, retained, skipped };
}
