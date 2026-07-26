import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'DM_POLICY',
  'HOME',
  'LOG_LEVEL',
  'MAX_ATTACHMENT_BYTES',
  'MAX_CONCURRENCY',
  'MAX_TOTAL_ATTACHMENT_BYTES',
  'MEDIA_RETENTION_HOURS',
  'PI_TAG_SLACK_CONFIG',
  'PI_BIN',
  'PI_CWD',
  'PI_EXTRA_FLAGS',
  'PI_MODEL',
  'PI_THINKING',
  'POLL_INTERVAL_MS',
  'SESSIONS_DIR',
  'SHUTDOWN_TIMEOUT_MS',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'TRIGGER_NAME',
];

/** Point home-derived locations at the fake home directory. */
function stubHomeDir(homeDir: string): void {
  process.env.HOME = homeDir;
}

afterEach(() => {
  vi.resetModules();
  process.chdir(originalCwd);

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveConfigPath', () => {
  it('uses PI_TAG_SLACK_CONFIG when set', async () => {
    process.env.PI_TAG_SLACK_CONFIG = '~/custom/pi-tag-slack/config.env';

    const { resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(resolve(homedir(), 'custom/pi-tag-slack/config.env'));
  });

  it('falls back to the platform default config path', async () => {
    delete process.env.PI_TAG_SLACK_CONFIG;

    const { resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(expectedDefaultConfigPath(homedir()));
  });
});

describe('config loading', () => {
  it('merges process env over config file over cwd .env fallback', async () => {
    const homeDir = createTempDir();
    const workDir = createTempDir();
    const configPath = resolve(homeDir, 'custom/config.env');

    writeEnvFile(resolve(workDir, '.env'), {
      DB_PATH: '/legacy/gateway.db',
      SESSIONS_DIR: '/legacy/sessions',
      PI_CWD: '/legacy/project',
    });
    writeEnvFile(configPath, {
      DB_PATH: '/config/gateway.db',
      SESSIONS_DIR: '/config/sessions',
      PI_CWD: '/config/project',
    });

    process.chdir(workDir);
    stubHomeDir(homeDir);
    process.env.PI_TAG_SLACK_CONFIG = configPath;
    process.env.PI_CWD = '/env/project';
    delete process.env.DB_PATH;
    delete process.env.SESSIONS_DIR;

    const { config, resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(configPath);
    expect(config.dbPath).toBe('/config/gateway.db');
    expect(config.sessionsDir).toBe('/config/sessions');
    expect(config.piCwd).toBe('/env/project');
  });

  it('uses the default config file before the cwd .env fallback', async () => {
    const homeDir = createTempDir();
    const workDir = createTempDir();
    // Stub before deriving the expected path.
    stubHomeDir(homeDir);
    const defaultConfigPath = expectedDefaultConfigPath(homeDir);

    writeEnvFile(resolve(workDir, '.env'), {
      DB_PATH: '/legacy/gateway.db',
      SESSIONS_DIR: '/legacy/sessions',
    });
    writeEnvFile(defaultConfigPath, {
      DB_PATH: '/default/gateway.db',
      SESSIONS_DIR: '/default/sessions',
    });

    process.chdir(workDir);
    delete process.env.PI_TAG_SLACK_CONFIG;
    delete process.env.DB_PATH;
    delete process.env.SESSIONS_DIR;

    const { config, resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(defaultConfigPath);
    expect(config.dbPath).toBe('/default/gateway.db');
    expect(config.sessionsDir).toBe('/default/sessions');
  });

  it('uses the pi-tag-slack platform data directory defaults when storage paths are unset', async () => {
    const homeDir = createTempDir();
    const workDir = createTempDir();

    process.chdir(workDir);
    stubHomeDir(homeDir);
    delete process.env.PI_TAG_SLACK_CONFIG;
    delete process.env.DB_PATH;
    delete process.env.SESSIONS_DIR;

    const { config } = await loadConfigModule();

    const dataDir = expectedDefaultDataDir(homeDir);
    expect(config.dbPath).toBe(resolve(dataDir, 'gateway.db'));
    expect(config.sessionsDir).toBe(resolve(dataDir, 'sessions'));
  });

  it('parses DM_POLICY and rejects unknown policies', async () => {
    const homeDir = createTempDir();
    const workDir = createTempDir();

    process.chdir(workDir);
    stubHomeDir(homeDir);
    delete process.env.PI_TAG_SLACK_CONFIG;
    process.env.DM_POLICY = 'disabled';

    const { config } = await loadConfigModule();
    expect(config.dmPolicy).toBe('disabled');

    process.env.DM_POLICY = 'bogus';
    const { config: fallbackConfig } = await loadConfigModule();
    expect(fallbackConfig.dmPolicy).toBe('open');
  });
});

describe('validateSlackTokens', () => {
  it('accepts a valid xoxb-/xapp- token pair', async () => {
    const { validateSlackTokens } = await loadConfigModule();

    expect(validateSlackTokens({ slackBotToken: 'xoxb-123', slackAppToken: 'xapp-456' })).toEqual(
      [],
    );
  });

  it('reports missing and mis-prefixed tokens', async () => {
    const { validateSlackTokens } = await loadConfigModule();

    expect(validateSlackTokens({ slackBotToken: '', slackAppToken: '' })).toHaveLength(2);

    const prefixProblems = validateSlackTokens({
      slackBotToken: 'xapp-wrong',
      slackAppToken: 'xoxb-wrong',
    });
    expect(prefixProblems).toHaveLength(2);
    expect(prefixProblems[0]).toContain('xoxb-');
    expect(prefixProblems[1]).toContain('xapp-');
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tag-slack-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeEnvFile(filePath: string, values: Record<string, string>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}

function expectedDefaultConfigPath(homeDir: string): string {
  switch (process.platform) {
    case 'darwin':
      return resolve(homeDir, 'Library/Application Support/pi-tag-slack/config.env');
    default:
      return resolve(homeDir, '.config', 'pi-tag-slack', 'config.env');
  }
}

function expectedDefaultDataDir(homeDir: string): string {
  switch (process.platform) {
    case 'darwin':
      return resolve(homeDir, 'Library/Application Support/pi-tag-slack');
    default:
      return resolve(homeDir, '.local/share', 'pi-tag-slack');
  }
}

async function loadConfigModule() {
  vi.resetModules();
  return import('../src/config.js');
}
