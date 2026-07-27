import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTrustedUser,
  closeDb,
  createGatewayConfig,
  ingestSlackEvent,
  initDb,
} from '../src/db.js';
import { dispatch, startControlServer } from '../src/control.js';
import { main } from '../src/cli/index.js';
import { startGateway } from '../src/index.js';
import { ensurePrivateLayout, gatewayPaths } from '../src/paths.js';

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-v2-'));
  directories.push(directory);
  return join(directory, 'gateway.db');
}

function configuredDb(): string {
  const path = databasePath();
  initDb(path);
  createGatewayConfig({
    channelId: 'C0123456789',
    channelLabel: 'gateway',
    workingDirectory: '/tmp',
    piBinary: 'pi',
    defaultModel: 'provider/model',
    defaultThinking: 'medium',
  });
  addTrustedUser('U0123456789');
  return path;
}

afterEach(() => {
  closeDb();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('startup and setup', () => {
  it('does not initialize state when the daemon is started before setup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-startup-'));
    directories.push(directory);
    const oldDataDir = process.env.PI_TAG_SLACK_DATA_DIR;
    const oldConfig = process.env.PI_TAG_SLACK_CONFIG;
    process.env.PI_TAG_SLACK_DATA_DIR = directory;
    process.env.PI_TAG_SLACK_CONFIG = join(directory, 'config.env');
    try {
      await expect(startGateway()).rejects.toThrow(/run pi-tag-slack setup/);
      expect(existsSync(join(directory, 'gateway.db'))).toBe(false);
      expect(existsSync(join(directory, 'config.env'))).toBe(false);
    } finally {
      if (oldDataDir === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
      else process.env.PI_TAG_SLACK_DATA_DIR = oldDataDir;
      if (oldConfig === undefined) delete process.env.PI_TAG_SLACK_CONFIG;
      else process.env.PI_TAG_SLACK_CONFIG = oldConfig;
    }
  });

  it('cleans staged state when setup validation fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-setup-'));
    directories.push(directory);
    const oldDataDir = process.env.PI_TAG_SLACK_DATA_DIR;
    const oldConfig = process.env.PI_TAG_SLACK_CONFIG;
    process.env.PI_TAG_SLACK_DATA_DIR = directory;
    process.env.PI_TAG_SLACK_CONFIG = join(directory, 'config.env');
    try {
      await expect(
        main([
          'setup',
          '--channel',
          'C0123456789',
          '--label',
          'gateway',
          '--cwd',
          '/tmp',
          '--model',
          'provider/model',
          '--thinking',
          'invalid',
          '--bot-token',
          'xoxb-token',
          '--app-token',
          'xapp-token',
        ]),
      ).rejects.toThrow(/Invalid default thinking level/);
      expect(existsSync(join(directory, 'gateway.db'))).toBe(false);
      expect(existsSync(join(directory, 'config.env'))).toBe(false);
    } finally {
      if (oldDataDir === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
      else process.env.PI_TAG_SLACK_DATA_DIR = oldDataDir;
      if (oldConfig === undefined) delete process.env.PI_TAG_SLACK_CONFIG;
      else process.env.PI_TAG_SLACK_CONFIG = oldConfig;
    }
  });
});

