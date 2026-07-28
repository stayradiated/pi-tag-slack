import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addTrustedUser,
  closeDb,
  createGatewayConfig,
  inboxSnapshot,
  ingestSlackEvent,
  initDb,
  recordInboxReaction,
  setInboxWorking,
} from '../src/db.js';
import { dispatch } from '../src/control.js';
import {
  clearSlackClient,
  configureSlackClient,
  reconcileInboxReactions,
} from '../src/slack-client.js';
import { restoreOpenInboxReceiptsAfterSessionLoss } from '../src/index.js';
import { PiRpcSession } from '../src/pi-rpc.js';

const directories: string[] = [];

function configuredDb(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-reactions-'));
  directories.push(directory);
  const path = join(directory, 'gateway.db');
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

function addInbox(eventId: string, ts: string): number {
  return ingestSlackEvent({
    eventId,
    kind: 'new-message',
    messageId: `C0123456789:${ts}`,
    senderId: 'U0123456789',
    senderLabel: 'Ada',
    content: 'work',
    messageTs: ts,
  }).inboxId!;
}

function slackError(code: string): Error {
  return Object.assign(new Error(code), { data: { error: code } });
}

afterEach(() => {
  clearSlackClient();
  closeDb();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('durable managed reaction reconciliation', () => {
  it('persists removal independently, survives restart, and retries only the failed addition', async () => {
    const path = configuredDb();
    const id = addInbox('Ev_partial', '1.0');
    setInboxWorking(id);
    recordInboxReaction(id, { actual: 'eyes' });
    const calls: string[] = [];
    let additions = 0;
    configureSlackClient(
      {
        reactions: {
          remove: async ({ name }: { name: string }) => {
            calls.push(`remove:${name}`);
          },
          add: async ({ name }: { name: string }) => {
            calls.push(`add:${name}`);
            if (additions++ === 0) throw slackError('temporary_failure');
          },
        },
      } as any,
      'C0123456789',
    );

    await reconcileInboxReactions();
    expect(inboxSnapshot(id)).toMatchObject({
      reaction_desired: 'hourglass_flowing_sand',
      reaction_actual: null,
      reaction_error: 'temporary_failure',
      reaction_next_attempt_at: expect.any(String),
    });

    // The retry schedule and transition state are database-owned, not process-owned.
    recordInboxReaction(id, { nextAttemptAt: '2000-01-01T00:00:00.000Z' });
    closeDb();
    initDb(path);
    await reconcileInboxReactions();
    expect(calls).toEqual([
      'remove:eyes',
      'add:hourglass_flowing_sand',
      'add:hourglass_flowing_sand',
    ]);
    expect(inboxSnapshot(id)).toMatchObject({
      reaction_desired: 'hourglass_flowing_sand',
      reaction_actual: 'hourglass_flowing_sand',
      reaction_error: null,
      reaction_next_attempt_at: null,
    });
  });

  it('treats no_reaction as confirmed absence without touching user-managed names', async () => {
    configuredDb();
    const id = addInbox('Ev_absent', '2.0');
    setInboxWorking(id);
    recordInboxReaction(id, { actual: 'eyes' });
    const removed: string[] = [];
    configureSlackClient(
      {
        reactions: {
          remove: async ({ name }: { name: string }) => {
            removed.push(name);
            throw slackError('no_reaction');
          },
          add: async () => undefined,
        },
      } as any,
      'C0123456789',
    );

    await reconcileInboxReactions();
    // Only the durable gateway-owned name is sent to reactions.remove; Slack's
    // API removes only the authenticated bot's reaction, preserving user reactions.
    expect(removed).toEqual(['eyes']);
    expect(inboxSnapshot(id)).toMatchObject({
      reaction_actual: 'hourglass_flowing_sand',
      reaction_error: null,
    });
  });

  it('supports eyes to hourglass, response cleanup, and silent completion', async () => {
    configuredDb();
    const responseId = addInbox('Ev_response', '3.0');
    const silentId = addInbox('Ev_silent', '4.0');
    recordInboxReaction(responseId, { actual: 'eyes' });
    recordInboxReaction(silentId, { actual: 'eyes' });
    setInboxWorking(responseId);
    const calls: string[] = [];
    configureSlackClient(
      {
        reactions: {
          remove: async ({ name }: { name: string }) => calls.push(`remove:${name}`),
          add: async ({ name }: { name: string }) => calls.push(`add:${name}`),
        },
        chat: { postMessage: async () => ({ ok: true, ts: '9.0' }) },
      } as any,
      'C0123456789',
    );

    await reconcileInboxReactions();
    expect(inboxSnapshot(responseId)?.reaction_actual).toBe('hourglass_flowing_sand');
    await dispatch({
      version: 1,
      id: 'respond',
      command: 'inbox.respond',
      params: { id: `inbox-${responseId}`, text: 'done' },
    });
    await reconcileInboxReactions();
    expect(inboxSnapshot(responseId)).toMatchObject({
      state: 'resolved',
      reaction_desired: null,
      reaction_actual: null,
    });

    dispatch({
      version: 1,
      id: 'resolve',
      command: 'inbox.resolve',
      params: { ids: [`inbox-${silentId}`] },
    });
    await reconcileInboxReactions();
    expect(inboxSnapshot(silentId)).toMatchObject({
      state: 'resolved',
      reaction_desired: 'white_check_mark',
      reaction_actual: 'white_check_mark',
    });
    expect(calls).toContain('add:hourglass_flowing_sand');
    expect(calls).toContain('add:white_check_mark');
  });

  it('clears confirmed deleted-source reaction state without retrying Slack', async () => {
    configuredDb();
    const id = addInbox('Ev_source', '5.0');
    recordInboxReaction(id, {
      actual: 'eyes',
      error: 'old failure',
      nextAttemptAt: '2000-01-01T00:00:00.000Z',
    });
    ingestSlackEvent({
      eventId: 'Ev_source_deleted',
      kind: 'deletion',
      messageId: 'C0123456789:5.0',
      senderId: 'U0123456789',
      senderLabel: 'Ada',
      messageTs: '5.0',
    });
    let calls = 0;
    configureSlackClient(
      {
        reactions: {
          remove: async () => calls++,
          add: async () => calls++,
        },
      } as any,
      'C0123456789',
    );

    await reconcileInboxReactions();
    expect(calls).toBe(0);
    expect(inboxSnapshot(id)).toMatchObject({
      source_deleted_at: expect.any(String),
      reaction_desired: null,
      reaction_actual: null,
      reaction_error: null,
      reaction_next_attempt_at: null,
    });
  });
});

function rpcChild(): ChildProcessWithoutNullStreams {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  stdin.on('data', (raw: Buffer) => {
    const request = JSON.parse(String(raw)) as { id: string; type: string };
    const data =
      request.type === 'get_state'
        ? {
            isStreaming: false,
            sessionId: 'session',
            model: { provider: 'provider', id: 'model' },
            thinkingLevel: 'medium',
          }
        : request.type === 'get_available_models'
          ? { models: [{ provider: 'provider', id: 'model' }] }
          : request.type === 'get_available_thinking_levels'
            ? { levels: ['medium'] }
            : undefined;
    stdout.write(
      `${JSON.stringify({ id: request.id, type: 'response', command: request.type, success: true, ...(data ? { data } : {}) })}\n`,
    );
  });
  return child;
}

describe('session-loss reaction recovery', () => {
  it('reverts open hourglasses to eyes on pi crash and explicit reset preparation', async () => {
    configuredDb();
    const crashId = addInbox('Ev_crash', '6.0');
    setInboxWorking(crashId);
    const child = rpcChild();
    const session = new PiRpcSession({
      binary: 'pi',
      sessionDir: '/tmp/session',
      cwd: '/tmp',
      version: async () => '0.82.0',
      spawn: (() => child) as typeof spawn,
      restartFailureThreshold: 1,
      onUnexpectedExit: restoreOpenInboxReceiptsAfterSessionLoss,
    });
    await session.start();
    child.emit('exit', 1, null);
    expect(inboxSnapshot(crashId)?.reaction_desired).toBe('eyes');

    const resetId = addInbox('Ev_reset', '7.0');
    setInboxWorking(resetId);
    expect(restoreOpenInboxReceiptsAfterSessionLoss()).toBe(1);
    expect(inboxSnapshot(resetId)?.reaction_desired).toBe('eyes');
  });
});
