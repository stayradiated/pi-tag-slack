#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { presentFailure, presentSuccess } from './presentation.js';
import { parseCliCommand, parseSetupOptions, type SetupOptions } from './parsing.js';
export { commandFor, paramsFor } from './parsing.js';
import {
  validateFirstTimeSetup,
  type SetupProgress,
  type SetupValidationDependencies,
} from '../setup-validation.js';
import { createResetBackupBundle } from '../reset-backup.js';
import { installFreshReset, readResetJournal, recoverInterruptedReset } from '../reset-install.js';
import { daemon } from '../daemon.js';
import {
  collectInteractiveSetup,
  confirmInteractiveRecovery,
  confirmInteractiveReset,
  systemSetupPrompts,
  type SetupPrompts,
} from '../setup-interactive.js';
import {
  addTrustedUser,
  closeDb,
  createGatewayConfig,
  initDb,
  requireConfiguredDb,
} from '../db.js';
import { resolveConfigPath, validateBootstrapConfigPath } from '../config.js';
import { offlineDoctor, onlineDoctor } from '../doctor.js';
import {
  acquireGatewayLock,
  ensurePrivateFile,
  ensurePrivateLayout,
  structuralPathExists,
} from '../paths.js';
import { request } from './control-client.js';
export { request } from './control-client.js';

const help = `pi-tag-slack

Usage:
  pi-tag-slack setup [--reset --yes] --channel <C...|G...> --cwd <path> --model <ref> --trusted-user <U...|W...>
  pi-tag-slack inbox list|show|working|respond|resolve ...
  pi-tag-slack slack history|message|thread|file download|send ...
  pi-tag-slack task add|list|show|resolve ...
  pi-tag-slack schedule add|list|show|enable|disable|remove ...
  pi-tag-slack trust add|list|remove ...
  pi-tag-slack config show|set|reset ...
  pi-tag-slack session status [--json]
  pi-tag-slack session reset [--confirm <session-id>:<run-sequence>]
  pi-tag-slack session archive list [--limit <n>] [--cursor <opaque>] [--json]
  pi-tag-slack session archive cleanup
  pi-tag-slack session model list [--json]|set <provider/model>|reset
  pi-tag-slack session thinking set <level>|reset
  pi-tag-slack doctor
  pi-tag-slack daemon install|uninstall|start|stop|status|logs
  pi-tag-slack start

Runtime commands use the daemon control socket. Run setup before starting the daemon.`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseCliCommand(argv);
  if (parsed.kind === 'help') {
    console.log(help);
    return 0;
  }
  if (parsed.kind === 'setup') return setup(parsed.args);
  if (parsed.kind === 'start') {
    const { startGateway } = await import('../index.js');
    await startGateway();
    return 0;
  }
  if (parsed.kind === 'doctor') return doctor();
  if (parsed.kind === 'daemon') {
    const status = daemon(parsed.verb);
    if (parsed.verb !== 'status' || status !== 'running') return 0;
    try {
      const health = await request('health', {});
      if (health.error) {
        console.log(`Daemon runtime: degraded (${health.error.code}).`);
        return 1;
      }
      const healthy = daemonHealthIsHealthy(health.result);
      console.log(`Daemon runtime: ${healthy ? 'healthy' : 'degraded'}.`);
      if (!healthy) console.log(presentSuccess('daemon.status', health.result, false));
      return healthy ? 0 : 1;
    } catch (error: unknown) {
      const code =
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'INTERNAL';
      console.log(`Daemon runtime: degraded (${code}).`);
      return 1;
    }
  }
  const response = await request(parsed.command, parsed.params);
  if (response.error)
    throw Object.assign(new Error(response.error.message), { code: response.error.code });
  console.log(presentSuccess(parsed.command, response.result, parsed.json));
  return 0;
}

export function daemonHealthIsHealthy(health: unknown): boolean {
  if (!health || typeof health !== 'object') return false;
  const value = health as Record<string, unknown>;
  const session = value.session as Record<string, unknown> | undefined;
  return value.database === 'ok' && value.control === 'ok' && session?.health === 'healthy';
}

