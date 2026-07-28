import { parse } from 'dotenv';
import { chmodSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, parse as parsePath, resolve } from 'node:path';

function userPath(value: string): string {
  const expanded = value === '~' ? homedir() : value.replace(/^~\//, `${homedir()}/`);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function uid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

export function defaultDataDir(): string {
  return process.platform === 'darwin'
    ? resolve(homedir(), 'Library/Application Support/pi-tag-slack')
    : resolve(homedir(), '.local/share/pi-tag-slack');
}

export function resolveDataDir(): string {
  return userPath(process.env.PI_TAG_SLACK_DATA_DIR?.trim() || defaultDataDir());
}

export function resolveConfigPath(): string {
  const fallback =
    process.platform === 'darwin'
      ? resolve(homedir(), 'Library/Application Support/pi-tag-slack/config.env')
      : resolve(homedir(), '.config/pi-tag-slack/config.env');
  return userPath(process.env.PI_TAG_SLACK_CONFIG?.trim() || fallback);
}

/**
 * Checks the bootstrap file and all existing ancestors before it is read. The
 * file may be absent during setup, but an existing file must be a private,
 * daemon-owned regular file. Ancestors may not be symlinks, foreign-owned, or
 * writable by group/other, preventing parent substitution after deployment.
 */
export function validateBootstrapConfigPath(
  path = resolveConfigPath(),
  options: { repairPermissions?: boolean; onRepair?: (path: string, mode: number) => void } = {},
): void {
  const target = resolve(path);
  const owner = uid();
  const configParent = dirname(target);
  let current = target;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink bootstrap path: ${current}`);
      if (
        (current === target || current === configParent) &&
        owner !== undefined &&
        stat.uid !== owner
      )
        throw new Error(`Foreign-owned bootstrap path: ${current}`);
      // Read-only ancestors may be system-owned. Writable ancestors are only
      // acceptable when sticky (for example /tmp); the daemon-owned immediate
      // config directory is still created private by setup.
      const writable = stat.mode & 0o022;
      if (writable !== 0 && !(stat.mode & 0o1000))
        throw new Error(`Bootstrap path is writable by group or other: ${current}`);
      if (current === target) {
        if (!stat.isFile()) throw new Error(`Bootstrap config is not a regular file: ${target}`);
        if ((stat.mode & 0o777) !== 0o600) {
          if (!options.repairPermissions)
            throw new Error(`Bootstrap config must have mode 0600: ${target}`);
          try {
            chmodSync(target, 0o600);
          } catch (error) {
            throw new Error(
              `Unable to repair permissions for ${target} (run chmod 600 ${target}): ${(error as Error).message}`,
              { cause: error },
            );
          }
          options.onRepair?.(target, 0o600);
        }
      } else if (!stat.isDirectory()) {
        throw new Error(`Bootstrap config parent is not a directory: ${current}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current || current === parsePath(current).root) break;
    current = parent;
  }
}

export interface BootstrapConfig {
  slackBotToken: string;
  slackAppToken: string;
  dataDir: string;
  configPath: string;
}

/** Loads bootstrap values at runtime, never as an import side effect. */
export function loadBootstrapConfig(): BootstrapConfig {
  const configPath = resolveConfigPath();
  let fileValues: Record<string, string> = {};
  try {
    validateBootstrapConfigPath(configPath);
    fileValues = parse(readFileSync(configPath, 'utf8'));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const values = { ...fileValues, ...process.env };
  return {
    slackBotToken: values.SLACK_BOT_TOKEN?.trim() ?? '',
    slackAppToken: values.SLACK_APP_TOKEN?.trim() ?? '',
    dataDir: resolveDataDir(),
    configPath,
  };
}

export function validateSlackTokens(cfg = loadBootstrapConfig()): string[] {
  const errors: string[] = [];
  if (!cfg.slackBotToken.startsWith('xoxb-'))
    errors.push('SLACK_BOT_TOKEN must be an xoxb- bot token.');
  if (!cfg.slackAppToken.startsWith('xapp-'))
    errors.push('SLACK_APP_TOKEN must be an xapp- app token.');
  return errors;
}