describe('schema v2', () => {
  it('creates only the strict hard-cut tables and private database', () => {
    const path = databasePath();
    initDb(path);
    closeDb();
    const sqlite = new Database(path, { readonly: true });
    try {
      expect(sqlite.pragma('user_version', { simple: true })).toBe(2);
      expect(
        sqlite
          .prepare(
            "select count(*) as count from sqlite_master where type='table' and name in ('channels', 'message_queue', 'message_log')",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        sqlite
          .prepare(
            "select count(*) as count from sqlite_master where type='table' and name in ('gateway_config', 'slack_events', 'inbox', 'tasks', 'schedules', 'trusted_users')",
          )
          .get(),
      ).toEqual({ count: 6 });
    } finally {
      sqlite.close();
    }
  });

  it('rejects legacy state rather than migrating it', () => {
    const path = databasePath();
    const sqlite = new Database(path);
    sqlite.exec('create table channels (id text)');
    sqlite.close();
    expect(() => initDb(path)).toThrow(/setup --reset/);
  });

  it('rejects same-name indexes with a weakened definition', () => {
    const path = databasePath();
    initDb(path);
    closeDb();
    const sqlite = new Database(path);
    try {
      sqlite.exec('drop index inbox_state_created; create index inbox_state_created on inbox(id);');
    } finally {
      sqlite.close();
    }
    expect(() => initDb(path)).toThrow(/Malformed gateway schema/);
  });

  it('refuses a symlink in a structural path ancestor', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-layout-'));
    directories.push(directory);
    const target = mkdtempSync(join(tmpdir(), 'pi-tag-slack-layout-target-'));
    directories.push(target);
    symlinkSync(target, join(directory, 'redirect'));
    expect(() => ensurePrivateLayout(gatewayPaths(join(directory, 'redirect', 'data')))).toThrow(
      /Unsafe symlink structural path/,
    );
  });

  it('refuses an existing database symlink before opening it', () => {
    const path = databasePath();
    const target = `${path}.target`;
    writeFileSync(target, 'not a database');
    symlinkSync(target, path);
    expect(() => initDb(path)).toThrow(/symlink structural path/);
  });
});

describe('control socket', () => {
  it('rejects trailing data and preserves a parsed request ID on command errors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-control-'));
    directories.push(directory);
    const previous = process.env.PI_TAG_SLACK_DATA_DIR;
    process.env.PI_TAG_SLACK_DATA_DIR = directory;
    initDb(join(directory, 'gateway.db'));
    createGatewayConfig({
      channelId: 'C0123456789',
      channelLabel: 'gateway',
      workingDirectory: '/tmp',
      piBinary: 'pi',
      defaultModel: 'provider/model',
      defaultThinking: 'medium',
    });
    const server = await startControlServer();
    const socketPath = join(directory, 'control.sock');
    const send = (frame: string): Promise<any> =>
      new Promise((resolve, reject) => {
        const client = connect(socketPath);
        let output = '';
        client.setEncoding('utf8');
        client.on('data', (chunk) => (output += chunk));
        client.once('error', reject);
        client.once('end', () => resolve(JSON.parse(output)));
        client.once('connect', () => client.end(frame));
      });
    try {
      await expect(
        send('{"version":1,"id":"request-1","command":"unknown","params":{}}\n'),
      ).resolves.toMatchObject({ id: 'request-1', error: { code: 'UNKNOWN_COMMAND' } });
      await expect(
        send('{"version":1,"id":"request-2","command":"task.list","params":{}}\n{}\n'),
      ).resolves.toMatchObject({ error: { code: 'TRAILING_DATA' } });
      const separatelyDeliveredTrailingFrame = await new Promise<any>((resolve, reject) => {
        const client = connect(socketPath);
        let output = '';
        client.setEncoding('utf8');
        client.on('data', (chunk) => (output += chunk));
        client.once('error', reject);
        client.once('end', () => resolve(JSON.parse(output)));
        client.once('connect', () => {
          client.write('{"version":1,"id":"request-3","command":"task.list","params":{}}\n');
          setTimeout(() => client.end('{}\n'), 10);
        });
      });
      expect(separatelyDeliveredTrailingFrame).toMatchObject({
        error: { code: 'TRAILING_DATA' },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(socketPath);
      } catch {
        // The operating system may have already removed the Unix socket.
      }
      closeDb();
      if (previous === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
      else process.env.PI_TAG_SLACK_DATA_DIR = previous;
    }
  });
});

describe('control socket startup', () => {
  it('refuses a dangling control-socket symlink instead of binding through it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-socket-'));
    directories.push(directory);
    const previous = process.env.PI_TAG_SLACK_DATA_DIR;
    process.env.PI_TAG_SLACK_DATA_DIR = directory;
    const socketPath = join(directory, 'control.sock');
    symlinkSync(join(directory, 'missing.sock'), socketPath);
    try {
      await expect(startControlServer()).rejects.toThrow(/Unsafe control socket path/);
    } finally {
      if (previous === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
      else process.env.PI_TAG_SLACK_DATA_DIR = previous;
    }
  });
});

