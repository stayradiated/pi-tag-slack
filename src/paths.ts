import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  type Stats,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { flockSync } from 'fs-ext';
import { dirname, join, parse as parsePath, resolve } from 'node:path';
import { resolveDataDir } from './config.js';

export interface GatewayPaths {
  dataDir: string;
  db: string;
  lock: string;
  socket: string;
  sessions: string;
  session: string;
  archive: string;
  media: string;
  backups: string;
  journal: string;
  stdout: string;
  stderr: string;
}

export function gatewayPaths(dataDir = resolveDataDir()): GatewayPaths {
  const root = resolve(dataDir);
  const sessions = join(root, 'sessions');
  return {
    dataDir: root,
    db: join(root, 'gateway.db'),
    lock: join(root, 'gateway.lock'),
    socket: join(root, 'control.sock'),
    sessions,
    session: join(sessions, 'session'),
    archive: join(sessions, 'archive'),
    media: join(root, 'media'),
    backups: join(root, 'backups'),
    journal: join(root, 'reset-journal.json'),
    stdout: join(root, 'daemon.stdout.log'),
    stderr: join(root, 'daemon.stderr.log'),
  };
}

function uid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwnedPrivate(path: string, expectedMode: number, kind: 'directory' | 'file'): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink structural path: ${path}`);
  if ((kind === 'directory' && !stat.isDirectory()) || (kind === 'file' && !stat.isFile())) {
    throw new Error(
      `Unexpected ${kind === 'directory' ? 'non-directory' : 'non-file'} path: ${path}`,
    );
  }
  const owner = uid();
  if (owner !== undefined && stat.uid !== owner) throw new Error(`Foreign-owned path: ${path}`);
  if ((stat.mode & 0o777) !== expectedMode) chmodSync(path, expectedMode);
}

function assertSafeExistingAncestors(path: string): void {
  let current = resolve(path);
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink structural path: ${current}`);
      // System-owned read-only ancestors are safe. A sticky directory (such as
      // /tmp) is safe from replacement by another unprivileged user.
      if ((stat.mode & 0o022) !== 0 && !(stat.mode & 0o1000))
        throw new Error(`Structural path is writable by group or other: ${current}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current || current === parsePath(current).root) return;
    current = parent;
  }
}

/** Creates and validates the daemon-private structural layout. */
export function ensurePrivateLayout(paths = gatewayPaths()): GatewayPaths {
  for (const path of [
    paths.dataDir,
    paths.sessions,
    paths.session,
    paths.archive,
    paths.media,
    paths.backups,
  ]) {
    assertSafeExistingAncestors(path);
    if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
    assertOwnedPrivate(path, 0o700, 'directory');
  }
  return paths;
}

export function structuralPathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function ensurePrivateFile(path: string): void {
  if (structuralPathExists(path)) assertOwnedPrivate(path, 0o600, 'file');
}

export interface GatewayLock {
  release(): void;
}

/** Stable error for an actively held OS advisory lock. */
export class GatewayLockContendedError extends Error {
  readonly code = 'GATEWAY_LOCKED';

  constructor(path: string, cause?: unknown) {
    super(`Gateway lock is held: ${path}. Stop the active gateway and retry.`, { cause });
    this.name = 'GatewayLockContendedError';
  }
}

function verifyLockFile(path: string, stat: Stats): void {
  if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink structural path: ${path}`);
  if (!stat.isFile()) throw new Error(`Unexpected non-file path: ${path}`);
  const owner = uid();
  if (owner !== undefined && stat.uid !== owner) throw new Error(`Foreign-owned path: ${path}`);
  if ((stat.mode & 0o777) !== 0o600)
    throw new Error(`Unsafe gateway lock mode (expected 0600): ${path}`);
}

/**
 * Acquires a non-blocking OS-held advisory lock. The regular lock file is
 * deliberately retained: lock ownership belongs to this descriptor, not to a
 * PID value or the path's presence.
 */
export function acquireGatewayLock(
  paths = gatewayPaths(),
  options: { createLayout?: boolean } = {},
): GatewayLock {
  if (options.createLayout !== false) ensurePrivateLayout(paths);
  else assertOwnedPrivate(paths.dataDir, 0o700, 'directory');

  let fd: number | undefined;
  let locked = false;
  try {
    let before: Stats;
    try {
      before = lstatSync(paths.lock);
      verifyLockFile(paths.lock, before);
      fd = openSync(paths.lock, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // O_EXCL prevents an attacker from replacing a previously absent path
      // between lstat and open. O_NOFOLLOW protects both Linux and macOS.
      fd = openSync(
        paths.lock,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      before = lstatSync(paths.lock);
      verifyLockFile(paths.lock, before);
    }
    const opened = fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino)
      throw new Error(`Gateway lock path changed while opening: ${paths.lock}`);

    try {
      flockSync(fd, 'exnb');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EAGAIN' || code === 'EWOULDBLOCK')
        throw new GatewayLockContendedError(paths.lock, error);
      throw error;
    }
    locked = true;
    // Metadata is diagnostic only. A stale value never affects acquisition.
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${process.pid}\n`, { encoding: 'utf8' });

    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        try {
          flockSync(fd!, 'un');
        } finally {
          closeSync(fd!);
        }
      },
    };
  } catch (error: unknown) {
    if (fd !== undefined) {
      try {
        if (locked) flockSync(fd, 'un');
      } finally {
        closeSync(fd);
      }
    }
    if (error instanceof GatewayLockContendedError) throw error;
    throw new Error(`Unable to acquire gateway lock: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export function assertPrivateSocket(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isSocket())
    throw new Error(`Unsafe control socket path: ${path}`);
  const owner = uid();
  if (owner !== undefined && stat.uid !== owner)
    throw new Error(`Foreign-owned control socket: ${path}`);
  if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

export interface PathDiagnostic {
  path: string;
  exists: boolean;
  mode?: string;
  uid?: number;
  kind?: string;
  symlink?: boolean;
}

export function pathDiagnostic(path: string): PathDiagnostic {
  if (!structuralPathExists(path)) return { path, exists: false };
  const stat = lstatSync(path);
  return {
    path,
    exists: true,
    mode: (stat.mode & 0o777).toString(8).padStart(4, '0'),
    uid: stat.uid,
    kind: stat.isDirectory()
      ? 'directory'
      : stat.isFile()
        ? 'file'
        : stat.isSocket()
          ? 'socket'
          : 'other',
    symlink: stat.isSymbolicLink(),
  };
}

export function pathDiagnostics(paths = gatewayPaths()): PathDiagnostic[] {
  return Object.values(paths).map(pathDiagnostic);
}
