import { SocketModeReceiver } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import {
  inboxSnapshot,
  ingestSlackEvent,
  isTrustedUser,
  markSlackEventAccepted,
  readGatewayConfig,
  recordInboxReaction,
  requireConfiguredDb,
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
        const value =
          file !== null && typeof file === 'object' ? (file as Record<string, unknown>) : {};
        // Metadata only: never retain Slack download URLs or fetch files on ingestion.
        return { id: value.id, name: value.name, mimetype: value.mimetype, size: value.size };
      })
    : [];
}
function mentionsBot(text: string, botId: string): boolean {
  return text.includes(`<@${botId}>`);
}

type SourceSnapshot = { content: string; attachments: string };

/**
 * This is the complete source snapshot owned by the gateway. Persist exactly
 * this representation and compare exactly this representation: Slack thread
 * metadata is intentionally excluded, but text (including bot mentions) and
 * attachment metadata are substantive source content.
 */
function sourceSnapshot(content: string, attachments: unknown[]): SourceSnapshot {
  return { content, attachments: JSON.stringify(attachments) };
}

function isUnchangedOpenSnapshot(messageId: string, snapshot: SourceSnapshot): boolean {
  const row = requireConfiguredDb()
    .prepare(
      "select content, attachments from inbox where slack_message_id=? and state='open' and source_deleted_at is null",
    )
    .get(messageId) as SourceSnapshot | undefined;
  return Boolean(
    row && row.content === snapshot.content && row.attachments === snapshot.attachments,
  );
}

type PendingSlackEffect = {
  eventId: string;
  kind: 'new-message' | 'edit' | 'deletion';
  inboxId: number;
  revision: number;
  outcome: string;
};

function pendingSlackEffect(eventId: string): PendingSlackEffect | undefined {
  const row = requireConfiguredDb()
    .prepare(
      "select kind, inbox_id, inbox_revision, outcome from slack_events where source_identity=? and rpc_accepted_at is null and outcome <> 'already-represented'",
    )
    .get(`slack:event:${eventId}`) as
    | {
        kind: PendingSlackEffect['kind'];
        inbox_id: number;
        inbox_revision: number;
        outcome: string;
      }
    | undefined;
  return row
    ? {
        eventId,
        kind: row.kind,
        inboxId: row.inbox_id,
        revision: row.inbox_revision,
        outcome: row.outcome,
      }
    : undefined;
}

async function deliverSlackEffect(
  effect: PendingSlackEffect,
  notifier: PiNotifier,
  receipts?: ReceiptReconciler,
): Promise<void> {
  const row = inboxSnapshot(effect.inboxId);
  if (!row) throw new Error(`Missing inbox-${effect.inboxId} for admitted Slack event.`);

  // Claim the initial receipt durably before crossing the Slack API boundary.
  // A crash after this write leaves ordinary reaction reconciliation responsible
  // for convergence rather than causing a duplicate delivery attempt here.
  if (
    effect.outcome === 'created' &&
    receipts &&
    row.reaction_actual === null &&
    row.reaction_error === null
  ) {
    recordInboxReaction(effect.inboxId, { error: 'receipt-awaiting-reconciliation' });
    await receipts.received(row).catch(() => undefined);
  }

  const acceptance = await notifier.notify(
    `[Slack ${effect.kind}; inbox-${effect.inboxId}; revision ${effect.revision}]\n` +
      `Sender: ${row.sender_label}\nThread: ${row.thread_ts}\n` +
      `Content follows:\n---\n${row.content}\n---\n` +
      'Use pi-tag-slack inbox list/show/respond/resolve to inspect and handle durable work.',
  );
  markSlackEventAccepted(effect.eventId, acceptance);
}

/** Replays only durably admitted Slack work that pi has not accepted yet. */
export async function reconcilePendingSlackEffects(
  notifier: PiNotifier,
  receipts?: ReceiptReconciler,
  logger?: DaemonLogger,
): Promise<void> {
  const rows = requireConfiguredDb()
    .prepare(
      "select source_identity from slack_events where rpc_accepted_at is null and outcome <> 'already-represented' order by created_at, source_identity",
    )
    .all() as Array<{ source_identity: string }>;
  for (const row of rows) {
    const eventId = row.source_identity.slice('slack:event:'.length);
    const effect = pendingSlackEffect(eventId);
    if (!effect) continue;
    try {
      await deliverSlackEffect(effect, notifier, receipts);
    } catch {
      logger?.error({ event: 'slack_effect_reconciliation_failed' });
    }
  }
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
  if (kind === 'new-message' && !mentionsBot(content, botId)) {
    await acknowledge();
    return 'ignored';
  }
  const messageId = `${channel}:${ts}`;
  const attachments = files(message);
  const snapshot = sourceSnapshot(content, attachments);
  // Slack changes reply_count/latest_reply on a thread parent by emitting
  // message_changed. Those fields are outside our source snapshot. Such no-ops
  // are intentionally not ledgered: every retry compares equal and remains inert.
  if (kind === 'edit' && isUnchangedOpenSnapshot(messageId, snapshot)) {
    await acknowledge();
    return 'ignored';
  }
  const result = ingestSlackEvent({
    eventId,
    kind,
    messageId,
    senderId,
    senderLabel: senderId,
    content: snapshot.content,
    messageTs: ts,
    threadTs: string(message.thread_ts) ?? ts,
    attachments,
  });

  let acknowledgementError: unknown;
  try {
    await acknowledge();
  } catch (error) {
    acknowledgementError = error;
  }

  if (!result.ignored && result.outcome !== 'already-represented') {
    const effect = pendingSlackEffect(eventId);
    if (effect) {
      try {
        await deliverSlackEffect(effect, notifier, receipts);
      } catch (error) {
        if (acknowledgementError) throw acknowledgementError;
        throw error;
      }
    }
  }
  if (acknowledgementError) throw acknowledgementError;
  if (result.duplicate) return 'duplicate';
  if (result.ignored || result.outcome === 'already-represented') return 'ignored';
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
  // Admission and pi acceptance are separate durable states. Recover any work
  // left between commit, acknowledgement, and post-commit effects on startup.
  await coordinator.run(() =>
    reconcilePendingSlackEffects(options.notifier, receipts, options.logger),
  );
  return {
    // Await the low-level disconnect itself; SocketModeReceiver.stop() does not
    // await its client's asynchronous disconnect in Bolt 5.0.0.
    stop: () => receiver.client.disconnect(),
  };
}
