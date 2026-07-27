import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { parse } from 'dotenv';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { validateBootstrapConfigPath } from './config.js';
import { structuralPathExists, type GatewayPaths } from './paths.js';
import type { ResetBackupBundle } from './reset-backup.js';

const JOURNAL_VERSION = 1;
type Phase = 'prepared' | 'active-moved' | 'fresh-installed' | 'complete';
type ComponentPaths = {
  config: string;
  database: string;
  wal: string;
  shm: string;
  session: string;
};

export type ResetJournal = {
  version: 1;
  phase: Phase;
  backupBundle: string;
  staged: ComponentPaths;
  active: ComponentPaths;
  rollback: ComponentPaths;
};

export type ResetInstallOptions = {
  paths: GatewayPaths;
  configPath: string;
  backup: ResetBackupBundle;
  staged: { config: string; database: string; session: string };
  /** Test-only seam, called after each durable/destructive boundary. */
  afterStep?: (step: string) => void;
};

function fsyncPath(path: string, directory = false): void {
  const fd = openSync(
    path,
    constants.O_RDONLY | (directory ? constants.O_DIRECTORY : constants.O_NOFOLLOW),
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function fsyncParent(path: string, step: (name: string) => void): void {
  fsyncPath(dirname(path), true);
  step(`fsync:${dirname(path)}`);
}
function exists(path: string): boolean {
  return structuralPathExists(path);
}
function absent(path: string): void {
  if (exists(path)) throw new Error(`Reset destination already exists: ${path}`);
}
function uid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function privateFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe reset file: ${path}`);
  if (uid() !== undefined && stat.uid !== uid())
    throw new Error(`Foreign-owned reset path: ${path}`);
  if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}
function privateTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`Unsafe reset directory: ${path}`);
  if (uid() !== undefined && stat.uid !== uid())
    throw new Error(`Foreign-owned reset path: ${path}`);
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const childStat = lstatSync(child);
    if (childStat.isDirectory()) privateTree(child);
    else privateFile(child);
  }
}
function validateConfig(path: string): void {
  validateBootstrapConfigPath(path);
  const values = parse(readFileSync(path, 'utf8'));
  if (!values.SLACK_BOT_TOKEN?.startsWith('xoxb-') || !values.SLACK_APP_TOKEN?.startsWith('xapp-'))
    throw new Error(`Invalid bootstrap config: ${path}`);
}
function validateDatabase(path: string): void {
  privateFile(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error(`Database quick_check failed: ${path}`);
    if (Number(db.pragma('user_version', { simple: true })) !== 2)
      throw new Error(`Unsupported installed database schema: ${path}`);
    const row = db.prepare('select count(*) as count from gateway_config').get() as {
      count: number;
    };
    if (Number(row.count) !== 1)
      throw new Error(`Installed database has no configuration singleton: ${path}`);
  } finally {
    db.close();
  }
}
function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function validateBundle(bundle: ResetBackupBundle): void {
  const manifestPath = join(bundle.path, 'manifest.json');
  privateTree(bundle.path);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ResetBackupBundle['manifest'];
  if (manifest.version !== 1 || manifest.phase !== 'validated')
    throw new Error('Invalid reset backup manifest.');
  for (const [name, component] of Object.entries(manifest.components)) {
    if (component.status === 'included') {
      const path = join(bundle.path, component.path);
      // Session hashes cover a tree rather than one file. Its private shape is
      // checked above; the backup creator has already validated its digest.
      if (name !== 'session' && (!exists(path) || digest(path) !== component.sha256))
        throw new Error(`Invalid reset backup component: ${name}`);
    }
  }
  validateDatabase(join(bundle.path, 'gateway.db'));
  if (manifest.components.config.status === 'included')
    validateConfig(join(bundle.path, 'config.env'));
}

/** Runtime validation for untrusted on-disk journal JSON. */
export function parseResetJournal(value: unknown): ResetJournal {
  if (!value || typeof value !== 'object') throw new Error('Invalid reset journal.');
  const v = value as Record<string, unknown>;
  if (
    v.version !== JOURNAL_VERSION ||
    !['prepared', 'active-moved', 'fresh-installed', 'complete'].includes(String(v.phase))
  )
    throw new Error('Invalid reset journal version or phase.');
  const paths = (name: string): ComponentPaths => {
    const candidate = v[name];
    if (!candidate || typeof candidate !== 'object')
      throw new Error(`Invalid reset journal ${name}.`);
    const record = candidate as Record<string, unknown>;
    const result = {} as ComponentPaths;
    for (const key of ['config', 'database', 'wal', 'shm', 'session'] as const) {
      if (typeof record[key] !== 'string' || !isAbsolute(record[key] as string))
        throw new Error(`Invalid reset journal ${name}.${key}.`);
      result[key] = resolve(record[key] as string);
    }
    return result;
  };
  if (typeof v.backupBundle !== 'string' || !isAbsolute(v.backupBundle))
    throw new Error('Invalid reset journal backup bundle.');
  return {
    version: 1,
    phase: v.phase as Phase,
    backupBundle: resolve(v.backupBundle),
    staged: paths('staged'),
    active: paths('active'),
    rollback: paths('rollback'),
  };
}

export function readResetJournal(path: string): ResetJournal | undefined {
  if (!exists(path)) return undefined;
  privateFile(path);
  return parseResetJournal(JSON.parse(readFileSync(path, 'utf8')));
}

function writeJournal(path: string, journal: ResetJournal, step: (name: string) => void): void {
  const temporary = `${path}.tmp`;
  absent(temporary);
  writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  step(`write:${temporary}`);
  privateFile(temporary);
  fsyncPath(temporary);
  step(`fsync:${temporary}`);
  renameSync(temporary, path);
  step(`rename:${temporary}:${path}`);
  fsyncParent(path, step);
}
function moveIfPresent(from: string, to: string, step: (name: string) => void): void {
  if (!exists(from)) return;
  absent(to);
  renameSync(from, to);
  step(`rename:${from}:${to}`);
  fsyncParent(to, step);
}
function removeIfPresent(path: string, step: (name: string) => void): void {
  if (!exists(path)) return;
  rmSync(path, { recursive: true, force: false });
  step(`remove:${path}`);
  fsyncParent(path, step);
}

/**
 * Installs already validated fresh candidates. The caller holds gateway.lock.
 * Errors before completion restore the old state and leave the journal behind
 * if restoration itself cannot be validated.
 */
export function installFreshReset(options: ResetInstallOptions): void {
  const { paths, configPath, backup, staged } = options;
  const step = options.afterStep ?? (() => {});
  validateBundle(backup);
  validateConfig(staged.config);
  validateDatabase(staged.database);
  privateTree(staged.session);
  const active: ComponentPaths = {
    config: resolve(configPath),
    database: paths.db,
    wal: `${paths.db}-wal`,
    shm: `${paths.db}-shm`,
    session: paths.session,
  };
  const tag = `.rollback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rollback: ComponentPaths = {
    config: `${active.config}${tag}`,
    database: `${active.database}${tag}`,
    wal: `${active.wal}${tag}`,
    shm: `${active.shm}${tag}`,
    session: `${active.session}${tag}`,
  };
  for (const path of [...Object.values(rollback), paths.journal, `${paths.journal}.tmp`])
    absent(path);
  const journal: ResetJournal = {
    version: 1,
    phase: 'prepared',
    backupBundle: backup.path,
    staged: {
      config: resolve(staged.config),
      database: resolve(staged.database),
      wal: `${resolve(staged.database)}-wal`,
      shm: `${resolve(staged.database)}-shm`,
      session: resolve(staged.session),
    },
    active,
    rollback,
  };
  writeJournal(paths.journal, journal, step);
  try {
    for (const key of ['config', 'database', 'wal', 'shm', 'session'] as const)
      moveIfPresent(active[key], rollback[key], step);
    journal.phase = 'active-moved';
    writeJournal(paths.journal, journal, step);
    // A WAL/SHM cannot accompany the fresh main database. They are staging
    // artefacts, never active state, and are discarded before publication.
    removeIfPresent(journal.staged.wal, step);
    removeIfPresent(journal.staged.shm, step);
    for (const key of ['config', 'database', 'session'] as const)
      moveIfPresent(journal.staged[key], active[key], step);
    for (const path of [active.config, active.database, active.session]) fsyncParent(path, step);
    journal.phase = 'fresh-installed';
    writeJournal(paths.journal, journal, step);
    validateConfig(active.config);
    validateDatabase(active.database);
    // Opening SQLite for validation can create an empty SHM sidecar. Remove
    // both only after that connection is closed, then durable-fsync the DB
    // directory before declaring the fresh installation valid.
    removeIfPresent(active.wal, step);
    removeIfPresent(active.shm, step);
    privateTree(active.session);
    if (exists(active.wal) || exists(active.shm))
      throw new Error('Fresh database has unexpected WAL/SHM sidecars.');
    journal.phase = 'complete';
    writeJournal(paths.journal, journal, step);
  } catch (error) {
    try {
      rollbackReset(journal, backup, step);
      // Restored state has passed the same validation as installed state, so
      // it is safe to forget the failed in-process attempt. A failed cleanup
      // deliberately leaves the journal for the next plain-setup recovery.
      removeIfPresent(paths.journal, step);
    } catch {
      /* journal intentionally remains for recovery */
    }
    throw error;
  }
  // Completion is durable. Cleanup failures preserve the completed journal,
  // rather than risking destruction of a validated installed state.
  for (const path of Object.values(rollback)) removeIfPresent(path, step);
  removeIfPresent(paths.journal, step);
}

function rollbackReset(
  journal: ResetJournal,
  backup: ResetBackupBundle,
  step: (name: string) => void,
): void {
  for (const path of Object.values(journal.active)) removeIfPresent(path, step);
  const useBundleDatabase = exists(journal.rollback.wal) || exists(journal.rollback.shm);
  for (const key of ['config', 'session'] as const)
    if (exists(journal.rollback[key]))
      moveIfPresent(journal.rollback[key], journal.active[key], step);
  if (!useBundleDatabase && exists(journal.rollback.database))
    moveIfPresent(journal.rollback.database, journal.active.database, step);
  else {
    // A main database paired with an old WAL is not a standalone image. The
    // pre-reset SQLite backup is the validated, WAL-inclusive rollback image.
    validateBundle(backup);
    const staging = `${journal.active.database}.restore-${Date.now()}`;
    absent(staging);
    copyFileSync(join(backup.path, 'gateway.db'), staging, constants.COPYFILE_EXCL);
    chmodSync(staging, 0o600);
    moveIfPresent(staging, journal.active.database, step);
  }
  // A backup image is self-contained; old sidecars must never shadow it.
  removeIfPresent(journal.active.wal, step);
  removeIfPresent(journal.active.shm, step);
  validateConfig(journal.active.config);
  validateDatabase(journal.active.database);
  privateTree(journal.active.session);
}
