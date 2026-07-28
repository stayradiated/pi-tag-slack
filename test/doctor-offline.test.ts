import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/index.js';
import { createGatewayConfig, closeDb, initDb } from '../src/db.js';
import { offlineDoctor, onlineDoctor } from '../src/doctor.js';
import {
  acquireGatewayLock,
  ensurePrivateLayout,
  gatewayPaths,
  type GatewayPaths,
} from '../src/paths.js';

const directories: string[] = [];
let server: Server | undefined;
let oldDataDir: string | undefined;
let oldConfig: string | undefined;

function configuredFixture(): { paths: GatewayPaths; config: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-tag-slack-doctor-'));
  directories.push(root);
  const paths = gatewayPaths(root);
  ensurePrivateLayout(paths);
  const lock = acquireGatewayLock(paths);
  lock.release();
  initDb(paths.db);
  createGatewayConfig({
    channelId: 'C0123456789',
    channelLabel: 'test',
    workingDirectory: '/tmp',
    piBinary: 'pi',
    defaultModel: 'provider/model',
    defaultThinking: 'medium',
  });
  closeDb();
  const config = join(root, 'config.env');
  writeFileSync(config, 'SLACK_BOT_TOKEN="xoxb-test"\nSLACK_APP_TOKEN="xapp-test"\n', {
    mode: 0o600,
  });
  oldDataDir = process.env.PI_TAG_SLACK_DATA_DIR;
  oldConfig = process.env.PI_TAG_SLACK_CONFIG;
  process.env.PI_TAG_SLACK_DATA_DIR = root;
  process.env.PI_TAG_SLACK_CONFIG = config;
  return { paths, config };
}

