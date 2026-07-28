import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, createGatewayConfig, initDb } from '../src/db.js';
import { gatewayPaths } from '../src/paths.js';
import { createResetBackupBundle } from '../src/reset-backup.js';
import { installFreshReset, recoverInterruptedReset } from '../src/reset-install.js';
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

async function interruptedFixture() {
  const current = await fixture();
  const { paths, configPath, backup } = current;
  const suffix = '.setup-01234567-89ab-cdef';
  const rollback = '.rollback-01234567-89ab-cdef';
  writeFileSync(
    paths.journal,
    `${JSON.stringify({
      version: 1,
      phase: 'active-moved',
      backupBundle: backup.path,
      staged: {
        config: `${configPath}${suffix}`,
        database: `${paths.db}${suffix}`,
        wal: `${paths.db}${suffix}-wal`,
        shm: `${paths.db}${suffix}-shm`,
        session: `${paths.session}${suffix}`,
      },
      active: {
        config: configPath,
        database: paths.db,
        wal: `${paths.db}-wal`,
        shm: `${paths.db}-shm`,
        session: paths.session,
      },
      rollback: {
        config: `${configPath}${rollback}`,
        database: `${paths.db}${rollback}`,
        wal: `${paths.db}-wal${rollback}`,
        shm: `${paths.db}-shm${rollback}`,
        session: `${paths.session}${rollback}`,
      },
    })}\n`,
    { mode: 0o600 },
  );
  return current;
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

  // Rebuilds, fsyncs, and inspects a complete fixture at every install boundary.
  it('never leaves mixed active state after failure injection at every install boundary', async () => {
    const baseline = await fixture();
    const normalize = (step: string, root: string) =>
      step.replaceAll(root, '<root>').replace(/\.rollback-[A-Za-z0-9.-]+/g, '.rollback-ID');
    const steps: string[] = [];
    installFreshReset({
      ...baseline,
      afterStep: (step) => steps.push(normalize(step, baseline.paths.dataDir)),
    });
    expect(steps.some((step) => step.startsWith('write:'))).toBe(true);
    expect(steps.some((step) => step.startsWith('fsync:'))).toBe(true);
    expect(steps.some((step) => step.startsWith('rename:'))).toBe(true);
    for (const boundary of [...new Set(steps)]) {
      const current = await fixture();
      let injected = false;
      expect(() =>
        installFreshReset({
          ...current,
          afterStep: (step) => {
            if (!injected && normalize(step, current.paths.dataDir) === boundary) {
              injected = true;
              throw new Error('boundary failure');
            }
          },
        }),
      ).toThrow('boundary failure');
      expect(injected).toBe(true);
      const configValue = readFileSync(current.configPath, 'utf8');
      const old = configValue.includes('xoxb-old');
      const fresh = configValue.includes('xoxb-fresh');
      expect(old || fresh).toBe(true);
      expect(
        existsSync(join(current.paths.session, old ? 'old.json' : 'fresh.json')),
        boundary,
      ).toBe(true);
      const db = new Database(current.paths.db, { readonly: true });
      expect(db.prepare('select channel_label from gateway_config').get()).toEqual({
        channel_label: old ? 'old' : 'fresh',
      });
      expect(db.pragma('quick_check', { simple: true })).toBe('ok');
      db.close();
      if (existsSync(current.paths.journal)) {
        const journal = JSON.parse(readFileSync(current.paths.journal, 'utf8')) as {
          phase: string;
        };
        expect(['prepared', 'active-moved', 'fresh-installed', 'complete']).toContain(
          journal.phase,
        );
      }
    }
  }, 45_000);

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

  it.each(['prepared', 'active-moved', 'fresh-installed'] as const)(
    'restores the durable bundle from a %s journal and removes sidecars',
    async (phase) => {
      const { paths, configPath, backup } = await fixture();
      const suffix = '.setup-01234567-89ab-cdef';
      const rollback = '.rollback-01234567-89ab-cdef';
      writeFileSync(configPath, 'partial fresh state', { mode: 0o600 });
      writeFileSync(`${paths.db}-wal`, 'stale', { mode: 0o600 });
      writeFileSync(`${paths.db}-shm`, 'stale', { mode: 0o600 });
      rmSync(paths.session, { recursive: true });
      // Representative abandoned fresh and rollback artifacts contain every
      // component type, including sidecars and private session state.
      for (const path of [
        `${configPath}${suffix}`,
        `${paths.db}${suffix}`,
        `${paths.db}${suffix}-wal`,
        `${paths.db}${suffix}-shm`,
        `${configPath}${rollback}`,
        `${paths.db}${rollback}`,
        `${paths.db}-wal${rollback}`,
        `${paths.db}-shm${rollback}`,
      ])
        writeFileSync(path, 'abandoned', { mode: 0o600 });
      for (const path of [`${paths.session}${suffix}`, `${paths.session}${rollback}`]) {
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, 'secret.json'), 'abandoned', { mode: 0o600 });
      }
      writeFileSync(
        paths.journal,
        `${JSON.stringify({
          version: 1,
          phase,
          backupBundle: backup.path,
          staged: {
            config: `${configPath}${suffix}`,
            database: `${paths.db}${suffix}`,
            wal: `${paths.db}${suffix}-wal`,
            shm: `${paths.db}${suffix}-shm`,
            session: `${paths.session}${suffix}`,
          },
          active: {
            config: configPath,
            database: paths.db,
            wal: `${paths.db}-wal`,
            shm: `${paths.db}-shm`,
            session: paths.session,
          },
          rollback: {
            config: `${configPath}${rollback}`,
            database: `${paths.db}${rollback}`,
            wal: `${paths.db}-wal${rollback}`,
            shm: `${paths.db}-shm${rollback}`,
            session: `${paths.session}${rollback}`,
          },
        })}\n`,
        { mode: 0o600 },
      );
      recoverInterruptedReset({ paths, configPath });
      expect(readFileSync(configPath, 'utf8')).toContain('xoxb-old');
      expect(readFileSync(join(paths.session, 'old.json'), 'utf8')).toBe('old');
      expect(existsSync(`${paths.db}-wal`)).toBe(false);
      expect(existsSync(`${paths.db}-shm`)).toBe(false);
      expect(existsSync(paths.journal)).toBe(false);
      for (const path of [
        `${configPath}${suffix}`,
        `${paths.db}${suffix}`,
        `${paths.db}${suffix}-wal`,
        `${paths.db}${suffix}-shm`,
        `${paths.session}${suffix}`,
        `${configPath}${rollback}`,
        `${paths.db}${rollback}`,
        `${paths.db}-wal${rollback}`,
        `${paths.db}-shm${rollback}`,
        `${paths.session}${rollback}`,
      ])
        expect(existsSync(path)).toBe(false);
      expect(existsSync(backup.path)).toBe(true);
    },
  );

  it('retains the journal after an injected recovery interruption and succeeds on retry', async () => {
    const { paths, configPath, backup } = await fixture();
    const suffix = '.setup-01234567-89ab-cdef';
    const rollback = '.rollback-01234567-89ab-cdef';
    writeFileSync(
      paths.journal,
      `${JSON.stringify({
        version: 1,
        phase: 'active-moved',
        backupBundle: backup.path,
        staged: {
          config: `${configPath}${suffix}`,
          database: `${paths.db}${suffix}`,
          wal: `${paths.db}${suffix}-wal`,
          shm: `${paths.db}${suffix}-shm`,
          session: `${paths.session}${suffix}`,
        },
        active: {
          config: configPath,
          database: paths.db,
          wal: `${paths.db}-wal`,
          shm: `${paths.db}-shm`,
          session: paths.session,
        },
        rollback: {
          config: `${configPath}${rollback}`,
          database: `${paths.db}${rollback}`,
          wal: `${paths.db}-wal${rollback}`,
          shm: `${paths.db}-shm${rollback}`,
          session: `${paths.session}${rollback}`,
        },
      })}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      recoverInterruptedReset({
        paths,
        configPath,
        afterStep: (step) => {
          if (step === `remove:${configPath}`) throw new Error('interrupted');
        },
      }),
    ).toThrow('interrupted');
    expect(existsSync(paths.journal)).toBe(true);
    recoverInterruptedReset({ paths, configPath });
    expect(readFileSync(configPath, 'utf8')).toContain('xoxb-old');
    expect(existsSync(paths.journal)).toBe(false);
  });

  // Rebuilds and recovers a complete fixture at every discovered durability boundary.
  it('restores a validated bundle after failure at every recovery boundary', async () => {
    const baseline = await interruptedFixture();
    const normalize = (step: string, root: string) =>
      step.replaceAll(root, '<root>').replace(/\.recovery-[A-Za-z0-9.-]+/g, '.recovery-ID');
    const steps: string[] = [];
    recoverInterruptedReset({
      paths: baseline.paths,
      configPath: baseline.configPath,
      afterStep: (step) => steps.push(normalize(step, baseline.paths.dataDir)),
    });
    expect(steps.some((step) => step.startsWith('write:'))).toBe(true);
    expect(steps.some((step) => step.startsWith('fsync:'))).toBe(true);
    expect(steps.some((step) => step.startsWith('rename:'))).toBe(true);
    for (const boundary of [...new Set(steps)]) {
      const current = await interruptedFixture();
      let injected = false;
      expect(() =>
        recoverInterruptedReset({
          paths: current.paths,
          configPath: current.configPath,
          afterStep: (step) => {
            if (!injected && normalize(step, current.paths.dataDir) === boundary) {
              injected = true;
              throw new Error('recovery boundary failure');
            }
          },
        }),
      ).toThrow('recovery boundary failure');
      expect(injected).toBe(true);
      if (existsSync(current.paths.journal))
        recoverInterruptedReset({ paths: current.paths, configPath: current.configPath });
      expect(readFileSync(current.configPath, 'utf8')).toContain('xoxb-old');
      expect(readFileSync(join(current.paths.session, 'old.json'), 'utf8')).toBe('old');
      expect(existsSync(`${current.paths.db}-wal`)).toBe(false);
      expect(existsSync(`${current.paths.db}-shm`)).toBe(false);
    }
  }, 45_000);

  it('rejects an unsafe journal without changing active state', async () => {
    const { paths, configPath, backup } = await fixture();
    const original = readFileSync(configPath, 'utf8');
    writeFileSync(
      paths.journal,
      `${JSON.stringify({ version: 1, phase: 'prepared', backupBundle: backup.path, staged: {}, active: {}, rollback: {} })}\n`,
      { mode: 0o600 },
    );
    expect(() => recoverInterruptedReset({ paths, configPath })).toThrow(/Invalid reset journal/);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(existsSync(paths.journal)).toBe(true);
  });

  it.each([
    ['neither', false, false],
    ['WAL only', true, false],
    ['SHM only', false, true],
    ['WAL and SHM', true, true],
  ])('restores from the bundle after rollback with %s sidecars', async (_name, wal, shm) => {
    const { paths, configPath, backup, staged } = await fixture();
    if (wal) writeFileSync(`${paths.db}-wal`, 'incomplete wal', { mode: 0o600 });
    if (shm) writeFileSync(`${paths.db}-shm`, 'incomplete shm', { mode: 0o600 });
    await expect(async () =>
      installFreshReset({
        paths,
        configPath,
        backup,
        staged,
        afterStep: (step) => {
          if (step === `rename:${staged.database}:${paths.db}`) throw new Error('injected');
        },
      }),
    ).rejects.toThrow('injected');
    expect(readFileSync(configPath, 'utf8')).toContain('xoxb-old');
    expect(readFileSync(join(paths.session, 'old.json'), 'utf8')).toBe('old');
    expect(existsSync(`${paths.db}-wal`)).toBe(false);
    expect(existsSync(`${paths.db}-shm`)).toBe(false);
  });

  it.each(['gateway.db', 'config.env', 'session/old.json', 'manifest.json'])(
    'detects backup tampering in %s before changing active state',
    async (component) => {
      const { paths, configPath, backup, staged } = await fixture();
      writeFileSync(join(backup.path, component), 'tampered', { mode: 0o600 });
      expect(() => installFreshReset({ paths, configPath, backup, staged })).toThrow();
      expect(readFileSync(configPath, 'utf8')).toContain('xoxb-old');
      expect(readFileSync(join(paths.session, 'old.json'), 'utf8')).toBe('old');
      expect(existsSync(paths.journal)).toBe(false);
    },
  );

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
