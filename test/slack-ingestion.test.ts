import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addTrustedUser,
  closeDb,
  createGatewayConfig,
  ingestSlackEvent,
  initDb,
} from '../src/db.js';
import {
  GatewayCoordinator,
  handleSocketModeEnvelope,
  processSlackEvent,
  reconcilePendingSlackEffects,
  type PiNotifier,
  type ReceiptReconciler,
  type SlackEventBody,
} from '../src/slack.js';

const directories: string[] = [];

function configuredDb(channelId = 'C0123456789'): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tag-slack-ingestion-'));
  directories.push(directory);
  const path = join(directory, 'gateway.db');
  initDb(path);
  createGatewayConfig({
    channelId,
    channelLabel: 'gateway',
    workingDirectory: '/tmp',
    piBinary: 'pi',
    defaultModel: 'provider/model',
    defaultThinking: 'medium',
  });
  addTrustedUser('U0123456789', 'Ada');
  return path;
}

function body(overrides: Record<string, unknown> = {}): SlackEventBody {
  return {
    event_id: 'Ev_top_level',
    event: {
      type: 'message',
      channel: 'C0123456789',
      channel_type: 'channel',
      user: 'U0123456789',
      ts: '123.456',
      text: '<@U_BOT> hello',
      ...overrides,
    },
  };
}

function notifier(onNotify: (message: string) => void = () => undefined): PiNotifier {
  return {
    async notify(message) {
      onNotify(message);
      return { acceptedAt: '2030-01-01T00:00:00.000Z', sessionId: 'session', runSequence: 1 };
    },
  };
}

function counts(path: string): { events: number; inbox: number } {
  const sqlite = new Database(path, { readonly: true });
  try {
    return {
      events: (sqlite.prepare('select count(*) as n from slack_events').get() as { n: number }).n,
      inbox: (sqlite.prepare('select count(*) as n from inbox').get() as { n: number }).n,
    };
  } finally {
    sqlite.close();
  }
}

