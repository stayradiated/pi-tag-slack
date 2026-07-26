/**
 * Slack text utilities shared by the Socket Mode client and the one-shot
 * `pi-tag-slack send` path.
 */

/**
 * chat.postMessage truncates `text` at 40,000 but chat.update rejects at
 * 4,000, and markdown_text caps at 12,000 — take the strictest so every
 * outbound path is safe.
 */
export const SLACK_MAX_MESSAGE_LENGTH = 4000;

/** Split a message at newline boundaries, hard-splitting only when forced. */
export function splitMessage(text: string, max: number = SLACK_MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt <= 0) {
      splitAt = max; // hard split if no newline
      // Never sever a surrogate pair: chat.postMessage rejects lone surrogates.
      const code = remaining.charCodeAt(splitAt - 1);
      if (code >= 0xd800 && code <= 0xdbff && splitAt > 1) splitAt -= 1;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Undo Slack's inbound message encoding so pi sees what the human typed.
 *
 * Slack escapes `&`, `<`, `>` as HTML entities and wraps links/refs in
 * angle-bracket syntax (https://docs.slack.dev/messaging/formatting-message-text).
 * User mentions (`<@U…>`) are intentionally left intact — the bot's own
 * mention is handled on the raw text by resolveInboundContent, and other
 * mentions pass through verbatim like the Discord gateway did.
 */
export function normalizeSlackText(text: string): string {
  let result = text;

  // <#C123|general> / <#C123> → #general / #C123
  result = result.replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_m, id: string, label: string) =>
    label ? `#${label}` : `#${id}`,
  );
  result = result.replace(/<#([A-Z0-9]+)>/g, '#$1');

  // <!here> / <!channel> / <!everyone> → @here / @channel / @everyone
  result = result.replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1');
  // <!subteam^ID|@group> → @group
  result = result.replace(/<!subteam\^[A-Z0-9]+\|@?([^>]*)>/g, '@$1');

  // <url|label> → url when the label is just the rendered url, else [label](url)
  result = result.replace(
    /<((?:https?|mailto|tel):[^|>]*)\|([^>]*)>/g,
    (_m, url: string, label: string) => {
      const bareUrl = url.replace(/^(https?:\/\/|mailto:|tel:)/, '');
      if (!label || label === url || label === bareUrl) return url;
      return `[${label}](${url})`;
    },
  );
  // <https://url> → https://url
  result = result.replace(/<((?:https?|mailto|tel):[^|>]*)>/g, '$1');

  // HTML entities last (Slack only escapes these three); &amp; very last so
  // literal "&amp;lt;" typed by a user decodes to "&lt;", not "<".
  result = result.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  return result;
}

/**
 * Build the agent-facing content from RAW inbound Slack text.
 *
 * Bot-mention handling must run on the raw text, BEFORE entity decoding: a
 * real mention arrives as `<@U…>` while the same characters typed literally
 * (e.g. quoting a payload or writing `<@U…>` in backticks) arrive escaped as
 * `&lt;@U…&gt;`. Matching first guarantees decoded literal text can never
 * false-trigger the bot. A real mention is stripped and translated to the
 * `@<triggerName>` prefix (unless one is already present) so downstream
 * trigger checks treat mention and prefix identically.
 */
export function resolveInboundContent(
  rawText: string,
  opts: { botUserId: string; triggerName: string },
): string {
  // The pattern is terminated (`>` required) so another user id sharing the
  // bot's id as a prefix never false-triggers.
  const botMention = opts.botUserId
    ? new RegExp(`<@${escapeRegExp(opts.botUserId)}(\\|[^>]*)?>`, 'g')
    : null;
  if (!botMention?.test(rawText)) {
    return normalizeSlackText(rawText);
  }

  botMention.lastIndex = 0;
  const content = normalizeSlackText(rawText.replace(botMention, '').trim());
  const triggerPattern = buildTriggerPattern(opts.triggerName);
  return triggerPattern.test(content) ? content : `@${opts.triggerName} ${content}`;
}

/**
 * Pattern matching the trigger name at the start of a message. The trigger is
 * "calling the bot by name", so both `@Coly …` and the bare `Coly …` work
 * (mid-sentence occurrences never trigger).
 */
export function buildTriggerPattern(triggerName: string): RegExp {
  return new RegExp(`^@?${escapeRegExp(triggerName)}\\b`, 'i');
}

/** Whether the RAW (pre-decode) event text explicitly mentions the bot. */
export function containsBotMention(rawText: string, botUserId: string): boolean {
  if (!botUserId) return false;
  return new RegExp(`<@${escapeRegExp(botUserId)}(\\|[^>]*)?>`).test(rawText);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
