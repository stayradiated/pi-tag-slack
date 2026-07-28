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

export type PermissionRepairReporter = (path: string, mode: number) => void;

function assertOwnedPrivate(
  path: string,
  expectedMode: number,
  kind: 'directory' | 'file',
  onRepair?: PermissionRepairReporter,
  repair = true,
): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink structural path: ${path}`);
  if ((kind === 'directory' && !stat.isDirectory()) || (kind === 'file' && !stat.isFile())) {
    throw new Error(
      `Unexpected ${kind === 'directory' ? 'non-directory' : 'non-file'} path: ${path}`,
    );
  }
  const owner = uid();
  if (owner !== undefined && stat.uid !== owner) throw new Error(`Foreign-owned path: ${path}`);
  if ((stat.mode & 0o777) !== expectedMode) {
    if (!repair)
      throw new Error(`Unsafe ${kind} mode (expected ${expectedMode.toString(8)}): ${path}`);
    try {
      chmodSync(path, expectedMode);
    } catch (error) {
      throw new Error(
        `Unable to repair permissions for ${path} (run chmod ${expectedMode.toString(8)} ${path}): ${(error as Error).message}`,
        { cause: error },
      );
    }
    onRepair?.(path, expectedMode);
  }
}

function assertSafeExistingAncestors(path: string): void {
  let current = resolve(path);
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink structural path: ${current}`);
      if (!stat.isDirectory())
        throw new Error(`Structural ancestor is not a directory: ${current}`);
      const owner = uid();
      // Structural ancestors may be owned only by this account or by the
      // system administrator. This rejects a path rooted in another user's
      // tree even when its current mode happens not to be writable.
      if (owner !== undefined && stat.uid !== owner && stat.uid !== 0)
        throw new Error(`Foreign-owned structural ancestor: ${current}`);
      // Group/other writable ancestors permit replacement. Root-owned sticky
      // directories (notably /tmp) are the sole safe shared exception.
      if ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))
        throw new Error(`Structural path is writable by group or other: ${current}`);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOTDIR means a lower component is a non-directory; walking upward
      // identifies and reports that component without following anything.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(current);
    if (parent === current || current === parsePath(current).root) return;
    current = parent;
  }
}

/** Creates and validates the daemon-private structural layout. */
export function ensurePrivateLayout(
  paths = gatewayPaths(),
  onRepair?: PermissionRepairReporter,
): GatewayPaths {
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
    assertOwnedPrivate(path, 0o700, 'directory', onRepair);
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

export function ensurePrivateFile(path: string, onRepair?: PermissionRepairReporter): void {
  if (structuralPathExists(path)) assertOwnedPrivate(path, 0o600, 'file', onRepair);
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

function verifyLockFile(
  path: string,
  stat: Stats,
  onRepair?: PermissionRepairReporter,
  repair = true,
): void {
  if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink structural path: ${path}`);
  if (!stat.isFile()) throw new Error(`Unexpected non-file path: ${path}`);
  const owner = uid();
  if (owner !== undefined && stat.uid !== owner) throw new Error(`Foreign-owned path: ${path}`);
  if ((stat.mode & 0o777) !== 0o600) {
    if (!repair) throw new Error(`Unsafe gateway lock mode (expected 0600): ${path}`);
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      throw new Error(
        `Unable to repair permissions for ${path} (run chmod 600 ${path}): ${(error as Error).message}`,
        { cause: error },
      );
    }
    onRepair?.(path, 0o600);
  }
}

/**
 * Acquires a non-blocking OS-held advisory lock. The regular lock file is
 * deliberately retained: lock ownership belongs to this descriptor, not to a
 * PID value or the path's presence.
 */
export function acquireGatewayLock(
  paths = gatewayPaths(),
  options: {
    createLayout?: boolean;
    createFile?: boolean;
    writeMetadata?: boolean;
    readOnly?: boolean;
    onRepair?: PermissionRepairReporter;
  } = {},
): GatewayLock {
  if (options.createLayout !== false)
    ensurePrivateLayout(paths, options.readOnly ? undefined : options.onRepair);
  else
    assertOwnedPrivate(
      paths.dataDir,
      0o700,
      'directory',
      options.readOnly ? undefined : options.onRepair,
      !options.readOnly,
    );

  let fd: number | undefined;
  let locked = false;
  try {
    let before: Stats;
    try {
      before = lstatSync(paths.lock);
      verifyLockFile(
        paths.lock,
        before,
        options.readOnly ? undefined : options.onRepair,
        !options.readOnly,
      );
      const noAtime = options.readOnly ? (constants.O_NOATIME ?? 0) : 0;
      fd = openSync(
        paths.lock,
        (options.readOnly ? constants.O_RDONLY : constants.O_RDWR) | constants.O_NOFOLLOW | noAtime,
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.createFile === false)
        throw error;
      // O_EXCL prevents an attacker from replacing a previously absent path
      // between lstat and open. O_NOFOLLOW protects both Linux and macOS.
      fd = openSync(
        paths.lock,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      before = lstatSync(paths.lock);
      verifyLockFile(
        paths.lock,
        before,
        options.readOnly ? undefined : options.onRepair,
        !options.readOnly,
      );
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
    // Offline doctor locks an existing read-only descriptor without rewriting it.
    if (options.writeMetadata !== false) {
      ftruncateSync(fd, 0);
      writeFileSync(fd, `${process.pid}\n`, { encoding: 'utf8' });
    }

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
