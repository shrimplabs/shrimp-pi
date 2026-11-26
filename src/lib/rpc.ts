/**
 * Pi RPC child: JSONL over stdin/stdout with strict LF framing, id correlation, backpressure
 * aware writes, stderr capture, and bounded escalation on shutdown.
 *
 * Protocol notes implemented here (verified against the pi 1.5.0 docs, rechecked against 1.6.1:
 * closing stdin now waits for pending work, which the stdin -> SIGTERM -> SIGKILL escalation allows):
 *  - one JSON object per line, terminated by LF; U+2028/U+2029 are legal inside JSON strings
 *    so readline must not be used (see framing.ts)
 *  - correlate responses by the request `id`, not by arrival order
 *  - a `prompt` response means accepted/queued/handled, never completion
 *  - `agent_end` closes one low-level run; `agent_settled` is the idle signal
 *  - events must be subscribed before the prompt is sent, and stdout must keep draining
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { LfFramer, encodeFrame } from './framing.ts';
import { appendLine, ensureParentDir, errMessage } from './util.ts';

export type RpcResponse = {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

export type ChildExit = { code: number | null; signal: string | null; message: string | null };

export type PiChildOptions = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  logs?: { stdin?: string; stdout?: string; stderr?: string };
  onEvent: (event: Record<string, unknown>) => void;
  onExit: (info: ChildExit) => void;
  requestTimeoutMs?: number;
  label?: string;
};

type Pending = {
  resolve: (value: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
};

export class RpcError extends Error {}

export class PiChild {
  #opts: PiChildOptions;
  #proc: ChildProcessWithoutNullStreams | null = null;
  #framer = new LfFramer();
  #pending = new Map<string, Pending>();
  #queue: string[] = [];
  #draining = false;
  #seq = 0;
  #closed = false;
  #stderrTail: string[] = [];
  #stdoutStream: fs.WriteStream | null = null;
  #stdinStream: fs.WriteStream | null = null;
  #stderrStream: fs.WriteStream | null = null;

  exited = false;
  closed = false;
  exitInfo: ChildExit | null = null;

  constructor(opts: PiChildOptions) {
    this.#opts = opts;
  }

  get pid(): number | null {
    return this.#proc?.pid ?? null;
  }

  get stderrTail(): string[] {
    return [...this.#stderrTail];
  }

  get label(): string {
    return this.#opts.label ?? 'pi';
  }

  start(): void {
    if (this.#proc) throw new RpcError('child already started');
    const [program, ...args] = this.#opts.argv;
    if (!program) throw new RpcError('empty command for pi child');
    for (const file of [this.#opts.logs?.stdin, this.#opts.logs?.stdout, this.#opts.logs?.stderr]) {
      if (file) ensureParentDir(file);
    }
    if (this.#opts.logs?.stdout) this.#stdoutStream = fs.createWriteStream(this.#opts.logs.stdout, { flags: 'a' });
    if (this.#opts.logs?.stdin) this.#stdinStream = fs.createWriteStream(this.#opts.logs.stdin, { flags: 'a' });
    if (this.#opts.logs?.stderr) this.#stderrStream = fs.createWriteStream(this.#opts.logs.stderr, { flags: 'a' });

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(program, args, {
        cwd: this.#opts.cwd,
        env: this.#opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group so shutdown can TERM/KILL the whole tree (bwrap + node inside).
        detached: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (err: unknown) {
      throw new RpcError(`failed to start ${this.label}: ${errMessage(err)}`);
    }
    this.#proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk: string) => this.#onStdout(chunk));
    proc.stderr.on('data', (chunk: string) => this.#onStderr(chunk));
    proc.stdin.on('error', (err: Error) => this.#failAll(new Error(`stdin error: ${err.message}`)));
    proc.stdout.on('error', (err: Error) => this.#failAll(new Error(`stdout error: ${err.message}`)));

    proc.on('error', (err: Error) => {
      this.exited = true;
      this.exitInfo = { code: null, signal: null, message: `child error: ${err.message}` };
      this.#failAll(new RpcError(this.exitInfo.message as string));
      this.#closeStreams();
      this.#opts.onExit(this.exitInfo);
    });
    proc.on('exit', (code, signal) => {
      // Fast signal for shutdown loops. Do NOT flush framing or report here: stdout can still
      // deliver buffered records after 'exit'; that happens on 'close'.
      this.exited = true;
      this.exitInfo = {
        code,
        signal,
        message: `${this.label} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
      };
    });

    proc.on('close', (code, signal) => {
      this.exited = true;
      this.closed = true;
      for (const text of this.#framer.end()) this.#dispatch(text);
      if (this.#framer.overflowed) {
        this.#opts.onEvent({ type: '$framing_overflow', message: 'dropped oversized unterminated record before close' });
      }
      this.exitInfo = this.exitInfo ?? {
        code,
        signal,
        message: `${this.label} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
      };
      this.#failAll(new RpcError(this.exitInfo.message as string));
      this.#closeStreams();
      this.#opts.onExit(this.exitInfo);
    });
  }

  #closeStreams(): void {
    for (const stream of [this.#stdoutStream, this.#stdinStream, this.#stderrStream]) {
      try {
        stream?.end();
      } catch {
        /* ignore */
      }
    }
    this.#stdoutStream = null;
    this.#stdinStream = null;
    this.#stderrStream = null;
  }

  #onStdout(chunk: string): void {
    this.#stdoutStream?.write(chunk);
    for (const record of this.#framer.push(Buffer.from(chunk, 'utf8'))) this.#dispatch(record);
    if (this.#framer.overflowed) {
      this.#framer = new LfFramer();
      this.#opts.onEvent({ type: '$framing_overflow', message: 'dropped oversized unterminated record from pi stdout' });
    }
  }

  #dispatch(record: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record);
    } catch (err: unknown) {
      // Malformed framing must never take the worker down, and must never be mistaken for
      // protocol progress: record it and keep reading.
      this.#opts.onEvent({
        type: '$malformed_frame',
        raw: record.slice(0, 2000),
        message: `unparseable stdout record: ${errMessage(err)}`,
      });
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.#opts.onEvent({ type: '$malformed_frame', raw: record.slice(0, 2000), message: 'stdout record was not an object' });
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.type === 'response') {
      const id = typeof obj.id === 'string' ? obj.id : null;
      if (id && this.#pending.has(id)) {
        const pending = this.#pending.get(id) as Pending;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve(obj as RpcResponse);
        return;
      }
      if (!id) {
        this.#opts.onEvent({ type: '$protocol_error', message: String(obj.error ?? 'unidentified parse error from pi') });
      }
      return;
    }
    this.#opts.onEvent(obj);
  }

  #onStderr(chunk: string): void {
    this.#stderrStream?.write(chunk);
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.#stderrTail.push(trimmed);
      if (this.#stderrTail.length > 50) this.#stderrTail.shift();
    }
    // stderr is diagnostics only: never parsed as protocol data.
  }

  #writeLine(line: string): void {
    if (!this.#proc || this.exited) throw new RpcError(`${this.label} is not running`);
    this.#stdinStream?.write(line);
    this.#queue.push(line);
    this.#drain();
  }

  #drain(): void {
    if (this.#draining || !this.#proc || this.exited) return;
    this.#draining = true;
    while (this.#queue.length > 0) {
      const line = this.#queue.shift() as string;
      // A `false` return still means the line was accepted into the stream buffer, so the line
      // is already dequeued: wait for 'drain' and only then continue with the next one.
      const ok = this.#proc.stdin.write(line);
      if (!ok) {
        this.#proc.stdin.once('drain', () => {
          this.#draining = false;
          this.#drain();
        });
        return;
      }
    }
    this.#draining = false;
  }

  nextId(prefix = 'req'): string {
    this.#seq += 1;
    return `${prefix}-${this.#seq}`;
  }

  /** Send a command and wait for the correlated response. */
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse> {
    if (this.exited) return Promise.reject(new RpcError(`${this.label} is not running (${this.exitInfo?.message ?? 'exited'})`));
    const id = typeof command.id === 'string' ? command.id : this.nextId();
    const payload = { ...command, id };
    const ms = timeoutMs ?? this.#opts.requestTimeoutMs ?? 30_000;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new RpcError(`timed out after ${ms}ms waiting for response to ${String(command.type)} (id ${id})`));
        }
      }, ms);
      this.#pending.set(id, { resolve, reject, timer, command: String(command.type) });
      try {
        this.#writeLine(encodeFrame(payload));
      } catch (err: unknown) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new RpcError(errMessage(err)));
      }
    });
  }

  /** Fire-and-forget record (used by tests and diagnostics). */
  writeRecord(record: Record<string, unknown>): void {
    this.#writeLine(encodeFrame(record));
  }

  #failAll(err: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }

  closeStdin(): void {
    try {
      this.#proc?.stdin.end();
    } catch {
      /* ignore */
    }
  }

  /**
   * Orderly shutdown, then escalation: close stdin (pi disposes its runtime), then SIGTERM
   * the process group, then SIGKILL. All work products are left on disk.
   */
  async shutdown(opts: { termGraceMs?: number; killGraceMs?: number } = {}): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const proc = this.#proc;
    if (!proc || this.exited) return;
    const pid = proc.pid;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          /* already gone */
        }
      }
    };
    this.closeStdin();
    if (await waitForExit(this, opts.termGraceMs ?? 5_000)) return;
    signalGroup('SIGTERM');
    if (await waitForExit(this, opts.killGraceMs ?? 5_000)) return;
    signalGroup('SIGKILL');
    await waitForExit(this, 3_000);
  }

  killGroup(signal: NodeJS.Signals): void {
    const pid = this.#proc?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }
}

async function waitForExit(child: PiChild, ms: number | undefined): Promise<boolean> {
  const timeout = ms ?? 5_000;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (child.exited) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return child.exited;
}

export function logRecord(file: string, record: Record<string, unknown>): void {
  appendLine(file, JSON.stringify(record));
}
