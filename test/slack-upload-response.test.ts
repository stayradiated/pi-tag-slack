import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, createGatewayConfig, initDb } from '../src/db.js';
import { clearSlackClient, configureSlackClient, sendSlackMessage } from '../src/slack-client.js';

const channel = 'C0123456789';
const directories: string[] = [];

function setup(files = 1): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-upload-response-'));
  directories.push(directory);
  initDb(join(directory, 'gateway.db'));
  createGatewayConfig({
    channelId: channel,
    channelLabel: 'gateway',
    workingDirectory: directory,
    piBinary: 'pi',
    defaultModel: 'provider/model',
    defaultThinking: 'medium',
  });
  return Array.from({ length: files }, (_, index) => {
    const path = join(directory, `${index + 1}.txt`);
    writeFileSync(path, `file ${index + 1}`);
    return path;
  });
}

function share(ts: string, threadTs?: string): Record<string, unknown> {
  return {
    shares: {
      public: {
        [channel]: [{ ts, ...(threadTs ? { thread_ts: threadTs } : {}) }],
      },
    },
  };
}

afterEach(() => {
  clearSlackClient();
  closeDb();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Slack Web API v8 uploadV2 responses', () => {
  it('accepts the live nested multi-file completion shape and returns its one message ts', async () => {
    const paths = setup(2);
    const uploadV2 = vi.fn(async () => ({
      ok: true,
      files: [
        {
          ok: true,
          files: [
            { id: 'FONE', ...share('1700000000.123456') },
            { id: 'FTWO', ...share('1700000000.123456') },
          ],
        },
      ],
    }));
    configureSlackClient({ files: { uploadV2 } } as any, channel);

    await expect(sendSlackMessage('two files', undefined, paths)).resolves.toEqual({
      ts: '1700000000.123456',
    });
    expect(uploadV2).toHaveBeenCalledOnce();
    expect(uploadV2.mock.calls[0]?.[0]).toMatchObject({
      channel_id: channel,
      initial_comment: 'two files',
      file_uploads: [{ filename: '1.txt' }, { filename: '2.txt' }],
    });
  });

  it('accepts a validated flat single-file shape', async () => {
    const paths = setup();
    configureSlackClient(
      {
        files: {
          uploadV2: async () => ({
            ok: true,
            files: [{ id: 'FONE', ...share('1700000001.123456') }],
          }),
        },
      } as any,
      channel,
    );

    await expect(sendSlackMessage('one file', undefined, paths)).resolves.toEqual({
      ts: '1700000001.123456',
    });
  });

  it('selects a thread share and returns the reply timestamp', async () => {
    const paths = setup();
    const threadTs = '1700000000.000001';
    configureSlackClient(
      {
        files: {
          uploadV2: async () => ({
            ok: true,
            files: [
              {
                ok: true,
                files: [{ id: 'FTHREAD', ...share('1700000002.123456', threadTs) }],
              },
            ],
          }),
        },
      } as any,
      channel,
    );

    await expect(sendSlackMessage('thread file', threadTs, paths)).resolves.toEqual({
      ts: '1700000002.123456',
    });
  });

  it('uses a bounded exact-file-ID lookup when completion omits shares', async () => {
    const paths = setup(2);
    const history = vi.fn(async () => ({
      ok: true,
      messages: [
        { ts: '1700000003.123456', files: [{ id: 'FONE' }, { id: 'FTWO' }] },
        { ts: '1700000002.123456', files: [{ id: 'FUNRELATED' }] },
      ],
    }));
    configureSlackClient(
      {
        files: {
          uploadV2: async () => ({
            ok: true,
            files: [{ ok: true, files: [{ id: 'FONE' }, { id: 'FTWO' }] }],
          }),
        },
        conversations: { history },
      } as any,
      channel,
    );

    await expect(sendSlackMessage('lookup', undefined, paths)).resolves.toEqual({
      ts: '1700000003.123456',
    });
    expect(history).toHaveBeenCalledWith({ channel, limit: 100 });
  });

  it.each([
    ['missing completion data', { ok: true }],
    ['wrong nested file count', { ok: true, files: [{ ok: true, files: [{ id: 'FONE' }] }] }],
    [
      'conflicting timestamps',
      {
        ok: true,
        files: [
          {
            ok: true,
            files: [
              { id: 'FONE', ...share('1700000004.000001') },
              { id: 'FTWO', ...share('1700000004.000002') },
            ],
          },
        ],
      },
    ],
  ])('classifies %s as unknown rather than definite failure', async (_name, response) => {
    const paths = setup(2);
    configureSlackClient({ files: { uploadV2: async () => response } } as any, channel);

    await expect(sendSlackMessage('ambiguous', undefined, paths)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      message: expect.stringContaining('inspect'),
    });
  });

  it('keeps an explicit Slack rejection distinct from a successful ambiguous completion', async () => {
    const paths = setup();
    configureSlackClient(
      { files: { uploadV2: async () => ({ ok: false, error: 'invalid_arguments' }) } } as any,
      channel,
    );

    await expect(sendSlackMessage('rejected', undefined, paths)).rejects.toMatchObject({
      code: 'SLACK_ERROR',
    });
  });

  it('classifies an upload transport failure as unknown because the mutation may have started', async () => {
    const paths = setup();
    configureSlackClient(
      { files: { uploadV2: async () => Promise.reject(new Error('connection lost')) } } as any,
      channel,
    );

    await expect(sendSlackMessage('lost', undefined, paths)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });
  });
});
