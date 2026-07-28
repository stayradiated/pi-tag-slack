import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, request } from '../src/cli/index.js';

const roots: string[] = [];
const servers: Server[] = [];
const originalDataDir = process.env.PI_TAG_SLACK_DATA_DIR;

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-tag-slack-cli-contract-'));
  roots.push(root);
  process.env.PI_TAG_SLACK_DATA_DIR = root;
  return root;
}

async function listen(handler: (request: string, socket: import('node:net').Socket) => void) {
  const root = dataDir();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      if (input.includes('\n')) handler(input, socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(join(root, 'control.sock'), resolve));
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
  else process.env.PI_TAG_SLACK_DATA_DIR = originalDataDir;
});

describe('CLI control transport classifications', () => {
  it('keeps a pre-connect refusal as DAEMON_UNAVAILABLE', async () => {
    dataDir();
    await expect(request('slack.send', { text: 'once' })).rejects.toMatchObject({
      code: 'DAEMON_UNAVAILABLE',
    });
  });

  it('returns correlated OUTCOME_UNKNOWN on mutation EOF after delivery', async () => {
    await listen((_request, socket) => socket.end());
    const error = await request('slack.send', { text: 'once' }).catch((value) => value);
    expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(error.message).toMatch(
      /Request ID: [0-9a-f-]+\. Inspect Slack\/inbox state before retrying\./,
    );
  });

  it('maps an unusable post-delivery mutation response but not a read-only response', async () => {
    await listen((_request, socket) => socket.end('{"id":"wrong","result":{"ok":true}}\n'));
    await expect(request('inbox.respond', { id: 'inbox-1', text: 'once' })).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });

    await expect(request('session.status', {})).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});

describe('CLI usage contract', () => {
  it('returns a concise stable unknown-command error without full help', async () => {
    const error = await main(['not-a-command']).catch((value) => value);
    expect(error).toMatchObject({
      code: 'UNKNOWN_COMMAND',
      message: 'Unsupported command. Run pi-tag-slack help for usage.',
    });
    expect(error.message).not.toContain('Usage:');
  });
});
