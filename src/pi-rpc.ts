import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TextDecoder } from 'node:util';

export type PiAcceptance = { acceptedAt: string; sessionId?: string; runSequence: number };
type Frame = Record<string, unknown>;

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

  constructor(private readonly options: { binary: string; sessionDir: string; cwd: string }) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(
      this.options.binary,
      ['--mode', 'rpc', '--session-dir', this.options.sessionDir, '--continue', '--approve'],
      {
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.on('error', (error) => this.failAll(error));
    child.on('exit', () => {
      this.child = undefined;
      this.streaming = false;
      this.failAll(new Error('pi RPC process exited.'));
    });
    await this.command('set_follow_up_mode', { mode: 'one-at-a-time' });
    const state = await this.command('get_state');
    this.streaming = state.isStreaming === true;
    this.sessionId = typeof state.sessionName === 'string' ? state.sessionName : undefined;
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
        if (frame.type === 'agent_settled') this.streaming = false;
        if (typeof frame.id === 'string' && this.pending.has(frame.id)) {
          const pending = this.pending.get(frame.id)!;
          this.pending.delete(frame.id);
          pending.resolve(frame);
        }
      } catch (error) {
        this.failAll(new Error(`Invalid pi RPC frame: ${(error as Error).message}`));
        this.child?.kill();
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
