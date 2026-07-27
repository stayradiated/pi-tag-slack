import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TextDecoder } from 'node:util';

export type PiAcceptance = { acceptedAt: string; sessionId?: string; runSequence: number };
export type PiSessionStatus = {
  running: boolean;
  health: 'healthy' | 'degraded';
  sessionId: string | null;
  activity: 'active' | 'idle';
  runSequence: number;
  lastError: string | null;
  desiredModel: string | null;
  desiredThinking: string | null;
  effectiveModel: string | null;
  effectiveThinking: string | null;
  pending: boolean;
};
type Frame = Record<string, unknown>;
type DesiredSessionSettings = { model: string | null; thinking: string | null };
export type PiModel = { provider: string; id: string; ref: string };
export type PiApplyResult = { application: 'applied' | 'pending' | 'failed' };
const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const minimumPiVersion = [0, 82, 0] as const;

/** Run the configured executable's version command before opening an RPC session. */
export async function piVersion(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(new Error(`Unable to run ${binary} --version: ${error.message}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

export function requireSupportedPiVersion(output: string): void {
  // pi has emitted both `0.x.y` and `pi 0.x.y`; accept only those complete forms.
  const match = /^(?:pi\s+)?v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(output);
  if (!match) throw new Error('Malformed pi --version output. Expected a semantic version.');
  const version = match.slice(1).map(Number);
  if (
    version[0] < minimumPiVersion[0] ||
    (version[0] === minimumPiVersion[0] && version[1] < minimumPiVersion[1]) ||
    (version[0] === minimumPiVersion[0] &&
      version[1] === minimumPiVersion[1] &&
      version[2] < minimumPiVersion[2])
  ) {
    throw new Error('pi 0.82.0 or later is required.');
  }
}

/** A single persistent, strictly-LF-framed pi RPC child. */
export class PiRpcSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    string,
    { resolve: (value: Frame) => void; reject: (error: Error) => void }
  >();
  private streaming = false;
  private sessionId: string | undefined;
  private sequence = 0;
  private lastError: string | undefined;
  private effectiveModel: string | undefined;
  private effectiveThinking: string | undefined;
  private safeBoundaryHandler: (() => void) | undefined;

  constructor(
    private readonly options: {
      binary: string;
      sessionDir: string;
      cwd: string;
      desired?: () => DesiredSessionSettings;
      spawn?: typeof spawn;
      version?: (binary: string) => Promise<string>;
      /** Injectable only to make restart supervision deterministic in tests. */
      restartBaseMs?: number;
      restartMaxMs?: number;
      restartFailureThreshold?: number;
      setTimeout?: typeof setTimeout;
      clearTimeout?: typeof clearTimeout;
    },
  ) {}

  private startPromise: Promise<void> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private consecutiveFailures = 0;
  private stopping = false;
  private restartAfterStart = false;

  async start(): Promise<void> {
    if (this.child) return;
    if (this.startPromise) return this.startPromise;
    this.cancelRestart();
    const operation = this.startChild();
    this.startPromise = operation;
    try {
      await operation;
    } catch (error) {
      if (!this.stopping)
        this.recordFailure(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (this.startPromise === operation) this.startPromise = undefined;
      if (this.restartAfterStart) {
        this.restartAfterStart = false;
        this.scheduleRestart();
      }
    }
  }

  private async startChild(): Promise<void> {
    if (this.stopping) throw new Error('pi RPC session is stopping.');
    const output = await (this.options.version ?? piVersion)(this.options.binary);
    if (this.stopping) throw new Error('pi RPC session is stopping.');
    requireSupportedPiVersion(output);
    const child = (this.options.spawn ?? spawn)(
      this.options.binary,
      ['--mode', 'rpc', '--session-dir', this.options.sessionDir, '--continue', '--approve'],
      { cwd: this.options.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.on('error', (error) => {
      this.handleUnexpectedExit(child, error);
    });
    child.on('exit', (code, signal) => {
      this.handleUnexpectedExit(
        child,
        new Error(`pi RPC process exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`),
      );
    });
    try {
      const followUp = await this.command('set_follow_up_mode', { mode: 'one-at-a-time' });
      if (
        followUp.type !== 'response' ||
        followUp.command !== 'set_follow_up_mode' ||
        followUp.success !== true
      )
        throw new Error('Invalid set_follow_up_mode response from pi RPC.');
      this.applyState(await this.getState());
      const [models, levels] = await Promise.all([
        this.availableModels(),
        this.availableThinkingLevels(),
      ]);
      const desired = this.options.desired?.() ?? { model: null, thinking: null };
      if (desired.model && !models.some((model) => model.ref === desired.model))
        throw new Error(`Configured model is unavailable from pi: ${desired.model}`);
      if (desired.thinking && !levels.includes(desired.thinking))
        throw new Error(`Configured thinking level is unavailable from pi: ${desired.thinking}`);
      // A fully validated handshake is the only point a restart is healthy.
      this.consecutiveFailures = 0;
      this.lastError = undefined;
    } catch (error) {
      this.failStart(child, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /** Run desired configuration only after pi reports a settled safe boundary. */
  setSafeBoundaryHandler(handler: () => void): void {
    this.safeBoundaryHandler = handler;
  }

  async availableModels(): Promise<PiModel[]> {
    const response = await this.command('get_available_models');
    const models =
      response.data && typeof response.data === 'object' && !Array.isArray(response.data)
        ? (response.data as Frame).models
        : undefined;
    if (
      response.type !== 'response' ||
      response.command !== 'get_available_models' ||
      response.success !== true ||
      !Array.isArray(models) ||
      models.some(
        (model) =>
          !model ||
          typeof model !== 'object' ||
          typeof (model as Frame).provider !== 'string' ||
          !(model as Frame).provider ||
          typeof (model as Frame).id !== 'string' ||
          !(model as Frame).id,
      )
    ) {
      throw new Error('Invalid get_available_models response from pi RPC.');
    }
    return models.map((model) => {
      const value = model as Frame;
      const provider = value.provider as string;
      const id = value.id as string;
      return { provider, id, ref: `${provider}/${id}` };
    });
  }

  async availableThinkingLevels(): Promise<string[]> {
    const response = await this.command('get_available_thinking_levels');
    const levels =
      response.data && typeof response.data === 'object' && !Array.isArray(response.data)
        ? (response.data as Frame).levels
        : undefined;
    if (
      response.type !== 'response' ||
      response.command !== 'get_available_thinking_levels' ||
      response.success !== true ||
      !Array.isArray(levels) ||
      levels.some((level) => typeof level !== 'string' || !thinkingLevels.has(level))
    ) {
      throw new Error('Invalid get_available_thinking_levels response from pi RPC.');
    }
    return levels as string[];
  }

  /** Applies the persisted desired values only while no agent turn is active. */
  async applyDesired(): Promise<PiApplyResult> {
    if (!this.child) return { application: 'pending' };
    try {
      this.applyState(await this.getState());
      if (this.streaming) return { application: 'pending' };
      const desired = this.options.desired?.() ?? { model: null, thinking: null };
      if (desired.model && desired.model !== this.effectiveModel) {
        const slash = desired.model.indexOf('/');
        if (slash < 1 || slash === desired.model.length - 1)
          throw new Error(`Invalid desired model reference: ${desired.model}`);
        const response = await this.command('set_model', {
          provider: desired.model.slice(0, slash),
          modelId: desired.model.slice(slash + 1),
        });
        if (
          response.type !== 'response' ||
          response.command !== 'set_model' ||
          response.success !== true
        )
          throw new Error('pi rejected set_model.');
      }
      // Model selection can change which thinking levels pi supports.
      this.applyState(await this.getState());
      if (desired.thinking && desired.thinking !== this.effectiveThinking) {
        const response = await this.command('set_thinking_level', { level: desired.thinking });
        if (
          response.type !== 'response' ||
          response.command !== 'set_thinking_level' ||
          response.success !== true
        )
          throw new Error('pi rejected set_thinking_level.');
      }
      this.applyState(await this.getState());
      return { application: 'applied' };
    } catch (error) {
      this.recordFailure(error instanceof Error ? error : new Error(String(error)));
      return { application: 'failed' };
    }
  }

  async notify(message: string): Promise<PiAcceptance> {
    if (this.stopping) throw new Error('pi RPC session is stopping.');
    let reopenedExhaustedWindow = false;
    if (!this.child) {
      // Exhaustion suppresses background restarts, not newly durable work. A
      // new event/task opens exactly one fresh attempt window.
      if (this.isExhausted()) {
        this.consecutiveFailures = 0;
        reopenedExhaustedWindow = true;
      }
      await this.start();
    }
    const command = this.streaming ? 'follow_up' : 'prompt';
    const response = await this.command(command, {
      message: reopenedExhaustedWindow ? `${message}\nOther open work may exist.` : message,
    });
    if (response.success !== true) throw new Error(`pi rejected ${command}.`);
    this.sequence += 1;
    return {
      acceptedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      runSequence: this.sequence,
    };
  }

  async stop(): Promise<void> {
    // This is terminal daemon shutdown. It must win races with exit handlers
    // and with a timer that was already queued.
    this.stopping = true;
    this.cancelRestart();
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }

  /** Returns a read-only, runtime-validated view of the child session. */
  async status(): Promise<PiSessionStatus> {
    if (this.child) {
      try {
        this.applyState(await this.getState());
      } catch (error) {
        this.recordFailure(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const desired = this.options.desired?.() ?? { model: null, thinking: null };
    return {
      running: Boolean(this.child),
      health: this.child && !this.lastError ? 'healthy' : 'degraded',
      sessionId: this.sessionId ?? null,
      activity: this.streaming ? 'active' : 'idle',
      runSequence: this.sequence,
      lastError: this.lastError ?? null,
      desiredModel: desired.model,
      desiredThinking: desired.thinking,
      effectiveModel: this.effectiveModel ?? null,
      effectiveThinking: this.effectiveThinking ?? null,
      pending:
        this.streaming &&
        ((desired.model !== null && desired.model !== this.effectiveModel) ||
          (desired.thinking !== null && desired.thinking !== this.effectiveThinking)),
    };
  }

  private async getState(): Promise<Record<string, unknown>> {
    const response = await this.command('get_state');
    const data = response.data;
    if (
      response.type !== 'response' ||
      response.command !== 'get_state' ||
      response.success !== true ||
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      typeof (data as Frame).isStreaming !== 'boolean' ||
      ((data as Frame).sessionId !== undefined && typeof (data as Frame).sessionId !== 'string') ||
      ((data as Frame).thinkingLevel !== undefined &&
        typeof (data as Frame).thinkingLevel !== 'string') ||
      ((data as Frame).model !== undefined &&
        (data as Frame).model !== null &&
        typeof (data as Frame).model !== 'object')
    ) {
      throw new Error('Invalid get_state response from pi RPC.');
    }
    return data as Frame;
  }

  private applyState(state: Frame): void {
    this.streaming = state.isStreaming === true;
    this.sessionId = typeof state.sessionId === 'string' ? state.sessionId : undefined;
    this.effectiveThinking =
      typeof state.thinkingLevel === 'string' ? state.thinkingLevel : undefined;
    const model = state.model;
    if (model && typeof model === 'object') {
      const value = model as Frame;
      this.effectiveModel =
        typeof value.provider === 'string' && typeof value.id === 'string'
          ? `${value.provider}/${value.id}`
          : typeof value.id === 'string'
            ? value.id
            : undefined;
    } else {
      this.effectiveModel = undefined;
    }
  }

  private command(type: string, values: Record<string, unknown> = {}): Promise<Frame> {
    if (!this.child) return Promise.reject(new Error('pi RPC process is not running.'));
    const id = randomUUID();
    const frame = JSON.stringify({ id, type, ...values });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(`${frame}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\r$/, '');
        const frame = JSON.parse(text) as Frame;
        if (!frame || typeof frame.type !== 'string') throw new Error('invalid RPC frame');
        if (frame.type === 'agent_start') this.streaming = true;
        if (frame.type === 'agent_settled') {
          this.streaming = false;
          this.safeBoundaryHandler?.();
        }
        if (typeof frame.id === 'string' && this.pending.has(frame.id)) {
          const pending = this.pending.get(frame.id)!;
          this.pending.delete(frame.id);
          pending.resolve(frame);
        }
      } catch (error) {
        this.recordFailure(new Error(`Invalid pi RPC frame: ${(error as Error).message}`));
        this.child?.kill();
      }
    }
  }

  private failStart(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (!this.stopping) this.recordFailure(error);
    if (this.child === child) this.child = undefined;
    this.streaming = false;
    child.stdin.end();
    child.kill();
  }

  private handleUnexpectedExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    // `error` and `exit` can both arrive. Only the owner of this child gets to
    // reject commands and schedule its successor.
    if (this.child !== child) return;
    this.child = undefined;
    this.streaming = false;
    if (this.stopping) {
      this.rejectPending(new Error('pi RPC process stopped.'));
      return;
    }
    this.recordFailure(error);
    this.consecutiveFailures += 1;
    this.scheduleRestart();
  }

  private isExhausted(): boolean {
    return this.consecutiveFailures >= (this.options.restartFailureThreshold ?? 3);
  }

  private scheduleRestart(): void {
    if (this.stopping || this.isExhausted() || this.restartTimer) return;
    if (this.startPromise) {
      this.restartAfterStart = true;
      return;
    }
    const base = this.options.restartBaseMs ?? 250;
    const cap = this.options.restartMaxMs ?? 10_000;
    const delay = Math.min(cap, base * 2 ** Math.max(0, this.consecutiveFailures - 1));
    const schedule = this.options.setTimeout ?? setTimeout;
    this.restartTimer = schedule(() => {
      this.restartTimer = undefined;
      if (this.stopping || this.isExhausted() || this.child || this.startPromise) return;
      // Failure is deliberately swallowed: it is reflected in status and the
      // next unexpected-exit/start failure schedules the next bounded retry.
      void this.start().catch((error: unknown) => {
        if (this.stopping) return;
        this.recordFailure(error instanceof Error ? error : new Error(String(error)));
        this.consecutiveFailures += 1;
        this.scheduleRestart();
      });
    }, delay);
  }

  private cancelRestart(): void {
    if (!this.restartTimer) return;
    (this.options.clearTimeout ?? clearTimeout)(this.restartTimer);
    this.restartTimer = undefined;
  }

  private recordFailure(error: Error): void {
    this.lastError = error.message;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
