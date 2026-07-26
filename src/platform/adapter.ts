/**
 * Platform adapter port — the single seam between the platform-neutral core
 * (queue, agent, sessions, scheduler) and a chat platform implementation.
 *
 * pi-tag-slack ships exactly one implementation (src/slack/client.ts). The interface
 * exists so the core never grows platform-specific imports beyond this shape,
 * and so a future shared gateway core can be extracted without refactoring.
 */
export interface PlatformAdapter {
  /** Connect to the platform and resolve once inbound events are flowing. */
  start(): Promise<void>;

  /** Disconnect and release the platform connection (fire-and-forget). */
  stop(): void;

  /** Human-readable bot identity for startup logs (undefined before start). */
  getBotTag(): string | undefined;

  /**
   * Deliver agent output to a channel. `ctx.threadTs` carries the parent
   * thread root ts for a user-triggered response. Returns false when delivery failed.
   */
  sendResponse(jid: string, text: string, ctx?: { threadTs?: string }): Promise<boolean>;

  /**
   * Toggle a "working on it" indicator. `ctx.ts` is the triggering message ts
   * so implementations without a typing indicator (Slack) can react to the
   * message instead. Best-effort: implementations must never reject.
   */
  setBusy(jid: string, on: boolean, ctx?: { ts?: string }): Promise<void>;
}
