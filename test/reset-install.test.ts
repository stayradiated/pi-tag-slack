import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, createGatewayConfig, initDb } from '../src/db.js';
import { gatewayPaths } from '../src/paths.js';
import { createResetBackupBundle } from '../src/reset-backup.js';
import { installFreshReset } from '../src/reset-install.js';
import { startGateway } from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  closeDb();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(path: string, token: string): void {
  writeFileSync(path, `SLACK_BOT_TOKEN="xoxb-${token}"\nSLACK_APP_TOKEN="xapp-${token}"\n`, {
    mode: 0o600,
  });
}
function database(path: string, label: string): void {
  initDb(path);
  createGatewayConfig({
    channelId: 'C0123456789',
    channelLabel: label,
    workingDirectory: '/tmp',
    piBinary: 'pi',
    defaultModel: 'provider/model',
    defaultThinking: 'medium',
  });
  closeDb();
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-tag-slack-reset-install-'));
  roots.push(root);
  const paths = gatewayPaths(root);
  const configPath = join(root, 'config.env');
  database(paths.db, 'old');
  config(configPath, 'old');
  mkdirSync(paths.session, { recursive: true, mode: 0o700 });
  writeFileSync(join(paths.session, 'old.json'), 'old', { mode: 0o600 });
  const backup = await createResetBackupBundle({ paths, configPath });
  const staged = {
    config: `${configPath}.fresh`,
    database: `${paths.db}.fresh`,
    session: `${paths.session}.fresh`,
  };
  database(staged.database, 'fresh');
  config(staged.config, 'fresh');
  mkdirSync(staged.session, { mode: 0o700 });
  writeFileSync(join(staged.session, 'fresh.json'), 'fresh', { mode: 0o600 });
  return { paths, configPath, backup, staged };
}

describe('journaled fresh reset installation', () => {
  it('publishes validated fresh state, then removes rollback state and journal last', async () => {
    const { paths, configPath, backup, staged } = await fixture();
    installFreshReset({ paths, configPath, backup, staged });
    expect(readFileSync(configPath, 'utf8')).toContain('xoxb-fresh');
    expect(existsSync(paths.journal)).toBe(false);
    expect(existsSync(backup.path)).toBe(true);
    expect(existsSync(`${paths.db}-wal`)).toBe(false);
    expect(existsSync(`${paths.db}-shm`)).toBe(false);
    expect(readFileSync(join(paths.session, 'fresh.json'), 'utf8')).toBe('fresh');
  });

  it('refuses daemon startup while a journal is incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-tag-slack-reset-refusal-'));
    roots.push(root);
    const paths = gatewayPaths(root);
    const journal = {
      version: 1,
      phase: 'active-moved',
      backupBundle: join(root, 'backups', 'reset'),
      staged: {
        config: '/tmp/fresh-config',
        database: '/tmp/fresh-db',
        wal: '/tmp/fresh-db-wal',
        shm: '/tmp/fresh-db-shm',
        session: '/tmp/fresh-session',
      },
      active: {
        config: '/tmp/config',
        database: '/tmp/db',
        wal: '/tmp/db-wal',
        shm: '/tmp/db-shm',
        session: '/tmp/session',
      },
      rollback: {
        config: '/tmp/config-old',
        database: '/tmp/db-old',
        wal: '/tmp/db-wal-old',
        shm: '/tmp/db-shm-old',
        session: '/tmp/session-old',
      },
    };
    writeFileSync(paths.journal, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    const previous = process.env.PI_TAG_SLACK_DATA_DIR;
    process.env.PI_TAG_SLACK_DATA_DIR = root;
    try {
      await expect(startGateway()).rejects.toThrow(
        /incomplete reset journal.*plain pi-tag-slack setup/i,
      );
    } finally {
      if (previous === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
      else process.env.PI_TAG_SLACK_DATA_DIR = previous;
    }
  });

  it('rolls back when installed-state validation fails', async () => {
    const { paths, configPath, backup, staged } = await fixture();
    await expect(async () =>
      installFreshReset({
        paths,
        configPath,
        backup,
        staged,
        afterStep: (step) => {
          if (step === `rename:${staged.session}:${paths.session}`)
            writeFileSync(configPath, 'not a bootstrap config\n', { mode: 0o600 });
        },
      }),
    ).rejects.toThrow(/Invalid bootstrap config/);
    expect(readFileSync(configPath, 'utf8')).toContain('xoxb-old');
    expect(readFileSync(join(paths.session, 'old.json'), 'utf8')).toBe('old');
  });

  it('retains the incomplete journal when rollback itself fails', async () => {
    const { paths, configPath, backup, staged } = await fixture();
    let injected = false;
    await expect(async () =>
      installFreshReset({
        paths,
        configPath,
        backup,
        staged,
        afterStep: (step) => {
          if (!injected && step.includes(`:${staged.database}:`)) {
            injected = true;
            throw new Error('install failure');
          }
          if (injected && step === `remove:${configPath}`) throw new Error('rollback failure');
        },
      }),
    ).rejects.toThrow('install failure');
    expect(existsSync(paths.journal)).toBe(true);
  });

  it('rolls back on a destructive-boundary failure without overwriting the backup', async () => {
    const { paths, configPath, backup, staged } = await fixture();
    const manifest = readFileSync(join(backup.path, 'manifest.json'));
    await expect(async () =>
      installFreshReset({
        paths,
        configPath,
        backup,
        staged,
        afterStep: (step) => {
          if (step.includes(`:${staged.database}:`)) throw new Error('injected');
        },
      }),
    ).rejects.toThrow('injected');
    expect(readFileSync(configPath, 'utf8')).toContain('xoxb-old');
    expect(readFileSync(join(paths.session, 'old.json'), 'utf8')).toBe('old');
    expect(readFileSync(join(backup.path, 'manifest.json'))).toEqual(manifest);
    expect(existsSync(paths.journal)).toBe(false);
  });
});
