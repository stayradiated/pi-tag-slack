import { gatewayPaths } from './paths.js';

export const SYSTEMD_SERVICE_NAME = 'pi-tag-slack.service';
export const LAUNCHD_LABEL = 'com.stayradiated.pi-tag-slack';

type SystemdDependencies = Pick<
  ServiceDefinitionDependencies,
  'nodePath' | 'cliPath' | 'configPath' | 'dataDir'
>;
type LaunchdDependencies = Pick<
  ServiceDefinitionDependencies,
  'nodePath' | 'cliPath' | 'configPath' | 'dataDir' | 'homeDirectory' | 'pathEnvironment'
>;

interface ServiceDefinitionDependencies {
  homeDirectory: string;
  nodePath: string;
  cliPath: string;
  pathEnvironment: string;
  configPath: string;
  dataDir: string;
}

function systemdEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function systemdUnit(deps: SystemdDependencies): string {
  const quote = (value: string) => `"${systemdEscape(value)}"`;
  return [
    '[Unit]',
    'Description=pi-tag-slack Slack Gateway',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quote(deps.nodePath)} ${quote(deps.cliPath)} start`,
    'Restart=on-failure',
    'RestartSec=10',
    'StandardOutput=journal',
    'StandardError=journal',
    `Environment="PI_TAG_SLACK_CONFIG=${systemdEscape(deps.configPath)}"`,
    `Environment="PI_TAG_SLACK_DATA_DIR=${systemdEscape(deps.dataDir)}"`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function launchdPlist(deps: LaunchdDependencies): string {
  const paths = gatewayPaths(deps.dataDir);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(deps.nodePath)}</string>`,
    `    <string>${xml(deps.cliPath)}</string>`,
    '    <string>start</string>',
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(deps.homeDirectory)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PI_TAG_SLACK_CONFIG</key>',
    `    <string>${xml(deps.configPath)}</string>`,
    '    <key>PI_TAG_SLACK_DATA_DIR</key>',
    `    <string>${xml(deps.dataDir)}</string>`,
    '    <key>PATH</key>',
    `    <string>${xml(deps.pathEnvironment)}</string>`,
    '  </dict>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(paths.stdout)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(paths.stderr)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
