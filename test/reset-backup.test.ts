import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, createGatewayConfig, initDb } from '../src/db.js';
import { gatewayPaths } from '../src/paths.js';
import { createResetBackupBundle, type ResetBackupManifest } from '../src/reset-backup.js';

const directories: string[] = [];
afterEach(() => {
  closeDb();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-tag-slack-backup-'));
  directories.push(root);
  const paths = gatewayPaths(root);
  const configPath = join(root, 'config.env');
  initDb(paths.db);
  createGatewayConfig({
    channelId: 'C0123456789',
    channelLabel: 'eng',
    workingDirectory: '/tmp',
    piBinary: 'pi',
    defaultModel: 'provider/model',
    defaultThinking: 'medium',
  });
  closeDb();
  writeFileSync(configPath, 'SLACK_BOT_TOKEN="xoxb-token"\nSLACK_APP_TOKEN="xapp-token"\n', {
    mode: 0o600,
  });
  mkdirSync(paths.session, { recursive: true, mode: 0o700 });
  writeFileSync(join(paths.session, 'state.json'), '{"session":true}\n', { mode: 0o600 });
  return { root, paths, configPath };
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('reset backup bundle', () => {
  it('backs up WAL-committed state, config, and session with manifest hashes', async () => {
    const { paths, configPath } = fixture();
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const Database=require('better-sqlite3');
         const db=new Database(${JSON.stringify(paths.db)});
         db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0');
         db.exec("insert into trusted_users values ('U0123456789', 'Ada', '2030-01-01T00:00:00.000Z')");
         console.log('ready'); setInterval(() => {}, 1000);`,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', () => resolve());
    });
    expect(existsSync(`${paths.db}-wal`)).toBe(true);
    const mainSnapshot = `${paths.db}.main-only`;
    copyFileSync(paths.db, mainSnapshot);
    const mainOnly = new Database(mainSnapshot, { readonly: true });
    expect(
      mainOnly.prepare('select label from trusted_users where user_id=?').get('U0123456789'),
    ).toBeUndefined();
    mainOnly.close();

    const bundle = await createResetBackupBundle({ paths, configPath });
    child.kill();
    const backup = new Database(join(bundle.path, 'gateway.db'), { readonly: true });
    expect(
      backup.prepare('select label from trusted_users where user_id=?').get('U0123456789'),
    ).toEqual({ label: 'Ada' });
    expect(backup.pragma('quick_check', { simple: true })).toBe('ok');
    backup.close();
    const manifest = JSON.parse(
      readFileSync(join(bundle.path, 'manifest.json'), 'utf8'),
    ) as ResetBackupManifest;
    expect(manifest.components.database).toMatchObject({
      status: 'included',
      sha256: hash(join(bundle.path, 'gateway.db')),
    });
    expect(manifest.components.config).toMatchObject({
      status: 'included',
      sha256: hash(join(bundle.path, 'config.env')),
    });
    expect(manifest.components.session).toMatchObject({ status: 'included' });
    expect(readFileSync(join(bundle.path, 'session/state.json'), 'utf8')).toBe(
      '{"session":true}\n',
    );
    for (const path of [
      bundle.path,
      join(bundle.path, 'gateway.db'),
      join(bundle.path, 'config.env'),
      join(bundle.path, 'session/state.json'),
    ])
      expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('backs up readable legacy SQLite and records missing optional components', async () => {
    const { paths, configPath } = fixture();
    closeDb();
    const legacy = new Database(paths.db);
    legacy.exec(
      'drop table gateway_config; create table old_state (id integer); pragma user_version = 1;',
    );
    legacy.close();
    rmSync(configPath);
    rmSync(paths.session, { recursive: true });
    const bundle = await createResetBackupBundle({ paths, configPath });
    expect(bundle.manifest.schemaVersion).toBe(1);
    expect(bundle.manifest.components.config).toEqual({ status: 'missing' });
    expect(bundle.manifest.components.session).toEqual({ status: 'missing' });
  });

  it('cleans or leaves a complete validated bundle after every injected boundary failure', async () => {
    const baseline = fixture();
    const normalize = (step: string, root: string) =>
      step
        .replaceAll(root, '<root>')
        .replace(/\.staging-[^/:]+/g, '.staging-ID')
        .replace(/reset-\d{4}-[^/:]+-\d+/g, 'reset-ID');
    const steps: string[] = [];
    await createResetBackupBundle({
      paths: baseline.paths,
      configPath: baseline.configPath,
      afterStep: (step) => steps.push(normalize(step, baseline.root)),
    });
    expect(steps.some((step) => step.startsWith('write:'))).toBe(true);
    expect(steps.some((step) => step.startsWith('fsync:'))).toBe(true);
    expect(steps.some((step) => step.startsWith('rename:'))).toBe(true);
    for (const boundary of [...new Set(steps)]) {
      const { paths, configPath } = fixture();
      let injected = false;
      await expect(
        createResetBackupBundle({
          paths,
          configPath,
          afterStep: (step) => {
            if (!injected && normalize(step, paths.dataDir) === boundary) {
              injected = true;
              throw new Error('injected boundary failure');
            }
          },
        }),
      ).rejects.toThrow('injected boundary failure');
      expect(injected).toBe(true);
      for (const name of existsSync(paths.backups) ? readdirSync(paths.backups) : []) {
        expect(name.startsWith('.')).toBe(false);
        const bundle = join(paths.backups, name);
        expect(JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'))).toMatchObject({
          phase: 'validated',
        });
      }
    }
  });

  it('chooses collision-free names and preserves prior bundles on failure', async () => {
    const { paths, configPath } = fixture();
    const now = () => new Date('2030-01-01T00:00:00.000Z');
    const first = await createResetBackupBundle({ paths, configPath, now });
    const firstManifest = readFileSync(join(first.path, 'manifest.json'));
    const second = await createResetBackupBundle({ paths, configPath, now });
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(join(first.path, 'manifest.json'))).toEqual(firstManifest);
    writeFileSync(paths.db, 'not sqlite');
    await expect(createResetBackupBundle({ paths, configPath })).rejects.toThrow();
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });
});