describe('control configuration', () => {
  it('exposes daemon health without opening a second database connection', () => {
    configuredDb();
    expect(dispatch({ version: 1, id: 'health', command: 'health', params: {} })).toEqual({
      database: 'ok',
      control: 'ok',
    });
  });

  it('updates only typed non-structural settings and resets session overrides', () => {
    configuredDb();
    const request = (command: string, params: Record<string, unknown>) =>
      dispatch({ version: 1, id: 'request', command, params });
    expect(request('config.show', {})).toMatchObject({
      channel_id: 'C0123456789',
      default_model: 'provider/model',
      session_model_override: null,
    });
    expect(
      request('config.set', { key: 'sessionModelOverride', value: 'other/model' }),
    ).toMatchObject({
      session_model_override: 'other/model',
    });
    expect(request('config.reset', { key: 'sessionModelOverride' })).toMatchObject({
      session_model_override: null,
    });
    expect(() => request('config.set', { key: 'workingDirectory', value: '/elsewhere' })).toThrow(
      /Unsupported configuration key/,
    );
    expect(() => request('config.set', { key: 'schedulerBatchLimit', value: '0' })).toThrow(
      /out of range/,
    );
  });
});

describe('control pagination', () => {
  it('returns opaque stable cursors for newest-first task lists', () => {
    configuredDb();
    const request = (command: string, params: Record<string, unknown>) =>
      dispatch({ version: 1, id: 'request', command, params });
    for (const title of ['one', 'two', 'three']) {
      request('task.add', { title, instructions: title });
    }
    const first = request('task.list', { limit: 2 }) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(first.items.map((item) => item.id)).toEqual(['task-3', 'task-2']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = request('task.list', { limit: 2, cursor: first.nextCursor }) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(second).toMatchObject({ items: [{ id: 'task-1' }], nextCursor: null });
    expect(() => request('task.list', { cursor: 'not-a-cursor' })).toThrow(/cursor is invalid/);
  });
});

describe('Slack event ledger', () => {
  it('never permits a resolved inbox item to reopen', () => {
    const path = configuredDb();
    const message = {
      eventId: 'Ev_new',
      kind: 'new-message' as const,
      messageId: 'C0123456789:123.456',
      senderId: 'U0123456789',
      senderLabel: 'Ada',
      content: 'hello',
      messageTs: '123.456',
      attachments: [],
    };
    ingestSlackEvent(message);
    closeDb();
    const sqlite = new Database(path);
    try {
      sqlite
        .prepare(
          "update inbox set state='resolved', resolved_at=?, resolution_reason='done' where id=1",
        )
        .run(new Date().toISOString());
      expect(() =>
        sqlite.prepare("update inbox set state='open', resolved_at=null where id=1").run(),
      ).toThrow(/cannot be reopened/);
    } finally {
      sqlite.close();
    }
  });

  it('deduplicates accepted deliveries and keeps ignored mutations out of the ledger', () => {
    configuredDb();
    const message = {
      eventId: 'Ev_new',
      kind: 'new-message' as const,
      messageId: 'C0123456789:123.456',
      senderId: 'U0123456789',
      senderLabel: 'Ada',
      content: 'hello',
      messageTs: '123.456',
      attachments: [],
    };
    expect(ingestSlackEvent(message)).toMatchObject({
      duplicate: false,
      outcome: 'created',
      revision: 1,
    });
    expect(ingestSlackEvent(message)).toMatchObject({ duplicate: true, outcome: 'duplicate' });
    expect(
      ingestSlackEvent({ ...message, eventId: 'Ev_edit', kind: 'edit', content: 'updated' }),
    ).toMatchObject({ outcome: 'updated', revision: 2 });
    expect(ingestSlackEvent({ ...message, eventId: 'Ev_delete', kind: 'deletion' })).toMatchObject({
      outcome: 'deleted',
    });
    expect(ingestSlackEvent({ ...message, eventId: 'Ev_late-edit', kind: 'edit' })).toMatchObject({
      ignored: true,
    });
  });
});
