import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import {
  chownSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startControlServer } from '../src/control.js';

const directories: string[] = [];

function socketPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-control-lifecycle-'));
  directories.push(directory);
  return join(directory, 'control.sock');
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('control socket lifecycle', () => {
  it('rejects dangling symlinks and non-socket paths using lstat', async () => {
    const symlink = socketPath();
    symlinkSync(`${symlink}.missing`, symlink);
    await expect(startControlServer(undefined, { path: symlink })).rejects.toThrow(
      /Unsafe control socket path/,
    );

    const file = socketPath();
    writeFileSync(file, 'not a socket');
    await expect(startControlServer(undefined, { path: file })).rejects.toThrow(
      /Unsafe control socket path/,
    );
  });

  it.skipIf(process.getuid?.() !== 0)('rejects a foreign-owned socket path', async () => {
    const path = socketPath();
    const foreign = createServer();
    await new Promise<void>((resolve) => foreign.listen(path, resolve));
    try {
      chownSync(path, 1, 1);
      await expect(startControlServer(undefined, { path })).rejects.toThrow(/Foreign-owned/);
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });

  it('closes and removes its socket after post-bind validation failure', async () => {
    const path = socketPath();
    await expect(
      startControlServer(undefined, {
        path,
        validateBoundSocket: () => {
          throw new Error('post-bind validation failed');
        },
      }),
    ).rejects.toThrow(/post-bind validation failed/);
    expect(existsSync(path)).toBe(false);
  });

  it('preserves a replacement path during post-bind failure cleanup', async () => {
    const path = socketPath();
    await expect(
      startControlServer(undefined, {
        path,
        validateBoundSocket: () => {
          unlinkSync(path);
          writeFileSync(path, 'replacement');
          throw new Error('post-bind validation failed');
        },
      }),
    ).rejects.toThrow(/post-bind validation failed/);
    expect(existsSync(path)).toBe(true);
  });

  it('removes its owned socket during graceful shutdown and permits repeated close', async () => {
    const path = socketPath();
    const server = await startControlServer(undefined, { path });
    expect(existsSync(path)).toBe(true);
    await server.close();
    expect(existsSync(path)).toBe(false);
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('preserves a replacement path during graceful shutdown', async () => {
    const path = socketPath();
    const server = await startControlServer(undefined, { path });
    unlinkSync(path);
    writeFileSync(path, 'replacement');
    await server.close();
    expect(existsSync(path)).toBe(true);
  });

  it('handles runtime server errors without an unhandled error event', async () => {
    const path = socketPath();
    let raw: Server | undefined;
    const reported: Error[] = [];
    const server = await startControlServer(undefined, {
      path,
      onServerCreated: (value) => {
        raw = value;
      },
      onRuntimeError: (error) => reported.push(error),
    });
    const error = new Error('runtime listener failure');
    expect(() => raw!.emit('error', error)).not.toThrow();
    expect(reported).toEqual([error]);
    expect(server.lastError()).toBe(error);
    await server.close();
  });
});
