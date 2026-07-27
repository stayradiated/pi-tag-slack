import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTrustedUser,
  closeDb,
  createGatewayConfig,
  ingestSlackEvent,
  initDb,
  recordInboxReaction,
  scheduleRow,
} from '../src/db.js';
import { dispatch, startControlServer } from '../src/control.js';
import { main } from '../src/cli/index.js';
import { startGateway, startupRecoveryPrompt } from '../src/index.js';
import { GatewayCoordinator, processSlackEvent } from '../src/slack.js';
import { addSchedule, materializeDueSchedules, SchedulerService } from '../src/scheduler.js';
import { validateConfiguredConversation } from '../src/slack-validation.js';
import {
  clearSlackClient,
  configureSlackClient,
  reconcileInboxReactions,
} from '../src/slack-client.js';
import { ensurePrivateLayout, gatewayPaths } from '../src/paths.js';
import { PiRpcSession } from '../src/pi-rpc.js';

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

describe('schedules', () => {
  it('materializes one-time and recurring work exactly once', () => {
    configuredDb();
    const once = addSchedule({ title: 'once', instructions: 'do it', at: '2030-01-01T00:00:00+00:00' });
    const recurring = addSchedule(
      { title: 'repeat', instructions: 'again', cron: '* * * * *', timezone: 'UTC' },
      () => new Date('2030-01-01T00:00:00Z'),
    );
    const due = new Date('2030-01-01T00:01:00Z');
    const created = materializeDueSchedules(() => due);
    expect(created).toHaveLength(1);
    expect(materializeDueSchedules(() => due)).toHaveLength(1);
    expect(materializeDueSchedules(() => due)).toHaveLength(0);
    expect(scheduleRow(once.id)?.enabled).toBe(0);
    expect(scheduleRow(recurring.id)?.next_run_at).toBe('2030-01-01T00:02:00.000Z');
  });

  it('rejects offset-less times, invalid cron, and invalid timezones', () => {
    configuredDb();
    expect(() => addSchedule({ title: 'x', instructions: 'x', at: '2030-01-01T00:00:00' })).toThrow(/explicit UTC offset/);
    expect(() => addSchedule({ title: 'x', instructions: 'x', cron: '* * * * * *', timezone: 'UTC' })).toThrow(/five fields/);
    expect(() => addSchedule({ title: 'x', instructions: 'x', cron: '* * * * *', timezone: 'Mars/Olympus' })).toThrow(/IANA timezone/);
  });

  it('notifies runtime-created schedule tasks and keeps failed notifications open', async () => {
    configuredDb();
    addSchedule({ title: 'once', instructions: 'do it', at: '2030-01-01T00:00:00Z' });
    const notified: string[] = [];
    const service = new SchedulerService(
      { notify: async (prompt) => { notified.push(prompt); return { acceptedAt: '2030-01-01T00:00:01.000Z' }; } },
      new GatewayCoordinator(),
      () => new Date('2030-01-01T00:00:01Z'),
    );
    await service.tick();
    expect(notified).toHaveLength(1);
  });
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

  it('includes the same session status in online daemon health', async () => {
    configuredDb();
    const session = { running: true, health: 'healthy', sessionId: 'session-123' };
    await expect(
      dispatch(
        { version: 1, id: 'health', command: 'health', params: {} },
        {
          notifier: { async notify() { return { acceptedAt: '', runSequence: 0 }; } },
          coordinator: new GatewayCoordinator(),
          sessionStatus: async () => session,
        },
      ),
    ).resolves.toEqual({ database: 'ok', control: 'ok', session });
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

describe('pi RPC session status', () => {
  it('reports a validated fake get_state snapshot and degrades on a malformed refresh', async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    let malformed = false;
    stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as { id: string; type: string };
      if (request.type === 'get_state') {
        stdout.write(
          JSON.stringify({
            id: request.id,
            type: 'response',
            command: 'get_state',
            success: true,
            data: malformed
              ? { isStreaming: 'yes' }
              : {
                  isStreaming: true,
                  sessionId: 'session-123',
                  model: { provider: 'anthropic', id: 'claude-test' },
                  thinkingLevel: 'high',
                },
          }) + '\n',
        );
      } else {
        stdout.write(JSON.stringify({ id: request.id, type: 'response', success: true }) + '\n');
      }
    });
    const session = new PiRpcSession({
      binary: 'fake-pi',
      sessionDir: '/tmp/session',
      cwd: '/tmp',
      desired: () => ({ model: 'configured/model', thinking: 'medium' }),
      spawn: (() => child) as typeof spawn,
    });
    await session.start();
    await expect(session.status()).resolves.toEqual({
      running: true,
      health: 'healthy',
      sessionId: 'session-123',
      activity: 'active',
      runSequence: 0,
      lastError: null,
      desiredModel: 'configured/model',
      desiredThinking: 'medium',
      effectiveModel: 'anthropic/claude-test',
      effectiveThinking: 'high',
    });
    malformed = true;
    await expect(session.status()).resolves.toMatchObject({
      running: true,
      health: 'degraded',
      lastError: 'Invalid get_state response from pi RPC.',
    });
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

describe('task pi delivery and recovery', () => {
  it('persists a manual task, then notifies pi and records acceptance only on success', async () => {
    configuredDb();
    const messages: string[] = [];
    const services = {
      coordinator: new GatewayCoordinator(),
      notifier: {
        async notify(message: string) {
          messages.push(message);
          return { acceptedAt: '2025-01-01T00:00:00.000Z', sessionId: 'session', runSequence: 7 };
        },
      },
    };
    await expect(
      dispatch(
        { version: 1, id: 'task-add', command: 'task.add', params: { title: 'Deploy', instructions: 'Ship it.' } },
        services,
      ),
    ).resolves.toEqual({ id: 'task-1', notified: true });
    expect(messages[0]).toContain('[New task; task-1]');
    expect(messages[0]).toContain('Title: Deploy');
    expect(messages[0]).toContain('task resolve task-1');
    expect(dispatch({ version: 1, id: 'show', command: 'task.show', params: { id: 'task-1' } })).toMatchObject({
      rpc_accepted_at: '2025-01-01T00:00:00.000Z',
      pi_session_id: 'session',
      run_sequence: 7,
    });
  });

  it('keeps a task open and unaccepted when pi notification fails', async () => {
    configuredDb();
    const services = {
      coordinator: new GatewayCoordinator(),
      notifier: { async notify() { throw new Error('pi unavailable'); } },
    };
    await expect(
      dispatch(
        { version: 1, id: 'task-add', command: 'task.add', params: { title: 'Deploy', instructions: 'Ship it.' } },
        services,
      ),
    ).rejects.toMatchObject({ code: 'PARTIAL_SUCCESS' });
    expect(dispatch({ version: 1, id: 'show', command: 'task.show', params: { id: 'task-1' } })).toMatchObject({
      state: 'open',
      rpc_accepted_at: null,
      pi_session_id: null,
      run_sequence: null,
    });
  });

  it('makes one neutral combined recovery summary without accepting individual work', () => {
    configuredDb();
    expect(startupRecoveryPrompt()).toBeUndefined();
    dispatch({ version: 1, id: 'task', command: 'task.add', params: { title: 'Task', instructions: 'Do it.' } });
    ingestSlackEvent({
      eventId: 'Ev_recovery', kind: 'new-message', messageId: 'C0123456789:1', senderId: 'U0123456789',
      senderLabel: 'User', content: 'Hello', messageTs: '1',
    });
    const summary = startupRecoveryPrompt();
    expect(summary).toContain('Open inbox items: 1');
    expect(summary).toContain('Open tasks: 1');
    expect(summary).toContain('inbox-1');
    expect(summary).toContain('task-1');
    expect(dispatch({ version: 1, id: 'show', command: 'task.show', params: { id: 'task-1' } })).toMatchObject({
      rpc_accepted_at: null,
    });
  });
});

describe('Slack startup validation', () => {
  it('rejects inaccessible, DM, and non-member configured conversations', async () => {
    const client = (channel: Record<string, unknown>) => ({
      conversations: { info: async () => ({ ok: true, channel }) },
    });
    await expect(
      validateConfiguredConversation(client({ is_im: true, is_member: true }), 'D123'),
    ).rejects.toThrow(/public channel or private channel/);
    await expect(
      validateConfiguredConversation(client({ is_channel: true, is_member: false }), 'C123'),
    ).rejects.toThrow(/not a member/);
    await expect(
      validateConfiguredConversation(client({ is_group: true, is_member: true }), 'G123'),
    ).resolves.toBeUndefined();
  });
});

describe('Socket Mode admission', () => {
  it('admits a mentioned trusted event only once and notifies pi after acknowledgement', async () => {
    configuredDb();
    const order: string[] = [];
    const notifier = {
      async notify(message: string) {
        order.push(`notify:${message.includes('hello')}`);
        return { acceptedAt: new Date().toISOString(), sessionId: 'session', runSequence: 1 };
      },
    };
    const body = {
      event_id: 'Ev_socket_new',
      event: {
        type: 'message',
        channel: 'C0123456789',
        channel_type: 'channel',
        user: 'U0123456789',
        ts: '123.456',
        text: '<@U_BOT> hello',
      },
    };
    const ack = async () => order.push('ack');
    await expect(processSlackEvent(body, 'U_BOT', notifier, ack)).resolves.toBe('accepted');
    await expect(processSlackEvent(body, 'U_BOT', notifier, ack)).resolves.toBe('duplicate');
    expect(order).toEqual(['ack', 'notify:true', 'ack']);
  });

  it('ignores unmentioned and untrusted messages without persistence or pi work', async () => {
    configuredDb();
    let acknowledgements = 0;
    let notifications = 0;
    const notifier = {
      async notify() {
        notifications += 1;
        return { acceptedAt: new Date().toISOString(), runSequence: 1 };
      },
    };
    await expect(
      processSlackEvent(
        {
          event_id: 'Ev_untrusted',
          event: {
            type: 'message',
            channel: 'C0123456789',
            channel_type: 'channel',
            user: 'U_NOT_TRUSTED',
            ts: '1.0',
            text: '<@U_BOT> hi',
          },
        },
        'U_BOT',
        notifier,
        () => acknowledgements++,
      ),
    ).resolves.toBe('ignored');
    expect(acknowledgements).toBe(1);
    expect(notifications).toBe(0);
  });
});

describe('inbox lifecycle controls', () => {
  it('marks an open item working and resolves it with a managed completion reaction', () => {
    configuredDb();
    ingestSlackEvent({
      eventId: 'Ev_working',
      kind: 'new-message',
      messageId: 'C0123456789:working',
      senderId: 'U0123456789',
      senderLabel: 'Ada',
      content: 'work',
      messageTs: '2.0',
    });
    expect(
      dispatch({ version: 1, id: 'working', command: 'inbox.working', params: { id: 'inbox-1' } }),
    ).toMatchObject({
      id: 'inbox-1',
      reaction_desired: 'hourglass_flowing_sand',
    });
    expect(
      dispatch({
        version: 1,
        id: 'resolve',
        command: 'inbox.resolve',
        params: { ids: ['inbox-1'] },
      }),
    ).toEqual({
      resolved: ['inbox-1'],
    });
    expect(
      dispatch({ version: 1, id: 'show', command: 'inbox.show', params: { id: 'inbox-1' } }),
    ).toMatchObject({
      state: 'resolved',
      reaction_desired: 'white_check_mark',
    });
  });
});

describe('reaction reconciliation', () => {
  it('replaces only the gateway reaction to match durable desired state', async () => {
    configuredDb();
    ingestSlackEvent({
      eventId: 'Ev_reaction',
      kind: 'new-message',
      messageId: 'C0123456789:reaction',
      senderId: 'U0123456789',
      senderLabel: 'Ada',
      content: 'work',
      messageTs: '3.0',
    });
    dispatch({ version: 1, id: 'working', command: 'inbox.working', params: { id: 'inbox-1' } });
    recordInboxReaction(1, { actual: 'eyes' });
    const calls: string[] = [];
    configureSlackClient(
      {
        reactions: {
          remove: async ({ name }: { name: string }) => {
            calls.push(`remove:${name}`);
            return { ok: true };
          },
          add: async ({ name }: { name: string }) => {
            calls.push(`add:${name}`);
            return { ok: true };
          },
        },
      } as any,
      'C0123456789',
    );
    try {
      await reconcileInboxReactions();
      expect(calls).toEqual(['remove:eyes', 'add:hourglass_flowing_sand']);
    } finally {
      clearSlackClient();
    }
  });
});

describe('Slack live navigation and send controls', () => {
  it('uses the configured conversation for all live Slack API calls', async () => {
    configuredDb();
    const calls: Array<Record<string, unknown>> = [];
    configureSlackClient(
      {
        conversations: {
          history: async (params: Record<string, unknown>) => {
            calls.push(params);
            return { ok: true, messages: [{ ts: '1.0' }] };
          },
          replies: async (params: Record<string, unknown>) => {
            calls.push(params);
            return { ok: true, messages: [{ ts: '2.0' }] };
          },
        },
        chat: {
          postMessage: async (params: Record<string, unknown>) => {
            calls.push(params);
            return { ok: true, ts: '3.0' };
          },
        },
      } as any,
      'C0123456789',
    );
    try {
      await dispatch({ version: 1, id: 'history', command: 'slack.history', params: {} });
      await dispatch({
        version: 1,
        id: 'thread',
        command: 'slack.thread',
        params: { threadTs: '2.0' },
      });
      await dispatch({ version: 1, id: 'send', command: 'slack.send', params: { text: 'hello' } });
      expect(calls.every((call) => call.channel === 'C0123456789')).toBe(true);
    } finally {
      clearSlackClient();
    }
  });

  it('passes Slack pagination cursors through and returns Slack cursors unchanged', async () => {
    configuredDb();
    const calls: Array<Record<string, unknown>> = [];
    configureSlackClient(
      {
        conversations: {
          history: async (params: Record<string, unknown>) => {
            calls.push(params);
            return { ok: true, messages: [], response_metadata: { next_cursor: 'next-history' } };
          },
          replies: async (params: Record<string, unknown>) => {
            calls.push(params);
            return { ok: true, messages: [], response_metadata: { next_cursor: 'next-thread' } };
          },
        },
      } as any,
      'C0123456789',
    );
    try {
      await expect(
        dispatch({
          version: 1,
          id: 'history',
          command: 'slack.history',
          params: { limit: 7, cursor: 'history-cursor' },
        }),
      ).resolves.toEqual({ items: [], nextCursor: 'next-history' });
      await expect(
        dispatch({
          version: 1,
          id: 'thread',
          command: 'slack.thread',
          params: { threadTs: '2.0', limit: 8, cursor: 'thread-cursor' },
        }),
      ).resolves.toEqual({ items: [], nextCursor: 'next-thread' });
      expect(calls).toMatchObject([
        { limit: 7, cursor: 'history-cursor' },
        { ts: '2.0', limit: 8, cursor: 'thread-cursor' },
      ]);
    } finally {
      clearSlackClient();
    }
  });

  it('returns only the requested live message and reports a missing timestamp as NOT_FOUND', async () => {
    configuredDb();
    configureSlackClient(
      {
        conversations: {
          history: async (params: { oldest: string }) => ({
            ok: true,
            messages: [{ ts: params.oldest }],
          }),
        },
      } as any,
      'C0123456789',
    );
    try {
      await expect(
        dispatch({
          version: 1,
          id: 'message',
          command: 'slack.message',
          params: { messageTs: 'requested' },
        }),
      ).resolves.toMatchObject({ ts: 'requested' });
      configureSlackClient(
        {
          conversations: { history: async () => ({ ok: true, messages: [{ ts: 'other' }] }) },
        } as any,
        'C0123456789',
      );
      await expect(
        dispatch({
          version: 1,
          id: 'missing-message',
          command: 'slack.message',
          params: { messageTs: 'requested' },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      clearSlackClient();
    }
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
