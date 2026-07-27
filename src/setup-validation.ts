import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebClient } from '@slack/web-api';
import { PiRpcSession, piVersion } from './pi-rpc.js';
import { validateConfiguredConversation } from './slack-validation.js';

export type SetupValidationInput = {
  channelId: string;
  workingDirectory: string;
  piBinary: string;
  model: string;
  thinking: string;
  botToken: string;
  appToken: string;
  trustedUserId: string;
};

export type SetupValidationResult = { channelLabel: string; trustedUserLabel: string };

type BotClient = {
  auth: { test(): Promise<unknown> };
  conversations: { info(args: { channel: string }): Promise<unknown> };
  users: { info(args: { user: string }): Promise<unknown> };
};
type AppClient = { apps: { connections: { open(): Promise<unknown> } } };

export type SetupValidationDependencies = {
  createBotClient(token: string): BotClient;
  createAppClient(token: string): AppClient;
  validatePi(
    input: Pick<SetupValidationInput, 'piBinary' | 'workingDirectory' | 'model' | 'thinking'>,
  ): Promise<void>;
};

const defaultDependencies: SetupValidationDependencies = {
  createBotClient: (token) => new WebClient(token) as unknown as BotClient,
  createAppClient: (token) => new WebClient(token) as unknown as AppClient,
  async validatePi({ piBinary, workingDirectory, model, thinking }): Promise<void> {
    // This session is deliberately outside the gateway layout and is always
    // removed: setup validation must not leave an active or staged session.
    const sessionDir = mkdtempSync(join(tmpdir(), 'pi-tag-slack-setup-rpc-'));
    const session = new PiRpcSession({
      binary: piBinary,
      cwd: workingDirectory,
      sessionDir,
      desired: () => ({ model, thinking }),
      version: piVersion,
    });
    try {
      await session.start();
    } finally {
      try {
        await session.stop();
      } finally {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  },
};

function slackOk(response: unknown, operation: string): void {
  if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true)
    throw new Error(
      `Slack ${operation} failed: ${String((response as { error?: unknown })?.error ?? 'unknown')}.`,
    );
}

function cosmeticLabel(value: Record<string, unknown> | undefined, kind: string): string {
  const profile = value?.profile as Record<string, unknown> | undefined;
  for (const candidate of [
    profile?.display_name,
    profile?.real_name,
    value?.real_name,
    value?.name,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  throw new Error(`Slack ${kind} did not provide a cosmetic label.`);
}

/** Runs every setup check which must precede creation of database/config state. */
export async function validateFirstTimeSetup(
  input: SetupValidationInput,
  dependencies: SetupValidationDependencies = defaultDependencies,
): Promise<SetupValidationResult> {
  let workingDirectory;
  try {
    workingDirectory = statSync(input.workingDirectory);
  } catch {
    throw new Error(`Working directory does not exist: ${input.workingDirectory}`);
  }
  if (!workingDirectory.isDirectory())
    throw new Error(`Working directory is not a directory: ${input.workingDirectory}`);
  if (!/^[CG][A-Z0-9]+$/.test(input.channelId))
    throw new Error('Setup requires a raw uppercase C... or G... conversation ID.');
  if (!/^[UW][A-Z0-9]+$/.test(input.trustedUserId))
    throw new Error('Setup requires a raw uppercase U... or W... trusted user ID.');
  if (!input.botToken.startsWith('xoxb-')) throw new Error('Setup requires an xoxb- bot token.');
  if (!input.appToken.startsWith('xapp-')) throw new Error('Setup requires an xapp- app token.');

  await dependencies.validatePi(input);

  const bot = dependencies.createBotClient(input.botToken);
  const auth = (await bot.auth.test()) as { ok?: unknown; user_id?: unknown; error?: unknown };
  slackOk(auth, 'auth.test');
  if (typeof auth.user_id !== 'string' || !auth.user_id)
    throw new Error('Slack auth.test did not return a bot user ID.');

  const app = dependencies.createAppClient(input.appToken);
  slackOk(await app.apps.connections.open(), 'apps.connections.open');

  const channelLabel = await validateConfiguredConversation(bot, input.channelId);
  const userResponse = (await bot.users.info({ user: input.trustedUserId })) as {
    ok?: unknown;
    user?: Record<string, unknown>;
    error?: unknown;
  };
  slackOk(userResponse, 'users.info');
  if (
    !userResponse.user ||
    userResponse.user.id !== input.trustedUserId ||
    userResponse.user.deleted === true
  )
    throw new Error('Initial trusted Slack user is invalid or deactivated.');
  return { channelLabel, trustedUserLabel: cosmeticLabel(userResponse.user, 'user') };
}
