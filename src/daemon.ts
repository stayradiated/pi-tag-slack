import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath, resolveDataDir } from './config.js';
import { gatewayPaths } from './paths.js';
import {
  LAUNCHD_LABEL,
  launchdPlist,
  SYSTEMD_SERVICE_NAME,
  systemdUnit,
} from './daemon-service-definitions.js';

export { LAUNCHD_LABEL, launchdPlist, SYSTEMD_SERVICE_NAME, systemdUnit };

export type DaemonStatus = 'not-installed' | 'stopped' | 'running';

type CommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type CommandOptions = { allowFailure?: boolean; capture?: boolean };

export interface DaemonDependencies {
  platform: string;
  homeDirectory: string;
  uid: number;
  nodePath: string;
  cliPath: string;
  pathEnvironment: string;
  configPath: string;
  dataDir: string;
  exists(path: string): boolean;
  mkdir(path: string): void;
  writeFile(path: string, content: string): void;
  remove(path: string): void;
  run(command: string, args: string[], options?: CommandOptions): CommandResult;
}

/** Real OS bindings live here so service lifecycle behavior is fully injectable. */
export function systemDaemonDependencies(): DaemonDependencies {
  return {
    platform: process.platform,
    homeDirectory: homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    nodePath: process.execPath,
    cliPath: fileURLToPath(new URL('./cli/index.js', import.meta.url)),
    pathEnvironment: process.env.PATH ?? '',
    configPath: resolveConfigPath(),
    dataDir: resolveDataDir(),
    exists: existsSync,
    mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
    writeFile: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
    remove: (path) => rmSync(path, { force: true }),
    run(command, args, options = {}) {
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      });
      if (result.error) throw result.error;
      const commandResult = {
        status: result.status,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
      if (!options.allowFailure && result.status !== 0)
        throw new Error(`Command failed: ${command} ${args.join(' ')}`);
      return commandResult;
    },
  };
}

export function daemon(
  action: string,
  dependencies = systemDaemonDependencies(),
): DaemonStatus | void {
  if (!['install', 'uninstall', 'start', 'stop', 'status', 'logs'].includes(action))
    throw new Error(`Unknown daemon action: ${action}`);
  if (dependencies.platform === 'linux') return systemd(action, dependencies);
  if (dependencies.platform === 'darwin') return launchd(action, dependencies);
  throw new Error(
    `Daemon management is not supported on ${dependencies.platform}. Supported: linux, darwin.`,
  );
}

function systemdDirectory(deps: DaemonDependencies): string {
  return resolve(deps.homeDirectory, '.config/systemd/user');
}

function systemdPath(deps: DaemonDependencies): string {
  return resolve(systemdDirectory(deps), SYSTEMD_SERVICE_NAME);
}

function systemd(action: string, deps: DaemonDependencies): DaemonStatus | void {
  const path = systemdPath(deps);
  if (action === 'install') {
    deps.mkdir(systemdDirectory(deps));
    deps.writeFile(path, systemdUnit(deps));
    deps.run('systemctl', ['--user', 'daemon-reload']);
    deps.run('systemctl', ['--user', 'enable', SYSTEMD_SERVICE_NAME]);
    console.log(`Installed service file: ${path}`);
    return;
  }
  if (action === 'uninstall') {
    deps.run('systemctl', ['--user', 'stop', SYSTEMD_SERVICE_NAME], { allowFailure: true });
    deps.run('systemctl', ['--user', 'disable', SYSTEMD_SERVICE_NAME], { allowFailure: true });
    deps.remove(path);
    deps.run('systemctl', ['--user', 'daemon-reload']);
    console.log(`Removed service file: ${path}`);
    return;
  }
  if (action === 'start')
    return void deps.run('systemctl', ['--user', 'start', SYSTEMD_SERVICE_NAME]);
  if (action === 'stop')
    return void deps.run('systemctl', ['--user', 'stop', SYSTEMD_SERVICE_NAME]);
  if (action === 'logs')
    return void deps.run('journalctl', [
      '--user',
      '-u',
      SYSTEMD_SERVICE_NAME,
      '-f',
      '--no-pager',
      '-n',
      '50',
    ]);
  if (!deps.exists(path)) return reportStatus('not-installed');
  return reportStatus(
    deps.run('systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_SERVICE_NAME], {
      allowFailure: true,
      capture: true,
    }).status === 0
      ? 'running'
      : 'stopped',
  );
}

function launchAgentsDirectory(deps: DaemonDependencies): string {
  return resolve(deps.homeDirectory, 'Library/LaunchAgents');
}

function launchdPath(deps: DaemonDependencies): string {
  return resolve(launchAgentsDirectory(deps), `${LAUNCHD_LABEL}.plist`);
}

function launchdTarget(deps: DaemonDependencies): string {
  return `gui/${deps.uid}/${LAUNCHD_LABEL}`;
}

function launchd(action: string, deps: DaemonDependencies): DaemonStatus | void {
  const path = launchdPath(deps);
  const target = launchdTarget(deps);
  if (action === 'install') {
    deps.mkdir(launchAgentsDirectory(deps));
    deps.mkdir(deps.dataDir);
    deps.writeFile(path, launchdPlist(deps));
    deps.run('launchctl', ['bootstrap', `gui/${deps.uid}`, path]);
    console.log(`Installed plist: ${path}`);
    return;
  }
  if (action === 'uninstall') {
    deps.run('launchctl', ['bootout', target], { allowFailure: true });
    deps.remove(path);
    console.log(`Removed plist: ${path}`);
    return;
  }
  if (action === 'start') {
    if (!deps.exists(path))
      throw new Error('Daemon service is not installed. Run pi-tag-slack daemon install first.');
    // A prior `stop` booted the job out, while a normally exited KeepAlive job
    // remains loaded. Bootstrap only the former; kickstart the latter.
    const loaded =
      deps.run('launchctl', ['print', target], { allowFailure: true, capture: true }).status === 0;
    return void deps.run(
      'launchctl',
      loaded ? ['kickstart', target] : ['bootstrap', `gui/${deps.uid}`, path],
    );
  }
  if (action === 'stop')
    return void deps.run('launchctl', ['bootout', target], { allowFailure: true });
  if (action === 'logs') {
    const paths = gatewayPaths(deps.dataDir);
    return void deps.run('tail', ['-n', '50', '-f', paths.stdout, paths.stderr]);
  }
  if (!deps.exists(path)) return reportStatus('not-installed');
  const result = deps.run('launchctl', ['print', target], { allowFailure: true, capture: true });
  return reportStatus(
    result.status === 0 && /state\s*=\s*running\b/.test(result.stdout) ? 'running' : 'stopped',
  );
}

function reportStatus(status: DaemonStatus): DaemonStatus {
  console.log(`Daemon status: ${status}.`);
  return status;
}
