import { SocketModeReceiver } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import {
  inboxSnapshot,
  ingestSlackEvent,
  isTrustedUser,
  markSlackEventAccepted,
  readGatewayConfig,
  recordInboxReaction,
} from './db.js';
import type { PiAcceptance } from './pi-rpc.js';
import type { DaemonLogger } from './logging.js';

export interface PiNotifier {
  notify(message: string): Promise<PiAcceptance>;
}
export interface ReceiptReconciler {
  received(inbox: Record<string, unknown>): Promise<void>;
}
export type SlackEventBody = { event_id?: unknown; event?: Record<string, unknown> };

/** Serializes all admission/post-commit pi notifications in delivery order. */
export type CoordinatorReservation<T> = {
  value: T;
  release(): void;
};

export class GatewayCoordinator {
  private tail = Promise.resolve();
  private accepting = true;
  run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('Gateway is shutting down.'));
    const next = this.tail.then(operation, operation);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Return a value to the caller while retaining the serialization lane. The
   * caller must release the lease after its external boundary (currently the
   * control response flush) succeeds or is cancelled.
   */
  reserve<T>(operation: () => Promise<T> | T): Promise<CoordinatorReservation<T>> {
    if (!this.accepting) return Promise.reject(new Error('Gateway is shutting down.'));
    let deliver!: (reservation: CoordinatorReservation<T>) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<CoordinatorReservation<T>>((resolve, fail) => {
      deliver = resolve;
      reject = fail;
    });
    const hold = this.tail.then(async () => {
      try {
        const value = await operation();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let released = false;
        deliver({
          value,
          release: () => {
            if (released) return;
            released = true;
            release();
          },
        });
        await gate;
      } catch (error) {
        reject(error);
        throw error;
      }
    });
    this.tail = hold.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Reject future work, while allowing already accepted work to finish. */
  close(): void {
    this.accepting = false;
  }
  drain(): Promise<void> {
    return this.tail;
  }
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
function files(message: Record<string, unknown>): unknown[] {
  return Array.isArray(message.files)
    ? message.files.map((file) => {
        const value = file as Record<string, unknown>;
        // Metadata only: never retain Slack download URLs or fetch files on ingestion.
        return { id: value.id, name: value.name, mimetype: value.mimetype, size: value.size };
      })
    : [];
}
function withoutMention(text: string, botId: string): string {
  return text.replace(new RegExp(`<@${botId}>`, 'g'), '').trim();
}

/**
 * Handles a real top-level Events API body. Ignored events deliberately do not
 * enter the ledger; relevant events are acknowledged only after SQLite commit.
 */
export async function processSlackEvent(
  body: SlackEventBody,
  botId: string,
  notifier: PiNotifier,
  acknowledge: () => Promise<void> | void,
  receipts?: ReceiptReconciler,
  logger?: DaemonLogger,
): Promise<'ignored' | 'duplicate' | 'accepted'> {
  const event = body.event;
  if (!event || event.type !== 'message' || event.bot_id || event.subtype === 'bot_message') {
    await acknowledge();
    return 'ignored';
  }
  const subtype = string(event.subtype);
  let kind: 'new-message' | 'edit' | 'deletion' = 'new-message';
  let message = event;
  if (subtype === 'message_changed') {
    kind = 'edit';
    message = (event.message as Record<string, unknown>) ?? {};
  } else if (subtype === 'message_deleted') {
    kind = 'deletion';
    message = (event.previous_message as Record<string, unknown>) ?? {};
  } else if (subtype && subtype !== 'file_share') {
    await acknowledge();
    return 'ignored';
  }
  if (message.bot_id || message.subtype === 'bot_message') {
    await acknowledge();
    return 'ignored';
  }
  const config = readGatewayConfig();
  const channel = string(event.channel) ?? string(message.channel);
  const channelType = string(event.channel_type);
  if (
    channel !== config.channel_id ||
    (channelType !== undefined &&
      channelType !== 'channel' &&
      channelType !== 'group' &&
      channelType !== 'public_channel' &&
      channelType !== 'private_channel')
  ) {
    await acknowledge();
    return 'ignored';
  }
  const senderId = string(message.user) ?? string(event.user);
  if (!senderId || !isTrustedUser(senderId)) {
    await acknowledge();
    return 'ignored';
  }
  const eventId = string(body.event_id);
  if (!eventId || !/^[A-Za-z0-9_-]+$/.test(eventId)) {
    // Do not manufacture a delivery identity: this is identifier-only logging.
    logger?.warn({ event: 'slack_event_refused', reason: 'missing_event_id' });
    await acknowledge();
    return 'ignored';
  }
  const ts = string(message.ts);
  if (!ts) {
    await acknowledge();
    return 'ignored';
  }
  const content = string(message.text) ?? '';
  if (kind === 'new-message' && !new RegExp(`<@${botId}>`).test(content)) {
    await acknowledge();
    return 'ignored';
  }
  const result = ingestSlackEvent({
    eventId,
    kind,
    messageId: `${channel}:${ts}`,
    senderId,
    senderLabel: senderId,
    content: kind === 'new-message' ? withoutMention(content, botId) : content,
    messageTs: ts,
    threadTs: string(message.thread_ts) ?? ts,
    attachments: files(message),
  });
  await acknowledge();
  if (result.duplicate) return 'duplicate';
  if (result.ignored || result.outcome === 'already-represented') return 'ignored';
  // Slack is now durably admitted. pi is explicitly post-ack and may fail
  // without changing inbox correctness.
  if (result.inboxId) {
    const row = inboxSnapshot(result.inboxId)!;
    // Receipt failures are diagnostic only and never delay or invalidate pi work.
    if (result.outcome === 'created' && receipts)
      void receipts.received(row).catch(() => undefined);
    const acceptance = await notifier.notify(
      `[Slack ${kind}; inbox-${result.inboxId}; revision ${result.revision}]\n` +
        `Sender: ${row.sender_label}\nThread: ${row.thread_ts}\n` +
        `Content follows:\n---\n${row.content}\n---\n` +
        'Use pi-tag-slack inbox list/show/respond/resolve to inspect and handle durable work.',
    );
    markSlackEventAccepted(eventId, acceptance);
  }
  return 'accepted';
}

export type SocketModeEnvelope = {
  type?: unknown;
  body?: unknown;
  ack: () => Promise<void> | void;
};

/**
 * Owns acknowledgement of one low-level Socket Mode envelope. Keeping this
 * seam below Bolt's listener middleware prevents its Events API auto-ack.
 */
export async function handleSocketModeEnvelope(
  envelope: SocketModeEnvelope,
  botId: string,
  notifier: PiNotifier,
  coordinator: GatewayCoordinator,
  receipts?: ReceiptReconciler,
  logger?: DaemonLogger,
): Promise<'ignored' | 'duplicate' | 'accepted'> {
  if (envelope.type !== 'events_api' || !envelope.body || typeof envelope.body !== 'object') {
    await envelope.ack();
    return 'ignored';
  }
  return coordinator.run(() =>
    processSlackEvent(
      envelope.body as SlackEventBody,
      botId,
      notifier,
      envelope.ack,
      receipts,
      logger,
    ),
  );
}

/** Starts the one low-level Socket Mode connection with gateway-owned acknowledgement. */
export async function startSlackGateway(options: {
  botToken: string;
  appToken: string;
  botId: string;
  notifier: PiNotifier;
  coordinator?: GatewayCoordinator;
  logger?: DaemonLogger;
}): Promise<{ stop(): Promise<void> }> {
  const receiver = new SocketModeReceiver({ appToken: options.appToken });
  // SocketModeReceiver installs a Bolt dispatch listener in its constructor.
  // Remove it and consume the same client's raw envelopes so no Bolt middleware
  // can acknowledge before our SQLite admission transaction commits.
  receiver.client.removeAllListeners('slack_event');
  const web = new WebClient(options.botToken);
  const coordinator = options.coordinator ?? new GatewayCoordinator();
  const receipts: ReceiptReconciler = {
    async received(inbox) {
      const id = inbox.id as number;
      try {
        await web.reactions.add({
          channel: String(inbox.slack_message_id).split(':', 1)[0],
          timestamp: String(inbox.message_ts),
          name: 'eyes',
        });
        recordInboxReaction(id, { actual: 'eyes', error: null });
      } catch (error) {
        recordInboxReaction(id, { actual: null, error: (error as Error).message });
      }
    },
  };
  receiver.client.on('slack_event', (envelope: SocketModeEnvelope) => {
    void handleSocketModeEnvelope(
      envelope,
      options.botId,
      options.notifier,
      coordinator,
      receipts,
      options.logger,
    ).catch(() => options.logger?.error({ event: 'slack_admission_failed' }));
  });
  await receiver.start();
  return {
    // Await the low-level disconnect itself; SocketModeReceiver.stop() does not
    // await its client's asynchronous disconnect in Bolt 5.0.0.
    stop: () => receiver.client.disconnect(),
  };
}
