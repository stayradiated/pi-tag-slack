import { describe, expect, it } from 'vitest';
import {
  validateGatewayConfigRow,
  validateInboxRow,
  validateScheduleRow,
  validateSlackEventRow,
  validateTaskRow,
  validateTrustedUserRow,
} from '../src/db-validation.js';

const stamp = '2030-01-01T00:00:00.000Z';

const config = () => ({
  id: 1,
  channel_id: 'C0123456789',
  channel_label: 'gateway',
  working_directory: '/work',
  pi_binary: 'pi',
  default_model: 'provider/model',
  default_thinking: 'medium',
  session_model_override: null,
  session_thinking_override: null,
  archive_retention_days: 30,
  media_retention_hours: 168,
  max_attachment_bytes: 1,
  max_total_attachment_bytes: 1,
  scheduler_batch_limit: 1,
  log_level: 'info',
  created_at: stamp,
  updated_at: stamp,
});
const inbox = () => ({
  id: 1,
  slack_message_id: 'C0123456789:1.0',
  sender_id: 'U0123456789',
  sender_label: 'Ada',
  content: 'hello',
  revision: 1,
  message_ts: '1.0',
  thread_ts: '1.0',
  attachments: '[]',
  state: 'open',
  source_deleted_at: null,
  resolution_reason: null,
  resolved_at: null,
  reaction_desired: 'eyes',
  reaction_actual: null,
  reaction_error: null,
  reaction_next_attempt_at: null,
  latest_reply_ts: null,
  latest_reply_at: null,
  created_at: stamp,
  updated_at: stamp,
});
const event = () => ({
  source_identity: 'slack:event:Ev_1',
  kind: 'new-message',
  inbox_id: 1,
  inbox_revision: 1,
  outcome: 'created',
  rpc_accepted_at: null,
  pi_session_id: null,
  run_sequence: null,
  created_at: stamp,
});
const schedule = () => ({
  id: 1,
  title: 'once',
  instructions: 'later',
  kind: 'at',
  at_time: stamp,
  cron_expression: null,
  timezone: null,
  enabled: 1,
  next_run_at: stamp,
  created_at: stamp,
  updated_at: stamp,
});
const task = () => ({
  id: 1,
  source: 'manual',
  occurrence_key: null,
  schedule_id: null,
  title: 'task',
  instructions: 'do it',
  catch_up_first_at: null,
  catch_up_last_at: null,
  catch_up_count: null,
  state: 'open',
  resolution_reason: null,
  resolved_at: null,
  rpc_accepted_at: null,
  pi_session_id: null,
  run_sequence: null,
  created_at: stamp,
});

describe('persisted row validators', () => {
  it('accepts valid plain rows', () => {
    expect(() => validateGatewayConfigRow(config())).not.toThrow();
    expect(() =>
      validateTrustedUserRow({ user_id: 'U0123456789', label: 'Ada', created_at: stamp }),
    ).not.toThrow();
    expect(() => validateInboxRow(inbox())).not.toThrow();
    expect(() => validateSlackEventRow(event())).not.toThrow();
    expect(() => validateScheduleRow(schedule())).not.toThrow();
    expect(() => validateTaskRow(task())).not.toThrow();
  });

  it('rejects representative cross-field invariant failures', () => {
    expect(() => validateGatewayConfigRow({ ...config(), scheduler_batch_limit: 0 })).toThrow(
      'Malformed gateway configuration singleton.',
    );
    expect(() =>
      validateTrustedUserRow({ user_id: 'U0123456789', label: '', created_at: stamp }),
    ).toThrow('Malformed persisted trusted-user data.');
    expect(() => validateInboxRow({ ...inbox(), state: 'resolved' })).toThrow(
      'Malformed persisted inbox data.',
    );
    expect(() => validateSlackEventRow({ ...event(), rpc_accepted_at: stamp })).toThrow(
      'Malformed persisted Slack-event data.',
    );
    expect(() => validateScheduleRow({ ...schedule(), enabled: 0, next_run_at: stamp })).toThrow(
      'Malformed persisted schedule data.',
    );
    expect(() => validateTaskRow({ ...task(), rpc_accepted_at: stamp })).toThrow(
      'Malformed persisted task data.',
    );
  });
});
