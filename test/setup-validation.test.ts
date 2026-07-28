import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { setup } from '../src/cli/index.js';
import { closeDb, initDb, readGatewayConfig, requireConfiguredDb } from '../src/db.js';
import { resolvePiExecutable, type SetupValidationDependencies } from '../src/setup-validation.js';

const directories: string[] = [];
afterEach(() => {
  closeDb();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function dependencies(
  overrides: Partial<SetupValidationDependencies> = {},
): SetupValidationDependencies {
  return {
    validatePi: async () => {},
    createBotClient: () => ({
      auth: { test: async () => ({ ok: true, user_id: 'UBOT' }) },
      conversations: {
        info: async () => ({
          ok: true,
          channel: { is_channel: true, is_member: true, name: 'engineering' },
        }),
      },
      users: {
        info: async () => ({
          ok: true,
          user: { id: 'U0123456789', profile: { display_name: 'Ada Lovelace' } },
        }),
      },
    }),
    createAppClient: () => ({ apps: { connections: { open: async () => ({ ok: true }) } } }),
    ...overrides,
  };
}

async function run(overrides: Partial<SetupValidationDependencies> = {}, extra: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-setup-validation-'));
  directories.push(directory);
  const oldData = process.env.PI_TAG_SLACK_DATA_DIR;
  const oldConfig = process.env.PI_TAG_SLACK_CONFIG;
  process.env.PI_TAG_SLACK_DATA_DIR = directory;
  process.env.PI_TAG_SLACK_CONFIG = join(directory, 'config.env');
  try {
    return await setup(
      [
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
      ],
      dependencies(overrides),
    );
  } finally {
    if (oldData === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
    else process.env.PI_TAG_SLACK_DATA_DIR = oldData;
    if (oldConfig === undefined) delete process.env.PI_TAG_SLACK_CONFIG;
    else process.env.PI_TAG_SLACK_CONFIG = oldConfig;
  }
}

function noApplicationState(): void {
  const directory = directories.at(-1)!;
  expect(existsSync(join(directory, 'gateway.db'))).toBe(false);
  expect(existsSync(join(directory, 'config.env'))).toBe(false);
  expect(existsSync(join(directory, 'gateway.db-wal'))).toBe(false);
  expect(existsSync(join(directory, 'gateway.db-shm'))).toBe(false);
}

describe('pi executable resolution', () => {
  it('canonicalizes a PATH command and rejects relative paths and unsafe files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-pi-bin-'));
    directories.push(directory);
    const executable = join(directory, 'pi');
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
    chmodSync(executable, 0o700);
    expect(resolvePiExecutable('pi', directory)).toBe(executable);
    expect(() => resolvePiExecutable('./pi', directory)).toThrow(/must be absolute/);
    chmodSync(executable, 0o600);
    expect(() => resolvePiExecutable(executable)).toThrow(/safe executable/);
  });
});

describe.sequential('first-time setup validation', () => {
  it('rejects setup --yes when no interrupted reset journal exists', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-setup-recovery-'));
    directories.push(directory);
    const oldData = process.env.PI_TAG_SLACK_DATA_DIR;
    const oldConfig = process.env.PI_TAG_SLACK_CONFIG;
    process.env.PI_TAG_SLACK_DATA_DIR = directory;
    process.env.PI_TAG_SLACK_CONFIG = join(directory, 'config.env');
    try {
      await expect(setup(['--yes'])).rejects.toThrow(/No incomplete reset journal/);
    } finally {
      if (oldData === undefined) delete process.env.PI_TAG_SLACK_DATA_DIR;
      else process.env.PI_TAG_SLACK_DATA_DIR = oldData;
      if (oldConfig === undefined) delete process.env.PI_TAG_SLACK_CONFIG;
      else process.env.PI_TAG_SLACK_CONFIG = oldConfig;
    }
  });

  it('fails old pi validation before staging', async () => {
    await expect(
      run({
        validatePi: async () => {
          throw new Error('pi 0.82.0 or later is required.');
        },
      }),
    ).rejects.toThrow(/0.82.0/);
    noApplicationState();
  });

  it('fails RPC/catalog validation cleanly', async () => {
    await expect(
      run({
        validatePi: async () => {
          throw new Error('Configured model is unavailable from pi');
        },
      }),
    ).rejects.toThrow(/model is unavailable/);
    noApplicationState();
  });

  it('rejects bot and app credentials independently', async () => {
    await expect(
      run({
        createBotClient: () => ({
          auth: { test: async () => ({ ok: false, error: 'invalid_auth' }) },
          conversations: { info: async () => ({}) },
          users: { info: async () => ({}) },
        }),
      }),
    ).rejects.toThrow(/auth.test/);
    noApplicationState();
    await expect(
      run({
        createAppClient: () => ({
          apps: { connections: { open: async () => ({ ok: false, error: 'invalid_auth' }) } },
        }),
      }),
    ).rejects.toThrow(/apps.connections.open/);
    noApplicationState();
  });

  it('rejects auth without a bot user, non-channel conversations, and invalid trusted users', async () => {
    await expect(
      run({
        createBotClient: () => ({
          auth: { test: async () => ({ ok: true }) },
          conversations: { info: async () => ({}) },
          users: { info: async () => ({}) },
        }),
      }),
    ).rejects.toThrow(/bot user ID/);
    noApplicationState();
    await expect(
      run({
        createBotClient: () => ({
          auth: { test: async () => ({ ok: true, user_id: 'UBOT' }) },
          conversations: {
            info: async () => ({ ok: true, channel: { is_im: true, is_member: true } }),
          },
          users: { info: async () => ({}) },
        }),
      }),
    ).rejects.toThrow(/public channel or private channel/);
    noApplicationState();
    await expect(
      run({
        createBotClient: () => ({
          auth: { test: async () => ({ ok: true, user_id: 'UBOT' }) },
          conversations: {
            info: async () => ({
              ok: true,
              channel: { is_channel: true, is_member: true, name: 'x' },
            }),
          },
          users: { info: async () => ({ ok: true, user: { id: 'U0123456789', deleted: true } }) },
        }),
      }),
    ).rejects.toThrow(/invalid or deactivated/);
    noApplicationState();
  });

  it('persists Slack cosmetic labels only after validation succeeds', async () => {
    await expect(run()).resolves.toBe(0);
    initDb(join(directories.at(-1)!, 'gateway.db'));
    const config = readGatewayConfig();
    expect(config.channel_label).toBe('engineering');
    expect(
      requireConfiguredDb()
        .prepare('select label from trusted_users where user_id=?')
        .get('U0123456789'),
    ).toEqual({ label: 'Ada Lovelace' });
  });

  it('stages and reopens the canonical executable validated for the service', async () => {
    const binDirectory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-canonical-pi-'));
    directories.push(binDirectory);
    const executable = join(binDirectory, 'pi');
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
    let validatedBinary = '';
    await expect(
      run(
        {
          validatePi: async ({ piBinary }) => {
            validatedBinary = piBinary;
          },
        },
        ['--pi-bin', executable],
      ),
    ).resolves.toBe(0);
    initDb(join(directories.at(-1)!, 'gateway.db'));
    expect(validatedBinary).toBe(executable);
    expect(readGatewayConfig().pi_binary).toBe(executable);
  });
});