afterEach(() => {
  closeDb();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('low-level Socket Mode durable admission', () => {
  it('commits a real Events API body before acknowledging, then runs effects', async () => {
    const path = configuredDb();
    const order: string[] = [];
    const receipts: ReceiptReconciler = {
      async received() {
        order.push('reaction');
      },
    };

    await expect(
      handleSocketModeEnvelope(
        {
          type: 'events_api',
          body: body(),
          ack: () => {
            expect(counts(path)).toEqual({ events: 1, inbox: 1 });
            order.push('ack');
          },
        },
        'U_BOT',
        notifier(() => order.push('notify')),
        new GatewayCoordinator(),
        receipts,
      ),
    ).resolves.toBe('accepted');

    expect(order).toEqual(['ack', 'reaction', 'notify']);
  });

  it('does not acknowledge or start post-commit effects when SQLite admission fails', async () => {
    const path = configuredDb();
    const sqlite = new Database(path);
    sqlite.exec(
      "create trigger fail_slack_admission before insert on slack_events begin select raise(abort, 'injected admission failure'); end",
    );
    sqlite.close();
    let acknowledgements = 0;
    let notifications = 0;
    let reactions = 0;

    await expect(
      processSlackEvent(
        body(),
        'U_BOT',
        notifier(() => notifications++),
        () => acknowledgements++,
        { received: async () => void reactions++ },
      ),
    ).rejects.toThrow(/injected admission failure/);

    expect({ acknowledgements, notifications, reactions }).toEqual({
      acknowledgements: 0,
      notifications: 0,
      reactions: 0,
    });
    expect(counts(path)).toEqual({ events: 0, inbox: 0 });
  });

  it('serializes concurrent duplicates and remains idempotent across restart', async () => {
    const path = configuredDb();
    const coordinator = new GatewayCoordinator();
    let acknowledgements = 0;
    let notifications = 0;
    let reactions = 0;
    const envelope = () => ({
      type: 'events_api',
      body: body(),
      ack: () => void acknowledgements++,
    });
    const receipts = { received: async () => void reactions++ };

    await expect(
      Promise.all([
        handleSocketModeEnvelope(
          envelope(),
          'U_BOT',
          notifier(() => notifications++),
          coordinator,
          receipts,
        ),
        handleSocketModeEnvelope(
          envelope(),
          'U_BOT',
          notifier(() => notifications++),
          coordinator,
          receipts,
        ),
      ]),
    ).resolves.toEqual(['accepted', 'duplicate']);
    expect({ acknowledgements, notifications, reactions }).toEqual({
      acknowledgements: 2,
      notifications: 1,
      reactions: 1,
    });
    expect(counts(path)).toEqual({ events: 1, inbox: 1 });

    closeDb();
    initDb(path);
    await expect(
      handleSocketModeEnvelope(
        envelope(),
        'U_BOT',
        notifier(() => notifications++),
        new GatewayCoordinator(),
        receipts,
      ),
    ).resolves.toBe('duplicate');
    expect({ acknowledgements, notifications, reactions }).toEqual({
      acknowledgements: 3,
      notifications: 1,
      reactions: 1,
    });
    expect(counts(path)).toEqual({ events: 1, inbox: 1 });
  });

  it('acks locally ignored bot, untrusted, channel-mismatch, missing-mention, and missing-ID events', async () => {
    const path = configuredDb();
    let acknowledgements = 0;
    let notifications = 0;
    let reactions = 0;
    const ignored = [
      body({ bot_id: 'B_OTHER' }),
      body({ user: 'U_NOT_TRUSTED' }),
      body({ channel: 'C_OTHER' }),
      body({ text: 'no mention' }),
      { event: body().event },
    ];

    for (const delivery of ignored) {
      await expect(
        processSlackEvent(
          delivery,
          'U_BOT',
          notifier(() => notifications++),
          () => acknowledgements++,
          { received: async () => void reactions++ },
        ),
      ).resolves.toBe('ignored');
    }

    expect({ acknowledgements, notifications, reactions }).toEqual({
      acknowledgements: ignored.length,
      notifications: 0,
      reactions: 0,
    });
    expect(counts(path)).toEqual({ events: 0, inbox: 0 });
  });

  it.each([
    ['public', 'C0123456789', 'channel'],
    ['private', 'G0123456789', 'group'],
  ])(
    'uses top-level event_id for new/edit/delete %s channel fixtures',
    async (_, channel, channelType) => {
      const path = configuredDb(channel);
      let acknowledgements = 0;
      let notifications = 0;
      const message = {
        type: 'message',
        channel,
        channel_type: channelType,
        user: 'U0123456789',
        ts: '456.789',
        text: '<@U_BOT> initial',
      };
      const fixtures: SlackEventBody[] = [
        { event_id: 'Ev_fixture_new', event: message },
        {
          event_id: 'Ev_fixture_edit',
          event: {
            type: 'message',
            subtype: 'message_changed',
            channel,
            channel_type: channelType,
            message: { ...message, text: 'edited' },
          },
        },
        {
          event_id: 'Ev_fixture_delete',
          event: {
            type: 'message',
            subtype: 'message_deleted',
            channel,
            channel_type: channelType,
            previous_message: { ...message, text: 'edited' },
          },
        },
      ];

      for (const fixture of fixtures) {
        await expect(
          processSlackEvent(
            fixture,
            'U_BOT',
            notifier(() => notifications++),
            () => acknowledgements++,
          ),
        ).resolves.toBe('accepted');
      }

      const sqlite = new Database(path, { readonly: true });
      try {
        const identities = (
          sqlite
            .prepare('select source_identity from slack_events order by source_identity')
            .all() as Array<{
            source_identity: string;
          }>
        ).map((row) => row.source_identity);
        expect(identities).toEqual([
          'slack:event:Ev_fixture_delete',
          'slack:event:Ev_fixture_edit',
          'slack:event:Ev_fixture_new',
        ]);
        expect(sqlite.prepare('select revision, source_deleted_at from inbox').get()).toMatchObject(
          { revision: 2, source_deleted_at: expect.any(String) },
        );
      } finally {
        sqlite.close();
      }
      expect({ acknowledgements, notifications }).toEqual({
        acknowledgements: 3,
        notifications: 3,
      });
    },
  );

  it('ignores synthetic thread-parent updates while preserving replies and substantive edits', async () => {
    const path = configuredDb();
    let acknowledgements = 0;
    const notifications: string[] = [];
    const accept = (delivery: SlackEventBody) =>
      processSlackEvent(
        delivery,
        'U_BOT',
        notifier((message) => notifications.push(message)),
        () => void acknowledgements++,
      );
    const parent = {
      type: 'message',
      channel: 'C0123456789',
      channel_type: 'channel',
      user: 'U0123456789',
      ts: '100.0',
      text: '<@U_BOT> parent',
    };

    await expect(accept({ event_id: 'Ev_parent', event: parent })).resolves.toBe('accepted');
    // The reply itself is unmentioned and ignored. Slack's following parent edit
    // changes only thread metadata, which is not part of the owned snapshot.
    await expect(
      accept({
        event_id: 'Ev_unmentioned_reply',
        event: { ...parent, ts: '101.0', thread_ts: '100.0', text: 'background reply' },
      }),
    ).resolves.toBe('ignored');
    for (const [eventId, metadata] of [
      ['Ev_parent_reply_added', { reply_count: 1, latest_reply: '101.0' }],
      ['Ev_parent_reply_deleted', { reply_count: 0, latest_reply: undefined }],
    ] as const) {
      await expect(
        accept({
          event_id: eventId,
          event: {
            type: 'message',
            subtype: 'message_changed',
            channel: 'C0123456789',
            channel_type: 'channel',
            message: { ...parent, ...metadata },
          },
        }),
      ).resolves.toBe('ignored');
    }

    // No-op deliveries are deliberately unledgered; retrying the same event ID
    // therefore rechecks the unchanged snapshot and remains inert.
    await expect(
      accept({
        event_id: 'Ev_parent_reply_added',
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C0123456789',
          channel_type: 'channel',
          message: { ...parent, reply_count: 1, latest_reply: '101.0' },
        },
      }),
    ).resolves.toBe('ignored');

    await expect(
      accept({
        event_id: 'Ev_mentioned_reply',
        event: {
          ...parent,
          ts: '102.0',
          thread_ts: '100.0',
          text: '<@U_BOT> please handle this reply',
        },
      }),
    ).resolves.toBe('accepted');
    await expect(
      accept({
        event_id: 'Ev_parent_after_mention',
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C0123456789',
          channel_type: 'channel',
          message: { ...parent, reply_count: 1, latest_reply: '102.0' },
        },
      }),
    ).resolves.toBe('ignored');

    const realEdit = (eventId: string, text: string, messageFiles: unknown[] = []) =>
      accept({
        event_id: eventId,
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C0123456789',
          channel_type: 'channel',
          message: { ...parent, text, files: messageFiles },
        },
      });
    await expect(realEdit('Ev_parent_real_edit', 'actually edited')).resolves.toBe('accepted');
    await expect(
      realEdit('Ev_parent_attachment_add', 'actually edited', [
        { id: 'F1', name: 'proof.txt', mimetype: 'text/plain', size: 12 },
      ]),
    ).resolves.toBe('accepted');
    await expect(realEdit('Ev_parent_attachment_remove', 'actually edited')).resolves.toBe(
      'accepted',
    );

    const sqlite = new Database(path, { readonly: true });
    try {
      expect(sqlite.prepare('select count(*) n from inbox').get()).toEqual({ n: 2 });
      expect(
        sqlite
          .prepare("select revision from inbox where slack_message_id='C0123456789:100.0'")
          .get(),
      ).toEqual({ revision: 4 });
      expect(sqlite.prepare('select count(*) n from slack_events').get()).toEqual({ n: 5 });
    } finally {
      sqlite.close();
    }
    expect(notifications).toHaveLength(5);
    expect(acknowledgements).toBe(10);
  });

  it('treats bot-mention addition and removal as canonical substantive source edits', async () => {
    const path = configuredDb();
    let notifications = 0;
    const parent = body({ ts: '200.0', text: '<@U_BOT> source' });
    const edit = (eventId: string, text: string) =>
      processSlackEvent(
        {
          event_id: eventId,
          event: {
            type: 'message',
            subtype: 'message_changed',
            channel: 'C0123456789',
            channel_type: 'channel',
            message: { ...(parent.event as Record<string, unknown>), text },
          },
        },
        'U_BOT',
        notifier(() => notifications++),
        () => undefined,
      );

    await expect(
      processSlackEvent(
        parent,
        'U_BOT',
        notifier(() => notifications++),
        () => undefined,
      ),
    ).resolves.toBe('accepted');
    await expect(edit('Ev_mention_removed', 'source')).resolves.toBe('accepted');
    await expect(edit('Ev_mention_added', '<@U_BOT> source')).resolves.toBe('accepted');

    const sqlite = new Database(path, { readonly: true });
    try {
      expect(
        sqlite
          .prepare("select content, revision from inbox where slack_message_id='C0123456789:200.0'")
          .get(),
      ).toEqual({ content: '<@U_BOT> source', revision: 3 });
    } finally {
      sqlite.close();
    }
    expect(notifications).toBe(3);
  });

  it('reconciles work committed before the acknowledgement/effect boundary exactly once', async () => {
    const path = configuredDb();
    let notifications = 0;
    let reactions = 0;

    // Failure injection: process death after SQLite admission and before either
    // Socket Mode acknowledgement or an external side effect.
    expect(
      ingestSlackEvent({
        eventId: 'Ev_committed_before_ack',
        kind: 'new-message',
        messageId: 'C0123456789:300.0',
        senderId: 'U0123456789',
        senderLabel: 'U0123456789',
        content: '<@U_BOT> committed',
        messageTs: '300.0',
        attachments: [],
      }),
    ).toMatchObject({ outcome: 'created' });
    closeDb();
    initDb(path);

    await reconcilePendingSlackEffects(
      notifier(() => notifications++),
      { received: async () => void reactions++ },
    );
    await reconcilePendingSlackEffects(
      notifier(() => notifications++),
      { received: async () => void reactions++ },
    );

    expect({ notifications, reactions }).toEqual({ notifications: 1, reactions: 1 });
  });

  it('runs committed effects once even when acknowledgement rejects, and keeps retry duplicate-safe', async () => {
    const path = configuredDb();
    let notifications = 0;
    let reactions = 0;

    await expect(
      processSlackEvent(
        body(),
        'U_BOT',
        notifier(() => notifications++),
        () => Promise.reject(new Error('ack transport closed')),
        { received: async () => void reactions++ },
      ),
    ).rejects.toThrow(/ack transport closed/);
    expect(counts(path)).toEqual({ events: 1, inbox: 1 });
    expect({ notifications, reactions }).toEqual({ notifications: 1, reactions: 1 });

    await expect(
      processSlackEvent(
        body(),
        'U_BOT',
        notifier(() => notifications++),
        () => undefined,
        { received: async () => void reactions++ },
      ),
    ).resolves.toBe('duplicate');
    expect({ notifications, reactions }).toEqual({ notifications: 1, reactions: 1 });
  });

  it('recovers pending post-commit work after restart without replaying the receipt or accepted pi work', async () => {
    const path = configuredDb();
    let notificationAttempts = 0;
    let reactions = 0;
    const failingNotifier: PiNotifier = {
      async notify() {
        notificationAttempts++;
        throw new Error('pi unavailable');
      },
    };

    await expect(
      processSlackEvent(body(), 'U_BOT', failingNotifier, () => undefined, {
        received: async () => void reactions++,
      }),
    ).rejects.toThrow(/pi unavailable/);
    expect({ notificationAttempts, reactions }).toEqual({ notificationAttempts: 1, reactions: 1 });

    closeDb();
    initDb(path);
    await reconcilePendingSlackEffects(
      notifier(() => notificationAttempts++),
      { received: async () => void reactions++ },
    );
    expect({ notificationAttempts, reactions }).toEqual({ notificationAttempts: 2, reactions: 1 });

    closeDb();
    initDb(path);
    await reconcilePendingSlackEffects(
      notifier(() => notificationAttempts++),
      { received: async () => void reactions++ },
    );
    await expect(
      processSlackEvent(
        body(),
        'U_BOT',
        notifier(() => notificationAttempts++),
        () => undefined,
        { received: async () => void reactions++ },
      ),
    ).resolves.toBe('duplicate');
    expect({ notificationAttempts, reactions }).toEqual({ notificationAttempts: 2, reactions: 1 });
  });

  it('stops new admission while draining work already accepted by the coordinator', async () => {
    configuredDb();
    const coordinator = new GatewayCoordinator();
    let release!: () => void;
    const blocker = coordinator.run(() => new Promise<void>((resolve) => (release = resolve)));
    let acceptedAck = 0;
    let refusedAck = 0;
    const accepted = handleSocketModeEnvelope(
      { type: 'events_api', body: body(), ack: () => void acceptedAck++ },
      'U_BOT',
      notifier(),
      coordinator,
    );
    coordinator.close();
    await expect(
      handleSocketModeEnvelope(
        { type: 'events_api', body: body({ ts: '999.1' }), ack: () => void refusedAck++ },
        'U_BOT',
        notifier(),
        coordinator,
      ),
    ).rejects.toThrow(/shutting down/);

    release();
    await blocker;
    await expect(accepted).resolves.toBe('accepted');
    await coordinator.drain();
    expect({ acceptedAck, refusedAck }).toEqual({ acceptedAck: 1, refusedAck: 0 });
  });
});
