import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
    },
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = (this.options.spawn ?? spawn)(
      this.options.binary,
      ['--mode', 'rpc', '--session-dir', this.options.sessionDir, '--continue', '--approve'],
      {
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.on('error', (error) => this.recordFailure(error));
    child.on('exit', (code, signal) => {
      this.child = undefined;
      this.streaming = false;
      this.recordFailure(
        new Error(`pi RPC process exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`),
      );
    });
    await this.command('set_follow_up_mode', { mode: 'one-at-a-time' });
    this.applyState(await this.getState());
  }

  /** Run desired configuration only after pi reports a settled safe boundary. */
  setSafeBoundaryHandler(handler: () => void): void {
    this.safeBoundaryHandler = handler;
  }

  async availableModels(): Promise<PiModel[]> {
    const response = await this.command('get_available_models');
    const models = response.data && typeof response.data === 'object' && !Array.isArray(response.data)
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
    const levels = response.data && typeof response.data === 'object' && !Array.isArray(response.data)
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
        if (response.type !== 'response' || response.command !== 'set_model' || response.success !== true)
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
    if (!this.child) await this.start();
    const command = this.streaming ? 'follow_up' : 'prompt';
    const response = await this.command(command, { message });
    if (response.success !== true) throw new Error(`pi rejected ${command}.`);
    this.sequence += 1;
    return {
      acceptedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      runSequence: this.sequence,
    };
  }

  async stop(): Promise<void> {
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

  private recordFailure(error: Error): void {
    this.lastError = error.message;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