async function doctor(): Promise<number> {
  // Prefer daemon-owned health. Only a genuine connection failure permits the
  // lock-gated offline path; daemon/protocol errors are not bypassed with SQLite.
  try {
    const health = await request('health', {});
    if (health.error) {
      const result = onlineDoctor({ control: 'error', error: health.error });
      console.log(JSON.stringify(result.report, null, 2));
      return result.exitCode;
    }
    const result = onlineDoctor(health.result);
    console.log(JSON.stringify(result.report, null, 2));
    return result.exitCode;
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== 'DAEMON_UNAVAILABLE') {
      const result = onlineDoctor({ control: 'error' });
      console.log(JSON.stringify(result.report, null, 2));
      return result.exitCode;
    }
  }
  const result = offlineDoctor();
  console.log(JSON.stringify(result.report, null, 2));
  return result.exitCode;
}

export interface SetupDependencies {
  /** Interactive seams keep tests away from terminals. */
  isInteractive(): boolean;
  prompts: SetupPrompts;
  /** Test-only setup/reset durability failure seam. */
  afterStep?: (step: string) => void;
}

export function systemSetupDependencies(): SetupDependencies {
  return {
    isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompts: systemSetupPrompts,
  };
}

function setupSuccess(): void {
  console.log(`Setup complete. The daemon was not installed or started.

To install the user service (first time only):
  pi-tag-slack daemon install

To start it:
  pi-tag-slack daemon start

To verify it:
  pi-tag-slack daemon status`);
}

export async function setup(
  args: string[],
  validationDependencies?: SetupValidationDependencies,
  dependencies = systemSetupDependencies(),
): Promise<number> {
  const options = parseSetupOptions(args);
  const { reset, yes } = options;
  const paths = ensurePrivateLayout();
  const journal = structuralPathExists(paths.journal) ? readResetJournal(paths.journal) : undefined;
  const incompleteJournal = journal !== undefined && journal.phase !== 'complete';
  const interactive = dependencies.isInteractive();
  if (!reset && incompleteJournal) {
    if (yes) {
      console.log(`Recovering interrupted reset from ${paths.journal}.`);
      recoverInterruptedReset({ paths, configPath: resolveConfigPath() });
      console.log(`Recovered interrupted reset at ${paths.db}.`);
      setupSuccess();
      return 0;
    }
    if (!interactive)
      throw new Error('An interrupted reset requires recovery. Run pi-tag-slack setup --yes.');
    console.log(`Interrupted reset detected: ${paths.journal}`);
    if (!(await confirmInteractiveRecovery(dependencies.prompts))) return 1;
    console.log(`Recovering interrupted reset from ${paths.journal}.`);
    recoverInterruptedReset({ paths, configPath: resolveConfigPath() });
    console.log(`Recovered interrupted reset at ${paths.db}.`);
    setupSuccess();
    return 0;
  }
  // --yes is reserved for deterministic reset-journal recovery, never setup consent.
  if (!reset && yes) {
    recoverInterruptedReset({ paths, configPath: resolveConfigPath() });
    console.log(`Recovered interrupted reset at ${paths.db}.`);
    setupSuccess();
    return 0;
  }
  const missingRequired =
    !options.channel ||
    !options.cwd ||
    !options.model ||
    !options.botToken ||
    !options.appToken ||
    !options.trustedUser;
  if (interactive && missingRequired) {
    const values = await collectInteractiveSetup(dependencies.prompts);
    if (!values) return 1;
    const collected = [
      '--channel',
      values.channel,
      '--cwd',
      values.cwd,
      '--pi-bin',
      values.piBin,
      '--model',
      values.model,
      '--thinking',
      values.thinking,
      '--bot-token',
      values.botToken,
      '--app-token',
      values.appToken,
      '--trusted-user',
      values.trustedUser,
      ...(reset ? ['--reset'] : []),
    ];
    return setupCore(
      parseSetupOptions(collected),
      validationDependencies,
      async (message) => confirmInteractiveReset(dependencies.prompts, message),
      dependencies.afterStep,
      (piBinary) => console.log(`Validated pi binary: ${piBinary}`),
      consoleSetupProgress(),
    ).then((result) => {
      if (result === 0) setupSuccess();
      return result;
    });
  }
  const result = await setupCore(
    options,
    validationDependencies,
    interactive && reset && !yes
      ? async (message) => confirmInteractiveReset(dependencies.prompts, message)
      : undefined,
    dependencies.afterStep,
    interactive ? (piBinary) => console.log(`Validated pi binary: ${piBinary}`) : undefined,
    consoleSetupProgress(),
  );
  if (result === 0) setupSuccess();
  return result;
}

