/** Startup-only Slack validation. No event ingestion path calls this API. */
export async function validateConfiguredConversation(
  client: { conversations: { info(args: { channel: string }): Promise<unknown> } },
  channelId: string,
): Promise<string> {
  const response = (await client.conversations.info({ channel: channelId })) as {
    ok?: unknown;
    channel?: Record<string, unknown>;
    error?: unknown;
  };
  const channel = response.channel;
  if (response.ok !== true || !channel)
    throw new Error(
      `Cannot access configured Slack conversation: ${String(response.error ?? 'unknown')}.`,
    );
  if (
    channel.is_im === true ||
    channel.is_mpim === true ||
    (channel.is_channel !== true && channel.is_group !== true)
  )
    throw new Error('Configured Slack conversation must be a public channel or private channel.');
  // conversations.info reports membership for the token owner. This catches a
  // removed bot before Socket Mode begins accepting events.
  if (channel.is_member !== true)
    throw new Error(
      'The Slack bot is not a member of the configured conversation; invite it first.',
    );
  if (typeof channel.name !== 'string' || !channel.name.trim())
    throw new Error('Configured Slack conversation did not provide a cosmetic label.');
  return channel.name;
}
