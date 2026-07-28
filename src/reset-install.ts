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
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveConfigPath, validateBootstrapConfigPath } from './config.js';
import { validateRequiredPragmas } from './db.js';
import {
  acquireGatewayLock,
  ensurePrivateLayout,
  structuralPathExists,
  type GatewayPaths,
} from './paths.js';
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
type BootstrapDatabase = { configuration: unknown; trustedUsers: unknown[] };

function validateDatabase(path: string): BootstrapDatabase {
  privateFile(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    // Connection-local safety settings must be enabled and read back on every
    // staged/installed validation connection; WAL is persisted in the file.
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('trusted_schema = OFF');
    validateRequiredPragmas(db);
    if (db.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error(`Database quick_check failed: ${path}`);
    if (Number(db.pragma('user_version', { simple: true })) !== 2)
      throw new Error(`Unsupported installed database schema: ${path}`);
    const configuration = db.prepare('select * from gateway_config where id = 1').get();
    if (!configuration)
      throw new Error(`Installed database has no configuration singleton: ${path}`);
    const trustedUsers = db
      .prepare('select * from trusted_users order by user_id')
      .all() as unknown[];
    return { configuration, trustedUsers };
  } finally {
    db.close();
  }
}
function validateBundledDatabase(path: string, schemaVersion: number | null): void {
  privateFile(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error(`Bundled database quick_check failed: ${path}`);
    if (Number(db.pragma('user_version', { simple: true })) !== schemaVersion)
      throw new Error(`Bundled database schema differs from its manifest: ${path}`);
  } finally {
    db.close();
  }
}
function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function treeDigest(path: string): { size: number; sha256: string } {
  const hash = createHash('sha256');
  let size = 0;
  const visit = (current: string, relative: string): void => {
    const stat = lstatSync(current);
    if (stat.isDirectory()) {
      hash.update(`d:${relative}\n`);
      for (const name of readdirSync(current).sort())
        visit(join(current, name), join(relative, name));
    } else {
      const content = readFileSync(current);
      size += content.length;
      hash.update(`f:${relative}:${content.length}\n`).update(content);
    }
  };
  visit(path, '.');
  return { size, sha256: hash.digest('hex') };
}
function validateBundle(bundle: ResetBackupBundle): void {
  const manifestPath = join(bundle.path, 'manifest.json');
  privateTree(bundle.path);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ResetBackupBundle['manifest'];
  if (manifest.version !== 1 || manifest.phase !== 'validated')
    throw new Error('Invalid reset backup manifest.');
  const expectedComponentPaths = {
    database: 'gateway.db',
    config: 'config.env',
    session: 'session',
  } as const;
  for (const [name, expectedPath] of Object.entries(expectedComponentPaths)) {
    const component = manifest.components[name as keyof typeof manifest.components];
    if (
      !component ||
      (component.status !== 'included' && component.status !== 'missing') ||
      (component.status === 'included' && component.path !== expectedPath)
    )
      throw new Error(`Invalid reset backup component manifest: ${name}`);
  }
  for (const [name, component] of Object.entries(manifest.components)) {
    if (component.status === 'included') {
      const path = join(bundle.path, component.path);
      if (!exists(path)) throw new Error(`Invalid reset backup component: ${name}`);
      if (name === 'session') {
        const hash = createHash('sha256');
        let size = 0;
        const visit = (current: string, relative: string) => {
          const stat = lstatSync(current);
          if (stat.isDirectory()) {
            hash.update(`d:${relative}\n`);
            for (const child of readdirSync(current).sort())
              visit(join(current, child), join(relative, child));
          } else {
            const content = readFileSync(current);
            size += content.length;
            hash.update(`f:${relative}:${content.length}\n`).update(content);
          }
        };
        visit(path, '.');
        if (size !== component.size || hash.digest('hex') !== component.sha256)
          throw new Error(`Invalid reset backup component: ${name}`);
      } else {
        const stat = lstatSync(path);
        if (stat.size !== component.size || digest(path) !== component.sha256)
          throw new Error(`Invalid reset backup component: ${name}`);
      }
    }
  }
  validateBundledDatabase(join(bundle.path, 'gateway.db'), manifest.schemaVersion);
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
  const expectedConfig = readFileSync(staged.config);
  const expectedDatabase = validateDatabase(staged.database);
  privateTree(staged.session);
  const expectedSession = treeDigest(staged.session);
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
    if (!readFileSync(active.config).equals(expectedConfig))
      throw new Error('Installed bootstrap config differs from its validated staged artifact.');
    const installedDatabase = validateDatabase(active.database);
    if (JSON.stringify(installedDatabase) !== JSON.stringify(expectedDatabase))
      throw new Error('Installed database bootstrap values differ from staged values.');
    // Opening SQLite for validation can create an empty SHM sidecar. Remove
    // both only after that connection is closed, then durable-fsync the DB
    // directory before declaring the fresh installation valid.
    removeIfPresent(active.wal, step);
    removeIfPresent(active.shm, step);
    privateTree(active.session);
    if (JSON.stringify(treeDigest(active.session)) !== JSON.stringify(expectedSession))
      throw new Error('Installed session artifact differs from its validated staged artifact.');
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

export type ResetRecoveryOptions = {
  paths?: GatewayPaths;
  configPath?: string;
  afterStep?: (step: string) => void;
};

function validateRecoveryJournal(
  journal: ResetJournal,
  paths: GatewayPaths,
  configPath: string,
): void {
  const active: ComponentPaths = {
    config: resolve(configPath),
    database: paths.db,
    wal: `${paths.db}-wal`,
    shm: `${paths.db}-shm`,
    session: paths.session,
  };
  for (const key of Object.keys(active) as (keyof ComponentPaths)[])
    if (journal.active[key] !== active[key]) throw new Error(`Unsafe reset journal active.${key}.`);
  const suffix = journal.rollback.config.slice(active.config.length);
  if (!/^\.rollback-[A-Za-z0-9-]+$/.test(suffix))
    throw new Error('Unsafe reset journal rollback paths.');
  for (const key of Object.keys(active) as (keyof ComponentPaths)[])
    if (journal.rollback[key] !== `${active[key]}${suffix}`)
      throw new Error(`Unsafe reset journal rollback.${key}.`);
  const stagingSuffix = journal.staged.config.slice(active.config.length);
  if (
    !/^\.setup-[A-Za-z0-9-]+$/.test(stagingSuffix) ||
    journal.staged.database !== `${active.database}${stagingSuffix}` ||
    journal.staged.wal !== `${journal.staged.database}-wal` ||
    journal.staged.shm !== `${journal.staged.database}-shm` ||
    journal.staged.session !== `${active.session}${stagingSuffix}`
  )
    throw new Error('Unsafe reset journal staging paths.');
  if (
    dirname(journal.backupBundle) !== paths.backups ||
    basename(journal.backupBundle).startsWith('.')
  )
    throw new Error('Unsafe reset journal backup bundle path.');
}

function copyPrivateTree(source: string, destination: string, step: (name: string) => void): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Unsafe reset source: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(destination, { mode: 0o700 });
    chmodSync(destination, 0o700);
    for (const name of readdirSync(source))
      copyPrivateTree(join(source, name), join(destination, name), step);
    fsyncPath(destination, true);
    step(`fsync:${destination}`);
  } else if (stat.isFile()) {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    step(`write:${destination}`);
    chmodSync(destination, 0o600);
    fsyncPath(destination);
    step(`fsync:${destination}`);
  } else throw new Error(`Unsafe reset source: ${source}`);
}

