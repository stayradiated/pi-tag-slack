import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandFor, paramsFor } from '../src/cli/index.js';
import { dispatch } from '../src/control.js';
import { closeDb, createGatewayConfig, initDb } from '../src/db.js';
import { GatewayCoordinator } from '../src/slack.js';

const roots: string[] = [];
afterEach(() => {
  closeDb();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configured(): { archive: string; coordinator: GatewayCoordinator } {
  const root = mkdtempSync(join(tmpdir(), 'pi-tag-slack-archive-control-'));
  roots.push(root);
  const archive = join(root, 'sessions', 'archive');
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  initDb(join(root, 'gateway.db'));
  createGatewayConfig({
    channelId: 'C0123456789',
    channelLabel: 'gateway',
    workingDirectory: '/tmp',
    piBinary: 'pi',
    defaultModel: 'provider/model',
    defaultThinking: 'medium',
    archiveRetentionDays: 1,
  });
  return { archive, coordinator: new GatewayCoordinator() };
}

function services(archivePath: string, coordinator: GatewayCoordinator) {
  return {
    archivePath,
    coordinator,
    notifier: { notify: async () => ({ acceptedAt: '', runSequence: 0 }) },
  };
}

describe('archive control routing', () => {
  it('routes list through the coordinator and returns the bounded response shape', async () => {
    const { archive, coordinator } = configured();
    mkdirSync(join(archive, 'session-2026-01-01T00-00-00-000Z-0'));
    let release!: () => void;
    const blocker = coordinator.run(() => new Promise<void>((resolve) => (release = resolve)));
    let settled = false;
    const listed = Promise.resolve(
      dispatch(
        {
          version: 1,
          id: 'list',
          command: 'session.archive.list',
          params: { limit: 1 },
        },
        services(archive, coordinator),
      ),
    ).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await blocker;
    await expect(listed).resolves.toEqual({
      items: [
        {
          name: 'session-2026-01-01T00-00-00-000Z-0',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  it('uses persisted retention for cleanup', async () => {
    const { archive, coordinator } = configured();
    const old = 'session-2000-01-01T00-00-00-000Z-0';
    mkdirSync(join(archive, old));
    await expect(
      dispatch(
        { version: 1, id: 'cleanup', command: 'session.archive.cleanup', params: {} },
        services(archive, coordinator),
      ),
    ).resolves.toMatchObject({ deleted: [old] });
  });
});

describe('archive CLI parsing', () => {
  it('accepts only the list and cleanup nested routes with list pagination flags', () => {
    expect(commandFor('session', 'archive', 'list')).toBe('session.archive.list');
    expect(commandFor('session', 'archive', 'cleanup')).toBe('session.archive.cleanup');
    expect(commandFor('session', 'archive', 'remove')).toBeUndefined();
    expect(
      paramsFor('session.archive.list', ['--limit', '17', '--cursor', 'opaque', '--json']),
    ).toEqual({ limit: 17, cursor: 'opaque' });
    expect(paramsFor('session.archive.cleanup', [])).toEqual({});
    expect(() => paramsFor('session.archive.cleanup', ['--limit', '2'])).toThrow(/Unknown option/);
  });
});
