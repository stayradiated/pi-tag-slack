import { describe, expect, it } from 'vitest';
import {
  MAX_CONTROL_FRAME_BYTES,
  decodeRequestFrame,
  errorReply,
  serializeReply,
} from '../src/control-protocol.js';

describe('control protocol validation and serialization', () => {
  it('decodes exactly the supported request envelope', () => {
    expect(
      decodeRequestFrame(
        Buffer.from('{"version":1,"id":"health-1","command":"health","params":{}}'),
      ),
    ).toEqual({ version: 1, id: 'health-1', command: 'health', params: {} });

    expect(() =>
      decodeRequestFrame(Buffer.from('{"version":1,"id":"health-1","command":"health"}')),
    ).toThrow('Invalid control request.');
    expect(() => decodeRequestFrame(Buffer.from([0xff]))).toThrow(
      'Control request must be valid UTF-8.',
    );
  });

  it('serializes newline-framed replies and rejects oversized replies', () => {
    expect(serializeReply({ id: 'health-1', result: { database: 'ok' } })).toBe(
      '{"id":"health-1","result":{"database":"ok"}}\n',
    );

    expect(() =>
      serializeReply({ id: 'large', result: 'x'.repeat(MAX_CONTROL_FRAME_BYTES) }),
    ).toThrow('Response exceeds frame limit.');
  });

  it('keeps safe error serialization at the protocol boundary', () => {
    expect(
      errorReply(
        'request-1',
        Object.assign(new Error('provider details'), { code: 'SLACK_ERROR' }),
      ),
    ).toEqual({
      id: 'request-1',
      error: { code: 'SLACK_ERROR', message: 'Slack request failed.' },
    });
  });
});
