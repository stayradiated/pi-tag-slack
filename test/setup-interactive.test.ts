import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setup, type SetupDependencies } from '../src/cli/index.js';
import { createResetBackupBundle } from '../src/reset-backup.js';
import type { SetupValidationDependencies } from '../src/setup-validation.js';
import { gatewayPaths } from '../src/paths.js';
import type { SetupPrompts } from '../src/setup-interactive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const validation: SetupValidationDependencies = {
  validatePi: async () => {},
  createBotClient: () => ({
    auth: { test: async () => ({ ok: true, user_id: 'UBOT' }) },
    conversations: {
      info: async () => ({ ok: true, channel: { is_channel: true, is_member: true, name: 'ops' } }),
    },
    users: {
      info: async () => ({
        ok: true,
        user: { id: 'U0123456789', profile: { display_name: 'Ada' } },
      }),
    },
  }),
  createAppClient: () => ({ apps: { connections: { open: async () => ({ ok: true }) } } }),
};

function prompts(values: unknown[] = []): SetupPrompts {
  const next = () => Promise.resolve((values.shift() ?? '') as string | symbol);
  return {
    text: next,
    password: next,
    select: next,
    confirm: next as () => Promise<boolean | symbol>,
    isCancel: (value) => typeof value === 'symbol',
    message: () => {},
  };
}

function dependencies(
  interactive: boolean,
  values: unknown[] = [],
  calls: string[] = [],
  afterStep?: (step: string) => void,
): SetupDependencies {
  return {
    isInteractive: () => interactive,
    prompts: prompts(values),
    installAndStartDaemon: () => {
      calls.push('install');
      calls.push('start');
    },
    ...(afterStep ? { afterStep } : {}),
  };
}

function argumentsFor(extra: string[] = []): string[] {
  return [
    '--channel',
    'C0123456789',
    '--cwd',
    '/tmp',
    '--model',
    'provider/model',
    '--bot-token',
    'xoxb-token',
    '--app-token',
    'xapp-token',
    '--trusted-user',
    'U0123456789',
    ...extra,
  ];
}

async function inRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'pi-tag-slack-interactive-'));
  roots.push(root);
  const oldData = process.env.PI_TAG_SLACK_DATA_DIR;
  const oldConfig = process.env.PI_TAG_SLACK_CONFIG;
  process.env.PI_TAG_SLACK_DATA_DIR = root;
  process.env.PI_TAG_SLACK_CONFIG = join(root, 'config.env');
  try {
    return await fn(root);
  } finally {
    if (oldData === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
    else process.env.PI_TAG_SLACK_DATA_DIR = oldData;
    if (oldConfig === undefined) delete process.env.PI_TAG_SLACK_CONFIG;
    else process.env.PI_TAG_SLACK_CONFIG = oldConfig;
  }
}

describe.sequential('interactive setup consent and daemon lifecycle', () => {
  it('does not create state on interactive EOF/cancellation', async () =>
    inRoot(async (root) => {
      const eof = Symbol('eof');
      await expect(setup([], validation, dependencies(true, [eof]))).resolves.toBe(1);
      expect(existsSync(join(root, 'gateway.db'))).toBe(false);
      expect(existsSync(join(root, 'config.env'))).toBe(false);
    }));

  it('rejects a reset confirmation other than exactly RESET', async () =>
    inRoot(async (root) => {
      await setup(argumentsFor(), validation, dependencies(false));
      const calls: string[] = [];
      await expect(
        setup(argumentsFor(['--reset']), validation, dependencies(true, ['reset'], calls)),
      ).resolves.toBe(1);
      expect(existsSync(join(root, 'gateway.db'))).toBe(true);
      expect(calls).toEqual([]);
    }));

  it('never starts the daemon, reports success, or leaves first-install artifacts after failure', async () =>
    inRoot(async (root) => {
      const calls: string[] = [];
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      await expect(
        setup(
          argumentsFor(),
          validation,
          dependencies(true, [], calls, (step) => {
            if (step.startsWith('rename:') && step.endsWith(`:${join(root, 'config.env')}`))
              throw new Error('install boundary failed');
          }),
        ),
      ).rejects.toThrow('install boundary failed');
      expect(calls).toEqual([]);
      expect(output).not.toHaveBeenCalledWith(expect.stringMatching(/Setup complete/i));
      expect(existsSync(join(root, 'config.env'))).toBe(false);
      expect(existsSync(join(root, 'gateway.db'))).toBe(false);
      output.mockRestore();
    }));

  it('installs then starts the service only after a confirmed reset succeeds', async () =>
    inRoot(async () => {
      await setup(argumentsFor(), validation, dependencies(false));
      const calls: string[] = [];
      await expect(
        setup(argumentsFor(['--reset']), validation, dependencies(true, ['RESET'], calls)),
      ).resolves.toBe(0);
      expect(calls).toEqual(['install', 'start']);
    }));

  it('requires affirmative interactive recovery confirmation before restoration', async () =>
    inRoot(async (root) => {
      await setup(argumentsFor(), validation, dependencies(false));
      const paths = gatewayPaths(root);
      mkdirSync(paths.session, { recursive: true, mode: 0o700 });
      writeFileSync(join(paths.session, 'session.json'), '{}', { mode: 0o600 });
      const backup = await createResetBackupBundle({ paths, configPath: join(root, 'config.env') });
      const suffix = '.setup-01234567-89ab-cdef';
      const rollback = '.rollback-01234567-89ab-cdef';
      writeFileSync(
        paths.journal,
        `${JSON.stringify({
          version: 1,
          phase: 'prepared',
          backupBundle: backup.path,
          staged: {
            config: `${join(root, 'config.env')}${suffix}`,
            database: `${paths.db}${suffix}`,
            wal: `${paths.db}${suffix}-wal`,
            shm: `${paths.db}${suffix}-shm`,
            session: `${paths.session}${suffix}`,
          },
          active: {
            config: join(root, 'config.env'),
            database: paths.db,
            wal: `${paths.db}-wal`,
            shm: `${paths.db}-shm`,
            session: paths.session,
          },
          rollback: {
            config: `${join(root, 'config.env')}${rollback}`,
            database: `${paths.db}${rollback}`,
            wal: `${paths.db}-wal${rollback}`,
            shm: `${paths.db}-shm${rollback}`,
            session: `${paths.session}${rollback}`,
          },
        })}\n`,
        { mode: 0o600 },
      );
      await expect(setup([], validation, dependencies(true, [false]))).resolves.toBe(1);
      expect(existsSync(paths.journal)).toBe(true);
      const calls: string[] = [];
      await expect(setup([], validation, dependencies(true, [true], calls))).resolves.toBe(0);
      expect(existsSync(paths.journal)).toBe(false);
      expect(calls).toEqual(['install', 'start']);
    }));

  it('keeps non-interactive setup service-free and prints manual next steps', async () =>
    inRoot(async () => {
      const calls: string[] = [];
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      await expect(setup(argumentsFor(), validation, dependencies(false, [], calls))).resolves.toBe(
        0,
      );
      expect(calls).toEqual([]);
      expect(output).toHaveBeenCalledWith(
        'Next steps:\n  pi-tag-slack daemon install\n  pi-tag-slack daemon start',
      );
      output.mockRestore();
    }));
});
