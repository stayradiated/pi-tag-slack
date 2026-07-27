import Database from 'better-sqlite3';
import { parse } from 'dotenv';
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse as parsePath, resolve } from 'node:path';
import { resolveConfigPath, validateBootstrapConfigPath } from './config.js';
import { SCHEMA_VERSION, validateConfiguredDatabase } from './db.js';
import { parseResetJournal } from './reset-install.js';
import {
  acquireGatewayLock,
  gatewayPaths,
  structuralPathExists,
  type GatewayLock,
  type GatewayPaths,
} from './paths.js';

type Finding = { code: string; message: string; path?: string };
type Kind = 'directory' | 'file' | 'socket';
type Diagnostic = {
  name: string;
  path: string;
  required: boolean;
  expectedKind: Kind;
  expectedMode: string;
  exists: boolean;
  kind?: string;
  mode?: string;
  uid?: number;
  owner?: 'current-user' | 'foreign';
  symlink?: boolean;
  healthy: boolean;
  error?: string;
};

export type DoctorReport = Record<string, unknown> & {
  mode: 'online' | 'offline';
  healthy: boolean;
  findings: Finding[];
};

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : undefined);

function kind(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSocket()) return 'socket';
  return 'other';
}

function diagnostic(
  name: string,
  path: string,
  expectedKind: Kind,
  expectedMode: number,
  required: boolean,
  findings: Finding[],
): Diagnostic {
  const expectedModeText = expectedMode.toString(8).padStart(4, '0');
  try {
    if (!structuralPathExists(path)) {
      if (required)
        findings.push({ code: 'PATH_MISSING', message: `Required ${name} path is missing.`, path });
      return {
        name,
        path,
        required,
        expectedKind,
        expectedMode: expectedModeText,
        exists: false,
        healthy: !required,
      };
    }
    const stat = lstatSync(path);
    const actualKind = kind(stat);
    const actualMode = (stat.mode & 0o777).toString(8).padStart(4, '0');
    const owner =
      currentUid() === undefined || stat.uid === currentUid() ? 'current-user' : 'foreign';
    const healthy =
      !stat.isSymbolicLink() &&
      actualKind === expectedKind &&
      actualMode === expectedModeText &&
      owner === 'current-user';
    if (!healthy)
      findings.push({
        code: 'UNSAFE_PATH',
        message: `${name} has an unsafe type, owner, mode, or symlink substitution.`,
        path,
      });
    return {
      name,
      path,
      required,
      expectedKind,
      expectedMode: expectedModeText,
      exists: true,
      kind: actualKind,
      mode: actualMode,
      uid: stat.uid,
      owner,
      symlink: stat.isSymbolicLink(),
      healthy,
    };
  } catch {
    findings.push({
      code: 'PATH_INSPECTION_FAILED',
      message: `${name} could not be inspected.`,
      path,
    });
    return {
      name,
      path,
      required,
      expectedKind,
      expectedMode: expectedModeText,
      exists: false,
      healthy: false,
      error: 'inspection-failed',
    };
  }
}

function inspectPaths(paths: GatewayPaths, online: boolean, findings: Finding[]): Diagnostic[] {
  const specs: Array<[keyof GatewayPaths, Kind, number, boolean]> = [
    ['dataDir', 'directory', 0o700, true],
    ['db', 'file', 0o600, true],
    ['lock', 'file', 0o600, true],
    ['socket', 'socket', 0o600, online],
    ['sessions', 'directory', 0o700, true],
    ['session', 'directory', 0o700, true],
    ['archive', 'directory', 0o700, true],
    ['media', 'directory', 0o700, true],
    ['backups', 'directory', 0o700, true],
    ['journal', 'file', 0o600, false],
    ['stdout', 'file', 0o600, false],
    ['stderr', 'file', 0o600, false],
  ];
  return specs.map(([name, expectedKind, mode, required]) =>
    diagnostic(name, paths[name], expectedKind, mode, required, findings),
  );
}

function inspectBootstrap(findings: Finding[], inspectContents: boolean): Record<string, unknown> {
  const path = resolveConfigPath();
  const metadata = diagnostic('bootstrapConfig', path, 'file', 0o600, true, findings);
  if (!metadata.exists || !metadata.healthy || !inspectContents)
    return { ...metadata, status: metadata.healthy ? 'validated-by-daemon' : 'unsafe-or-missing' };
  try {
    validateBootstrapConfigPath(path);
    const values = parse(readForInspection(path));
    const keys = Object.keys(values).sort();
    if (
      keys.join(',') !== 'SLACK_APP_TOKEN,SLACK_BOT_TOKEN' ||
      !values.SLACK_BOT_TOKEN?.startsWith('xoxb-') ||
      !values.SLACK_APP_TOKEN?.startsWith('xapp-')
    )
      throw new Error('incomplete');
    return { ...metadata, status: 'complete' };
  } catch {
    findings.push({
      code: 'BOOTSTRAP_CONFIG_INVALID',
      message: 'Bootstrap configuration is malformed, incomplete, or unsafe.',
      path,
    });
    return { ...metadata, healthy: false, status: 'invalid' };
  }
}

