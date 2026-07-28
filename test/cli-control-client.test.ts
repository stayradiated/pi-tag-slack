import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../src/cli/control-client.js';

const roots: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

async function listen(handler: (socket: Socket) => void): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'pi-tag-slack-cli-client-'));
  roots.push(root);
  const path = join(root, 'control.sock');
  const server = createServer({ allowHalfOpen: true }, handler);
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.once('close', () => sockets.splice(sockets.indexOf(socket), 1));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return path;
}

function client(path: string, id = 'request-id') {
  return { socketPath: () => path, requestId: () => id, controlDeadlineMs: 25 };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CLI control client', () => {
  it('sends one LF-delimited request with its exact ID and accepts its envelope', async () => {
    const path = await listen((socket) => {
      let frame = '';
      socket.on('data', (chunk) => (frame += chunk));
      socket.on('end', () => {
        expect(frame).toBe(
          '{"version":1,"id":"request-id","command":"session.status","params":{}}\n',
        );
        socket.end('{"id":"request-id","result":{"ok":true}}\n');
      });
    });

    await expect(request('session.status', {}, client(path))).resolves.toEqual({
      id: 'request-id',
      result: { ok: true },
    });
  });

  it('rejects malformed and oversized response frames', async () => {
    const malformed = await listen((socket) =>
      socket.on('data', () => socket.end('{"id":"wrong","result":true}\n')),
    );
    await expect(request('session.status', {}, client(malformed))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'Daemon response has an invalid correlation ID.',
    });

    const oversized = await listen((socket) =>
      socket.on('data', () => socket.end(Buffer.alloc(1024 * 1024 + 2, 0x78))),
    );
    await expect(request('session.status', {}, client(oversized))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'Daemon response exceeds frame limit.',
    });
  });

  it('uses a deadline and preserves mutation uncertainty after delivery', async () => {
    const deadline = await listen((socket) => socket.on('data', () => undefined));
    await expect(
      request('session.reset', { confirm: 'session:1' }, client(deadline)),
    ).rejects.toMatchObject({
      code: 'DEADLINE_EXCEEDED',
      requestId: 'request-id',
    });

    const mutation = await listen((socket) => socket.on('data', () => socket.end()));
    await expect(request('slack.send', { text: 'once' }, client(mutation))).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      requestId: 'request-id',
    });
  });
});
