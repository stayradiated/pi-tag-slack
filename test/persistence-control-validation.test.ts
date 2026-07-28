import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addTrustedUser,
  closeDb,
  createGatewayConfig,
  createManualTask,
  ingestSlackEvent,
  inboxSnapshot,
  initDb,
  markSlackEventAccepted,
  markTaskAccepted,
  recordInboxReply,
  validateInboxRow,
  validateScheduleRow,
  validateSlackEventRow,
  validateTaskRow,
  validateTrustedUserRow,
  validateRequiredPragmas,
} from '../src/db.js';
import { dispatch, errorReply, startControlServer } from '../src/control.js';
import { addSchedule } from '../src/scheduler.js';
import {
  clearSlackClient,
  configureSlackClient,
  SLACK_RESPONSE_BUDGET_BYTES,
} from '../src/slack-client.js';

const directories: string[] = [];

function configured() {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-validation-'));
  directories.push(directory);
  const path = join(directory, 'gateway.db');
  const db = initDb(path);
  createGatewayConfig({
    channelId: 'C0123456789',
    channelLabel: 'gateway',
    workingDirectory: '/private/gateway/work',
    piBinary: 'pi',
    defaultModel: 'provider/model',
    defaultThinking: 'medium',
  });
  addTrustedUser('U0123456789', 'Ada');
  return { db, path, directory };
}

