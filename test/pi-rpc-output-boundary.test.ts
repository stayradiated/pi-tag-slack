import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { addTrustedUser, closeDb, createGatewayConfig, inboxSnapshot, initDb } from '../src/db.js';
import { PiRpcSession } from '../src/pi-rpc.js';
import { GatewayCoordinator, processSlackEvent } from '../src/slack.js';
import { clearSlackClient, configureSlackClient } from '../src/slack-client.js';

const directories: string[] = [];

afterEach(() => {
  clearSlackClient();
  closeDb();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function configuredDb(): void {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-rpc-output-'));
  directories.push(directory);
  initDb(join(directory, 'gateway.db'));
  createGatewayConfig({
    channelId: 'C0123456789',
    channelLabel: 'gateway',
    workingDirectory: '/tmp',
    piBinary: 'pi',
    defaultModel: 'provider/model',
    defaultThinking: 'medium',
  });
  addTrustedUser('U0123456789');
}

function fakeRpcChild(): ChildProcessWithoutNullStreams & { commands: string[] } {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const commands: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => true,
    commands,
  }) as unknown as ChildProcessWithoutNullStreams & { commands: string[] };
  stdin.on('data', (raw: Buffer) => {
    const request = JSON.parse(String(raw)) as { id: string; type: string };
    commands.push(request.type);
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
      `${JSON.stringify({
        id: request.id,
        type: 'response',
        command: request.type,
        success: true,
        ...(data ? { data } : {}),
      })}\n`,
    );
  });
  return child;
}

describe('pi RPC output boundary', () => {
  it('keeps assistant/final output session-local and leaves settled unresolved work idle', async () => {
    configuredDb();
    const child = fakeRpcChild();
    const session = new PiRpcSession({
      binary: 'pi',
      sessionDir: '/tmp/session',
      cwd: '/tmp',
      version: async () => '0.82.0',
      spawn: (() => child) as typeof spawn,
    });
    const coordinator = new GatewayCoordinator();
    session.setSafeBoundaryHandler(() => void coordinator.run(() => session.applyDesired()));
    await session.start();

    // This is the daemon's actual singleton outbound Slack seam: both
    // slack send/inbox reply use chat.postMessage, and file output uses uploadV2.
    const slack = { chat: { postMessage: vi.fn() }, files: { uploadV2: vi.fn() } };
    configureSlackClient(slack as never, 'C0123456789');
    await expect(
      processSlackEvent(
        {
          event_id: 'rpc-output-boundary',
          event: {
            type: 'message',
            channel: 'C0123456789',
            channel_type: 'channel',
            user: 'U0123456789',
            ts: '100.000001',
            text: '<@U_BOT> investigate this',
          },
        },
        'U_BOT',
        session,
        () => undefined,
      ),
    ).resolves.toBe('accepted');
    expect(
      child.commands.filter((command) => command === 'prompt' || command === 'follow_up'),
    ).toEqual(['prompt']);
    expect(inboxSnapshot(1)).toMatchObject({ state: 'open', latest_reply_ts: null });

    // Actual pi RPC stdout event shapes: streaming assistant text, finalized
    // assistant message, then a clean fully-settled run.
    child.stdout.write('{"type":"agent_start"}\n');
    child.stdout.write(
      '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"I will post this automatically."}]},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"I will post this automatically."}}\n',
    );
    child.stdout.write(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Final answer that must remain local."}]}}\n',
    );
    child.stdout.write('{"type":"agent_settled"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    await coordinator.drain();

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(slack.files.uploadV2).not.toHaveBeenCalled();
    expect(inboxSnapshot(1)).toMatchObject({ state: 'open', latest_reply_ts: null });
    expect(
      child.commands.filter((command) => command === 'prompt' || command === 'follow_up'),
    ).toEqual(['prompt']);
  });
});