/** Uses no-atime reads when available, with a portable read-only fallback. */
function readForInspection(path: string): Buffer {
  const noAtime = (constants as Record<string, number | undefined>).O_NOATIME ?? 0;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | noAtime);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function inspectDataAncestors(paths: GatewayPaths, findings: Finding[]): void {
  let current = resolve(paths.dataDir);
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || ((stat.mode & 0o022) !== 0 && !(stat.mode & 0o1000))) {
        findings.push({
          code: 'UNSAFE_PATH_ANCESTOR',
          message: 'A structural path ancestor is a symlink or writable by group/other.',
          path: current,
        });
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        findings.push({
          code: 'PATH_INSPECTION_FAILED',
          message: 'A structural path ancestor could not be inspected.',
          path: current,
        });
      }
    }
    const parent = dirname(current);
    if (parent === current || current === parsePath(current).root) break;
    current = parent;
  }
}

function statusOf(paths: GatewayPaths, key: keyof GatewayPaths): string {
  try {
    return structuralPathExists(paths[key]) ? 'present' : 'absent';
  } catch {
    return 'inspection-failed';
  }
}

function inspectJournal(paths: GatewayPaths, findings: Finding[]): Record<string, unknown> {
  if (!structuralPathExists(paths.journal)) return { status: 'absent' };
  try {
    const journal = parseResetJournal(
      JSON.parse(readForInspection(paths.journal).toString('utf8')),
    );
    if (journal.phase !== 'complete') {
      findings.push({
        code: 'RESET_INTERRUPTED',
        message: 'An incomplete reset journal is present; offline doctor does not repair it.',
        path: paths.journal,
      });
    }
    return {
      status: journal.phase === 'complete' ? 'complete' : 'interrupted',
      phase: journal.phase,
    };
  } catch {
    findings.push({
      code: 'RESET_JOURNAL_INVALID',
      message: 'The reset journal is malformed or unsafe.',
      path: paths.journal,
    });
    return { status: 'invalid' };
  }
}

type SidecarSnapshot = { status: 'absent' | 'present'; bytes?: Buffer };

function readSidecar(path: string): SidecarSnapshot {
  if (!structuralPathExists(path)) return { status: 'absent' };
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (currentUid() !== undefined && stat.uid !== currentUid())
  )
    throw new Error('unsafe-sidecar');
  return { status: 'present', bytes: readForInspection(path) };
}

function validWalHeader(wal: Buffer): boolean {
  if (wal.length === 0) return true;
  if (wal.length < 32) return false;
  const magic = wal.readUInt32BE(0);
  const pageSize = wal.readUInt32BE(8);
  return (
    (magic === 0x377f0682 || magic === 0x377f0683) &&
    (pageSize === 1 || (pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0))
  );
}

function openMainImageReadOnly(image: Buffer): Database.Database {
  if (image.length < 20 || ![1, 2].includes(image[18]) || ![1, 2].includes(image[19]))
    throw new Error('invalid-header');
  // A serialized image cannot itself use WAL. Normalize only this private
  // buffer's header before opening the resulting connection read-only.
  image[18] = 1;
  image[19] = 1;
  return new Database(image, { readonly: true, fileMustExist: true });
}

