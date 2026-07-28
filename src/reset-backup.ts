import { createHash, randomUUID } from 'node:crypto';
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
import { basename, join } from 'node:path';
import { resolveConfigPath, validateBootstrapConfigPath } from './config.js';
import {
  acquireGatewayLock,
  ensurePrivateFile,
  gatewayPaths,
  structuralPathExists,
  type GatewayPaths,
} from './paths.js';

const BUNDLE_VERSION = 1;
type Component =
  { status: 'included'; path: string; size: number; sha256: string } | { status: 'missing' };
export type ResetBackupManifest = {
  version: number;
  phase: 'validated';
  createdAt: string;
  sourcePaths: { database: string; config: string; session: string };
  schemaVersion: number | null;
  components: { database: Component; config: Component; session: Component };
};
export type ResetBackupBundle = { path: string; manifest: ResetBackupManifest };

function uid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory: ${path}`);
  if (uid() !== undefined && stat.uid !== uid()) throw new Error(`Foreign-owned path: ${path}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Directory is not private: ${path}`);
}

function sourceTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink source path: ${path}`);
  if (uid() !== undefined && stat.uid !== uid())
    throw new Error(`Foreign-owned source path: ${path}`);
  // The private session root protects ordinary pi-created files, which may be
  // 0644. Every copied descendant is tightened to 0600/0700 below.
  if (stat.isDirectory()) for (const name of readdirSync(path)) sourceTree(join(path, name));
  else if (!stat.isFile()) throw new Error(`Unsupported source path type: ${path}`);
}

function fsyncFile(path: string, step: (name: string) => void): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  step(`fsync:${path}`);
}

function fsyncDirectory(path: string, step: (name: string) => void): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  step(`fsync:${path}`);
}

function privateMkdir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  privateDirectory(path);
}

function copyTree(source: string, destination: string, step: (name: string) => void): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink source path: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(destination, { mode: 0o700 });
    chmodSync(destination, 0o700);
    for (const name of readdirSync(source))
      copyTree(join(source, name), join(destination, name), step);
    fsyncDirectory(destination, step);
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported source path type: ${source}`);
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  step(`write:${destination}`);
  chmodSync(destination, 0o600);
  fsyncFile(destination, step);
}

function digest(path: string): { size: number; sha256: string } {
  const content = readFileSync(path);
  return { size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}

function treeDigest(path: string): { size: number; sha256: string } {
  const hash = createHash('sha256');
  let size = 0;
  const visit = (current: string, relative: string) => {
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

function validateBootstrap(path: string): void {
  validateBootstrapConfigPath(path);
  const values = parse(readFileSync(path, 'utf8'));
  if (!values.SLACK_BOT_TOKEN?.startsWith('xoxb-') || !values.SLACK_APP_TOKEN?.startsWith('xapp-'))
    throw new Error('Bundled bootstrap config has invalid Slack tokens.');
}

function validateBackupDatabase(path: string): number {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = database.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') throw new Error(`Bundled database quick_check failed: ${quickCheck}`);
    return Number(database.pragma('user_version', { simple: true }));
  } finally {
    database.close();
  }
}

function component(path: string, present: boolean, tree = false): Component {
  if (!present) return { status: 'missing' };
  return { status: 'included', path: basename(path), ...(tree ? treeDigest(path) : digest(path)) };
}

function bundleStem(now: Date): string {
  return `reset-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Creates a durable, validated pre-reset bundle. It deliberately does not
 * rename or otherwise alter active application state.
 */
export async function createResetBackupBundle(
  options: {
    paths?: GatewayPaths;
    configPath?: string;
    now?: () => Date;
    /** Caller already holds the gateway lock. */
    lockHeld?: boolean;
    /** Test-only failure seam at each source mutation/publication/write/fsync boundary. */
    afterStep?: (step: string) => void;
  } = {},
): Promise<ResetBackupBundle> {
  const paths = options.paths ?? gatewayPaths();
  const configPath = options.configPath ?? resolveConfigPath();
  // A reset caller must share this lock with the daemon; acquiring it here
  // keeps this primitive safe and makes it independently reusable.
  const lock = options.lockHeld ? undefined : acquireGatewayLock(paths, { createLayout: false });
  const step = options.afterStep ?? (() => {});
  let staging: string | undefined;
  try {
    privateMkdir(paths.backups);
    ensurePrivateFile(paths.db);
    if (!structuralPathExists(paths.db))
      throw new Error(`No active gateway database exists: ${paths.db}`);
    const dbStat = lstatSync(paths.db);
    if (dbStat.isSymbolicLink() || !dbStat.isFile())
      throw new Error(`Unsafe database path: ${paths.db}`);
    const sessionPresent = structuralPathExists(paths.session);
    if (sessionPresent) {
      privateDirectory(paths.sessions);
      privateDirectory(paths.session);
      sourceTree(paths.session);
    }
    const configPresent = structuralPathExists(configPath);
    if (configPresent) validateBootstrapConfigPath(configPath);

    const stem = bundleStem((options.now ?? (() => new Date()))());
    let counter = 0;
    let finalPath: string;
    do {
      finalPath = join(paths.backups, `${stem}-${counter++}`);
    } while (structuralPathExists(finalPath));
    staging = join(paths.backups, `.${basename(finalPath)}.staging-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    chmodSync(staging, 0o700);

    // `backup` reads SQLite's live view; checkpointing first reduces WAL state
    // but failure to checkpoint due to readers must not make us copy a stale DB.
    const source = new Database(paths.db, { fileMustExist: true });
    let schemaVersion: number;
    try {
      source.pragma('wal_checkpoint(TRUNCATE)');
      step(`checkpoint:${paths.db}`);
      schemaVersion = Number(source.pragma('user_version', { simple: true }));
      await source.backup(join(staging, 'gateway.db'));
      step(`write:${join(staging, 'gateway.db')}`);
    } finally {
      source.close();
    }
    chmodSync(join(staging, 'gateway.db'), 0o600);
    fsyncFile(join(staging, 'gateway.db'), step);
    const bundledSchemaVersion = validateBackupDatabase(join(staging, 'gateway.db'));
    if (bundledSchemaVersion !== schemaVersion)
      throw new Error('Bundled database schema version changed during backup.');

    if (configPresent) {
      copyTree(configPath, join(staging, 'config.env'), step);
      validateBootstrap(join(staging, 'config.env'));
    }
    if (sessionPresent) {
      copyTree(paths.session, join(staging, 'session'), step);
      privateDirectory(join(staging, 'session'));
      sourceTree(join(staging, 'session'));
    }
    const manifest: ResetBackupManifest = {
      version: BUNDLE_VERSION,
      phase: 'validated',
      createdAt: new Date().toISOString(),
      sourcePaths: { database: paths.db, config: configPath, session: paths.session },
      schemaVersion,
      components: {
        database: component(join(staging, 'gateway.db'), true),
        config: component(join(staging, 'config.env'), configPresent),
        session: component(join(staging, 'session'), sessionPresent, true),
      },
    };
    const manifestPath = join(staging, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    step(`write:${manifestPath}`);
    chmodSync(manifestPath, 0o600);
    fsyncFile(manifestPath, step);
    fsyncDirectory(staging, step);
    if (structuralPathExists(finalPath))
      throw new Error(`Backup bundle destination already exists: ${finalPath}`);
    renameSync(staging, finalPath);
    step(`rename:${staging}:${finalPath}`);
    fsyncDirectory(paths.backups, step);
    staging = undefined;
    return { path: finalPath, manifest };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    lock?.release();
  }
}
