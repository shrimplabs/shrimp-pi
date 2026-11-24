/**
 * Per-worker daemon. Owns one persistent Pi RPC child, a Unix socket for supervisor requests
 * (including long-poll `wait`, which is event driven: the supervisor never polls), and the
 * authoritative state transitions for one worker. It stays alive while idle so a supervisor
 * can steer the same session after review; `stop` ends it.
 *
 * Concurrency rules implemented here:
 *  - events are ingested in arrival order by a single async pump, so a tool failure can never
 *    be processed after the agent_settled that follows it;
 *  - the pump never awaits an `abort` response, because `abort` only answers once the session
 *    is idle and that would deadlock the queue that has to deliver agent_settled;
 *  - every run owns its outcome through a generation counter: a child exit that already marked
 *    the run FAILED can never be overwritten by the run's own evaluation;
 *  - mutating socket ops (start/steer/accept/stop) are serialized, read-only ops (status/ping)
 *    and long-poll wait are not.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { BridgeConfig, RunRecord, ToolEvidence, Usage, WorkerState, WorkerStateName } from './types.ts';
import { ensureWorkerDirs, workerPaths, type WorkerPaths } from './paths.ts';
import { buildChildEnv, buildModelsJson, buildPiArgv, loadConfig } from './config.ts';
import { checkSandbox, defaultBinds, wrapCommand, type SandboxStatus } from './sandbox.ts';
import { PiChild, type ChildExit } from './rpc.ts';
import {
  clearAttention,
  emptyUsage,
  mutateState,
  pushEvidence,
  pushIntervention,
  pushWarning,
  readState,
  setAttention,
  transition,
  TERMINAL_STATES,
  waitSatisfied,
} from './state.ts';
import { buildResumeNotice, buildTaskPrompt, parseAgentReport, type ParsedReport } from './prompt.ts';
import { applyAccept, pidNamespace, readPidFile, BridgeError } from './worker.ts';
import { appendLine, atomicWrite, clampInt, errMessage, nowIso, truncate } from './util.ts';

export type DaemonOptions = { workerId: string; stateDir: string; recover: boolean };

type SettleSignal = { aborted: boolean };

type ActiveRun = {
  seq: number;
  record: RunRecord;
  dispositions: string[];
  settleSignals: SettleSignal[];
  settleWaiter: ((signal: SettleSignal | 'timeout') => void) | null;
  dispositionWaiter: ((disposition: string | null) => void) | null;
  timedOut: boolean;
  cancelled: boolean;
};

type Waiter = { after: number | null; socket: net.Socket; timer: NodeJS.Timeout };

const CHILD_EXIT = '$child_exit';

export class WorkerDaemon {
  #opts: DaemonOptions;
  #paths: WorkerPaths;
  #config: BridgeConfig;
  #state: WorkerState;
  #child: PiChild | null = null;
  #server: net.Server | null = null;
  #waiters = new Set<Waiter>();
  #stopping = false;
  #started = false;
  #pendingAbort: string | null = null;
  #run: ActiveRun | null = null;
  #runSeq = 0;
  #toolArgs = new Map<string, Record<string, unknown>>();
  #eventQueue: Record<string, unknown>[] = [];
  #pumping = false;
  #opChain: Promise<unknown> = Promise.resolve();
  #autoStart: NodeJS.Timeout | null = null;
  #exitTimer: NodeJS.Timeout | null = null;
  #calls = 0;
  #failures = 0;
  #consecutive = 0;
  #lastAssistantText: string | null = null;
  #lastAssistantStop: string | null = null;
  #lastAssistantError: string | null = null;
  #usage = emptyUsage();

  constructor(opts: DaemonOptions) {
    this.#opts = opts;
    this.#paths = workerPaths(opts.stateDir, opts.workerId);
    const state = readState(this.#paths.stateFile);
    if (!state) throw new BridgeError(`worker state not found: ${this.#paths.stateFile}`);
    this.#state = state;
    const loaded = loadConfig(this.#paths.configSnapshot);
    this.#config = loaded.config;
    this.#calls = state.tool.calls;
    this.#failures = state.tool.failures;
    this.#consecutive = state.tool.consecutiveFailures;
    this.#usage = state.usage;
  }

  get paths(): WorkerPaths {
    return this.#paths;
  }

  log(message: string, extra: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ at: nowIso(), workerId: this.#opts.workerId, message, ...extra });
    appendLine(this.#paths.eventsLog, line);
    process.stdout.write(`${line}\n`);
  }

  /** Serialize mutating operations so two requests cannot both create a run. */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#opChain.then(fn, fn);
    this.#opChain = next.catch((err: unknown) => {
      this.log(`serialized operation failed: ${errMessage(err)}`);
    });
    return next;
  }

  async main(): Promise<void> {
    ensureWorkerDirs(this.#paths);
    fs.writeFileSync(this.#paths.pidFile, `${process.pid}\n`, { mode: 0o600 });
    await this.#mutate((state) => {
      state.daemon.pid = process.pid;
      state.daemon.socket = this.#paths.socket;
      // Record which PID namespace this daemon lives in. A later CLI invocation in a
      // different namespace must not mistake its own invisible pid/socket for a dead worker.
      state.daemon.pidNamespace = pidNamespace();
      state.daemon.launchHost = os.hostname();
      state.daemon.startedAt = nowIso();
      state.daemon.lastSeenAt = nowIso();
    });
    await this.#listen();
    this.#installSignals();
    // The CLI normally sends `start` right away. If it died before doing so, start anyway: a
    // worker must not sit in CREATED forever because the caller vanished.
    this.#autoStart = setTimeout(() => {
      void this.#startWorker(this.#opts.recover).catch((err: unknown) => this.#fatal(errMessage(err)));
    }, 2000);
    this.#autoStart.unref();
  }

  #installSignals(): void {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        this.log(`received ${signal}`);
        void this.#serialize(() => this.#stop(`received ${signal}`)).finally(() => this.#exit(0));
      });
    }
    process.on('uncaughtException', (err: Error) => {
      this.log(`uncaught exception: ${err.message}`, { stack: truncate(String(err.stack), 2000) });
      void this.#fatal(`uncaught exception: ${err.message}`);
    });
    process.on('exit', () => {
      try {
        if (fs.existsSync(this.#paths.socket)) fs.unlinkSync(this.#paths.socket);
      } catch {
        /* best effort cleanup */
      }
      try {
        if (readPidFile(this.#paths.pidFile) === process.pid) fs.unlinkSync(this.#paths.pidFile);
      } catch {
        /* best effort cleanup */
      }
    });
  }

  async #listen(): Promise<void> {
    if (fs.existsSync(this.#paths.socket)) {
      // A socket left behind by a dead daemon is ours to replace; the CLI checks liveness
      // before launching, so a live daemon never gets here.
      fs.unlinkSync(this.#paths.socket);
    }
    const server = net.createServer((conn) => this.#onConnection(conn));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#paths.socket, () => resolve());
    });
    fs.chmodSync(this.#paths.socket, 0o600);
    this.#server = server;
    this.log('daemon socket ready', { socket: this.#paths.socket });
  }

  async #mutate(fn: (state: WorkerState) => void): Promise<WorkerState> {
    const { state } = await mutateState(this.#paths, fn);
    this.#state = state;
    this.#notifyWaiters();
    return state;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Serialized launch + kickoff. Returns as soon as the run is kicked off, not when it ends. */
  #startWorker(recover: boolean): Promise<{ note: string; alreadyRunning: boolean }> {
    return this.#serialize(async () => {
      if (this.#started) {
        if (this.#run) return { note: 'already running', alreadyRunning: true };
        return { note: 'already started', alreadyRunning: true };
      }
      if (this.#stopping) throw new BridgeError('daemon is stopping');
      this.#started = true;
      if (this.#autoStart) {
        clearTimeout(this.#autoStart);
        this.#autoStart = null;
      }
      await this.#launch();
      if (recover) {
        const notice = buildResumeNotice({ workerId: this.#opts.workerId, state: this.#state.state });
        await this.#mutate((state) => {
          if (!TERMINAL_STATES.has(state.state) && state.state !== 'BLOCKED') return;
          transition(state, 'BLOCKED', notice, { reason: 'recovered_interrupted', force: true });
          setAttention(state, 'interrupted', 'recovered_interrupted', notice);
          pushIntervention(state, 'recover', 'daemon relaunched on the same session file; nothing was replayed');
        });
        this.log('recovered: session reopened without replaying the original task');
        return { note: 'recovered; supervisor must steer to resume', alreadyRunning: false };
      }
      const taskText = fs.readFileSync(this.#paths.taskFile, 'utf8');
      void this.#runTurn('task', buildTaskPrompt(taskText, outputTokenLimit(this.#config)), { steer: false }).catch((err: unknown) =>
        this.#fatal(`task run failed: ${errMessage(err)}`),
      );
      return { note: 'task prompt submitted', alreadyRunning: false };
    });
  }

  async #awaitDisposition(timeoutMs: number): Promise<string | null> {
    const run = this.#run;
    if (!run) return null;
    if (run.dispositions.length > 0) return run.dispositions[0] ?? null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        run.dispositionWaiter = null;
        resolve(null);
      }, timeoutMs);
      run.dispositionWaiter = (disposition) => {
        clearTimeout(timer);
        run.dispositionWaiter = null;
        resolve(disposition);
      };
    });
  }

  async #launch(): Promise<void> {
    atomicWrite(this.#paths.modelsFile, buildModelsJson(this.#config));
    const inner = buildPiArgv(this.#config, { sessionFile: this.#state.sessionFile, cwd: this.#paths.workspace });
    const env = buildChildEnv(this.#config, { homeDir: this.#paths.homeDir, agentDir: this.#paths.agentDir, tmpDir: this.#paths.tmpDir });
    const binds = defaultBinds(this.#paths);
    const allowDisabled = this.#state.sandbox.mode === 'disabled';
    const status: SandboxStatus = checkSandbox(this.#config, { allowDisabled, binds });
    const wrapped = wrapCommand({
      config: this.#config,
      inner,
      cwd: this.#paths.workspace,
      env,
      binds,
      status,
      hostname: `pi-${this.#opts.workerId.slice(0, 8)}`,
    });
    this.#lastAssistantText = null;
    this.#lastAssistantStop = null;
    this.#lastAssistantError = null;
    const child = new PiChild({
      label: 'pi',
      argv: wrapped.argv,
      cwd: wrapped.cwd,
      env: wrapped.env,
      logs: { stdin: this.#paths.rpcInLog, stdout: this.#paths.rpcOutLog, stderr: this.#paths.stderrLog },
      onEvent: (event) => this.#enqueueEvent(event),
      onExit: (info) => this.#enqueueEvent({ type: CHILD_EXIT, ...info }),
    });
    child.start();
    this.#child = child;
    this.log('pi child launched', { pid: child.pid, mode: wrapped.mode });
    await this.#mutate((state) => {
      state.daemon.childPid = child.pid;
      state.daemon.childExitedAt = null;
      state.daemon.childExit = null;
      state.sandbox = { mode: wrapped.mode, detail: wrapped.detail, warnings: wrapped.warnings };
      for (const warning of wrapped.warnings) pushWarning(state, warning);
    });
    // Handshake: proves the RPC pipe is live and the isolated model config resolved.
    const reply = await child.request({ type: 'get_state' }, 30_000);
    if (!reply.success) {
      throw new BridgeError(`pi rejected the startup get_state command: ${reply.error ?? 'unknown error'}`);
    }
    const data = (reply.data ?? {}) as Record<string, unknown>;
    await this.#mutate((state) => {
      if (typeof data.sessionFile === 'string') state.sessionFile = data.sessionFile;
      if (data.model === undefined) pushWarning(state, 'pi reported no selected model in get_state at startup');
    });
  }

  /** Persist the outcome of the in-flight run entry (the in-memory record is not shared with
   * the parsed state object, so every path that ends a run outside #evaluate must write it). */
  #finishRunEntry(state: WorkerState, outcome: string): void {
    const current = state.runs[state.runs.length - 1];
    if (!current) return;
    current.endedAt = current.endedAt ?? nowIso();
    current.outcome = outcome;
  }

  async #fatal(message: string): Promise<void> {
    this.log(`fatal: ${message}`);
    const run = this.#run;
    if (run) {
      run.cancelled = true;
      this.#run = null;
      if (run.settleWaiter) run.settleWaiter({ aborted: true });
      if (run.dispositionWaiter) run.dispositionWaiter(null);
    }
    await this.#mutate((state) => {
      if (TERMINAL_STATES.has(state.state)) return;
      this.#finishRunEntry(state, 'daemon_error');
      transition(state, 'FAILED', message, { reason: 'daemon_error' });
    });
    await this.#stopChild();
    this.#exit(1);
  }

  async #stop(reason: string): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.log(`stopping worker: ${reason}`);
    const run = this.#run;
    if (run) {
      run.cancelled = true;
      this.#run = null;
      if (run.settleWaiter) run.settleWaiter({ aborted: true });
      if (run.dispositionWaiter) run.dispositionWaiter(null);
    }
    if (this.#child && this.#state.state === 'RUNNING') {
      try {
        await this.#child.request({ type: 'abort' }, 10_000);
      } catch (err: unknown) {
        this.log(`abort before stop failed (continuing with shutdown): ${errMessage(err)}`);
      }
    }
    await this.#stopChild();
    await this.#mutate((state) => {
      if (TERMINAL_STATES.has(state.state)) {
        pushWarning(state, `pi child shut down after the worker reached ${state.state}; no process was left running`);
        return;
      }
      this.#finishRunEntry(state, 'stopped');
      transition(state, 'STOPPED', `stopped by supervisor (${reason})`, { reason: 'supervisor_stop' });
    });
    this.#resolveAllWaiters();
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    await child.shutdown({ termGraceMs: 5_000, killGraceMs: 4_000 });
  }

  #exit(code: number): void {
    if (this.#exitTimer) return;
    this.#resolveAllWaiters();
    try {
      this.#server?.close();
    } catch {
      /* ignore */
    }
    this.#exitTimer = setTimeout(() => process.exit(code), 200);
    setTimeout(() => process.exit(code), 800).unref();
  }

  // ---------------------------------------------------------------- runs

  #newRun(kind: RunRecord['kind']): ActiveRun {
    const record: RunRecord = {
      index: this.#state.runs.length + 1,
      startedAt: nowIso(),
      endedAt: null,
      kind,
      disposition: null,
      agentEndCount: 0,
      settled: false,
      settledAborted: false,
      stopReason: null,
      errorMessage: null,
      reportStatus: null,
      outcome: null,
      interventionCount: 0,
    };
    return {
      seq: ++this.#runSeq,
      record,
      dispositions: [],
      settleSignals: [],
      settleWaiter: null,
      dispositionWaiter: null,
      timedOut: false,
      cancelled: false,
    };
  }

  async #runTurn(kind: RunRecord['kind'], text: string, opts: { steer: boolean }): Promise<void> {
    if (!this.#child || this.#child.exited) throw new BridgeError('pi child is not running');
    const run = this.#newRun(kind);
    this.#run = run;
    this.#pendingAbort = null;
    this.#lastAssistantText = null;
    this.#lastAssistantStop = null;
    this.#lastAssistantError = null;
    const child = this.#child;
    await this.#mutate((state) => {
      transition(state, 'RUNNING', kind === 'task' ? 'task prompt sent' : `${kind} prompt sent`, { force: true });
      state.runs.push(run.record);
      if (state.runs.length > 50) state.runs = state.runs.slice(-50);
      if (kind === 'steer') pushIntervention(state, 'steer', text);
    });

    let disposition: string | null = null;
    try {
      const command: Record<string, unknown> = { type: 'prompt', message: text };
      if (opts.steer) command.streamingBehavior = 'steer';
      let reply = await child.request(command, 120_000);
      if (!reply.success && opts.steer && /stream/i.test(reply.error ?? '')) {
        // Not streaming any more: an idle prompt restarts the same session.
        this.log('steer rejected because the agent is idle; sending an idle prompt on the same session');
        reply = await child.request({ type: 'prompt', message: text }, 120_000);
      }
      if (!reply.success) {
        run.record.outcome = 'prompt_rejected';
        run.record.errorMessage = reply.error ?? 'prompt rejected';
        if (this.#run === run) this.#run = null;
        await this.#mutate((state) => {
          if (this.#state.state === 'RUNNING') {
            transition(state, 'FAILED', `prompt rejected: ${reply.error ?? 'unknown error'}`, { reason: 'prompt_rejected' });
          }
        });
        return;
      }
      disposition = ((reply.data ?? {}) as Record<string, unknown>).disposition as string | null;
    } catch (err: unknown) {
      run.record.outcome = 'prompt_send_failed';
      run.record.errorMessage = errMessage(err);
      if (this.#run === run) this.#run = null;
      await this.#mutate((state) => {
        if (this.#state.state === 'RUNNING') {
          transition(state, 'FAILED', `could not send the prompt: ${errMessage(err)}`, { reason: 'prompt_send_failed' });
        }
      });
      return;
    }
    if (run.cancelled || this.#run !== run) {
      this.log(`run ${run.seq} was cancelled while the prompt was in flight (child exit or stop)`);
      return;
    }

    run.record.disposition = disposition;
    run.dispositions.push(disposition ?? 'unknown');
    if (run.dispositionWaiter) run.dispositionWaiter(disposition);
    await this.#mutate((state) => {
      const current = state.runs[state.runs.length - 1];
      if (current) current.disposition = disposition;
    });

    if (disposition === 'handled') {
      // No run started for this prompt: do not wait for agent_settled.
      run.record.outcome = 'handled';
      if (this.#run === run) this.#run = null;
      await this.#mutate((state) => {
        pushWarning(state, 'pi reported disposition "handled": no run started for that prompt');
        if (kind === 'task') {
          transition(state, 'BLOCKED', 'the task prompt was consumed without starting a run', { reason: 'prompt_handled' });
        }
      });
      return;
    }

    const timeoutMs = clampInt(this.#config.limits.runTimeoutSeconds, 5, 86_400, 1800) * 1000;
    const settled = await this.#awaitSettled(run, timeoutMs);
    if (run.cancelled || this.#run !== run) {
      // Something else already decided the outcome (child exit, stop). Do not overwrite it.
      this.log(`run ${run.seq} evaluation skipped: outcome already decided elsewhere`);
      return;
    }
    if (this.#stopping) {
      run.record.outcome = 'stopped';
      this.#run = null;
      return;
    }
    await this.#evaluate(run, settled);
  }

  #awaitSettled(run: ActiveRun, timeoutMs: number): Promise<SettleSignal | 'timeout'> {
    if (run.settleSignals.length > 0) return Promise.resolve(run.settleSignals.shift() as SettleSignal);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        run.timedOut = true;
        run.settleWaiter = null;
        resolve('timeout');
      }, timeoutMs);
      run.settleWaiter = (signal) => {
        clearTimeout(timer);
        run.settleWaiter = null;
        resolve(signal);
      };
    });
  }

  async #evaluate(run: ActiveRun, settled: SettleSignal | 'timeout'): Promise<void> {
    if (run.cancelled || this.#run !== run) {
      this.log(`ignoring stale evaluation of run ${run.seq}`);
      return;
    }
    run.record.endedAt = nowIso();
    if (settled !== 'timeout') {
      run.record.settled = true;
      run.record.settledAborted = settled.aborted;
    }
    run.record.stopReason = this.#lastAssistantStop;
    run.record.errorMessage = this.#lastAssistantError;
    const report: ParsedReport = parseAgentReport(this.#lastAssistantText);
    run.record.reportStatus = report.status;

    let to: WorkerStateName = 'BLOCKED';
    let reason = 'blocked';
    let message = 'worker is blocked';

    if (this.#pendingAbort) {
      // An abort we requested ourselves: the resulting agent_settled{aborted:true} must NOT
      // overwrite the reason we aborted for.
      reason = this.#pendingAbort;
      to = 'BLOCKED';
      message =
        reason === 'tool_failure_threshold'
          ? `${this.#consecutive} consecutive tool failures reached the threshold ${this.#config.limits.toolFailureThreshold}; the run was aborted and left for the supervisor`
          : `run aborted (${reason}); all work was kept`;
      run.record.outcome = reason;
      if (reason === 'run_timeout') await this.#sendAbortRequest('run_timeout');
    } else if (settled === 'timeout') {
      reason = 'run_timeout';
      to = 'BLOCKED';
      message = `no agent_settled within ${this.#config.limits.runTimeoutSeconds}s; the run was aborted and all work was kept`;
      run.record.outcome = reason;
      await this.#sendAbortRequest('run_timeout');
    } else if (settled.aborted) {
      reason = 'aborted';
      to = 'BLOCKED';
      message = 'the run was aborted; work was kept and the supervisor decides what is next';
      run.record.outcome = reason;
    } else if (this.#lastAssistantStop === 'error' || this.#lastAssistantError) {
      reason = 'provider_error';
      to = 'FAILED';
      message = `provider/model failure: ${this.#lastAssistantError ?? 'assistant message ended with stopReason error'}`;
      run.record.outcome = reason;
    } else if (this.#lastAssistantStop === 'length') {
      // The reply was cut off by the output-token limit (thinking included). Without this branch it
      // surfaced as a bare missing_report, and the supervisor had to read the session log to find out why.
      reason = 'output_truncated';
      to = 'BLOCKED';
      const limit = outputTokenLimit(this.#config);
      message =
        `the model's reply hit its output-token limit${limit ? ` (maxTokens ${limit})` : ''} before it finished, ` +
        'so there is no report. Steer it to work in smaller steps (write large files in pieces, keep thinking short), ' +
        'or raise modelOptions.maxTokens for new workers. All work so far is kept.';
      run.record.outcome = reason;
    } else if (!report.parsed) {
      reason = 'missing_report';
      to = 'BLOCKED';
      message =
        'the agent settled without a structured JSON report; a missing report is never treated as success: ' +
        (report.parseNotes[0] ?? 'no report found');
      run.record.outcome = reason;
    } else if (report.status === 'review') {
      to = 'REVIEW_REQUIRED';
      reason = 'agent_reported_review';
      message = report.workCompleted
        ? `agent reports work ready for review: ${report.workCompleted}`
        : 'agent reports work ready for review';
      run.record.outcome = 'review_required';
    } else if (report.status === 'blocked') {
      to = 'BLOCKED';
      reason = 'agent_blocked';
      message = report.outstandingProblems.length
        ? `agent is blocked: ${truncate(JSON.stringify(report.outstandingProblems), 400)}`
        : 'agent reported it is blocked';
      run.record.outcome = reason;
    } else {
      to = 'BLOCKED';
      reason = 'agent_checkpoint';
      message = report.workCompleted ? `agent checkpoint: ${report.workCompleted}` : 'agent stopped at a checkpoint';
      run.record.outcome = reason;
    }

    this.#run = null;
    const usage = await this.#collectUsage();
    await this.#mutate((state) => {
      state.report = report;
      state.lastAssistantText = this.#lastAssistantText ? truncate(this.#lastAssistantText, 20_000) : null;
      state.usage = usage;
      state.tool.calls = this.#calls;
      state.tool.failures = this.#failures;
      state.tool.consecutiveFailures = this.#consecutive;
      const current = state.runs[state.runs.length - 1];
      if (current) {
        current.endedAt = run.record.endedAt;
        current.settled = run.record.settled;
        current.settledAborted = run.record.settledAborted;
        current.stopReason = run.record.stopReason;
        current.errorMessage = run.record.errorMessage;
        current.reportStatus = run.record.reportStatus;
        current.outcome = run.record.outcome;
        current.agentEndCount = run.record.agentEndCount;
      }
      transition(state, to, message, { reason });
    });
    this.#pendingAbort = null;
    this.log(`run ${run.seq} finished: ${to} (${reason})`);
  }

  /**
   * Request an abort. Never awaited from the event pump: `abort` answers only once the session
   * is idle, and the pump is what delivers the settling event.
   */
  #sendAbortRequest(reason: string): Promise<void> {
    this.#pendingAbort = reason;
    const child = this.#child;
    if (!child || child.exited) return Promise.resolve();
    this.log(`requesting abort: ${reason}`);
    return child
      .request({ type: 'abort' }, 20_000)
      .then(() => {
        void this.#mutate((state) => pushIntervention(state, 'abort', reason));
      })
      .catch((err: unknown) => {
        this.log(`abort (${reason}) failed: ${errMessage(err)}`);
      });
  }

  async #collectUsage(): Promise<Usage> {
    const child = this.#child;
    if (!child || child.exited) return this.#usage;
    try {
      const reply = await child.request({ type: 'get_session_stats' }, 15_000);
      if (!reply.success) return this.#usage;
      const data = (reply.data ?? {}) as Record<string, unknown>;
      const tokens = (data.tokens ?? {}) as Record<string, unknown>;
      // Pi's `cost` is computed from configured prices, not billed by the provider. Only a
      // value with explicit provider provenance may be reported as a cost.
      const cost = data.cost;
      const costObject = cost && typeof cost === 'object' ? (cost as Record<string, unknown>) : null;
      const priceEstimate = typeof cost === 'number' ? cost : typeof costObject?.total === 'number' ? costObject.total : null;
      const provenance = typeof data.costSource === 'string' ? data.costSource : null;
      const providerCost = typeof costObject?.totalFromProvider === 'number' ? costObject.totalFromProvider : null;
      return {
        input: typeof tokens.input === 'number' ? tokens.input : null,
        output: typeof tokens.output === 'number' ? tokens.output : null,
        cacheRead: typeof tokens.cacheRead === 'number' ? tokens.cacheRead : null,
        cacheWrite: typeof tokens.cacheWrite === 'number' ? tokens.cacheWrite : null,
        totalTokens:
          typeof tokens.total === 'number'
            ? tokens.total
            : typeof tokens.totalTokens === 'number'
              ? tokens.totalTokens
              : null,
        costUsd: provenance === 'provider' ? providerCost : null,
        priceEstimateUsd: priceEstimate,
        source: 'pi:get_session_stats',
        collectedAt: nowIso(),
      };
    } catch (err: unknown) {
      this.log(`get_session_stats unavailable: ${errMessage(err)}`);
      return this.#usage;
    }
  }

  // ---------------------------------------------------------------- ordered event ingestion

  #enqueueEvent(event: Record<string, unknown>): void {
    this.#eventQueue.push(event);
    if (!this.#pumping) void this.#pumpEvents();
  }

  async #pumpEvents(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#eventQueue.length > 0) {
        const event = this.#eventQueue.shift() as Record<string, unknown>;
        try {
          await this.#handleEvent(event);
        } catch (err: unknown) {
          this.log(`event handler error for ${String(event.type)}: ${errMessage(err)}`);
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #handleEvent(event: Record<string, unknown>): Promise<void> {
    const type = String(event.type ?? 'unknown');
    if (type === CHILD_EXIT) {
      await this.#handleChildExit({
        code: typeof event.code === 'number' ? event.code : null,
        signal: typeof event.signal === 'string' ? event.signal : null,
        message: typeof event.message === 'string' ? event.message : 'pi child exited',
      });
      return;
    }
    if (type.startsWith('$')) {
      await this.#mutate((state) => pushWarning(state, `${type}: ${String(event.message ?? '')}`));
      this.log(`protocol anomaly ${type}`, { detail: event });
      return;
    }
    switch (type) {
      case 'agent_start':
      case 'turn_start':
      case 'message_start':
      case 'queue_update':
      case 'compaction_start':
      case 'compaction_end':
        appendLine(
          this.#paths.eventsLog,
          JSON.stringify({ at: nowIso(), workerId: this.#opts.workerId, event: truncate(JSON.stringify(event), 4000) }),
        );
        return;
      case 'agent_end': {
        // Explicitly NOT completion: retries, steering, and follow-ups can still follow.
        if (this.#run) this.#run.record.agentEndCount += 1;
        appendLine(
          this.#paths.eventsLog,
          JSON.stringify({
            at: nowIso(),
            workerId: this.#opts.workerId,
            event: 'agent_end',
            willRetry: event.willRetry,
          }),
        );
        return;
      }
      case 'message_end': {
        const message = event.message as Record<string, unknown> | undefined;
        if (!message || message.role !== 'assistant') return;
        const text = extractAssistantText(message);
        if (text.trim().length > 0) this.#lastAssistantText = text;
        this.#lastAssistantStop = typeof message.stopReason === 'string' ? message.stopReason : null;
        this.#lastAssistantError = typeof message.errorMessage === 'string' ? message.errorMessage : null;
        return;
      }
      case 'tool_execution_start': {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : null;
        if (id) this.#toolArgs.set(id, (event.args ?? {}) as Record<string, unknown>);
        return;
      }
      case 'tool_execution_end':
        await this.#recordToolEvidence(event);
        return;
      case 'agent_settled': {
        const run = this.#run;
        const signal: SettleSignal = { aborted: event.aborted === true };
        if (!run) {
          this.log('agent_settled with no active run (ignored for state)', { aborted: event.aborted === true });
          return;
        }
        if (run.settleWaiter) run.settleWaiter(signal);
        else run.settleSignals.push(signal);
        return;
      }
      default:
        return;
    }
  }

  async #recordToolEvidence(event: Record<string, unknown>): Promise<void> {
    const id = typeof event.toolCallId === 'string' ? event.toolCallId : null;
    const args = (id ? this.#toolArgs.get(id) : undefined) ?? {};
    const toolName = typeof event.toolName === 'string' ? event.toolName : 'unknown';
    const target =
      typeof args.command === 'string'
        ? truncate(args.command, 300)
        : typeof args.path === 'string'
          ? args.path
          : typeof args.pattern === 'string'
            ? args.pattern
            : null;
    const excerpt = extractResultText(event.result);
    const evidence: ToolEvidence = {
      at: nowIso(),
      run: this.#state.runs.length,
      toolCallId: id,
      toolName,
      isError: event.isError === true,
      durationMs: typeof event.durationMs === 'number' ? event.durationMs : null,
      target,
      outputExcerpt: excerpt ? truncate(excerpt, 500) : null,
    };
    this.#calls += 1;
    if (evidence.isError) {
      this.#failures += 1;
      this.#consecutive += 1;
    } else {
      this.#consecutive = 0;
    }
    await this.#mutate((state) => {
      pushEvidence(state, evidence, this.#config.limits.maxEvidence);
    });
    const threshold = clampInt(this.#config.limits.toolFailureThreshold, 1, 1000, 5);
    if (evidence.isError && this.#consecutive >= threshold && !this.#pendingAbort && this.#run && !this.#stopping) {
      this.log(`consecutive tool failures reached ${threshold}; aborting the run`, { toolName, target });
      // Deliberately not awaited: see #sendAbortRequest.
      void this.#sendAbortRequest('tool_failure_threshold');
    }
  }

  async #handleChildExit(info: ChildExit): Promise<void> {
    const child = this.#child;
    const stderrTail = child ? truncate(child.stderrTail.slice(-5).join(' | '), 600) : '';
    this.#child = null;
    if (this.#stopping) {
      this.log(`pi child exited while stopping: ${info.message ?? ''}`);
      return;
    }
    const run = this.#run;
    if (run) {
      // Take ownership of the outcome before waking the waiting run turn.
      run.cancelled = true;
      run.record.endedAt = nowIso();
      run.record.outcome = 'pi_child_exit';
      this.#run = null;
      if (run.settleWaiter) run.settleWaiter({ aborted: true });
      if (run.dispositionWaiter) run.dispositionWaiter(null);
      await this.#mutate((state) => {
        state.daemon.childExitedAt = nowIso();
        state.daemon.childExit = { code: info.code, signal: info.signal };
        const current = state.runs[state.runs.length - 1];
        if (current) {
          current.endedAt = run.record.endedAt ?? nowIso();
          current.outcome = 'pi_child_exit';
          current.errorMessage = info.message ?? null;
        }
        transition(
          state,
          'FAILED',
          `${info.message ?? 'pi child exited'}; last stderr: ${stderrTail || 'none captured'}`,
          { reason: 'pi_child_exit' },
        );
      });
      this.log('pi child died during a run; worker marked FAILED');
      return;
    }
    // Idle exit: the work products are still valid. Keep the state, relaunch on next steer.
    await this.#mutate((state) => {
      state.daemon.childExitedAt = nowIso();
      state.daemon.childExit = { code: info.code, signal: info.signal };
      pushWarning(
        state,
        `pi child exited while idle (${info.message ?? 'unknown'}); the next steer relaunches it on the same session file`,
      );
    });
    this.log('pi child exited while idle');
  }

  // ---------------------------------------------------------------- socket server

  #onConnection(conn: net.Socket): void {
    let buffer = Buffer.alloc(0);
    let handled = false;
    conn.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf(0x0a);
      if (index === -1 || handled) return;
      handled = true;
      const line = buffer.subarray(0, index).toString('utf8').replace(/\r$/, '');
      let request: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request was not an object');
        request = parsed as Record<string, unknown>;
      } catch (err: unknown) {
        this.#respond(conn, { ok: false, error: `unparseable request: ${errMessage(err)}`, code: 'bad_request' });
        conn.end();
        return;
      }
      void this.#handleRequest(conn, request);
    });
    conn.on('error', () => {
      /* supervisor went away; waiters are cleaned up by their timers */
    });
  }

  #respond(conn: net.Socket, payload: Record<string, unknown>): void {
    try {
      conn.write(`${JSON.stringify(payload)}\n`);
    } catch {
      /* peer gone */
    }
  }

  async #handleRequest(conn: net.Socket, request: Record<string, unknown>): Promise<void> {
    const op = String(request.op ?? request.type ?? '');
    const workerId = typeof request.workerId === 'string' ? request.workerId : null;
    if (workerId && workerId !== this.#opts.workerId) {
      this.#respond(conn, { ok: false, error: `this daemon serves worker ${this.#opts.workerId}`, code: 'wrong_worker' });
      conn.end();
      return;
    }
    try {
      switch (op) {
        case 'ping': {
          this.#respond(conn, {
            ok: true,
            workerId: this.#opts.workerId,
            pid: process.pid,
            childPid: this.#child?.pid ?? null,
            state: this.#state.state,
            revision: this.#state.revision,
            started: this.#started,
            activeRun: this.#run ? this.#run.record.index : null,
          });
          conn.end();
          return;
        }
        case 'status': {
          const state = readState(this.#paths.stateFile) ?? this.#state;
          this.#respond(conn, { ok: true, workerId: this.#opts.workerId, daemonPid: process.pid, state });
          conn.end();
          return;
        }
        case 'wait':
          await this.#handleWait(conn, request);
          return;
        case 'start': {
          const started = await this.#startWorker(request.recover === true || this.#opts.recover);
          const disposition = await this.#awaitDisposition(
            clampInt(this.#config.limits.spawnAckSeconds, 1, 600, 60) * 1000,
          );
          const state = readState(this.#paths.stateFile) ?? this.#state;
          this.#respond(conn, {
            ok: true,
            workerId: this.#opts.workerId,
            daemonPid: process.pid,
            childPid: this.#child?.pid ?? null,
            disposition,
            note: started.note,
            alreadyRunning: started.alreadyRunning,
            state: state.state,
            revision: state.revision,
          });
          conn.end();
          return;
        }
        case 'steer': {
          const text = typeof request.text === 'string' ? request.text : null;
          if (!text || !text.trim()) {
            this.#respond(conn, { ok: false, error: 'steer requires a non-empty text field', code: 'bad_request' });
            conn.end();
            return;
          }
          const result = await this.#serialize(() => this.#steer(text));
          const state = readState(this.#paths.stateFile) ?? this.#state;
          this.#respond(conn, {
            ok: true,
            workerId: this.#opts.workerId,
            ...result,
            state: state.state,
            revision: state.revision,
          });
          conn.end();
          return;
        }
        case 'stop': {
          const stopped = this.#serialize(() => this.#stop(typeof request.reason === 'string' ? request.reason : 'supervisor_stop'));
          await stopped;
          const state = readState(this.#paths.stateFile) ?? this.#state;
          this.#respond(conn, { ok: true, workerId: this.#opts.workerId, state: state.state, revision: state.revision });
          conn.end();
          this.#exit(0);
          return;
        }
        case 'accept': {
          const result = await this.#serialize(() =>
            applyAccept(this.#paths, {
              note: typeof request.note === 'string' ? request.note : null,
              force: request.force === true,
              reportId: typeof request.reportId === 'string' ? request.reportId : null,
              diffSha256: typeof request.diffSha256 === 'string' ? request.diffSha256 : null,
            }),
          );
          this.#respond(conn, {
            ok: true,
            workerId: this.#opts.workerId,
            accepted: result.accepted,
            message: result.message,
            state: result.state.state,
            revision: result.state.revision,
          });
          conn.end();
          if (result.accepted) {
            // COMPLETED is terminal: the daemon's job is done, the work products stay on disk.
            await this.#serialize(() => this.#stop('worker completed'));
            this.#exit(0);
          }
          return;
        }
        default:
          this.#respond(conn, { ok: false, error: `unknown op ${JSON.stringify(op)}`, code: 'unknown_op' });
          conn.end();
      }
    } catch (err: unknown) {
      this.#respond(conn, {
        ok: false,
        error: errMessage(err),
        code: err instanceof BridgeError ? err.code : 'daemon_error',
      });
      conn.end();
    }
  }

  async #steer(text: string): Promise<{ mode: string; disposition: string | null }> {
    if (TERMINAL_STATES.has(this.#state.state)) {
      throw new BridgeError(`worker is ${this.#state.state}; steering is not possible, spawn a new worker`);
    }
    const run = this.#run;
    if (run) {
      const child = this.#child;
      if (!child || child.exited) throw new BridgeError('the Pi child exited mid-run; run recover');
      const reply = await child.request({ type: 'prompt', message: text, streamingBehavior: 'steer' }, 60_000);
      if (!reply.success) throw new BridgeError(`steer rejected: ${reply.error ?? 'unknown error'}`);
      // The run can finish while this request is in flight: hold our own reference instead of
      // re-reading this.#run after the await.
      run.record.interventionCount += 1;
      const disposition = ((reply.data ?? {}) as Record<string, unknown>).disposition as string | null;
      await this.#mutate((state) => {
        pushIntervention(state, 'steer', text);
        const current = state.runs[state.runs.length - 1];
        if (current) current.interventionCount += 1;
      });
      return { mode: 'steer', disposition };
    }
    if (!this.#child || this.#child.exited) {
      this.log('steer arrived while the pi child was gone; relaunching on the same session file');
      await this.#launch();
      await this.#mutate((state) => {
        clearAttention(state);
      });
      void this.#runTurn('steer', text, { steer: false }).catch((err: unknown) =>
        this.#fatal(`steer run failed: ${errMessage(err)}`),
      );
      return { mode: 'relaunched', disposition: 'started' };
    }
    void this.#runTurn('steer', text, { steer: false }).catch((err: unknown) =>
      this.#fatal(`steer run failed: ${errMessage(err)}`),
    );
    return { mode: 'resume', disposition: 'started' };
  }

  async #handleWait(conn: net.Socket, request: Record<string, unknown>): Promise<void> {
    const after = typeof request.afterRevision === 'number' ? request.afterRevision : null;
    const maxMs = clampInt(this.#config.limits.maxWaitSeconds, 1, 86_400, 3600) * 1000;
    const timeoutMs = clampInt(request.timeoutMs, 100, maxMs, 300_000);
    const state = readState(this.#paths.stateFile) ?? this.#state;
    if (waitSatisfied(state, after)) {
      this.#respond(conn, waitPayload(state, 'attention', 0));
      conn.end();
      return;
    }
    const waiter: Waiter = {
      after,
      socket: conn,
      timer: setTimeout(() => {
        this.#waiters.delete(waiter);
        const current = readState(this.#paths.stateFile) ?? this.#state;
        this.#respond(conn, waitPayload(current, 'timed_out', timeoutMs));
        conn.end();
      }, timeoutMs),
    };
    this.#waiters.add(waiter);
    conn.on('close', () => {
      if (this.#waiters.delete(waiter)) clearTimeout(waiter.timer);
    });
  }

  #notifyWaiters(): void {
    if (this.#waiters.size === 0) return;
    const state = readState(this.#paths.stateFile);
    if (!state) return;
    for (const waiter of [...this.#waiters]) {
      if (!waitSatisfied(state, waiter.after)) continue;
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      try {
        this.#respond(waiter.socket, waitPayload(state, 'attention', 0));
        waiter.socket.end();
      } catch {
        /* peer gone */
      }
    }
  }

  #resolveAllWaiters(): void {
    const state = readState(this.#paths.stateFile) ?? this.#state;
    for (const waiter of [...this.#waiters]) {
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      try {
        this.#respond(waiter.socket, waitPayload(state, 'daemon_shutdown', 0));
        waiter.socket.end();
      } catch {
        /* peer gone */
      }
    }
  }
}

function waitPayload(state: WorkerState, outcome: string, waitedMs: number): Record<string, unknown> {
  return {
    ok: true,
    outcome,
    workerId: state.workerId,
    state: state.state,
    revision: state.revision,
    attention: state.attention,
    report: state.report
      ? { status: state.report.status, workCompleted: state.report.workCompleted, questions: state.report.questions }
      : null,
    lastError: state.lastError,
    waitedMs,
  };
}

function extractAssistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

function extractResultText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n') || null;
}

export async function daemonMain(opts: DaemonOptions): Promise<void> {
  const daemon = new WorkerDaemon(opts);
  await daemon.main();
}

/** The per-reply output-token limit the worker's model was configured with, if any. */
export function outputTokenLimit(config: BridgeConfig): number | null {
  const value = config.modelOptions?.maxTokens;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
