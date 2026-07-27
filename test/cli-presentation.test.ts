import { describe, expect, it } from 'vitest';
import { presentFailure, presentSuccess } from '../src/cli/presentation.js';

describe('CLI successful-response presentation', () => {
  const representative: Array<[string, unknown, string]> = [
    ['inbox.show', { id: 'inbox-1', state: 'open' }, 'id: inbox-1\nstate: open'],
    ['slack.message', { ts: '1.2', text: 'hello' }, 'text: hello\nts: 1.2'],
    ['task.add', { id: 'task-1', notified: true }, 'id: task-1\nnotified: true'],
    ['schedule.enable', { id: 'schedule-1', enabled: 1 }, 'enabled: 1\nid: schedule-1'],
    ['trust.add', { added: true, label: 'Ada' }, 'added: true\nlabel: Ada'],
    [
      'config.set',
      { key: 'archiveRetentionDays', value: '7' },
      'key: archiveRetentionDays\nvalue: 7',
    ],
    ['session.status', { active: false, health: 'healthy' }, 'active: false\nhealth: healthy'],
    [
      'session.model.set',
      { desiredModel: 'openai/gpt', applied: true },
      'applied: true\ndesiredModel: openai/gpt',
    ],
    ['session.thinking.reset', { desiredThinking: 'medium' }, 'desiredThinking: medium'],
    ['session.archive.cleanup', { removed: 2 }, 'removed: 2'],
  ];

  it.each(representative)('%s has stable concise human output', (command, result, expected) => {
    expect(presentSuccess(command, result, false)).toBe(expected);
  });

  it.each(representative)('%s emits its direct payload in JSON mode', (command, result) => {
    expect(presentSuccess(command, result, true)).toBe(JSON.stringify(result));
  });

  it('makes empty lists and continuation cursors visible', () => {
    expect(presentSuccess('inbox.list', { items: [], nextCursor: null }, false)).toBe(
      'No inbox items.',
    );
    expect(
      presentSuccess(
        'schedule.list',
        { items: [{ id: 'schedule-1', enabled: true }], nextCursor: 'opaque-next' },
        false,
      ),
    ).toBe('- enabled=true; id=schedule-1\nNext cursor: opaque-next');
  });

  it('prints mutation confirmations without dropping returned details', () => {
    expect(
      presentSuccess('inbox.respond', { id: 'inbox-2', replyTs: '2.3', resolved: true }, false),
    ).toBe('id: inbox-2\nreplyTs: 2.3\nresolved: true');
  });

  it('keeps JSON errors as one exact envelope and human errors off stdout', () => {
    const error = Object.assign(new Error('Inspect before retrying.'), { code: 'OUTCOME_UNKNOWN' });
    expect(presentFailure(error, true)).toBe(
      '{"error":{"code":"OUTCOME_UNKNOWN","message":"Inspect before retrying."}}',
    );
    expect(presentFailure(error, false)).toBe('Error [OUTCOME_UNKNOWN]: Inspect before retrying.');
  });
});
