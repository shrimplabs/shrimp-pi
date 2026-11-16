/**
 * Control plane shared by the CLI and the daemon: socket requests, daemon liveness
 * diagnosis, detached daemon launch, and lock-protected state mutations that the CLI may
 * have to perform itself when no daemon is alive.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { WorkerState } from './types.ts';
import type { WorkerPaths } from './paths.ts';
import { LfFramer } from './framing.ts';
import { errMessage, pidLooksLike, sleep } from './util.ts';
import { ATTENTION_STATES, makeAcceptRecord, mutateState, readState, setAttention, transition, TERMINAL_STATES } from './state.ts';

export class BridgeError extends Error {
  code: string;
  errno: string | null;
  constructor(message: string, code = 'error', errno: string | null = null) {
    super(message);
    this.code = code;
    this.errno = errno;
  }
}

export type SocketRequest = Record<string, unknown>;

/** One request, one response, connection closed. Long-poll `wait` keeps the socket open. */
export function socketRequest(socketPath: string, request: SocketRequest, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(socketPath)) {
      reject(new BridgeError(`worker socket not present: ${socketPath}`, 'no_socket', 'ENOENT'));
      return;
    }
    const conn = net.createConnection(socketPath);
    const framer = new LfFramer();
    let settled = false;
    const timer = setTimeout(() => {
      finishReject(new BridgeError(`worker did not answer within ${timeoutMs}ms`, 'socket_timeout', 'ETIMEDOUT'));
    }, timeoutMs);
    function finishResolve(value: Record<string, unknown>) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(value);
    }
    function finishReject(err: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      reject(err);
    }
    conn.on('connect', () => {
      conn.write(`${JSON.stringify(request)}\n`);
    });
    conn.on('data', (chunk: Buffer) => {
      for (const record of framer.push(chunk)) {
        try {
          const parsed = JSON.parse(record);
          if (parsed && typeof parsed === 'object') {
            finishResolve(parsed as Record<string, unknown>);
            return;
          }
        } catch (err: unknown) {
          finishReject(new BridgeError(`worker socket sent an unparseable record: ${errMessage(err)}`, 'bad_response'));
        }
      }
    });
    conn.on('error', (err: Error) => {
      const errno = (err as NodeJS.ErrnoException).code ?? null;
      const code = errno === 'EACCES' || errno === 'EPERM' ? 'socket_permission' : 'socket_error';
      finishReject(new BridgeError(`worker socket error: ${err.message}`, code, errno));
    });
    conn.on('close', () => finishReject(new BridgeError('worker closed the connection without answering', 'socket_closed', 'ECONNRESET')));
  });
}

export type DaemonStatus = {
  alive: boolean;
  responsive: boolean;
  verdict: DaemonVerdict;
  pid: number | null;
  childPid: number | null;
  socketPresent: boolean;
  pidError: string | null;
  socketError: string | null;
  recordedPidNamespace: string | null;
  currentPidNamespace: string | null;
  namespaceMismatch: boolean;
  detail: string;
};

export type DaemonVerdict = 'alive' | 'dead' | 'foreign_context' | 'unresponsive' | 'unknown';