function restoreEnvironment(): void {
  if (oldDataDir === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
  else process.env.PI_TAG_SLACK_DATA_DIR = oldDataDir;
  if (oldConfig === undefined) delete process.env.PI_TAG_SLACK_CONFIG;
  else process.env.PI_TAG_SLACK_CONFIG = oldConfig;
  oldDataDir = undefined;
  oldConfig = undefined;
}

afterEach(async () => {
  closeDb();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  restoreEnvironment();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('bounded doctor diagnostics', () => {
  it('marks degraded pi and control runtime state unhealthy', () => {
    configuredFixture();
    for (const health of [
      {
        database: 'ok',
        control: 'ok',
        session: { running: false, health: 'degraded', lastError: 'Pi RPC timed out.' },
      },
      {
        database: 'ok',
        control: 'degraded',
        lastError: 'Control server runtime error.',
        session: { running: true, health: 'healthy', lastError: null },
      },
    ]) {
      const result = onlineDoctor(health);
      expect(result.exitCode).toBe(1);
      expect(result.report).toMatchObject({ healthy: false, daemon: health });
      expect(result.report.findings).toContainEqual(
        expect.objectContaining({ code: 'DAEMON_UNHEALTHY' }),
      );
    }
  });

  it('uses daemon control health online and never parses SQLite', async () => {
    const { paths } = configuredFixture();
    // This is intentionally not SQLite. Healthy online doctor must trust only
    // the daemon control response for database/session health.
    writeFileSync(paths.db, 'not a sqlite database', { mode: 0o600 });
    server = createServer((socket) => {
      let request = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => (request += chunk));
      socket.on('end', () => {
        const id = (JSON.parse(request) as { id: string }).id;
        socket.end(
          `${JSON.stringify({
            version: 1,
            id,
            result: {
              database: 'ok',
              control: 'ok',
              session: { running: true, health: 'healthy', sessionId: 'session-test' },
            },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(paths.socket, () => resolve());
    });
    chmodSync(paths.socket, 0o600);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await main(['doctor'])).toBe(0);
    const report = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(report).toMatchObject({
      mode: 'online',
      healthy: true,
      database: 'ok',
      socket: 'ok',
      lock: 'held-by-daemon',
    });
  });

  it('inspects a healthy configured gateway without writes and preserves Linux timestamps', () => {
    const { paths, config } = configuredFixture();
    const files = [paths.db, paths.lock, config];
    const oldTime = new Date('2020-01-02T03:04:05.000Z');
    for (const path of files) utimesSync(path, oldTime, oldTime);
    const before = files.map((path) => ({
      path,
      bytes: readFileSync(path),
    }));
    // Reading the fixture above can update atime, so pin it once more before inspection.
    for (const path of files) utimesSync(path, oldTime, oldTime);
    const stats = files.map((path) => lstatSync(path));

    const result = offlineDoctor();

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      mode: 'offline',
      healthy: true,
      lock: 'acquired-read-only',
      database: {
        status: 'ok',
        quickCheck: 'ok',
        schemaVersion: 2,
        configuration: 'complete',
        wal: 'absent',
        shm: 'absent',
      },
      bootstrapConfig: { status: 'complete' },
      resetJournal: { status: 'absent' },
      socket: 'absent',
    });
    for (const diagnostic of result.report.paths as Array<Record<string, unknown>>) {
      for (const field of ['kind', 'mode', 'uid', 'owner', 'symlink'])
        expect(Object.hasOwn(diagnostic, field)).toBe(true);
      expect(diagnostic.owner).toEqual(expect.any(String));
    }
    files.forEach((path, index) => {
      const after = lstatSync(path);
      if (process.platform === 'linux') expect(after.atimeMs).toBe(stats[index].atimeMs);
      expect(after.mtimeMs).toBe(stats[index].mtimeMs);
      expect(after.ctimeMs).toBe(stats[index].ctimeMs);
      expect(readFileSync(path)).toEqual(before[index].bytes);
    });
    expect(() => lstatSync(`${paths.db}-wal`)).toThrow();
    expect(() => lstatSync(`${paths.db}-shm`)).toThrow();
  });

  it('reads latest WAL state without source writes and preserves Linux timestamps', () => {
    const { paths } = configuredFixture();
    // Establish an incomplete checkpointed main image.
    const database = initDb(paths.db);
    database.exec('delete from gateway_config');
    database.pragma('wal_checkpoint(TRUNCATE)');
    closeDb();

    // Commit the complete singleton only to WAL, then simulate a crash without
    // allowing SQLite's final-connection close checkpoint to run.
    const stamp = '2026-07-27T21:00:00.000Z';
    const script = `
      const Database = require('better-sqlite3');
      const db = new Database(${JSON.stringify(paths.db)});
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      db.prepare(\`insert into gateway_config
        (id,channel_id,channel_label,working_directory,pi_binary,default_model,default_thinking,
         archive_retention_days,media_retention_hours,max_attachment_bytes,max_total_attachment_bytes,
         scheduler_batch_limit,log_level,created_at,updated_at)
        values (1,'C0123456789','wal-latest','/tmp','pi','provider/wal-latest','medium',30,168,26214400,52428800,1,'info',?,?)\`).run(${JSON.stringify(stamp)}, ${JSON.stringify(stamp)});
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);
    const files = [paths.db, `${paths.db}-wal`, `${paths.db}-shm`];
    files.forEach((path) => expect(lstatSync(path).isFile()).toBe(true));
    const bytes = files.map((path) => readFileSync(path));
    const oldTime = new Date('2020-02-03T04:05:06.000Z');
    files.forEach((path) => utimesSync(path, oldTime, oldTime));
    const stats = files.map((path) => lstatSync(path));

    const result = offlineDoctor();

    expect(result.exitCode).toBe(0);
    expect(result.report.database).toMatchObject({
      status: 'ok',
      configuration: 'complete',
      wal: 'present',
      shm: 'present',
    });
    files.forEach((path, index) => {
      const after = lstatSync(path);
      if (process.platform === 'linux') expect(after.atimeMs).toBe(stats[index].atimeMs);
      expect(after.mtimeMs).toBe(stats[index].mtimeMs);
      expect(after.ctimeMs).toBe(stats[index].ctimeMs);
      expect(readFileSync(path)).toEqual(bytes[index]);
    });
  });

  it('reports an uninspectable WAL sidecar without falling back to the main image', () => {
    const { paths } = configuredFixture();
    const wal = Buffer.from('not a valid WAL');
    writeFileSync(`${paths.db}-wal`, wal, { mode: 0o600 });

    const result = offlineDoctor();

    expect(result.exitCode).toBe(1);
    expect(result.report.database).toMatchObject({ status: 'invalid', wal: 'present' });
    expect(result.report.findings).toContainEqual(
      expect.objectContaining({ code: 'DATABASE_INVALID', path: paths.db }),
    );
    expect(readFileSync(`${paths.db}-wal`)).toEqual(wal);
  });

  it('reports a corrupt database with sanitized output and does not repair it', () => {
    const { paths } = configuredFixture();
    const bytes = Buffer.from('corrupt database contents');
    writeFileSync(paths.db, bytes, { mode: 0o600 });

    const result = offlineDoctor();

    expect(result.exitCode).toBe(1);
    expect(result.report.database).toMatchObject({ status: 'invalid' });
    expect(result.report.findings).toContainEqual(
      expect.objectContaining({ code: 'DATABASE_INVALID', path: paths.db }),
    );
    expect(JSON.stringify(result.report)).not.toContain('database contents');
    expect(readFileSync(paths.db)).toEqual(bytes);
    expect(() => lstatSync(`${paths.db}-wal`)).toThrow();
    expect(() => lstatSync(`${paths.db}-shm`)).toThrow();
  });

  it('rejects incomplete database and malformed bootstrap configuration', () => {
    const { paths, config } = configuredFixture();
    unlinkSync(paths.db);
    initDb(paths.db); // schema v2, deliberately no gateway_config row
    closeDb();
    writeFileSync(config, 'SLACK_BOT_TOKEN="secret-without-prefix"\nEXTRA="value"\n', {
      mode: 0o600,
    });

    const result = offlineDoctor();

    expect(result.exitCode).toBe(1);
    expect(result.report.database).toMatchObject({ status: 'invalid' });
    expect(result.report.bootstrapConfig).toMatchObject({ status: 'invalid' });
    expect(result.report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DATABASE_INVALID' }),
        expect.objectContaining({ code: 'BOOTSTRAP_CONFIG_INVALID' }),
      ]),
    );
    expect(JSON.stringify(result.report)).not.toContain('secret-without-prefix');
  });

  it('reports missing and unsafe structural paths without chmod or repair', () => {
    const { paths } = configuredFixture();
    rmSync(paths.archive, { recursive: true });
    rmSync(paths.media, { recursive: true });
    symlinkSync(paths.backups, paths.media);
    chmodSync(paths.session, 0o755);

    const result = offlineDoctor();

    expect(result.exitCode).toBe(1);
    expect(result.report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PATH_MISSING', path: paths.archive }),
        expect.objectContaining({ code: 'UNSAFE_PATH', path: paths.media }),
        expect.objectContaining({ code: 'UNSAFE_PATH', path: paths.session }),
      ]),
    );
    expect(lstatSync(paths.media).isSymbolicLink()).toBe(true);
    expect(lstatSync(paths.session).mode & 0o777).toBe(0o755);
    expect(() => lstatSync(paths.archive)).toThrow();
  });

  it('does not bypass lock contention or inspect the database', () => {
    const { paths } = configuredFixture();
    const held = acquireGatewayLock(paths);
    try {
      const result = offlineDoctor();
      expect(result.exitCode).toBe(1);
      expect(result.report).toMatchObject({
        database: 'not-inspected',
        lock: 'contended',
      });
      expect(result.report.findings).toContainEqual(
        expect.objectContaining({ code: 'GATEWAY_LOCKED' }),
      );
    } finally {
      held.release();
    }
  });
});
