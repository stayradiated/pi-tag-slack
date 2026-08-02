import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAUNCHD_LABEL, launchdPlist, systemdUnit } from '../src/daemon-service-definitions.js';

const dependencies = {
  homeDirectory: '/home/tester',
  nodePath: '/opt/node/bin/node',
  cliPath: '/opt/pi-tag-slack/dist/cli/index.js',
  pathEnvironment: '/opt/bin:/usr/bin',
  configPath: '/private/config.env',
  dataDir: '/private/data',
};

describe('daemon service definitions', () => {
  it('renders a complete systemd user unit', () => {
    expect(systemdUnit(dependencies)).toBe(`[Unit]
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

  it('renders a complete launchd plist', () => {
    expect(launchdPlist(dependencies)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node/bin/node</string>
    <string>/opt/pi-tag-slack/dist/cli/index.js</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/home/tester</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PI_TAG_SLACK_CONFIG</key>
    <string>/private/config.env</string>
    <key>PI_TAG_SLACK_DATA_DIR</key>
    <string>/private/data</string>
    <key>PATH</key>
    <string>/opt/bin:/usr/bin</string>
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/private/data/daemon.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/private/data/daemon.stderr.log</string>
</dict>
</plist>
`);
  });

  it('escapes percent signs, quotes, and backslashes in systemd values', () => {
    const unit = systemdUnit({
      ...dependencies,
      nodePath: '/opt/node%bin\\node',
      cliPath: '/opt/cli%"quoted',
      configPath: '/config%with\\"quotes',
      dataDir: '/data%"with\\slashes',
    });

    expect(unit).toContain(`ExecStart="/opt/node%%bin\\\\node" "/opt/cli%%\\"quoted" start
Restart=on-failure`);
    expect(unit).toContain('Environment="PI_TAG_SLACK_CONFIG=/config%%with\\\\\\"quotes"');
    expect(unit).toContain('Environment="PI_TAG_SLACK_DATA_DIR=/data%%\\"with\\\\slashes"');
  });

  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/systemd-analyze'))(
    'passes systemd-analyze verification with percent-containing environment values',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-systemd-'));
      const unitPath = join(directory, 'pi-tag-slack.service');
      try {
        writeFileSync(
          unitPath,
          systemdUnit({
            ...dependencies,
            nodePath: '/bin/true',
            cliPath: '/bin/true',
            configPath: '/private/config%value.env',
            dataDir: '/private/data%value',
          }),
        );
        expect(() => execFileSync('/usr/bin/systemd-analyze', ['verify', unitPath])).not.toThrow();
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it('escapes XML metacharacters in launchd values', () => {
    const plist = launchdPlist({
      ...dependencies,
      nodePath: '/node&<"',
      cliPath: '/cli&<"',
      homeDirectory: '/home&<"',
      configPath: '/config&<"',
      dataDir: '/data&<"',
      pathEnvironment: '/bin&<"',
    });
    expect(plist).toContain('<string>/node&amp;&lt;&quot;</string>');
    expect(plist).toContain('<string>/cli&amp;&lt;&quot;</string>');
    expect(plist).toContain('<string>/home&amp;&lt;&quot;</string>');
    expect(plist).toContain('<string>/config&amp;&lt;&quot;</string>');
    expect(plist).toContain('<string>/data&amp;&lt;&quot;</string>');
    expect(plist).toContain('<string>/bin&amp;&lt;&quot;</string>');
  });
});