function openWalSnapshot(
  main: Buffer,
  wal: Buffer,
  shm: Buffer | undefined,
): { database: Database.Database; cleanup: () => void } {
  if (!validWalHeader(wal)) throw new Error('invalid-wal-header');
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-doctor-snapshot-'));
  const databasePath = join(directory, 'gateway.db');
  try {
    writeFileSync(databasePath, main, { flag: 'wx', mode: 0o600 });
    writeFileSync(`${databasePath}-wal`, wal, { flag: 'wx', mode: 0o600 });
    if (shm) writeFileSync(`${databasePath}-shm`, shm, { flag: 'wx', mode: 0o600 });
    chmodSync(directory, 0o700);
    // This writable connection is confined to the disposable snapshot. SQLite
    // may rebuild SHM or checkpoint there, but deployment files remain unopened.
    const database = new Database(databasePath, { fileMustExist: true });
    return {
      database,
      cleanup: () => {
        database.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function inspectDatabase(paths: GatewayPaths, findings: Finding[]): Record<string, unknown> {
  let database: Database.Database | undefined;
  let cleanup: () => void = () => {
    database?.close();
  };
  let walStatus = 'absent';
  let shmStatus = 'absent';
  try {
    if (!structuralPathExists(paths.db))
      return { status: 'missing', wal: walStatus, shm: shmStatus };
    const main = readForInspection(paths.db);
    const wal = readSidecar(`${paths.db}-wal`);
    const shm = readSidecar(`${paths.db}-shm`);
    walStatus = wal.status;
    shmStatus = shm.status;
    if (wal.bytes) {
      const snapshot = openWalSnapshot(main, wal.bytes, shm.bytes);
      database = snapshot.database;
      cleanup = snapshot.cleanup;
    } else {
      database = openMainImageReadOnly(main);
    }
    const quickCheck = database.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') throw new Error('quick-check');
    validateConfiguredDatabase(database);
    return {
      status: 'ok',
      quickCheck: 'ok',
      schemaVersion: SCHEMA_VERSION,
      configuration: 'complete',
      wal: walStatus,
      shm: shmStatus,
    };
  } catch {
    findings.push({
      code: 'DATABASE_INVALID',
      message:
        'Database or sidecars are corrupt, malformed, unsafe, unsupported, or incompletely configured.',
      path: paths.db,
    });
    return { status: 'invalid', wal: walStatus, shm: shmStatus };
  } finally {
    cleanup();
  }
}

function healthIsHealthy(health: unknown): boolean {
  if (!health || typeof health !== 'object') return false;
  const value = health as Record<string, unknown>;
  const session = value.session as Record<string, unknown> | undefined;
  return value.database === 'ok' && value.control === 'ok' && session?.health === 'healthy';
}

export function onlineDoctor(health: unknown): { report: DoctorReport; exitCode: number } {
  const paths = gatewayPaths();
  const findings: Finding[] = [];
  inspectDataAncestors(paths, findings);
  const pathResults = inspectPaths(paths, true, findings);
  const bootstrapConfig = inspectBootstrap(findings, false);
  if (!healthIsHealthy(health))
    findings.push({
      code: 'DAEMON_UNHEALTHY',
      message: 'Daemon control health reports an unhealthy database, control socket, or session.',
    });
  const value = (health && typeof health === 'object' ? health : {}) as Record<string, unknown>;
  const healthy = findings.length === 0;
  return {
    report: {
      mode: 'online',
      healthy,
      paths: pathResults,
      bootstrapConfig,
      database: value.database ?? 'unavailable',
      session: value.session ?? 'unavailable',
      socket: value.control ?? 'unavailable',
      lock: 'held-by-daemon',
      daemon: health,
      findings,
    },
    exitCode: healthy ? 0 : 1,
  };
}

export function offlineDoctor(): { report: DoctorReport; exitCode: number } {
  const paths = gatewayPaths();
  const findings: Finding[] = [];
  let lock: GatewayLock | undefined;
  try {
    lock = acquireGatewayLock(paths, {
      createLayout: false,
      createFile: false,
      writeMetadata: false,
      readOnly: true,
    });
  } catch (error: unknown) {
    const code =
      (error as { cause?: NodeJS.ErrnoException; code?: string }).code ??
      (error as { cause?: NodeJS.ErrnoException }).cause?.code ??
      'LOCK_ERROR';
    findings.push({
      code: code === 'GATEWAY_LOCKED' ? 'GATEWAY_LOCKED' : 'LOCK_UNAVAILABLE',
      message:
        code === 'GATEWAY_LOCKED'
          ? 'Gateway lock is held; offline inspection was not attempted.'
          : 'Gateway lock is missing, unsafe, or unavailable; state may be unconfigured.',
      path: paths.lock,
    });
    inspectDataAncestors(paths, findings);
    const pathResults = inspectPaths(paths, false, findings);
    const bootstrapConfig = inspectBootstrap(findings, false);
    return {
      report: {
        mode: 'offline',
        healthy: false,
        paths: pathResults,
        bootstrapConfig,
        database: 'not-inspected',
        session: 'not-inspected',
        archive: 'not-inspected',
        media: 'not-inspected',
        socket: statusOf(paths, 'socket'),
        lock: code === 'GATEWAY_LOCKED' ? 'contended' : 'unavailable',
        resetJournal: 'not-inspected',
        findings,
      },
      exitCode: 1,
    };
  }

  try {
    inspectDataAncestors(paths, findings);
    const pathResults = inspectPaths(paths, false, findings);
    const bootstrapConfig = inspectBootstrap(findings, true);
    const database = inspectDatabase(paths, findings);
    const resetJournal = inspectJournal(paths, findings);
    const socket = statusOf(paths, 'socket');
    if (socket !== 'absent')
      findings.push({
        code: 'STALE_CONTROL_SOCKET',
        message: 'A control socket path remains while the daemon is offline.',
        path: paths.socket,
      });
    const healthy = findings.length === 0;
    return {
      report: {
        mode: 'offline',
        healthy,
        paths: pathResults,
        bootstrapConfig,
        database,
        session: { status: statusOf(paths, 'session') },
        archive: { status: statusOf(paths, 'archive') },
        media: { status: statusOf(paths, 'media') },
        socket,
        lock: 'acquired-read-only',
        resetJournal,
        findings,
      },
      exitCode: healthy ? 0 : 1,
    };
  } finally {
    lock.release();
  }
}
