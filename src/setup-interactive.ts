import * as clack from '@clack/prompts';

export type InteractiveSetupValues = {
  channel: string;
  cwd: string;
  piBin: string;
  model: string;
  thinking: string;
  botToken: string;
  appToken: string;
  trustedUser: string;
};

export interface SetupPrompts {
  text(options: { message: string; initialValue?: string }): Promise<string | symbol>;
  select(options: {
    message: string;
    initialValue?: string;
    options: { value: string; label: string }[];
  }): Promise<string | symbol>;
  confirm(options: { message: string }): Promise<boolean | symbol>;
  isCancel(value: unknown): boolean;
  message(value: string): void;
}

export const systemSetupPrompts: SetupPrompts = {
  text: clack.text,
  select: clack.select,
  confirm: clack.confirm,
  isCancel: clack.isCancel,
  message: (value) => clack.cancel(value),
};

function cancelled(prompts: SetupPrompts, value: unknown): boolean {
  if (!prompts.isCancel(value)) return false;
  prompts.message('Setup cancelled; no changes were made.');
  return true;
}

/** Collects values only; validation and all durable work remain in setup's core. */
export async function collectInteractiveSetup(
  prompts: SetupPrompts,
): Promise<InteractiveSetupValues | undefined> {
  const trustedUser = await prompts.text({ message: 'Initial trusted Slack user (U... or W...)' });
  if (cancelled(prompts, trustedUser)) return undefined;
  const channel = await prompts.text({ message: 'Slack channel ID (C... or G...)' });
  if (cancelled(prompts, channel)) return undefined;
  const cwd = await prompts.text({ message: 'Working directory', initialValue: process.cwd() });
  if (cancelled(prompts, cwd)) return undefined;
  const piBin = await prompts.text({ message: 'pi binary', initialValue: 'pi' });
  if (cancelled(prompts, piBin)) return undefined;
  const model = await prompts.text({ message: 'Default model (provider/model)' });
  if (cancelled(prompts, model)) return undefined;
  const thinking = await prompts.select({
    message: 'Default thinking level',
    initialValue: 'medium',
    options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
      value,
      label: value,
    })),
  });
  if (cancelled(prompts, thinking)) return undefined;
  // Visible entry is intentional: tokens stay out of argv/history but can be
  // observed in this terminal or its recording.
  const botToken = await prompts.text({ message: 'Slack bot token (xoxb-...)' });
  if (cancelled(prompts, botToken)) return undefined;
  const appToken = await prompts.text({ message: 'Slack app token (xapp-...)' });
  if (cancelled(prompts, appToken)) return undefined;
  return {
    channel: channel as string,
    cwd: cwd as string,
    piBin: piBin as string,
    model: model as string,
    thinking: thinking as string,
    botToken: botToken as string,
    appToken: appToken as string,
    trustedUser: trustedUser as string,
  };
}

export async function confirmInteractiveReset(
  prompts: SetupPrompts,
  message: string,
): Promise<boolean> {
  const value = await prompts.text({ message });
  if (cancelled(prompts, value)) return false;
  return value === 'RESET';
}

export async function confirmInteractiveRecovery(prompts: SetupPrompts): Promise<boolean> {
  const value = await prompts.confirm({
    message: 'An interrupted reset was found. Restore its backup now?',
  });
  if (cancelled(prompts, value)) return false;
  return value === true;
}
