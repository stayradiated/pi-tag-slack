import { describe, expect, it } from 'vitest';
import {
  buildTriggerPattern,
  containsBotMention,
  normalizeSlackText,
  resolveInboundContent,
  splitMessage,
  SLACK_MAX_MESSAGE_LENGTH,
} from '../src/slack/text.js';

describe('normalizeSlackText', () => {
  it('decodes the three Slack HTML entities', () => {
    expect(normalizeSlackText('a &amp; b &lt; c &gt; d')).toBe('a & b < c > d');
  });

  it('decodes literal user-typed entities exactly once', () => {
    // User typed "&lt;" — Slack escapes the ampersand to "&amp;lt;".
    expect(normalizeSlackText('&amp;lt;')).toBe('&lt;');
  });

  it('unwraps bare links', () => {
    expect(normalizeSlackText('see <https://example.com/a?b=1>')).toBe(
      'see https://example.com/a?b=1',
    );
  });

  it('drops redundant link labels', () => {
    expect(normalizeSlackText('<https://example.com|example.com>')).toBe('https://example.com');
    expect(normalizeSlackText('<https://example.com|https://example.com>')).toBe(
      'https://example.com',
    );
    expect(normalizeSlackText('<mailto:a@b.com|a@b.com>')).toBe('mailto:a@b.com');
  });

  it('keeps meaningful link labels as markdown', () => {
    expect(normalizeSlackText('<https://example.com|the docs>')).toBe(
      '[the docs](https://example.com)',
    );
  });

  it('converts channel references', () => {
    expect(normalizeSlackText('ask in <#C0123ABC|general>')).toBe('ask in #general');
    expect(normalizeSlackText('ask in <#C0123ABC>')).toBe('ask in #C0123ABC');
  });

  it('converts special mentions', () => {
    expect(normalizeSlackText('<!here> and <!channel>')).toBe('@here and @channel');
    expect(normalizeSlackText('<!subteam^S012345|@devs>')).toBe('@devs');
  });

  it('leaves user mentions intact', () => {
    expect(normalizeSlackText('hey <@U0123456789> hi')).toBe('hey <@U0123456789> hi');
  });

  it('handles code-looking text a user typed', () => {
    expect(normalizeSlackText('if (a &lt; b &amp;&amp; b &gt; c) {}')).toBe(
      'if (a < b && b > c) {}',
    );
  });
});

describe('resolveInboundContent', () => {
  const opts = { botUserId: 'U0BOT123', triggerName: 'pi' };

  it('translates a real bot mention into the trigger prefix', () => {
    expect(resolveInboundContent('<@U0BOT123> run the tests', opts)).toBe('@pi run the tests');
  });

  it('handles labeled bot mentions', () => {
    expect(resolveInboundContent('<@U0BOT123|pi> hello', opts)).toBe('@pi hello');
  });

  it('does not double-prefix when the trigger is already present', () => {
    expect(resolveInboundContent('<@U0BOT123> @pi do it', opts)).toBe('@pi do it');
  });

  it('normalizes entities in mention-triggered content', () => {
    expect(resolveInboundContent('<@U0BOT123> a &amp; b &lt; c', opts)).toBe('@pi a & b < c');
  });

  it('never false-triggers on escaped literal mention text', () => {
    // User typed the literal text `<@U0BOT123>` (e.g. quoting a payload);
    // Slack delivers it entity-escaped. It must decode without triggering.
    expect(resolveInboundContent('&lt;@U0BOT123&gt; what does this render as?', opts)).toBe(
      '<@U0BOT123> what does this render as?',
    );
  });

  it('never matches another user id sharing the bot id as a prefix', () => {
    expect(resolveInboundContent('<@U0BOT1234> hi', opts)).toBe('<@U0BOT1234> hi');
  });

  it('normalizes without mention handling when the bot id is unknown', () => {
    expect(resolveInboundContent('a &amp; b', { botUserId: '', triggerName: 'pi' })).toBe('a & b');
  });
});

describe('buildTriggerPattern', () => {
  it('matches the trigger prefix case-insensitively at the start only', () => {
    const pattern = buildTriggerPattern('pi');
    expect(pattern.test('@pi status')).toBe(true);
    expect(pattern.test('@PI status')).toBe(true);
    expect(pattern.test('say @pi status')).toBe(false);
    expect(pattern.test('@pier status')).toBe(false);
  });

  it('matches the bare trigger name without @', () => {
    const pattern = buildTriggerPattern('pi');
    expect(pattern.test('pi status')).toBe(true);
    expect(pattern.test('PI status')).toBe(true);
    expect(pattern.test('pier status')).toBe(false);
    expect(pattern.test('say pi status')).toBe(false);
  });

  it('escapes regex metacharacters in the trigger name', () => {
    const pattern = buildTriggerPattern('pi.bot');
    expect(pattern.test('@pi.bot status')).toBe(true);
    expect(pattern.test('@piXbot status')).toBe(false);
  });
});

describe('containsBotMention', () => {
  it('detects real mentions, terminated only', () => {
    expect(containsBotMention('<@U0BOT123> hi', 'U0BOT123')).toBe(true);
    expect(containsBotMention('<@U0BOT123|pi> hi', 'U0BOT123')).toBe(true);
    expect(containsBotMention('<@U0BOT1234> hi', 'U0BOT123')).toBe(false);
    expect(containsBotMention('&lt;@U0BOT123&gt; hi', 'U0BOT123')).toBe(false);
    expect(containsBotMention('hello', 'U0BOT123')).toBe(false);
    expect(containsBotMention('<@U0BOT123> hi', '')).toBe(false);
  });
});

describe('splitMessage', () => {
  it('returns short text as a single chunk', () => {
    expect(splitMessage('hello', 10)).toEqual(['hello']);
  });

  it('splits at newline boundaries within the limit', () => {
    const text = 'aaa\nbbb\nccc';
    expect(splitMessage(text, 8)).toEqual(['aaa\nbbb', 'ccc']);
  });

  it('hard-splits when no newline is available', () => {
    expect(splitMessage('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('never severs a surrogate pair on a hard split', () => {
    // '😀' is two UTF-16 code units; place the limit mid-pair.
    const text = 'abc😀def';
    const chunks = splitMessage(text, 4);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('defaults to the Slack outbound limit', () => {
    const text = 'x'.repeat(SLACK_MAX_MESSAGE_LENGTH + 1);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBeLessThanOrEqual(SLACK_MAX_MESSAGE_LENGTH);
  });
});
