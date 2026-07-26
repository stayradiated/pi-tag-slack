import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { WebClient } from '@slack/web-api';
import { config, resolveConfigPath, validateSlackTokens } from '../config.js';
import { closeDb, getAllChannels, initDb } from '../db.js';

const AUTH_PATH = resolve(homedir(), '.pi/agent/auth.json');
const SERVICE_NAME = 'pi-tag-slack';

export async function runStatus(): Promise<void> {
  const configPath = resolveConfigPath();
  const piPath = findExecutable('pi');
  const piVersion = piPath ? readCommandOutput('pi --version') : undefined;
  const authStatus = existsSync(AUTH_PATH);
  const slackAuth = await getSlackAuthStatus();
  const serviceStatus = getServiceStatus();
  const channelCount = getRegisteredChannelCount();
  const sessionsPath = resolve(config.sessionsDir);
  const sessionFolderCount = countSessionFolders(sessionsPath);

  const lines = [
    'pi-tag-slack status',
    '',
    `Pi binary: ${piPath || 'not found'}`,
    `Pi version: ${piVersion || 'unknown'}`,
    `Pi auth: ${authStatus ? `found (${AUTH_PATH})` : `missing (${AUTH_PATH})`}`,
    `Pi working dir: ${config.piCwd}`,
    `Slack auth: ${slackAuth}`,
    `Config path: ${configPath}`,
    `Gateway service: ${serviceStatus}`,
    `Database: ${config.dbPath}`,
    `Registered channels: ${channelCount}`,
    `Sessions directory: ${config.sessionsDir}`,
    `Session folders: ${sessionFolderCount}`,
  ];

  console.log(lines.join('\n'));
}

async function getSlackAuthStatus(): Promise<string> {
  const problems = validateSlackTokens(config);
  if (problems.length > 0) {
    const hints = [...problems];
    if (!config.slackAppToken) {
      hints.push(
        'Generate an app-level token with the connections:write scope (Socket Mode) at api.slack.com/apps.',
      );
    }
    return `not configured — ${hints.join(' ')}`;
  }

  try {
    const auth = await new WebClient(config.slackBotToken).auth.test();
    return `ok (team ${auth.team ?? 'unknown'}, bot user ${auth.user ?? auth.user_id ?? 'unknown'})`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `failed (${message}) — check SLACK_BOT_TOKEN, and the Socket Mode app token (SLACK_APP_TOKEN)`;
  }
}

function getServiceStatus(): string {
  if (process.platform === 'linux') return getLinuxServiceStatus();
  if (process.platform === 'darwin') return getMacServiceStatus();
  return 'unsupported platform';
}

function getLinuxServiceStatus(): string {
  const result = spawnSync('systemctl', ['--user', 'is-active', SERVICE_NAME], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return `unavailable (${result.error.message})`;
  }

  const status = `${result.stdout || result.stderr || ''}`.trim();
  return status || `inactive (exit ${result.status ?? 'unknown'})`;
}

function getMacServiceStatus(): string {
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
  const result = spawnSync('launchctl', ['print', `gui/${uid}/com.${SERVICE_NAME}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    return 'not loaded';
  }

  const output = result.stdout;
  const state = output.match(/state\s*=\s*(\S+)/)?.[1] ?? 'unknown';
  const pid = output.match(/pid\s*=\s*(\d+)/)?.[1];
  return pid ? `running (pid ${pid}, ${state})` : `loaded (${state})`;
}

function getRegisteredChannelCount(): number {
  try {
    initDb();
    return getAllChannels().length;
  } finally {
    closeDb();
  }
}

function countSessionFolders(baseDir: string): number {
  if (!existsSync(baseDir)) {
    return 0;
  }

  let count = 0;
  const stack = [baseDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'media') {
        continue;
      }

      count += 1;
      stack.push(resolve(currentDir, entry.name));
    }
  }

  return count;
}

function findExecutable(name: string): string | undefined {
  return readCommandOutput(`which ${name}`);
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