function consoleSetupProgress(): SetupProgress {
  return {
    start: (label) => console.log(`${label}...`),
    success: (label) => console.log(`${label}: ok`),
    failure: (label) => console.log(`${label}: failed`),
  };
}

function validateSetupBootstrapDatabase(expected: {
  channelId: string;
  channelLabel: string;
  workingDirectory: string;
  piBinary: string;
  model: string;
  thinking: string;
  trustedUserId: string;
  trustedUserLabel: string;
}): void {
  const database = requireConfiguredDb();
  const configuration = database
    .prepare(
      `select channel_id, channel_label, working_directory, pi_binary,
              default_model, default_thinking from gateway_config where id = 1`,
    )
    .get();
  expectExactBootstrap(configuration, {
    channel_id: expected.channelId,
    channel_label: expected.channelLabel,
    working_directory: expected.workingDirectory,
    pi_binary: expected.piBinary,
    default_model: expected.model,
    default_thinking: expected.thinking,
  });
  const users = database.prepare('select user_id, label from trusted_users order by user_id').all();
  expectExactBootstrap(users, [
    { user_id: expected.trustedUserId, label: expected.trustedUserLabel },
  ]);
}

function expectExactBootstrap(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Database bootstrap values differ from validated setup values.');
}

function fsyncSetupPath(path: string, directory = false): void {
  const fd = openSync(
    path,
    constants.O_RDONLY | (directory ? constants.O_DIRECTORY : constants.O_NOFOLLOW),
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function setupCore(
  options: SetupOptions,
  validationDependencies?: SetupValidationDependencies,
  confirmReset?: (message: string) => Promise<boolean>,
  afterStep: (step: string) => void = () => {},
  onValidatedPiBinary?: (piBinary: string) => void,
  progress?: SetupProgress,
): Promise<number> {
  const { channel, cwd, model, reset, yes } = options;
  const botToken = options.botToken ?? process.env.SLACK_BOT_TOKEN?.trim();
  const appToken = options.appToken ?? process.env.SLACK_APP_TOKEN?.trim();
  const trusted = options.trustedUser;
  if (!channel || !cwd || !model || !botToken || !appToken || !trusted) {
    throw new Error(
      'Usage: pi-tag-slack setup --channel <C...|G...> --cwd <path> --model <ref> --trusted-user <U...|W...> (--bot-token <xoxb-...> --app-token <xapp-...> | environment tokens)',
    );
  }
  const piBinary = options.piBin ?? 'pi';
  const thinking = options.thinking ?? 'medium';
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking))
    throw new Error('Invalid default thinking level.');

  // Lock/layout checks are the only structural work before validation. They
  // create no application config/database state and serialize setup attempts.
  const repaired = (path: string, mode: number) =>
    console.log(`Repaired permissions: ${path} (${mode.toString(8).padStart(4, '0')})`);
  progress?.start('Checking local paths and acquiring the setup lock');
  const paths = ensurePrivateLayout(undefined, repaired);
  const lock = acquireGatewayLock(paths, { onRepair: repaired });
  progress?.success('Checking local paths and acquiring the setup lock');
  const configPath = resolveConfigPath();
  const suffix = `.setup-${randomUUID()}`;
  const stagedDb = `${paths.db}${suffix}`;
  const stagedConfig = `${configPath}${suffix}`;
  const stagedSession = `${paths.session}${suffix}`;
  let installedConfig = false;
  let installedDb = false;
  let installationComplete = false;
  try {
    validateBootstrapConfigPath(configPath, { repairPermissions: true, onRepair: repaired });
    ensurePrivateFile(paths.db, repaired);
    ensurePrivateFile(configPath, repaired);
    if ((structuralPathExists(paths.db) || structuralPathExists(configPath)) && !reset) {
      throw new Error(
        'Gateway state already exists; plain setup never replaces it. Use setup --reset.',
      );
    }
    if (reset && !yes && !confirmReset)
      throw new Error('setup --reset requires --yes in non-interactive mode.');
    // All local, RPC, and Slack validation runs before SQLite/config staging.
    const validated = await validateFirstTimeSetup(
      {
        channelId: channel,
        workingDirectory: cwd,
        piBinary,
        model,
        thinking,
        botToken,
        appToken,
        trustedUserId: trusted,
      },
      validationDependencies,
      progress,
    );
    onValidatedPiBinary?.(validated.piBinary);
    console.warn(
      "Warning: trusted Slack users can influence an agent with this daemon account's local capabilities.",
    );
    if (reset && !yes) {
      const confirmed = await confirmReset?.(
        `Type RESET to replace:\n  config: ${configPath}\n  database: ${paths.db}\n  session: ${paths.session}\nBackup bundle: ${paths.backups}/reset-<UTC>-<counter>/`,
      );
      if (!confirmed) {
        console.log('Reset cancelled; no changes were made.');
        return 1;
      }
    }

    // Build all durable state off to the side first. Nothing active is changed
    // until validation of the complete database singleton has succeeded.
    progress?.start('Writing and verifying staged state');
    initDb(stagedDb);
    try {
      createGatewayConfig({
        channelId: channel,
        channelLabel: validated.channelLabel,
        workingDirectory: cwd,
        piBinary: validated.piBinary,
        defaultModel: model,
        defaultThinking: thinking,
      });
      addTrustedUser(trusted, validated.trustedUserLabel);
    } finally {
      closeDb();
    }
    afterStep(`write:${stagedDb}`);
    fsyncSetupPath(stagedDb);
    afterStep(`fsync:${stagedDb}`);
    // Reopen the staged database before any active path is replaced. This
    // catches a malformed singleton and verifies the durable SQLite image.
    const expectedBootstrap = {
      channelId: channel,
      channelLabel: validated.channelLabel,
      workingDirectory: cwd,
      piBinary: validated.piBinary,
      model,
      thinking,
      trustedUserId: trusted,
      trustedUserLabel: validated.trustedUserLabel,
    };
    initDb(stagedDb);
    try {
      validateSetupBootstrapDatabase(expectedBootstrap);
      const quickCheck = requireConfiguredDb().pragma('quick_check', { simple: true }) as string;
      if (quickCheck !== 'ok') throw new Error(`Staged database quick_check failed: ${quickCheck}`);
    } finally {
      closeDb();
    }

    const configDirectory = dirname(configPath);
    const customConfigPath = Boolean(process.env.PI_TAG_SLACK_CONFIG?.trim());
    try {
      const configDirectoryStat = lstatSync(configDirectory);
      if (!configDirectoryStat.isDirectory() || configDirectoryStat.isSymbolicLink())
        throw new Error(`Bootstrap config parent is not a safe directory: ${configDirectory}`);
      if (customConfigPath && (configDirectoryStat.mode & 0o777) !== 0o700)
        throw new Error(
          `Custom bootstrap config parent must have mode 0700: ${configDirectory}. Run chmod 700 ${configDirectory} or choose another path.`,
        );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (customConfigPath)
        throw new Error(
          `Custom bootstrap config parent does not exist: ${configDirectory}. Create it with mode 0700 first.`,
          { cause: error },
        );
      mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    }
    // Only setup's default application directory is part of its owned layout.
    if (!customConfigPath) chmodSync(configDirectory, 0o700);
    writeFileSync(
      stagedConfig,
      `SLACK_BOT_TOKEN=${JSON.stringify(botToken)}\nSLACK_APP_TOKEN=${JSON.stringify(appToken)}\n`,
      { mode: 0o600 },
    );
    afterStep(`write:${stagedConfig}`);
    chmodSync(stagedConfig, 0o600);
    fsyncSetupPath(stagedConfig);
    afterStep(`fsync:${stagedConfig}`);
    validateBootstrapConfigPath(stagedConfig);
    const stagedBootstrap = readFileSync(stagedConfig, 'utf8');
    if (
      stagedBootstrap !==
      `SLACK_BOT_TOKEN=${JSON.stringify(botToken)}\nSLACK_APP_TOKEN=${JSON.stringify(appToken)}\n`
    )
      throw new Error('Staged bootstrap config validation failed.');
    progress?.success('Writing and verifying staged state');
    progress?.start('Installing setup state');
    if (reset) {
      mkdirSync(stagedSession, { mode: 0o700 });
      chmodSync(stagedSession, 0o700);
      const backup = await createResetBackupBundle({
        paths,
        configPath,
        lockHeld: true,
        afterStep,
      });
      installFreshReset({
        paths,
        configPath,
        backup,
        staged: { config: stagedConfig, database: stagedDb, session: stagedSession },
        afterStep,
      });
      installedConfig = true;
      installedDb = true;
      initDb(paths.db);
      try {
        validateSetupBootstrapDatabase(expectedBootstrap);
      } finally {
        closeDb();
      }
    } else {
      renameSync(stagedConfig, configPath);
      installedConfig = true;
      afterStep(`rename:${stagedConfig}:${configPath}`);
      fsyncSetupPath(dirname(configPath), true);
      afterStep(`fsync:${dirname(configPath)}`);
      renameSync(stagedDb, paths.db);
      installedDb = true;
      afterStep(`rename:${stagedDb}:${paths.db}`);
      fsyncSetupPath(dirname(paths.db), true);
      afterStep(`fsync:${dirname(paths.db)}`);
      ensurePrivateFile(configPath, repaired);
      ensurePrivateFile(paths.db, repaired);
      const expectedConfig =
        `SLACK_BOT_TOKEN=${JSON.stringify(botToken)}\n` +
        `SLACK_APP_TOKEN=${JSON.stringify(appToken)}\n`;
      if (readFileSync(configPath, 'utf8') !== expectedConfig)
        throw new Error('Installed bootstrap config differs from validated staged values.');
      initDb(paths.db);
      try {
        validateSetupBootstrapDatabase(expectedBootstrap);
      } finally {
        closeDb();
      }
    }
    installationComplete = true;
    progress?.success('Installing setup state');
    console.log(`Initialized schema v2 at ${paths.db}.`);
    return 0;
  } finally {
    closeDb();
    for (const path of [
      stagedConfig,
      stagedDb,
      `${stagedDb}-wal`,
      `${stagedDb}-shm`,
      stagedSession,
    ]) {
      rmSync(path, { force: true });
    }
    if (!installedDb && installedConfig) rmSync(configPath, { force: true });
    if (!reset && !installationComplete) {
      rmSync(configPath, { force: true });
      rmSync(paths.db, { force: true });
      rmSync(`${paths.db}-wal`, { force: true });
      rmSync(`${paths.db}-shm`, { force: true });
    }
    lock.release();
  }
}

if (process.argv[1]?.endsWith('/cli/index.js') || process.argv[1]?.endsWith('/cli/index.ts')) {
  void main().catch((error: unknown) => {
    const output = presentFailure(error, process.argv.slice(2).includes('--json'));
    // A failed JSON invocation writes one machine-readable value, and nothing
    // else, so an agent never needs to parse diagnostics from stderr.
    if (process.argv.slice(2).includes('--json')) console.log(output);
    else console.error(output);
    process.exitCode = 1;
  });
}
