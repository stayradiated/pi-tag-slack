import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveActiveSession,
  cleanupSessionArchives,
  listSessionArchives,
} from '../src/session-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout(): { root: string; session: string; archive: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-tag-slack-archive-'));
  roots.push(root);
  const session = join(root, 'sessions', 'session');
  const archive = join(root, 'sessions', 'archive');
  mkdirSync(session, { recursive: true, mode: 0o700 });
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  return { root, session, archive };
}

function name(iso: string, sequence = 0): string {
  return `session-${iso.replace(/[:.]/g, '-')}-${sequence}`;
}

function archiveDirectory(path: string, iso: string, sequence = 0): string {
  const archive = join(path, name(iso, sequence));
  mkdirSync(archive, { mode: 0o700 });
  return archive;
}

describe('session archive listing', () => {
  it('lists an archive created by reset naming and ignores malformed entries and symlinks', () => {
    const paths = layout();
    writeFileSync(join(paths.session, 'session.jsonl'), 'work');
    const archivedTo = archiveActiveSession(paths, new Date('2026-07-27T12:34:56.789Z'));
    mkdirSync(paths.session, { mode: 0o700 });
    mkdirSync(join(paths.archive, 'not-an-archive'));
    writeFileSync(join(paths.archive, name('2026-07-26T00:00:00.000Z')), 'not a directory');
    const outside = join(paths.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(paths.archive, name('2026-07-25T00:00:00.000Z')));

    expect(listSessionArchives(paths.archive)).toEqual({
      items: [
        {
          name: name('2026-07-27T12:34:56.789Z'),
          createdAt: '2026-07-27T12:34:56.789Z',
        },
      ],
      nextCursor: null,
    });
    expect(archivedTo).toBe(join(paths.archive, name('2026-07-27T12:34:56.789Z')));
  });

  it('orders newest-first deterministically and paginates with opaque bounded cursors', () => {
    const { archive } = layout();
    archiveDirectory(archive, '2026-01-01T00:00:00.000Z', 0);
    archiveDirectory(archive, '2026-01-03T00:00:00.000Z', 0);
    archiveDirectory(archive, '2026-01-03T00:00:00.000Z', 1);
    const first = listSessionArchives(archive, { limit: 2 });
    expect(first.items.map((item) => item.name)).toEqual([
      name('2026-01-03T00:00:00.000Z', 1),
      name('2026-01-03T00:00:00.000Z', 0),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(listSessionArchives(archive, { limit: 2, cursor: first.nextCursor })).toEqual({
      items: [
        {
          name: name('2026-01-01T00:00:00.000Z'),
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(() => listSessionArchives(archive, { limit: 201 })).toThrow(/1 to 200/);
    expect(() => listSessionArchives(archive, { cursor: 'not-opaque' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    );
  });
});

describe('session archive cleanup', () => {
  it('retains the exact boundary, deletes only older valid archives, and is disabled by zero', () => {
    const { archive } = layout();
    const old = archiveDirectory(archive, '2026-01-01T11:59:59.999Z');
    const boundary = archiveDirectory(archive, '2026-01-01T12:00:00.000Z');
    const recent = archiveDirectory(archive, '2026-01-02T00:00:00.000Z');
    const disabled = cleanupSessionArchives(archive, 0, {
      now: new Date('2026-01-02T12:00:00.000Z'),
    });
    expect(disabled).toEqual({ deleted: [], retained: 0, skipped: 0 });
    expect(existsSync(old)).toBe(true);

    const result = cleanupSessionArchives(archive, 1, {
      now: new Date('2026-01-02T12:00:00.000Z'),
    });
    expect(result.deleted).toEqual([name('2026-01-01T11:59:59.999Z')]);
    expect(result.retained).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(boundary)).toBe(true);
    expect(existsSync(recent)).toBe(true);
  });

  it('reports a sanitized stable failure and restores an archive when removal fails', () => {
    const { archive } = layout();
    const candidate = archiveDirectory(archive, '2025-01-01T00:00:00.000Z');
    let failure: unknown;
    try {
      cleanupSessionArchives(archive, 1, {
        now: new Date('2026-01-01T00:00:00.000Z'),
        remove: () => {
          throw new Error('sensitive filesystem detail');
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'ARCHIVE_CLEANUP_FAILED',
      message: 'Session archive cleanup failed.',
    });
    expect(existsSync(candidate)).toBe(true);
  });

  it('revalidates deletion candidates and never follows a raced symlink', () => {
    const paths = layout();
    const candidate = archiveDirectory(paths.archive, '2025-01-01T00:00:00.000Z');
    writeFileSync(join(candidate, 'inside'), 'archive');
    const moved = join(paths.archive, 'raced-original');
    const outside = join(paths.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'safe');

    const result = cleanupSessionArchives(paths.archive, 1, {
      now: new Date('2026-01-01T00:00:00.000Z'),
      beforeDelete: (path) => {
        renameSync(path, moved);
        symlinkSync(outside, path);
      },
    });
    expect(result).toEqual({ deleted: [], retained: 0, skipped: 1 });
    expect(existsSync(join(outside, 'keep'))).toBe(true);
    expect(existsSync(join(moved, 'inside'))).toBe(true);
  });
});
