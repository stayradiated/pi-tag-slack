import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli/index.js';
import { startGateway } from '../src/index.js';
import {
  acquireGatewayLock,
  ensurePrivateLayout,
  gatewayPaths,
  GatewayLockContendedError,
} from '../src/paths.js';

const directories: string[] = [];
const children: ChildProcess[] = [];

function paths() {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-lock-'));
  directories.push(directory);
  return gatewayPaths(directory);
}

function hold(directory: string): Promise<ChildProcess> {
  const child = fork(fileURLToPath(new URL('./lock-holder.ts', import.meta.url)), [directory], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once('message', (message) => {
      if ((message as { type?: string }).type === 'acquired') resolve(child);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (!child.killed) {
        child.kill('SIGKILL');
        await exited(child);
      }
    }),
  );
  for (const directory of directories.splice(0))
    // The fixture deliberately leaves regular lock files behind.
    rmSync(directory, { recursive: true, force: true });
});

describe('OS-held gateway lock', () => {
  it('excludes another process, reports stable contention, and leaks no descriptor', async () => {
    const gateway = paths();
    ensurePrivateLayout(gateway);
    await hold(gateway.dataDir);
    const before = process.platform === 'linux' ? readdirSync('/proc/self/fd').length : undefined;
    expect(() => acquireGatewayLock(gateway)).toThrow(GatewayLockContendedError);
    if (before !== undefined) expect(readdirSync('/proc/self/fd').length).toBe(before);
    expect(() => acquireGatewayLock(gateway)).toThrow(/Gateway lock is held/);
  });

  it('is released when a holder crashes and ignores stale PID metadata', async () => {
    const gateway = paths();
    ensurePrivateLayout(gateway);
    writeFileSync(gateway.lock, '999999\n', { mode: 0o600 });
    const initial = acquireGatewayLock(gateway);
    initial.release();

    const child = await hold(gateway.dataDir);
    child.kill('SIGKILL');
    await exited(child);
    const reacquired = acquireGatewayLock(gateway);
    reacquired.release();
  });

  it('allows immediate reacquisition, retains its regular file, and never deletes a replacement', () => {
    const gateway = paths();
    ensurePrivateLayout(gateway);
    const first = acquireGatewayLock(gateway);
    const replacement = `${gateway.lock}.replacement`;
    writeFileSync(replacement, 'replacement\n', { mode: 0o600 });
    renameSync(replacement, gateway.lock);
    first.release();
    expect(existsSync(gateway.lock)).toBe(true);
    expect(lstatSync(gateway.lock).isFile()).toBe(true);
    const second = acquireGatewayLock(gateway);
    second.release();
  });

  it('rejects symlinks, directories, unsafe modes, and foreign owners without leaking descriptors', () => {
    const gateway = paths();
    ensurePrivateLayout(gateway);
    const target = join(gateway.dataDir, 'target');
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, gateway.lock);
    expect(() => acquireGatewayLock(gateway)).toThrow(/symlink/);

    // A fresh layout gives each unsafe shape an independent path.
    const directoryLock = paths();
    ensurePrivateLayout(directoryLock);
    mkdirSync(directoryLock.lock);
    expect(() => acquireGatewayLock(directoryLock)).toThrow(/non-file/);
    rmSync(directoryLock.lock, { recursive: true });
    writeFileSync(directoryLock.lock, '', { mode: 0o644 });
    const before = process.platform === 'linux' ? readdirSync('/proc/self/fd').length : undefined;
    const repaired = acquireGatewayLock(directoryLock);
    repaired.release();
    expect(lstatSync(directoryLock.lock).mode & 0o777).toBe(0o600);
    if (before !== undefined) expect(readdirSync('/proc/self/fd').length).toBe(before);
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    try {
      expect(() => acquireGatewayLock(directoryLock)).toThrow(/Foreign-owned/);
    } finally {
      getuid.mockRestore();
    }
  });

  it('makes setup, daemon startup, and offline doctor contend on the same lock', async () => {
    const gateway = paths();
    ensurePrivateLayout(gateway);
    const oldDataDir = process.env.PI_TAG_SLACK_DATA_DIR;
    const oldConfig = process.env.PI_TAG_SLACK_CONFIG;
    process.env.PI_TAG_SLACK_DATA_DIR = gateway.dataDir;
    process.env.PI_TAG_SLACK_CONFIG = join(gateway.dataDir, 'config.env');
    try {
      await hold(gateway.dataDir);
      await expect(startGateway()).rejects.toThrow(GatewayLockContendedError);
      await expect(
        main([
          'setup',
          '--channel',
          'C0123456789',
          '--cwd',
          '/tmp',
          '--model',
          'provider/model',
          '--bot-token',
          'xoxb-token',
          '--app-token',
          'xapp-token',
          '--trusted-user',
          'U0123456789',
        ]),
      ).rejects.toThrow(GatewayLockContendedError);
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await expect(main(['doctor'])).resolves.toBe(1);
        expect(output).toHaveBeenCalledWith(expect.stringContaining('GATEWAY_LOCKED'));
      } finally {
        output.mockRestore();
      }
    } finally {
      if (oldDataDir === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
      else process.env.PI_TAG_SLACK_DATA_DIR = oldDataDir;
      if (oldConfig === undefined) delete process.env.PI_TAG_SLACK_CONFIG;
      else process.env.PI_TAG_SLACK_CONFIG = oldConfig;
    }
  });
});
