import { describe, expect, it, vi } from 'vitest';
import {
  daemon,
  LAUNCHD_LABEL,
  launchdPlist,
  SYSTEMD_SERVICE_NAME,
  systemdUnit,
  type DaemonDependencies,
} from '../src/daemon.js';

function fake(
  platform: string,
  installed = true,
): DaemonDependencies & { calls: string[][]; files: Map<string, string> } {
  const calls: string[][] = [];
  const files = new Map<string, string>();
  const homeDirectory = '/home/tester';
  const service = `${homeDirectory}/.config/systemd/user/${SYSTEMD_SERVICE_NAME}`;
  const plist = `${homeDirectory}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
  if (installed) files.set(platform === 'linux' ? service : plist, 'installed');
  return {
    platform,
    homeDirectory,
    uid: 501,
    nodePath: '/opt/node/bin/node',
    cliPath: '/opt/pi-tag-slack/dist/cli/index.js',
    pathEnvironment: '/opt/bin:/usr/bin',
    configPath: '/private/config.env',
    dataDir: '/private/data',
    calls,
    files,
    exists: (path) => files.has(path),
    mkdir: (path) => calls.push(['mkdir', path]),
    writeFile: (path, content) => {
      files.set(path, content);
      calls.push(['writeFile', path]);
    },
    remove: (path) => {
      files.delete(path);
      calls.push(['remove', path]);
    },
    run: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

describe('daemon service definitions', () => {
  it('generates a systemd user unit that starts the public CLI entrypoint', () => {
    expect(systemdUnit(fake('linux'))).toBe(`[Unit]
Description=pi-tag-slack Slack Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="/opt/node/bin/node" "/opt/pi-tag-slack/dist/cli/index.js" start
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment="PI_TAG_SLACK_CONFIG=/private/config.env"
Environment="PI_TAG_SLACK_DATA_DIR=/private/data"

[Install]
WantedBy=default.target
`);
  });

  it('generates a launchd agent with canonical log paths and preserved overrides', () => {
    const plist = launchdPlist(fake('darwin'));
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain(
      '<string>/opt/pi-tag-slack/dist/cli/index.js</string>\n    <string>start</string>',
    );
    expect(plist).toContain(
      '<key>PI_TAG_SLACK_CONFIG</key>\n    <string>/private/config.env</string>',
    );
    expect(plist).toContain('<key>PI_TAG_SLACK_DATA_DIR</key>\n    <string>/private/data</string>');
    expect(plist).toContain('<string>/private/data/daemon.stdout.log</string>');
    expect(plist).toContain('<string>/private/data/daemon.stderr.log</string>');
  });
});

describe('systemd lifecycle', () => {
  it('uses exact systemd user targets for install and lifecycle actions', () => {
    const deps = fake('linux', false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    daemon('install', deps);
    daemon('start', deps);
    daemon('stop', deps);
    daemon('logs', deps);
    daemon('uninstall', deps);
    expect(deps.calls).toEqual([
      ['mkdir', '/home/tester/.config/systemd/user'],
      ['writeFile', '/home/tester/.config/systemd/user/pi-tag-slack.service'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'pi-tag-slack.service'],
      ['systemctl', '--user', 'start', 'pi-tag-slack.service'],
      ['systemctl', '--user', 'stop', 'pi-tag-slack.service'],
      ['journalctl', '--user', '-u', 'pi-tag-slack.service', '-f', '--no-pager', '-n', '50'],
      ['systemctl', '--user', 'stop', 'pi-tag-slack.service'],
      ['systemctl', '--user', 'disable', 'pi-tag-slack.service'],
      ['remove', '/home/tester/.config/systemd/user/pi-tag-slack.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    log.mockRestore();
  });

  it('distinguishes absent, stopped, and running systemd services', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(daemon('status', fake('linux', false))).toBe('not-installed');
    const stopped = fake('linux');
    stopped.run = (command, args) => {
      stopped.calls.push([command, ...args]);
      return { status: 3, stdout: '', stderr: '' };
    };
    expect(daemon('status', stopped)).toBe('stopped');
    expect(stopped.calls).toEqual([
      ['systemctl', '--user', 'is-active', '--quiet', SYSTEMD_SERVICE_NAME],
    ]);
    expect(daemon('status', fake('linux'))).toBe('running');
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      'Daemon status: not-installed.',
      'Daemon status: stopped.',
      'Daemon status: running.',
    ]);
    log.mockRestore();
  });
});

describe('launchd lifecycle', () => {
  it('uses exact launchctl domains and canonical logs', () => {
    const deps = fake('darwin', false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    daemon('install', deps);
    daemon('start', deps);
    daemon('stop', deps);
    daemon('logs', deps);
    daemon('uninstall', deps);
    expect(deps.calls).toEqual([
      ['mkdir', '/home/tester/Library/LaunchAgents'],
      ['mkdir', '/private/data'],
      ['writeFile', `/home/tester/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`],
      [
        'launchctl',
        'bootstrap',
        'gui/501',
        `/home/tester/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
      ],
      ['launchctl', 'print', `gui/501/${LAUNCHD_LABEL}`],
      ['launchctl', 'kickstart', `gui/501/${LAUNCHD_LABEL}`],
      ['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`],
      [
        'tail',
        '-n',
        '50',
        '-f',
        '/private/data/daemon.stdout.log',
        '/private/data/daemon.stderr.log',
      ],
      ['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`],
      ['remove', `/home/tester/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`],
    ]);
    log.mockRestore();
  });

  it('bootstraps an installed but unloaded agent so it starts after stop', () => {
    const deps = fake('darwin');
    deps.run = (command, args) => {
      deps.calls.push([command, ...args]);
      return {
        status: command === 'launchctl' && args[0] === 'print' ? 3 : 0,
        stdout: '',
        stderr: '',
      };
    };
    daemon('start', deps);
    expect(deps.calls).toEqual([
      ['launchctl', 'print', `gui/501/${LAUNCHD_LABEL}`],
      [
        'launchctl',
        'bootstrap',
        'gui/501',
        `/home/tester/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
      ],
    ]);
  });

  it('distinguishes absent, loaded/stopped, and running launchd agents', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(daemon('status', fake('darwin', false))).toBe('not-installed');
    const stopped = fake('darwin');
    stopped.run = (command, args) => {
      stopped.calls.push([command, ...args]);
      return { status: 0, stdout: 'state = waiting\n', stderr: '' };
    };
    expect(daemon('status', stopped)).toBe('stopped');
    expect(stopped.calls).toEqual([['launchctl', 'print', `gui/501/${LAUNCHD_LABEL}`]]);
    const running = fake('darwin');
    running.run = () => ({ status: 0, stdout: 'state = running\npid = 12\n', stderr: '' });
    expect(daemon('status', running)).toBe('running');
    log.mockRestore();
  });
});

describe('unsupported daemon platforms', () => {
  it('does not attempt process-manager commands', () => {
    const deps = fake('win32');
    expect(() => daemon('status', deps)).toThrow('Daemon management is not supported on win32');
    expect(deps.calls).toEqual([]);
  });
});
