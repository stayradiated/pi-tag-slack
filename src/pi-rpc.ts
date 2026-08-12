import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TextDecoder } from 'node:util';

export type PiAcceptance = { acceptedAt: string; sessionId: string; runSequence: number };
export type PiRuntimeFailure = {
  event: 'pi_prompt_preflight_timeout' | 'pi_rpc_failure';
  reason: string;
};
export type PiSessionStatus = {
  running: boolean;
  health: 'healthy' | 'degraded';
  sessionId: string | null;
  activity: 'active' | 'idle';
  runSequence: number;
  lastError: string | null;
  /** Retained across automatic restarts so recovery evidence remains inspectable. */
  lastFailure: PiRuntimeFailure | null;
  desiredModel: string | null;
  desiredThinking: string | null;
  effectiveModel: string | null;
  effectiveThinking: string | null;
  pending: boolean;
};
type Frame = Record<string, unknown>;
type PendingCommand = {
  command: string;
  resolve: (value: Frame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type DesiredSessionSettings = { model: string | null; thinking: string | null };
export type PiModel = { provider: string; id: string; ref: string };
export type PiApplyResult = { application: 'applied' | 'pending' | 'failed' };
const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const minimumPiVersion = [0, 82, 0] as const;
/** Shared with daemon lifecycle so gateway finalizers cannot outrun escalation. */
export const PI_STOP_GRACE_MS = 5_000;
export const PI_STOP_TERMINATE_MS = 2_000;
export const PI_STOP_MAX_MS = PI_STOP_GRACE_MS + PI_STOP_TERMINATE_MS * 2;
/** Includes scheduler/event-loop margin beyond PiRpcSession's internal bound. */
export const PI_STOP_LIFECYCLE_TIMEOUT_MS = PI_STOP_MAX_MS + 1_000;
const DEFAULT_RPC_FRAME_BYTES = 1024 * 1024;
const DEFAULT_RPC_COMMAND_TIMEOUT_MS = 30_000;
export const SETUP_PI_VERSION_TIMEOUT_MS = 10_000;
const DEFAULT_STDERR_LOG_BYTES = 64 * 1024;
const DEFAULT_STDERR_LOG_EVENTS = 16;

/** Run the configured executable's version command before opening an RPC session. */
export function piEnvironment(extraPath = process.env.EXTRA_PATH): NodeJS.ProcessEnv {
  const prefix = extraPath?.trim();
  if (!prefix) return process.env;
  return { ...process.env, PATH: [prefix, process.env.PATH].filter(Boolean).join(':') };
}

export async function piVersion(
  binary: string,
  timeoutMs = SETUP_PI_VERSION_TIMEOUT_MS,
  environment = piEnvironment(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['--version'],
      { encoding: 'utf8', timeout: timeoutMs, env: environment },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Unable to run ${binary} --version: ${error.message}`));
          return;
        }
        resolve(String(stdout));
      },
    );
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
  private readonly pending = new Map<string, PendingCommand>();
  private streaming = false;
  private activityEpoch = 0;
  private sessionId: string | undefined;
  private sequence = 0;
  private lastError: string | undefined;
  private lastFailure: PiRuntimeFailure | undefined;
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
      /** Environment inherited by Pi; EXTRA_PATH is prepended to PATH. */
      environment?: NodeJS.ProcessEnv;
      /** Injectable only to make restart supervision deterministic in tests. */
      restartBaseMs?: number;
      restartMaxMs?: number;
      restartFailureThreshold?: number;
      setTimeout?: typeof setTimeout;
      clearTimeout?: typeof clearTimeout;
      /** Transport bounds are configurable so failure paths can be tested cheaply. */
      commandTimeoutMs?: number;
      maxFrameBytes?: number;
      maxIncompleteBytes?: number;
      stderrLogMaxBytes?: number;
      stderrLogMaxEvents?: number;
      onStderrActivity?: (activity: { bytes: number; suppressed: boolean }) => void;
      /** Bounded graceful shutdown seams for daemon lifecycle tests. */
      stopGraceMs?: number;
      stopTerminateMs?: number;
      onRuntimeFailure?: (failure: PiRuntimeFailure) => void;
      /** Called once when this session loses ownership of a running child. */
      onUnexpectedExit?: () => void;
    },
  ) {}

  private startPromise: Promise<void> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private consecutiveFailures = 0;
  private stopping = false;
  private restartAfterStart = false;
  private stopPromise: Promise<void> | undefined;

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
    const output = this.options.version
      ? await this.options.version(this.options.binary)
      : await piVersion(this.options.binary, SETUP_PI_VERSION_TIMEOUT_MS, this.options.environment);
    if (this.stopping) throw new Error('pi RPC session is stopping.');
    requireSupportedPiVersion(output);
    const child = (this.options.spawn ?? spawn)(
      this.options.binary,
      ['--mode', 'rpc', '--session-dir', this.options.sessionDir, '--continue', '--approve'],
      {
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.options.environment ?? piEnvironment(),
      },
    );
    this.child = child;
    this.buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => this.receive(child, chunk));
    this.drainStderr(child);
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
      // The catalog is model-specific. Only validate it here when the resumed
      // model is already the desired model; applyDesired validates again after
      // selecting a different target model.
      if (
        desired.thinking &&
        (!desired.model || desired.model === this.effectiveModel) &&
        !levels.includes(desired.thinking)
      )
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
      // Model selection can change both the effective thinking value and its
      // catalog. Read both from the resulting model before applying thinking.
      this.applyState(await this.getState());
      const levels = await this.availableThinkingLevels();
      if (desired.thinking && !levels.includes(desired.thinking))
        throw new Error(
          `Configured thinking level is unavailable for the resulting model: ${desired.thinking}`,
        );
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
      if (desired.model !== null && desired.model !== this.effectiveModel)
        throw new Error(
          `pi effective model does not match desired model: expected ${desired.model}, received ${this.effectiveModel ?? 'none'}.`,
        );
      if (desired.thinking !== null && desired.thinking !== this.effectiveThinking)
        throw new Error(
          `pi effective thinking does not match desired thinking: expected ${desired.thinking}, received ${this.effectiveThinking ?? 'none'}.`,
        );
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
    if (!this.sessionId) throw new Error('pi accepted work without a session ID.');
    this.sequence += 1;
    return {
      acceptedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      runSequence: this.sequence,
    };
  }

  async stop(): Promise<void> {
    return (this.stopPromise ??= this.stopBounded());
  }

  private async stopBounded(): Promise<void> {
    // This is terminal daemon shutdown. It must win races with exit handlers
    // and with a timer that was already queued.
    this.stopping = true;
    this.cancelRestart();
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // A broken stdin still receives bounded process escalation below.
    }
    if (await this.waitForExit(child, this.options.stopGraceMs ?? PI_STOP_GRACE_MS)) return;
    child.kill('SIGTERM');
    if (await this.waitForExit(child, this.options.stopTerminateMs ?? PI_STOP_TERMINATE_MS)) return;
    child.kill('SIGKILL');
    // SIGKILL should be final; never let a broken child event source hang daemon cleanup.
    await this.waitForExit(child, this.options.stopTerminateMs ?? PI_STOP_TERMINATE_MS);
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (this.child !== child) return Promise.resolve(true);
    const schedule = this.options.setTimeout ?? setTimeout;
    const cancel = this.options.clearTimeout ?? clearTimeout;
    return new Promise((resolve) => {
      const timer = schedule(() => {
        child.off('exit', exited);
        resolve(false);
      }, timeoutMs);
      const exited = () => {
        cancel(timer);
        resolve(true);
      };
      child.once('exit', exited);
    });
  }

  /** Monotonic token used to detect settle/restart transitions during reset flush. */
  currentActivityEpoch(): number {
    return this.activityEpoch;
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
      lastFailure: this.lastFailure ?? null,
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

  private setStreaming(streaming: boolean): void {
    if (this.streaming !== streaming) this.activityEpoch += 1;
    this.streaming = streaming;
  }

  private applyState(state: Frame): void {
    this.setStreaming(state.isStreaming === true);
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
    const child = this.child;
    if (!child) return Promise.reject(new Error('pi RPC process is not running.'));
    const id = randomUUID();
    const frame = JSON.stringify({ id, type, ...values });
    const schedule = this.options.setTimeout ?? setTimeout;
    return new Promise((resolve, reject) => {
      const timer = schedule(() => {
        const pending = this.takePending(id);
        if (!pending) return;
        const error = new Error(`pi RPC ${type} command timed out.`);
        pending.reject(error);
        this.failTransport(child, error);
      }, this.options.commandTimeoutMs ?? DEFAULT_RPC_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { command: type, resolve, reject, timer });
      child.stdin.write(`${frame}\n`, (error) => {
        if (!error) return;
        const pending = this.takePending(id);
        if (!pending) return;
        pending.reject(error);
        this.failTransport(child, error);
      });
    });
  }

  private receive(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child) return;
    let offset = 0;
    while (offset < chunk.length && this.child === child) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const addition = end - offset;
      const limit =
        newline < 0
          ? (this.options.maxIncompleteBytes ?? DEFAULT_RPC_FRAME_BYTES)
          : (this.options.maxFrameBytes ?? DEFAULT_RPC_FRAME_BYTES);
      if (this.buffer.length + addition > limit) {
        this.failTransport(
          child,
          new Error(
            newline < 0
              ? 'pi RPC incomplete frame exceeded the byte limit.'
              : 'pi RPC frame exceeded the byte limit.',
          ),
        );
        return;
      }
      if (addition > 0) {
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
      }
      if (newline < 0) return;
      const raw = this.buffer;
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      try {
        this.processFrame(child, raw);
      } catch (error) {
        this.failTransport(
          child,
          new Error(
            `Invalid pi RPC frame: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
    }
  }

  private processFrame(child: ChildProcessWithoutNullStreams, raw: Buffer): void {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\r$/, '');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('frame must be an object');
    const frame = parsed as Frame;
    if (typeof frame.type !== 'string' || !frame.type) throw new Error('frame type is missing');

    if (frame.type === 'agent_start') this.setStreaming(true);
    if (frame.type === 'agent_settled') {
      this.setStreaming(false);
      this.safeBoundaryHandler?.();
    }

    if (frame.type === 'response') {
      if (typeof frame.id !== 'string' || !frame.id) throw new Error('response id is missing');
      const pending = this.pending.get(frame.id);
      if (!pending) throw new Error('response id is not pending');
      this.validateCorrelatedResponse(pending.command, frame);
      // Pi 0.82 acknowledges prompt preflight before emitting agent_start.
      // Record the accepted logical turn in frame receive-order so a caller
      // awakened by this response queues immediate work as a follow-up. Later
      // frames in this same chunk (especially agent_settled) still win.
      if (
        frame.success === true &&
        (pending.command === 'prompt' || pending.command === 'follow_up')
      )
        this.setStreaming(true);
      this.takePending(frame.id)!.resolve(frame);
      return;
    }

    // A command id may only correlate a response, never an arbitrary event.
    if (typeof frame.id === 'string' && this.pending.has(frame.id)) {
      const command = this.pending.get(frame.id)!.command;
      throw new Error(`Invalid ${command} response from pi RPC: frame is not a response`);
    }
    if (this.child !== child) throw new Error('response arrived from a stale child');
  }

  private validateCorrelatedResponse(command: string, frame: Frame): void {
    if (frame.command !== command) throw new Error(`response command does not match ${command}`);
    if (typeof frame.success !== 'boolean') throw new Error('response success is not boolean');
    if (frame.success === false && typeof frame.error !== 'string')
      throw new Error('failed response error is missing');

    // Validate the response payloads consumed as runtime state before resolving
    // the command. Mutation/notification responses have no payload contract.
    if (frame.success && command === 'get_state' && !isValidState(frame.data))
      throw new Error('Invalid get_state response from pi RPC.');
    if (frame.success && command === 'get_available_models' && !isValidModels(frame.data))
      throw new Error('Invalid get_available_models response from pi RPC.');
    if (
      frame.success &&
      command === 'get_available_thinking_levels' &&
      !isValidThinkingLevels(frame.data)
    )
      throw new Error('Invalid get_available_thinking_levels response from pi RPC.');
  }

  private takePending(id: string): PendingCommand | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    (this.options.clearTimeout ?? clearTimeout)(pending.timer);
    return pending;
  }

  private failTransport(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.buffer = Buffer.alloc(0);
    this.handleUnexpectedExit(child, error);
    child.kill();
  }

  private drainStderr(child: ChildProcessWithoutNullStreams): void {
    let loggedBytes = 0;
    let loggedEvents = 0;
    let suppressionLogged = false;
    const byteLimit = this.options.stderrLogMaxBytes ?? DEFAULT_STDERR_LOG_BYTES;
    const eventLimit = this.options.stderrLogMaxEvents ?? DEFAULT_STDERR_LOG_EVENTS;
    child.stderr.on('data', (value: Buffer | string) => {
      const bytes = Buffer.byteLength(value);
      if (loggedBytes < byteLimit && loggedEvents < eventLimit) {
        const report = Math.min(bytes, byteLimit - loggedBytes);
        loggedBytes += report;
        loggedEvents += 1;
        this.options.onStderrActivity?.({ bytes: report, suppressed: report < bytes });
        if (report < bytes) suppressionLogged = true;
      } else if (!suppressionLogged) {
        suppressionLogged = true;
        this.options.onStderrActivity?.({ bytes: 0, suppressed: true });
      }
      // The listener intentionally consumes every chunk after logging is capped.
    });
  }

  private failStart(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (!this.stopping) this.recordFailure(error);
    if (this.child === child) this.child = undefined;
    this.buffer = Buffer.alloc(0);
    this.setStreaming(false);
    child.stdin.end();
    child.kill();
  }

  private handleUnexpectedExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    // `error` and `exit` can both arrive. Only the owner of this child gets to
    // reject commands and schedule its successor.
    if (this.child !== child) return;
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
    this.setStreaming(false);
    if (!this.stopping) this.options.onUnexpectedExit?.();
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
    const failure = this.classifyFailure(error);
    this.lastFailure = failure;
    this.options.onRuntimeFailure?.(failure);
    this.rejectPending(error);
  }

  private classifyFailure(error: Error): PiRuntimeFailure {
    const promptPreflightTimeout =
      error.message === 'pi RPC prompt command timed out.' && !this.streaming;
    if (promptPreflightTimeout) {
      return {
        event: 'pi_prompt_preflight_timeout',
        reason:
          'Pi did not start the agent turn before the prompt deadline; a resumed session may be stalled in prompt preflight or compaction. Archive and replace it with pi-tag-slack session reset.',
      };
    }
    return { event: 'pi_rpc_failure', reason: error.message };
  }

  private rejectPending(error: Error): void {
    for (const id of [...this.pending.keys()]) this.takePending(id)?.reject(error);
  }
}

function isRecord(value: unknown): value is Frame {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.isStreaming !== 'boolean') return false;
  if (typeof value.sessionId !== 'string' || !value.sessionId) return false;
  if (typeof value.thinkingLevel !== 'string' || !thinkingLevels.has(value.thinkingLevel))
    return false;
  if (value.model === null || value.model === undefined) return true;
  return (
    isRecord(value.model) &&
    typeof value.model.provider === 'string' &&
    Boolean(value.model.provider) &&
    typeof value.model.id === 'string' &&
    Boolean(value.model.id)
  );
}

function isValidModels(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.models) &&
    value.models.every(
      (model) =>
        isRecord(model) &&
        typeof model.provider === 'string' &&
        Boolean(model.provider) &&
        typeof model.id === 'string' &&
        Boolean(model.id),
    )
  );
}

function isValidThinkingLevels(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.levels) &&
    value.levels.every((level) => typeof level === 'string' && thinkingLevels.has(level))
  );
}
