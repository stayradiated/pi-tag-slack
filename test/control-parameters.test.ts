import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  decodeTrustCursor,
  encodeCursor,
  encodeTrustCursor,
  fileId,
  filePaths,
  ids,
  limit,
  optionalCursor,
  state,
  text,
  trustUserId,
} from '../src/control-parameters.js';

function invalid(operation: () => unknown, message: string) {
  expect(operation).toThrow(message);
  try {
    operation();
  } catch (error) {
    expect((error as { code?: string }).code).toBe('INVALID_PARAMS');
  }
}

describe('control parameters', () => {
  it('coerces list limits and validates their inclusive boundaries', () => {
    expect(limit(undefined)).toBe(50);
    expect(limit('1')).toBe(1);
    expect(limit(200)).toBe(200);
    invalid(() => limit(0), 'limit must be an integer from 1 to 200.');
    invalid(() => limit(201), 'limit must be an integer from 1 to 200.');
    invalid(() => limit('1.5'), 'limit must be an integer from 1 to 200.');
  });

  it('validates states, text, paths, IDs, and Slack IDs without changing values', () => {
    expect(state(undefined)).toBe('open');
    expect(state('all')).toBe('all');
    invalid(() => state('closed'), 'state must be open, resolved, or all.');
    expect(text('  value  ', 'name')).toBe('value');
    invalid(() => text(' ', 'name'), 'name must be non-empty.');
    expect(filePaths(undefined)).toEqual([]);
    expect(filePaths([' relative ', '/tmp/file'])).toEqual([' relative ', '/tmp/file']);
    invalid(() => filePaths(['']), 'files must be an array of non-empty paths.');
    expect(ids(['inbox-1'])).toEqual(['inbox-1']);
    invalid(() => ids([]), 'ids must be a non-empty string array.');
    expect(fileId('F012ABC')).toBe('F012ABC');
    invalid(() => fileId('f012'), 'Slack file ID must be a raw uppercase F... ID.');
    expect(trustUserId('W012ABC')).toBe('W012ABC');
    invalid(() => trustUserId('C012'), 'Slack user ID must be a raw uppercase U... or W... ID.');
    expect(optionalCursor(undefined)).toBeUndefined();
    expect(optionalCursor(' cursor ')).toBe('cursor');
  });

  it('round trips byte-compatible newest-first list cursors', () => {
    const encoded = encodeCursor({ created_at: '2026-07-28T09:14:12.000Z', id: 12 });
    expect(encoded).toBe(
      Buffer.from(JSON.stringify({ createdAt: '2026-07-28T09:14:12.000Z', id: 12 })).toString(
        'base64url',
      ),
    );
    expect(decodeCursor(encoded)).toEqual({ createdAt: '2026-07-28T09:14:12.000Z', id: 12 });
    expect(decodeCursor(undefined)).toBeUndefined();
    invalid(() => decodeCursor(''), 'cursor must be a non-empty string.');
    invalid(() => decodeCursor('not-a-cursor'), 'cursor is invalid.');
    invalid(
      () => decodeCursor(Buffer.from('{"createdAt":"x","id":0}').toString('base64url')),
      'cursor is invalid.',
    );
  });

  it('round trips byte-compatible ascending trust cursors', () => {
    const cursor = { createdAt: '2026-07-28T09:14:12.000Z', userId: 'U012ABC' };
    const encoded = encodeTrustCursor(cursor);
    expect(encoded).toBe(Buffer.from(JSON.stringify(cursor)).toString('base64url'));
    expect(decodeTrustCursor(encoded)).toEqual(cursor);
    expect(decodeTrustCursor(undefined)).toBeUndefined();
    invalid(() => decodeTrustCursor(''), 'cursor must be a non-empty string.');
    invalid(() => decodeTrustCursor('not-a-cursor'), 'cursor is invalid.');
    invalid(
      () =>
        decodeTrustCursor(
          Buffer.from('{"createdAt":"x","userId":"C012ABC"}').toString('base64url'),
        ),
      'cursor is invalid.',
    );
  });
});
