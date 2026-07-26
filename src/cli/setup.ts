import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import * as clack from '@clack/prompts';
import { listAvailableModels } from '../agent/model-catalog.js';
import type { DmPolicy } from '../config.js';
import { defaultDataDir, resolveConfigPath, validateSlackTokens } from '../config.js';
import { validateTrustedUserId } from '../db.js';

const SERVICE_NAME = 'pi-tag-slack';
const DEFAULT_TRIGGER_NAME = 'pi-tag-slack';
const DEFAULT_WORKING_DIR = homedir();

const AUTH_PATH = resolve(homedir(), '.pi/agent/auth.json');

export async function runSetup(args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new Error(
      'Usage: pi-tag-slack setup (use SLACK_BOT_TOKEN and SLACK_APP_TOKEN in non-interactive mode)',
    );
  }
  const botTokenArg = process.env.SLACK_BOT_TOKEN?.trim() ?? '';
  const appTokenArg = process.env.SLACK_APP_TOKEN?.trim() ?? '';
  const trustedUserIdArg = process.env.PI_TAG_SLACK_TRUSTED_USER_ID ?? '';
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const configPath = resolveConfigPath();
  // A custom config location never relocates application storage.
  const dataDir = defaultDataDir();
  const sessionsDir = resolve(dataDir, 'sessions');
  const dbPath = resolve(dataDir, 'gateway.db');

  if (!interactive && (!botTokenArg || !appTokenArg || !trustedUserIdArg)) {
    throw new Error(
      'SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and PI_TAG_SLACK_TRUSTED_USER_ID are required when stdin is not interactive.',
    );
  }

  clack.intro('pi-tag-slack setup');

  // ── Prerequisites ──
  const prereqs = checkPrerequisites();
  const prereqLines = [
    prereqs.piPath
      ? `  ✓ pi binary: ${prereqs.piPath}${prereqs.piVersion ? ` (${prereqs.piVersion})` : ''}`
      : '  ✗ pi binary: not found in PATH — install pi first',
    prereqs.authFound ? `  ✓ pi auth: found` : `  ✗ pi auth: missing — run "pi" and log in first`,
    prereqs.modelCount !== undefined
      ? `  ✓ models: ${prereqs.modelCount} available`
      : `  ✗ models: unavailable`,
  ];
  clack.note(prereqLines.join('\n'), 'Prerequisites');

  if (!prereqs.piPath || !prereqs.authFound) {
    clack.log.warn(
      'Some prerequisites are missing. The gateway needs pi installed and logged in to work.',
    );
  }

  // ── Slack app creation ──
  if (interactive && (!botTokenArg || !appTokenArg)) {
    clack.note(
      [
        '1. Open https://api.slack.com/apps and click "Create New App"',
        '2. Choose "From a manifest", pick your workspace, and paste the',
        '   contents of manifest.yaml from this repository',
        '   (Socket Mode, scopes, and the /pi command are preconfigured)',
        '3. Click "Install to Workspace" and approve the permissions',
        '4. OAuth & Permissions → copy the Bot User OAuth Token (xoxb-…)',
        '5. Basic Information → App-Level Tokens → generate a token with',
        '   the connections:write scope and copy it (xapp-…)',
      ].join('\n'),
      'Create your Slack app',
    );
  }

  // ── Bot token ──
  let botToken = botTokenArg;
  if (!botToken && interactive) {
    const result = await clack.text({
      message: 'Slack Bot Token (xoxb-…)',
      placeholder: 'Paste your bot token here',
      validate: (v) => {
        if (!v?.trim()) return 'Token cannot be empty.';
        if (!v.trim().startsWith('xoxb-')) return 'Bot tokens start with "xoxb-".';
      },
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    botToken = result?.trim() ?? '';
  }

  // ── App-level token (Socket Mode) ──
  let appToken = appTokenArg;
  if (!appToken && interactive) {
    const result = await clack.text({
      message: 'Slack App-Level Token (xapp-…, Socket Mode)',
      placeholder: 'Paste your app-level token here',
      validate: (v) => {
        if (!v?.trim()) return 'Token cannot be empty.';
        if (!v.trim().startsWith('xapp-')) return 'App-level tokens start with "xapp-".';
      },
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    appToken = result?.trim() ?? '';
  }

  // Covers non-interactive/argument-passed tokens too (same rules as startup).
  const tokenProblems = validateSlackTokens({ slackBotToken: botToken, slackAppToken: appToken });
  if (tokenProblems.length > 0) {
    throw new Error(tokenProblems.join(' '));
  }

  // ── Trigger name ──
  let triggerName = DEFAULT_TRIGGER_NAME;
  if (interactive) {
    const result = await clack.text({
      message: 'Trigger Name',
      placeholder: DEFAULT_TRIGGER_NAME,
      defaultValue: DEFAULT_TRIGGER_NAME,
      initialValue: DEFAULT_TRIGGER_NAME,
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    triggerName = result || DEFAULT_TRIGGER_NAME;
  }

  // ── Channel policy ──
  let channelPolicy: 'open' | 'open-trigger' | 'allowlist' = 'allowlist';
  if (interactive) {
    const result = await clack.select({
      message: 'Channel Policy — how should the bot handle workspace channels?',
      options: [
        {
          value: 'open' as const,
          label: 'open',
          hint: 'Respond to all messages in every channel the bot is a member of',
        },
        {
          value: 'open-trigger' as const,
          label: 'open-trigger',
          hint: `Listen in all channels, but only respond when @${triggerName} is mentioned`,
        },
        {
          value: 'allowlist' as const,
          label: 'allowlist',
          hint: 'Only respond in manually registered channels (pi-tag-slack register ...)',
        },
      ],
      initialValue: 'allowlist' as const,
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    channelPolicy = result;
  }

  // ── DM policy ──
  let dmPolicy: DmPolicy = 'open';
  if (interactive) {
    const result = await clack.select({
      message: 'DM Policy — how should the bot handle direct messages?',
      options: [
        {
          value: 'open' as const,
          label: 'open',
          hint: 'Respond to all DMs, registering them automatically',
        },
        {
          value: 'allowlist' as const,
          label: 'allowlist',
          hint: 'Only respond in manually registered DM channels (IDs start with D)',
        },
        {
          value: 'disabled' as const,
          label: 'disabled',
          hint: 'Ignore all direct messages',
        },
      ],
      initialValue: 'open' as const,
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    dmPolicy = result;
  }

  // ── Initial trusted Slack user ──
  let trustedUserId = trustedUserIdArg;
  if (interactive) {
    clack.note(
      'Find your raw Member ID in Slack: profile → ⋮ → Copy member ID. Do not use a display name or <@mention>.',
      'Gateway trust',
    );
    const result = await clack.text({
      message: 'Initial trusted Slack user ID (U... or W...)',
      validate: (value) => {
        try {
          validateTrustedUserId(value ?? '');
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    trustedUserId = result ?? '';
  }
  trustedUserId = validateTrustedUserId(trustedUserId);

  // ── Working directory ──
  let workingDir = DEFAULT_WORKING_DIR;
  if (interactive) {
    const result = await clack.text({
      message: 'Working Directory — base directory pi uses when executing commands',
      placeholder: DEFAULT_WORKING_DIR,
      defaultValue: DEFAULT_WORKING_DIR,
      initialValue: DEFAULT_WORKING_DIR,
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    workingDir = result || DEFAULT_WORKING_DIR;
  }

  // ── Write config ──
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  writeFileSync(
    configPath,
    buildConfigFile({
      botToken,
      appToken,
      triggerName,
      workingDir,
      channelPolicy,
      dmPolicy,
      sessionsDir,
      dbPath,
    }),
    { mode: 0o600 },
  );
  chmodSync(configPath, 0o600);

  // Bootstrap trust only after config creation; do not claim setup succeeded
  // until both persistent pieces exist.
  const dbModule = await import('../db.js');
  try {
    dbModule.initDb(dbPath);
    dbModule.addTrustedUser(trustedUserId);
  } finally {
    dbModule.closeDb();
  }

  clack.log.success(`Config written to: ${configPath}`);

  // ── Daemon install + start ──
  if (interactive && isUnix()) {
    const serviceName = process.platform === 'darwin' ? 'launchd' : 'systemd';
    const installDaemon = await clack.confirm({
      message: `Install as a background service (${serviceName}) and start now?`,
      initialValue: true,
    });
    if (clack.isCancel(installDaemon)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }

    if (installDaemon) {
      const s = clack.spinner();
      s.start(`Installing ${serviceName} service...`);
      try {
        const { runDaemon } = await import('./daemon.js');
        runDaemon('install');
        s.message('Starting service...');
        runDaemon('start');
        s.stop('Service installed and started.');
        clack.log.success(`${SERVICE_NAME} is active`);
      } catch (err) {
        s.stop('Service installation failed.');
        clack.log.error(errorMessage(err));
        clack.log.info(
          'You can install manually later: pi-tag-slack daemon install && pi-tag-slack daemon start',
        );
      }
    }
  }

  // ── Summary ──
  const summaryLines = [
    `Config:    ${configPath}`,
    `Policy:    ${channelPolicy}`,
    `DMs:       ${dmPolicy}`,
    `Trust:     ${trustedUserId}`,
    `Trigger:   ${triggerName}`,
    `Sessions:  ${sessionsDir}`,
  ];
  clack.note(summaryLines.join('\n'), 'Configuration');

  clack.outro('Setup complete! Invite the bot to a Slack channel (/invite) or DM it to test.');
}

function checkPrerequisites(): {
  piPath: string | undefined;
  piVersion: string | undefined;
  authFound: boolean;
  modelCount: number | undefined;
} {
  const piPath = findExecutable('pi');
  const piVersion = piPath ? readCommandOutput('pi --version') : undefined;
  const authFound = existsSync(AUTH_PATH);
  let modelCount: number | undefined;

  try {
    modelCount = listAvailableModels().length;
  } catch {
    modelCount = undefined;
  }

  return { piPath, piVersion, authFound, modelCount };
}

function findExecutable(name: string): string | undefined {
  return readCommandOutput(`which ${name}`);
}

function isUnix(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin';
}

export function serializeDotenvValue(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(
      'Configuration values cannot contain NUL, carriage return, or newline characters.',
    );
  }
  // dotenv 17 preserves the contents of backtick and single quoted values.
  // Prefer those delimiters rather than shell escaping, which dotenv does not
  // reverse. Double quotes expand literal \\n and \\r, so use them only when safe.
  if (!value.includes('`')) return `\`${value}\``;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !/\\[nr]/.test(value)) return `"${value}"`;
  // An unquoted value is exact only when dotenv will neither trim nor start a comment.
  if (value !== '' && value === value.trim() && !value.includes('#')) return value;
  throw new Error('Configuration value cannot be represented exactly in dotenv format.');
}

export function buildConfigFile(options: {
  botToken: string;
  appToken: string;
  triggerName: string;
  workingDir: string;
  channelPolicy?: 'open' | 'open-trigger' | 'allowlist';
  dmPolicy?: DmPolicy;
  sessionsDir: string;
  dbPath: string;
}): string {
  const assignment = (key: string, value: string) => `${key}=${serializeDotenvValue(value)}`;
  return [
    '# Generated by: pi-tag-slack setup',
    '# Or edit manually. See: pi-tag-slack help',
    '',
    assignment('SLACK_BOT_TOKEN', options.botToken),
    assignment('SLACK_APP_TOKEN', options.appToken),
    '',
    '# Pi agent configuration',
    assignment('PI_BIN', 'pi'),
    assignment('PI_MODEL', ''),
    assignment('PI_THINKING', ''),
    assignment('PI_CWD', options.workingDir),
    assignment('PI_EXTRA_FLAGS', ''),
    '',
    '# Gateway behavior',
    assignment('TRIGGER_NAME', options.triggerName),
    assignment('MAX_CONCURRENCY', '3'),
    assignment('MAX_SCHEDULED_CONCURRENCY', '1'),
    assignment('POLL_INTERVAL_MS', '1000'),
    assignment('SHUTDOWN_TIMEOUT_MS', '15000'),
    assignment('DM_POLICY', options.dmPolicy ?? 'open'),
    assignment('CHANNEL_POLICY', options.channelPolicy ?? 'allowlist'),
    assignment('EXCLUDED_CHANNELS', ''),
    assignment('MAX_ATTACHMENT_BYTES', '26214400'),
    assignment('MAX_TOTAL_ATTACHMENT_BYTES', '52428800'),
    assignment('MEDIA_RETENTION_HOURS', '168'),
    '',
    '# Archive',
    assignment('ARCHIVE_RETENTION_DAYS', '30'),
    '',
    '# Storage',
    assignment('SESSIONS_DIR', options.sessionsDir),
    assignment('DB_PATH', options.dbPath),
    '',
    '# Logging',
    assignment('LOG_LEVEL', 'info'),
    '',
  ].join('\n');
}

function readCommandOutput(command: string): string | undefined {
  try {
    const stdout = execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (stdout) return stdout;
  } catch {}
  // Some commands (e.g. pi --version) output to stderr — retry with merge
  try {
    return (
      execSync(command + ' 2>&1', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