async function request(socketPath: string, command: string, params: Record<string, unknown>) {
  return new Promise<any>((resolve, reject) => {
    const socket = connect(socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (output += chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(JSON.parse(output)));
    socket.once('connect', () =>
      socket.end(JSON.stringify({ version: 1, id: 'validation', command, params }) + '\n'),
    );
  });
}

afterEach(() => {
  clearSlackClient();
  closeDb();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('persistent boundary validation', () => {
  it('reads back every required SQLite runtime setting', () => {
    const { db } = configured();
    expect(() => validateRequiredPragmas(db)).not.toThrow();
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(Number(db.pragma('synchronous', { simple: true }))).toBe(2);
    expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1);
    expect(Number(db.pragma('busy_timeout', { simple: true }))).toBe(5000);
    expect(Number(db.pragma('trusted_schema', { simple: true }))).toBe(0);
  });

  it('rejects inconsistent lifecycle, JSON, source deletion, schedule, and RPC metadata', () => {
    const { db } = configured();
    ingestSlackEvent({
      eventId: 'Ev_constraints',
      kind: 'new-message',
      messageId: 'C0123456789:1.0',
      senderId: 'U0123456789',
      senderLabel: 'Ada',
      content: 'hello',
      messageTs: '1.0',
    });
    createManualTask('task', 'instructions');
    addSchedule({ title: 'once', instructions: 'later', at: '2030-01-01T00:00:00Z' });

    const statements = [
      "update inbox set state='resolved' where id=1",
      "update inbox set attachments='{}' where id=1",
      "update inbox set source_deleted_at='2030-01-01T00:00:00.000Z' where id=1",
      "update inbox set updated_at='not-a-time' where id=1",
      "update tasks set pi_session_id='session', run_sequence=1 where id=1",
      "update tasks set rpc_accepted_at='2030-01-01T00:00:00.000Z' where id=1",
      "update tasks set state='resolved', resolution_reason='done' where id=1",
      'update schedules set enabled=0 where id=1',
      "update slack_events set rpc_accepted_at='bad' where source_identity='slack:event:Ev_constraints'",
      "update slack_events set rpc_accepted_at='2030-01-01T00:00:00.000Z' where source_identity='slack:event:Ev_constraints'",
      "update slack_events set outcome='already-represented', rpc_accepted_at='2030-01-01T00:00:00.000Z', pi_session_id='session', run_sequence=1 where source_identity='slack:event:Ev_constraints'",
      "update inbox set message_ts='1' where id=1",
      "update inbox set thread_ts='1.bad' where id=1",
      "update inbox set latest_reply_ts='1..2', latest_reply_at='2030-01-01T00:00:00.000Z' where id=1",
      "update trusted_users set label='' where user_id='U0123456789'",
    ];
    for (const statement of statements)
      expect(() => db.prepare(statement).run(), statement).toThrow(/constraint/i);
  });

  it('rejects malformed acceptance metadata and Slack timestamps before writes', () => {
    configured();
    ingestSlackEvent({
      eventId: 'Ev_api_constraints',
      kind: 'new-message',
      messageId: 'C0123456789:5.0',
      senderId: 'U0123456789',
      senderLabel: 'Ada',
      content: 'hello',
      messageTs: '5.0',
    });
    createManualTask('task', 'instructions');

    expect(() =>
      markSlackEventAccepted('Ev_api_constraints', {
        acceptedAt: '2030-01-01T00:00:00.000Z',
        sessionId: '',
        runSequence: 1,
      }),
    ).toThrow(/acceptance metadata/);
    expect(() =>
      markTaskAccepted(1, {
        acceptedAt: 'not-a-time',
        sessionId: 'session',
        runSequence: 1,
      }),
    ).toThrow(/acceptance metadata/);
    expect(() => recordInboxReply(1, 'not-a-slack-timestamp')).toThrow(/decimal timestamp/);
    expect(() =>
      ingestSlackEvent({
        eventId: 'Ev_bad_timestamp',
        kind: 'new-message',
        messageId: 'C0123456789:bad',
        senderId: 'U0123456789',
        senderLabel: 'Ada',
        content: 'hello',
        messageTs: 'bad',
      }),
    ).toThrow(/decimal timestamp/);
  });

  it('accepts exactly the practical Slack timestamp shape enforced by SQLite', () => {
    const { db } = configured();
    ingestSlackEvent({
      eventId: 'Ev_timestamp_boundaries',
      kind: 'new-message',
      messageId: 'C0123456789:timestamp',
      senderId: 'U0123456789',
      senderLabel: 'Ada',
      content: 'hello',
      messageTs: '1.0',
    });
    const inbox = () =>
      db.prepare('select * from inbox where id=1').get() as Record<string, unknown>;
    for (const timestamp of ['1.0', '12.345', '000.0']) {
      expect(() =>
        db.prepare('update inbox set message_ts=? where id=1').run(timestamp),
      ).not.toThrow();
      expect(() => validateInboxRow({ ...inbox(), message_ts: timestamp })).not.toThrow();
    }
    for (const timestamp of ['', '1', '.0', '1.', '1..0', '1.a', ' 1.0', '1.0 ']) {
      expect(() => db.prepare('update inbox set message_ts=? where id=1').run(timestamp)).toThrow(
        /constraint/i,
      );
      expect(() => validateInboxRow({ ...inbox(), message_ts: timestamp })).toThrow(/inbox/);
    }
  });

  it('runtime-validates every persisted work and trust row shape', () => {
    const { db } = configured();
    ingestSlackEvent({
      eventId: 'Ev_validators',
      kind: 'new-message',
      messageId: 'C0123456789:4.0',
      senderId: 'U0123456789',
      senderLabel: 'Ada',
      content: 'hello',
      messageTs: '4.0',
    });
    createManualTask('task', 'instructions');
    addSchedule({ title: 'once', instructions: 'later', at: '2030-01-01T00:00:00Z' });
    const row = (table: string) =>
      db.prepare(`select * from ${table} limit 1`).get() as Record<string, unknown>;
    expect(() => validateInboxRow({ ...row('inbox'), attachments: '{}' })).toThrow(/inbox/);
    expect(() => validateInboxRow({ ...row('inbox'), message_ts: '4' })).toThrow(/inbox/);
    expect(() => validateSlackEventRow({ ...row('slack_events'), outcome: 'unknown' })).toThrow(
      /Slack-event/,
    );
    expect(() =>
      validateSlackEventRow({
        ...row('slack_events'),
        rpc_accepted_at: '2030-01-01T00:00:00.000Z',
      }),
    ).toThrow(/Slack-event/);
    expect(() => validateTaskRow({ ...row('tasks'), title: '' })).toThrow(/task/);
    expect(() =>
      validateTaskRow({
        ...row('tasks'),
        rpc_accepted_at: '2030-01-01T00:00:00.000Z',
      }),
    ).toThrow(/task/);
    expect(() => validateScheduleRow({ ...row('schedules'), next_run_at: null })).toThrow(
      /schedule/,
    );
    expect(() => validateTrustedUserRow({ ...row('trusted_users'), user_id: 'bad' })).toThrow(
      /trusted-user/,
    );
  });

  it('fails application reads and startup on a deliberately corrupted row', () => {
    const { db, path } = configured();
    ingestSlackEvent({
      eventId: 'Ev_corrupt',
      kind: 'new-message',
      messageId: 'C0123456789:2.0',
      senderId: 'U0123456789',
      senderLabel: 'Ada',
      content: 'hello',
      messageTs: '2.0',
    });
    db.pragma('ignore_check_constraints = ON');
    db.prepare("update inbox set message_ts='not-a-slack-timestamp' where id=1").run();
    db.pragma('ignore_check_constraints = OFF');
    expect(() => inboxSnapshot(1)).toThrow('Malformed persisted inbox data.');
    expect(() =>
      dispatch({ version: 1, id: 'show', command: 'inbox.show', params: { id: 'inbox-1' } }),
    ).toThrow('Malformed persisted inbox data.');
    closeDb();
    expect(() => initDb(path)).toThrow('Malformed persisted inbox data.');
  });
});

describe('safe control errors and Slack response budgets', () => {
  it('maps invalid IDs, Slack failures, filesystem failures, and corruption safely', async () => {
    const { db, directory } = configured();
    const socketPath = join(directory, 'control.sock');
    const server = await startControlServer(undefined, { path: socketPath });
    try {
      await expect(
        request(socketPath, 'inbox.show', { id: '/private/gateway.db' }),
      ).resolves.toEqual({
        id: 'validation',
        error: { code: 'INVALID_PARAMS', message: 'Invalid inbox ID.' },
      });

      expect(
        errorReply(
          'validation',
          Object.assign(new Error('token xoxb-secret at /private/gateway.db'), {
            code: 'SLACK_ERROR',
          }),
        ),
      ).toEqual({
        id: 'validation',
        error: { code: 'SLACK_ERROR', message: 'Slack request failed.' },
      });
      expect(
        errorReply(
          'validation',
          Object.assign(new Error('/private/gateway/secret.txt'), { code: 'EACCES' }),
        ),
      ).toEqual({
        id: 'validation',
        error: { code: 'FILESYSTEM_ERROR', message: 'A local filesystem operation failed.' },
      });
      expect(
        errorReply(
          'validation',
          Object.assign(new Error('select secret from gateway_config'), {
            code: 'SQLITE_CONSTRAINT_CHECK',
          }),
        ),
      ).toEqual({
        id: 'validation',
        error: { code: 'INTERNAL', message: 'Internal gateway error.' },
      });

      ingestSlackEvent({
        eventId: 'Ev_safe',
        kind: 'new-message',
        messageId: 'C0123456789:3.0',
        senderId: 'U0123456789',
        senderLabel: 'Ada',
        content: 'hello',
        messageTs: '3.0',
      });
      db.pragma('ignore_check_constraints = ON');
      db.prepare("update inbox set attachments='{}' where id=1").run();
      db.pragma('ignore_check_constraints = OFF');
      const reply = await request(socketPath, 'inbox.show', { id: 'inbox-1' });
      expect(reply).toEqual({
        id: 'validation',
        error: { code: 'INTERNAL', message: 'Internal gateway error.' },
      });
      expect(JSON.stringify(reply)).not.toMatch(/sqlite|select|private|gateway\.db/i);
    } finally {
      await server.close();
    }
  });

  it('rejects oversized history, message, and thread results before control serialization', async () => {
    const { directory } = configured();
    const huge = 'x'.repeat(SLACK_RESPONSE_BUDGET_BYTES + 1);
    configureSlackClient(
      {
        conversations: {
          history: async (params: Record<string, unknown>) => ({
            ok: true,
            messages: [{ ts: params.oldest ?? '1.0', text: huge }],
          }),
          replies: async () => ({ ok: true, messages: [{ ts: '1.0', text: huge }] }),
        },
      } as any,
      'C0123456789',
    );
    for (const [command, params] of [
      ['slack.history', {}],
      ['slack.message', { messageTs: '1.0' }],
      ['slack.thread', { threadTs: '1.0' }],
    ] as const) {
      await expect(dispatch({ version: 1, id: command, command, params })).rejects.toMatchObject({
        code: 'RESPONSE_TOO_LARGE',
      });
    }
    const socketPath = join(directory, 'control.sock');
    const server = await startControlServer(undefined, { path: socketPath });
    try {
      await expect(request(socketPath, 'slack.history', {})).resolves.toEqual({
        id: 'validation',
        error: {
          code: 'RESPONSE_TOO_LARGE',
          message: 'Slack response exceeds the control response budget.',
        },
      });
    } finally {
      await server.close();
    }
  });
});