export function readPidFile(file: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Identity of the PID namespace this process runs in (null where /proc is unavailable). */
export function pidNamespace(): string | null {
  try {
    return fs.readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
}

export function daemonNeedles(paths: WorkerPaths): string[] {
  return ['shrimp-pi', 'daemon.ts', paths.id];
}

const PERMISSION_ERRORS = new Set(['EACCES', 'EPERM']);

/**
 * Liveness diagnosis that never guesses across a visibility boundary.
 *
 * A CLI running in a restricted PID/socket namespace cannot see the daemon's process or its
 * Unix socket. That is NOT evidence that the worker died, so it is reported as
 * `foreign_context` and callers must not mutate state or send signals. Death is only proven
 * when the recorded PID namespace matches, the process is gone, and the socket is absent or
 * refuses connections.
 */
export async function probeDaemon(
  paths: WorkerPaths,
  opts: { timeoutMs?: number; recordedPidNamespace?: string | null } = {},
): Promise<DaemonStatus> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const pid = readPidFile(paths.pidFile);
  const currentPidNamespace = pidNamespace();
  const recordedPidNamespace = opts.recordedPidNamespace ?? null;
  const namespaceMismatch = Boolean(
    recordedPidNamespace && currentPidNamespace && recordedPidNamespace !== currentPidNamespace,
  );

  let socketPresent = false;
  let socketError: string | null = null;
  try {
    fs.accessSync(paths.socket, fs.constants.R_OK | fs.constants.W_OK);
    socketPresent = true;
  } catch (err: unknown) {
    socketError = (err as NodeJS.ErrnoException).code ?? 'EIO';
  }

  let pidError: string | null = null;
  let pidRunning = false;
  if (pid === null) pidError = 'ENOENT';
  else {
    try {
      process.kill(pid, 0);
      pidRunning = true;
    } catch (err: unknown) {
      pidError = (err as NodeJS.ErrnoException).code ?? 'ESRCH';
    }
  }

  const base = {
    pid,
    childPid: null as number | null,
    socketPresent,
    pidError,
    socketError,
    recordedPidNamespace,
    currentPidNamespace,
    namespaceMismatch,
  };

  if (socketPresent) {
    try {
      const reply = await socketRequest(paths.socket, { op: 'ping', workerId: paths.id }, timeoutMs);
      return {
        ...base,
        childPid: typeof reply.childPid === 'number' ? reply.childPid : null,
        alive: true,
        responsive: true,
        verdict: 'alive',
        detail: 'daemon answered ping',
      };
    } catch (err: unknown) {
      socketError = err instanceof BridgeError ? err.errno : 'EIO';
      if (socketError && PERMISSION_ERRORS.has(socketError)) {
        return {
          ...base,
          socketError,
          alive: pidRunning,
          responsive: false,
          verdict: 'foreign_context',
          detail: `the worker socket exists but this process may not open it (${socketError}); run the CLI in the same access context that spawned the worker`,
        };
      }
      base.socketError = socketError;
    }
  } else if (socketError && PERMISSION_ERRORS.has(socketError)) {
    return {
      ...base,
      alive: pidRunning,
      responsive: false,
      verdict: 'foreign_context',
      detail: `the worker socket is not accessible from this context (${socketError}); cannot judge worker liveness`,
    };
  }

  if (namespaceMismatch) {
    return {
      ...base,
      alive: pidRunning,
      responsive: false,
      verdict: 'foreign_context',
      detail: `this CLI is in PID namespace ${currentPidNamespace ?? 'unknown'} but the daemon recorded ${recordedPidNamespace ?? 'unknown'}; the pid and socket visible here are not the daemon's`,
    };
  }
  if (pidError && PERMISSION_ERRORS.has(pidError)) {
    return {
      ...base,
      alive: true,
      responsive: false,
      verdict: 'foreign_context',
      detail: `daemon pid ${String(pid)} exists but belongs to another uid or context (${pidError})`,
    };
  }
  if (pidRunning) {
    if (socketError === 'ENOENT') {
      return {
        ...base,
        alive: true,
        responsive: false,
        verdict: 'unknown',
        detail: `daemon pid ${String(pid)} is running but has not created its socket yet`,
      };
    }
    if (!pidLooksLike(pid, daemonNeedles(paths))) {
      return {
        ...base,
        alive: false,
        responsive: false,
        verdict: 'dead',
        detail: `pid ${String(pid)} is alive but is not this worker's daemon (pid was reused)`,
      };
    }
    return {
      ...base,
      alive: true,
      responsive: false,
      verdict: 'unresponsive',
      detail: `daemon pid ${String(pid)} is running but its socket did not answer`,
    };
  }
  if (pid === null && socketError === 'ENOENT') {
    return {
      ...base,
      alive: false,
      responsive: false,
      verdict: 'dead',
      detail: 'no daemon pid file and no daemon socket',
    };
  }
  if (pidError === 'ESRCH' && (socketError === 'ENOENT' || socketError === 'ECONNREFUSED' || socketError === 'ECONNRESET')) {
    return {
      ...base,
      alive: false,
      responsive: false,
      verdict: 'dead',
      detail: `daemon pid ${String(pid)} is gone (${pidError}) and the socket reports ${socketError}`,
    };
  }
  return {
    ...base,
    alive: false,
    responsive: false,
    verdict: 'unknown',
    detail: `cannot determine daemon liveness (pid: ${pidError ?? 'ok'}, socket: ${socketError ?? 'ok'})`,
  };
}

export function accessContextMismatch(status: DaemonStatus): string {
  return `worker liveness cannot be determined from this access context: ${status.detail}. Run the CLI in the same PID/socket namespace and file-system permissions as the process that spawned the worker; the bridge refused to change worker state or signal any process.`;
}

/**
 * Detached daemon launch: survives CLI exit, logs to the worker log directory.
 * The daemon environment is sanitized (nothing unrelated is inherited) but must still carry
 * the endpoint key name the config explicitly names, otherwise an authenticated endpoint is
 * unusable after the CLI exits. Only the explicitly configured names are forwarded, and no
 * secret is ever written into the config snapshot or state.json.
 */
export function launchDaemon(opts: {
  stateDir: string;
  workerId: string;
  recover: boolean;
  daemonEntry: string;
  forwardEnv?: Record<string, string>;
}): { pid: number } {
  const args = [opts.daemonEntry, '--worker', opts.workerId, '--state-dir', opts.stateDir];
  if (opts.recover) args.push('--recover');
  const logPath = path.join(opts.stateDir, 'workers', opts.workerId, 'logs', 'daemon.log');
  const errPath = path.join(opts.stateDir, 'workers', opts.workerId, 'logs', 'daemon.stderr.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(logPath, 'a', 0o600);
  const errFd = fs.openSync(errPath, 'a', 0o600);
  const devNull = fs.openSync('/dev/null', 'r');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ ?? 'UTC',
    SHRIMP_PI_STATE_DIR: opts.stateDir,
  };
  for (const [name, value] of Object.entries(opts.forwardEnv ?? {})) {
    if (typeof value === 'string' && value.length > 0 && name !== 'SHRIMP_PI_STATE_DIR') env[name] = value;
  }
  const child = spawn(process.execPath, args, {
    cwd: path.join(opts.stateDir, 'workers', opts.workerId),
    env,
    stdio: [devNull, logFd, errFd],
    detached: true,
  });
  fs.closeSync(logFd);
  fs.closeSync(errFd);
  fs.closeSync(devNull);
  if (!child.pid) throw new BridgeError('failed to launch worker daemon', 'daemon_launch_failed');
  child.unref();
  return { pid: child.pid };
}

/**
 * A worker whose daemon is gone cannot advance on its own. Diagnose it explicitly instead of
 * leaving a stale RUNNING state forever.
 */
/**
 * A worker whose daemon is provably gone cannot advance on its own, so record FAILED
 * explicitly. This refuses to act unless death is proven in THIS access context: on a
 * foreign PID/socket namespace or a permission error nothing is mutated at all.
 */
export async function markDaemonLost(
  paths: WorkerPaths,
  reason: string,
  status?: DaemonStatus,
): Promise<{ state: WorkerState | null; marked: boolean; verdict: DaemonVerdict; message: string }> {
  const state = readState(paths.stateFile);
  if (!state) return { state: null, marked: false, verdict: 'unknown', message: `no state file for ${paths.id}` };
  if (TERMINAL_STATES.has(state.state)) {
    return { state, marked: false, verdict: 'alive', message: `worker is already ${state.state}` };
  }
  const diagnosis = status ?? (await probeDaemon(paths, { recordedPidNamespace: state.daemon.pidNamespace }));
  if (diagnosis.verdict !== 'dead') {
    return {
      state,
      marked: false,
      verdict: diagnosis.verdict,
      message:
        diagnosis.verdict === 'foreign_context'
          ? accessContextMismatch(diagnosis)
          : `worker state was left untouched: ${diagnosis.detail}`,
    };
  }
  const { state: updated } = await mutateState(paths, (current) => {
    if (TERMINAL_STATES.has(current.state)) return;
    const message = `worker daemon is gone (${diagnosis.detail}): ${reason}`;
    transition(current, 'FAILED', message, { reason: 'daemon_lost' });
    setAttention(current, 'failed', 'daemon_lost', message);
    current.daemon.childExitedAt = current.daemon.childExitedAt ?? new Date().toISOString();
  });
  return { state: updated, marked: true, verdict: diagnosis.verdict, message: `recorded FAILED: ${diagnosis.detail}` };
}

export type AcceptResult = { state: WorkerState; accepted: boolean; message: string };

/** Supervisor acceptance. Records the decision; never merges, never deletes. */
export async function applyAccept(
  paths: WorkerPaths,
  opts: { note: string | null; force: boolean; reportId: string | null; diffSha256: string | null },
): Promise<AcceptResult> {
  const { state, result } = await mutateState(paths, (current) => {
    if (current.state === 'COMPLETED') {
      return { accepted: false, message: `worker already COMPLETED at revision ${current.revision}; nothing merged` };
    }
    if (current.state !== 'REVIEW_REQUIRED' && !opts.force) {
      return {
        accepted: false,
        message: `worker is ${current.state}, not REVIEW_REQUIRED; accept only records acceptance after review (pass --force to accept anyway)`,
      };
    }
    if (current.state !== 'REVIEW_REQUIRED' && opts.force && ATTENTION_STATES.has(current.state) === false) {
      return { accepted: false, message: `worker is ${current.state}; refusing to accept a running worker even with --force` };
    }
    current.accept = makeAcceptRecord(current, opts.note, opts.reportId, opts.diffSha256);
    transition(current, 'COMPLETED', `supervisor accepted the work${opts.note ? `: ${opts.note}` : ''}`, {
      reason: 'supervisor_accepted',
      force: opts.force && current.state !== 'REVIEW_REQUIRED',
    });
    return { accepted: true, message: 'acceptance recorded; the bridge never merges or deletes anything' };
  });
  return { state, ...result };
}

export async function waitForSocket(paths: WorkerPaths, timeoutMs: number): Promise<DaemonStatus | null> {
  const started = Date.now();
  let last: DaemonStatus | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await probeDaemon(paths, { timeoutMs: 1000 });
    if (last.responsive) return last;
    await sleep(100);
  }
  return last;
}
