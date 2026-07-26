import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeAgentMock, sendResponseMock, setBusyMock } = vi.hoisted(() => ({
  invokeAgentMock: vi.fn(),
  sendResponseMock: vi.fn(),
  setBusyMock: vi.fn(),
}));

vi.mock('../src/agent/invoke.js', () => ({
  invokeAgent: invokeAgentMock,
}));

vi.mock('../src/slack/client.js', () => ({
  sendResponse: sendResponseMock,
  setBusy: setBusyMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'MAX_CONCURRENCY',
  'PI_CWD',
  'POLL_INTERVAL_MS',
  'SESSIONS_DIR',
];

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('queue cwd selection', () => {
  it('passes a channel-specific cwd override to invokeAgent', async () => {
    const call = await runQueuedMessage('/workspace/project');
    expect(call?.cwd).toBe('/workspace/project');
  });

  it('falls back to the global PI_CWD when no channel override is configured', async () => {
    const call = await runQueuedMessage('');
    expect(call?.cwd).toBe('/global/project');
  });

  it('passes thread context to sendResponse and toggles the busy indicator', async () => {
    await runQueuedMessage('');

    expect(sendResponseMock).toHaveBeenCalledWith('sl:C123', 'done', {
      threadTs: '1751954000.000100',
    });
    expect(setBusyMock).toHaveBeenNthCalledWith(1, 'sl:C123', true, { ts: '1751955000.000100' });
    expect(setBusyMock).toHaveBeenNthCalledWith(2, 'sl:C123', false, { ts: '1751955000.000100' });
  });
});

async function runQueuedMessage(cwdOverride: string): Promise<{ cwd?: string } | undefined> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pi-tag-slack-queue-cwd-'));
  tempDirs.push(tempDir);

  process.env.DB_PATH = ':memory:';
  process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
  process.env.POLL_INTERVAL_MS = '1';
  process.env.MAX_CONCURRENCY = '1';
  process.env.PI_CWD = '/global/project';

  invokeAgentMock.mockResolvedValue({ ok: true, text: 'done' });
  sendResponseMock.mockResolvedValue(true);
  setBusyMock.mockResolvedValue(undefined);

  vi.resetModules();
  const db = await import('../src/db.js');
  const queue = await import('../src/agent/queue.js');

  db.initDb();

  try {
    db.registerChannel({
      jid: 'sl:C123',
      name: 'queue test',
      folder: 'ch_C123',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride,
    });
    db.addTrustedUser('U1');
    db.enqueueMessage({
      channelJid: 'sl:C123',
      sender: 'U1',
      senderName: 'Alice',
      content: 'hello',
      timestamp: new Date().toISOString(),
      eventTs: '1751955000.000100',
      threadTs: '1751954000.000100',
    });

    queue.startProcessingLoop();
    await vi.waitFor(
      () => {
        expect(invokeAgentMock).toHaveBeenCalledTimes(1);
        expect(sendResponseMock).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000, interval: 10 },
    );

    return invokeAgentMock.mock.calls[0]?.[2] as { cwd?: string } | undefined;
  } finally {
    await queue.stopProcessingLoop({ timeoutMs: 1000 });
    db.closeDb();
  }
}
