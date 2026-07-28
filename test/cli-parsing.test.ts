import { describe, expect, it } from 'vitest';
import { parseCliCommand, parseSetupOptions } from '../src/cli/parsing.js';

describe('CLI argument parsing', () => {
  it('returns a fully parsed runtime request without dispatching it', () => {
    expect(
      parseCliCommand([
        'session',
        'archive',
        'list',
        '--limit',
        '17',
        '--cursor',
        'opaque',
        '--json',
      ]),
    ).toEqual({
      kind: 'runtime',
      command: 'session.archive.list',
      params: { limit: 17, cursor: 'opaque' },
      json: true,
    });
  });

  it('parses setup options independently from setup orchestration', () => {
    expect(
      parseSetupOptions([
        '--channel',
        'C123',
        '--cwd',
        '/work',
        '--model',
        'openai/gpt',
        '--reset',
        '--yes',
      ]),
    ).toMatchObject({
      channel: 'C123',
      cwd: '/work',
      model: 'openai/gpt',
      reset: true,
      yes: true,
    });
  });

  it('preserves invalid command and option errors', () => {
    expect(() => parseCliCommand(['unknown'])).toThrow(/Unsupported command/);
    expect(() => parseCliCommand(['task', 'list', '--bogus'])).toThrow('Unknown option: --bogus');
  });
});