/** Restores a validated backup after any interrupted reset-install phase. */
export function recoverInterruptedReset(options: ResetRecoveryOptions = {}): void {
  const paths = ensurePrivateLayout(options.paths);
  const configPath = resolve(options.configPath ?? resolveConfigPath());
  const step = options.afterStep ?? (() => {});
  const lock = acquireGatewayLock(paths);
  try {
    const journal = readResetJournal(paths.journal);
    if (!journal || journal.phase === 'complete')
      throw new Error('No incomplete reset journal exists.');
    validateRecoveryJournal(journal, paths, configPath);
    const bundle: ResetBackupBundle = {
      path: journal.backupBundle,
      manifest: JSON.parse(
        readFileSync(join(journal.backupBundle, 'manifest.json'), 'utf8'),
      ) as ResetBackupBundle['manifest'],
    };
    validateBundle(bundle);
    if (
      bundle.manifest.components.config.status !== 'included' ||
      bundle.manifest.components.session.status !== 'included' ||
      bundle.manifest.components.database.status !== 'included'
    )
      throw new Error('Reset backup bundle cannot restore complete active state.');
    const suffix = `.recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const staged = {
      config: `${configPath}${suffix}`,
      database: `${paths.db}${suffix}`,
      session: `${paths.session}${suffix}`,
    };
    for (const path of Object.values(staged)) absent(path);
    try {
      copyPrivateTree(join(bundle.path, 'config.env'), staged.config, step);
      copyPrivateTree(join(bundle.path, 'gateway.db'), staged.database, step);
      copyPrivateTree(join(bundle.path, 'session'), staged.session, step);
      validateConfig(staged.config);
      validateDatabase(staged.database);
      privateTree(staged.session);
      for (const path of Object.values(staged)) fsyncParent(path, step);
      for (const path of Object.values(journal.active)) removeIfPresent(path, step);
      for (const key of ['config', 'database', 'session'] as const)
        moveIfPresent(staged[key], journal.active[key], step);
      removeIfPresent(journal.active.wal, step);
      removeIfPresent(journal.active.shm, step);
      validateConfig(journal.active.config);
      validateBundledDatabase(journal.active.database, bundle.manifest.schemaVersion);
      // SQLite validation may create an empty SHM sidecar even for a
      // self-contained backup image; remove it only after closing SQLite.
      removeIfPresent(journal.active.wal, step);
      removeIfPresent(journal.active.shm, step);
      privateTree(journal.active.session);
      if (exists(journal.active.wal) || exists(journal.active.shm))
        throw new Error('Recovered database has unexpected WAL/SHM sidecars.');
      for (const path of [journal.active.config, journal.active.database, journal.active.session])
        fsyncParent(path, step);
      // Only a fully validated, durable restored active state permits disposal
      // of journal-owned secrets, partial fresh state, and rollback copies.
      for (const path of [...Object.values(journal.staged), ...Object.values(journal.rollback)])
        removeIfPresent(path, step);
      removeIfPresent(paths.journal, step);
    } finally {
      for (const path of Object.values(staged)) removeIfPresent(path, step);
    }
  } finally {
    lock.release();
  }
}

function rollbackReset(
  journal: ResetJournal,
  backup: ResetBackupBundle,
  step: (name: string) => void,
): void {
  // Restore each component according to observed journal-owned paths. Before
  // its active->rollback rename, an active component is still the old value
  // and must not be deleted merely because a preceding component failed.
  for (const key of ['config', 'session'] as const) {
    if (exists(journal.rollback[key])) {
      removeIfPresent(journal.active[key], step);
      moveIfPresent(journal.rollback[key], journal.active[key], step);
    } else if (!exists(journal.staged[key])) {
      // No rollback means the old component was absent; an absent staged path
      // means the fresh component was already published and must be removed.
      removeIfPresent(journal.active[key], step);
    }
  }
  const useBundleDatabase =
    exists(journal.rollback.wal) ||
    exists(journal.rollback.shm) ||
    (exists(journal.staged.database) && (exists(journal.active.wal) || exists(journal.active.shm)));
  if (useBundleDatabase) {
    // A main database paired with an old WAL is not a standalone image. The
    // pre-reset SQLite backup is the validated, WAL-inclusive rollback image.
    removeIfPresent(journal.active.database, step);
    validateBundle(backup);
    const staging = `${journal.active.database}.restore-${Date.now()}`;
    absent(staging);
    copyFileSync(join(backup.path, 'gateway.db'), staging, constants.COPYFILE_EXCL);
    step(`write:${staging}`);
    chmodSync(staging, 0o600);
    fsyncPath(staging);
    step(`fsync:${staging}`);
    moveIfPresent(staging, journal.active.database, step);
  } else if (exists(journal.rollback.database)) {
    removeIfPresent(journal.active.database, step);
    moveIfPresent(journal.rollback.database, journal.active.database, step);
  } else if (!exists(journal.staged.database)) {
    removeIfPresent(journal.active.database, step);
  }
  // A backup image is self-contained; old sidecars must never shadow it.
  removeIfPresent(journal.active.wal, step);
  removeIfPresent(journal.active.shm, step);
  validateConfig(journal.active.config);
  validateBundledDatabase(journal.active.database, backup.manifest.schemaVersion);
  // Validation of a WAL-mode image may create fresh empty sidecars. They are
  // not part of the restored snapshot and must not survive rollback.
  removeIfPresent(journal.active.wal, step);
  removeIfPresent(journal.active.shm, step);
  privateTree(journal.active.session);
  if (exists(journal.active.wal) || exists(journal.active.shm))
    throw new Error('Rolled-back database has unexpected WAL/SHM sidecars.');
}
