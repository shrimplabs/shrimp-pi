#!/usr/bin/env node
/**
 * shrimp-pi CLI. Supervisor-agnostic: any shell-capable program (Codex, Claude, Vibe, a human,
 * a CI job) drives it the same way. Machine-readable JSON on stdout, errors as JSON on stderr,
 * exit code 0 on success and 1 on error. No supervisor SDK.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWorkerDirs, resolveStateDir, workerPaths } from './lib/paths.ts';
import { assertSafeWorkerId, newWorkerId, workerBranch } from './lib/ids.ts';
import { daemonForwardEnv, loadConfig, resolveConfigPath } from './lib/config.ts';
import { workerMetrics } from './lib/metrics.ts';
import { withLock } from './lib/lock.ts';
import { checkSandbox, defaultBinds } from './lib/sandbox.ts';
import { createCloneWorkspace, inspectRepo } from './lib/git.ts';
import {
  mutateState,
  newState,
  pushWarning,
  readState,
  setAttention,
  transition,
  TERMINAL_STATES,
  waitSatisfied,
  writeState,
} from './lib/state.ts';
import {
  accessContextMismatch,
  applyAccept,
  BridgeError,
  launchDaemon,
  markDaemonLost,
  probeDaemon,
  socketRequest,
  waitForSocket,
  type DaemonStatus,
} from './lib/worker.ts';
import { buildReview } from './lib/report.ts';
import { atomicWrite, clampInt, errMessage, isNotFound, sha256 } from './lib/util.ts';
import type { WorkerState } from './lib/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = path.join(HERE, 'daemon.ts');

const ALIASES: Record<string, string> = {
  spawn_worker: 'spawn',
  worker_status: 'status',
  status_worker: 'status',
  steer_worker: 'steer',
  wait_for_worker: 'wait',
  review_worker: 'review',
  stop_worker: 'stop',
  recover_worker: 'recover',
  accept_worker: 'accept',
  help: 'help',
};

const HELP = `shrimp-pi - run persistent Pi coding workers for any supervisor

The bridge starts one detached daemon per worker. Each daemon owns one Pi RPC child, an
isolated git clone of your repository, and an atomically updated state.json. Supervisors talk
to the CLI only; the CLI talks to the daemon over a private Unix socket. Nothing is ever
merged, committed to your repository, or deleted by the bridge.

USAGE
  shrimp-pi <command> [options]            (also: spawn_worker, worker_status, steer_worker,
                                            wait_for_worker, review_worker, stop_worker,
                                            recover_worker, accept_worker)

GLOBAL OPTIONS
  --state-dir <path>   Worker state root. Default: $SHRIMP_PI_HOME or ~/.local/state/shrimp-pi
  --help, -h           Show this help

COMMANDS
  spawn --repo <path> --task <file> [--config <file>] [options]
      Create a worker: unique worker directory, private "git clone --no-hardlinks" of <path>
      at the current HEAD on branch shrimp-pi/<id>, then a detached daemon that starts Pi in
      RPC mode and sends the task. Requires a repository with at least one commit; a dirty
      source repository is allowed (the base is HEAD, so uncommitted work is NOT copied) and is
      reported as a warning.
        --repo <path>       Source git repository (required)
        --task <file>       Task description file, read once at spawn (required)
        --config <file>     Bridge config JSON (model endpoint, sandbox, limits). Optional:
                            defaults to $SHRIMP_PI_CONFIG, then
                            $XDG_CONFIG_HOME/shrimp-pi/config.json (~/.config/...). See CONFIG.
        --label <text>      Free-form label stored in state.json
        --no-sandbox        Explicitly disable the sandbox for a trusted caller. Refused
                            unless you pass it; always surfaced in status/review output.
        --no-start          Create the worker but do not start the daemon yet

  status <worker-id>
      Full state: worker state, revision, attention, runs, tool evidence, usage, daemon and
      process liveness, paths. Detects a lost daemon and records FAILED explicitly.

  steer <worker-id> (--message <text> | --message-file <file>)
      Send a correction. While the worker is RUNNING this uses Pi streamingBehavior "steer";
      while idle it sends a prompt that restarts the same session; if the Pi child died it is
      relaunched on the same session file. The daemon stays alive while idle for corrections.

  wait <worker-id> [--timeout <seconds>] [--after <revision>]
      Long-poll the daemon socket (event driven, no polling loop). Returns immediately when an
      attention state already exists; with --after <revision> it returns only for an attention
      event raised after that revision. On timeout it returns normal JSON with
      "outcome":"timed_out" and exit code 0, so a supervisor can loop safely.
        --timeout <seconds>  Default: config limits.waitTimeoutSeconds (300), clamped to
                             limits.maxWaitSeconds
        --after <revision>   Ignore attention events at or before this state revision

  review <worker-id>
      Independent review: git data measured by the bridge (commits vs the original base commit,
      uncommitted edits, untracked file contents), plus the agent's own claims clearly labelled
      untrusted, plus observed tool evidence. Writes report.json, report.md and diff.patch
      outside the workspace under <worker-dir>/reports/<id>/ and prints their paths.

  accept <worker-id> [--note <text>] [--force]
      Record supervisor acceptance (state COMPLETED). Never merges, never deletes: you review
      and merge the branch yourself. --force accepts a state other than REVIEW_REQUIRED.

  stop <worker-id>
      Abort the run, close Pi's stdin, then escalate TERM/KILL to the whole process group.
      All work products, logs, and the session file are preserved. Ends the daemon.

  recover <worker-id>
      After a crash: relaunch the daemon on the SAME session file, report interrupted work, and
      wait for you to steer. The original task and its tool commands are never replayed.

  list
      Summarize every worker in the state directory.

CONFIG
  Lookup for spawn: --config <file>, else $SHRIMP_PI_CONFIG, else
  \${XDG_CONFIG_HOME:-~/.config}/shrimp-pi/config.json. A portable config needs only the
  endpoint; Pi is found automatically ("pi" on PATH, or the global install next to Node):
      { "model": "<model-id>", "baseUrl": "http://<host>:<port>/v1" }
  Set "piCommand" to pin a specific Pi; set "apiKeyEnv" to the NAME of the variable holding
  the endpoint key. Each worker keeps a snapshot of its config, including the Pi it started
  with, so later config edits only affect new workers. Full field list: README.md.

STATE MODEL
  CREATED -> RUNNING -> REVIEW_REQUIRED | BLOCKED | FAILED | STOPPED; REVIEW_REQUIRED ->
  COMPLETED only through an explicit "accept" after review. COMPLETED/FAILED/STOPPED are
  terminal (spawn a new worker). BLOCKED can be resumed with steer; FAILED with recover.

OUTPUT
  stdout: one JSON document. stderr: {"ok":false,"error":...,"code":...}. Exit 0 on success,
  1 on error. Timeouts are not errors: inspect "outcome" in the JSON.`;

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string | null; positionals: string[]; flags: Flags } {
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  const raw = positionals.shift() ?? null;
  const command = raw === null ? null : (ALIASES[raw] ?? raw);
  return { command, positionals, flags };
}

function flagString(flags: Flags, name: string): string | null {
  const value = flags[name];
  if (value === undefined || value === false) return null;
  return String(value);
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message: string, code = 'error'): never {
  throw new BridgeError(message, code);
}

function needWorkerId(positionals: string[], command: string): string {
  const raw = positionals[0];
  if (!raw) fail(`${command} requires a worker id (uuid) as its first argument`, 'usage');
  try {
    return assertSafeWorkerId(raw);
  } catch (err: unknown) {
    fail(errMessage(err), 'bad_worker_id');
  }
}

function requireFile(file: string, what: string): string {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`${what} not found: ${abs}`, 'not_found');
  return abs;
}

function stateDir(flags: Flags): string {
  return resolveStateDir(flagString(flags, 'state-dir'));
}

async function diagnose(paths: ReturnType<typeof workerPaths>, state: WorkerState | null): Promise<DaemonStatus> {
  return probeDaemon(paths, { recordedPidNamespace: state?.daemon.pidNamespace ?? null });
}

function loadWorker(paths: ReturnType<typeof workerPaths>): WorkerState {
  const state = readState(paths.stateFile);
  if (!state) {
    fail(`no worker ${paths.id} in ${path.dirname(path.dirname(paths.stateFile))}`, 'unknown_worker');
  }
  return state as WorkerState;
}

function configOrNull(paths: ReturnType<typeof workerPaths>) {
  try {
    return loadConfig(paths.configSnapshot).config;
  } catch {
    return null;
  }
}

function statusView(state: WorkerState, daemon: { responsive: boolean; alive: boolean; detail: string }) {
  return {
    ok: true,
    workerId: state.workerId,
    label: state.label,
    state: state.state,
    revision: state.revision,
    attention: state.attention,
    terminal: TERMINAL_STATES.has(state.state),
    branch: state.branch,
    baseCommit: state.baseCommit,
    headRepo: state.repo,
    workspaceDir: state.workspaceDir,
    sessionFile: state.sessionFile,
    sandbox: state.sandbox,
    daemon: {
      pid: state.daemon.pid,
      childPid: state.daemon.childPid,
      responsive: daemon.responsive,
      processAlive: daemon.alive,
      verdict: daemon.verdict,
      detail: daemon.detail,
      pidNamespace: state.daemon.pidNamespace,
      launchHost: state.daemon.launchHost,
      thisPidNamespace: daemon.currentPidNamespace,
      accessContextMismatch: daemon.verdict === 'foreign_context',
      childExit: state.daemon.childExit,
    },
    task: state.task,
    usage: state.usage,
    metrics: workerMetrics(state),
    tool: {
      calls: state.tool.calls,
      failures: state.tool.failures,
      consecutiveFailures: state.tool.consecutiveFailures,
      threshold: state.tool.threshold,
    },
    runs: state.runs.slice(-5),
    report: state.report
      ? {
          status: state.report.status,
          workCompleted: state.report.workCompleted,
          tests: state.report.tests,
          outstandingProblems: state.report.outstandingProblems,
          questions: state.report.questions,
          parseNotes: state.report.parseNotes,
        }
      : null,
    lastAssistantText: state.lastAssistantText,
    accept: state.accept,
    lastError: state.lastError,
    warnings: state.warnings,
    events: state.events.slice(-10),
    reviews: state.reviews.slice(-3),
    logs: state.logs,
    next: nextActions(state),
  };
}

function nextActions(state: WorkerState): string[] {
  switch (state.state) {
    case 'CREATED':
      return [`shrimp-pi wait ${state.workerId} --after ${state.revision}`];
    case 'RUNNING':
      return [
        `shrimp-pi wait ${state.workerId} --after ${state.revision} --timeout 300`,
        `shrimp-pi steer ${state.workerId} --message "..."`,
      ];
    case 'REVIEW_REQUIRED':
      return [`shrimp-pi review ${state.workerId}`, `shrimp-pi accept ${state.workerId} --note "..."`];
    case 'BLOCKED':
      return [
        `shrimp-pi review ${state.workerId}`,
        `shrimp-pi steer ${state.workerId} --message "..."`,
        `shrimp-pi stop ${state.workerId}`,
      ];
    case 'FAILED':
      return [`shrimp-pi recover ${state.workerId}`, `shrimp-pi review ${state.workerId}`];
    default:
      return [];
  }
}

// ------------------------------------------------------------------ commands

async function cmdSpawn(flags: Flags): Promise<void> {
  const repoArg = flagString(flags, 'repo');
  const taskArg = flagString(flags, 'task');
  const configArg = flagString(flags, 'config');
  if (!repoArg || !taskArg) {
    fail('spawn requires --repo <path> and --task <file> (see: shrimp-pi help)', 'usage');
  }
  const repo = path.resolve(repoArg as string);
  const taskFile = requireFile(taskArg as string, 'task file');
  let configFile: string;
  try {
    configFile = resolveConfigPath(configArg);
  } catch (err: unknown) {
    fail(errMessage(err), 'bad_config');
  }
  configFile = requireFile(configFile, 'config file');
  const dir = stateDir(flags);

  let loaded;
  try {
    loaded = loadConfig(configFile);
  } catch (err: unknown) {
    fail(errMessage(err), 'bad_config');
  }
  const config = loaded.config;

  let repoInfo;
  try {
    repoInfo = await inspectRepo(repo);
  } catch (err: unknown) {
    fail(errMessage(err), 'bad_repo');
  }

  const id = newWorkerId();
  const paths = workerPaths(dir, id);
  const warnings: string[] = [...loaded.warnings];

  let sandboxStatus;
  try {
    ensureWorkerDirs(paths);
    sandboxStatus = checkSandbox(config, {
      allowDisabled: flags['no-sandbox'] === true,
      binds: defaultBinds(paths),
    });
  } catch (err: unknown) {
    fs.rmSync(paths.root, { recursive: true, force: true });
    fail(errMessage(err), 'sandbox_unavailable');
  }

  if (fs.existsSync(paths.workspace)) fail(`worker workspace already exists: ${paths.workspace}`, 'collision');

  // Task provenance: keep the exact bytes the supervisor handed us.
  const taskBytes = fs.readFileSync(taskFile);
  atomicWrite(paths.taskFile, taskBytes);
  if (loaded.detectedPi) {
    // Pin the detected Pi into the worker's snapshot so the daemon, recover and later restarts
    // use the same installation even if PATH or the global install changes.
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    raw.piCommand = config.piCommand;
    raw.runtimePaths = config.runtimePaths;
    fs.writeFileSync(paths.configSnapshot, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  } else {
    fs.copyFileSync(configFile, paths.configSnapshot);
  }
  try {
    fs.chmodSync(paths.root, 0o700);
    fs.chmodSync(paths.socket, 0o600);
  } catch (err: unknown) {
    if (!isNotFound(err)) {
      /* socket does not exist yet */
    }
  }

  let workspaceInfo;
  try {
    workspaceInfo = await createCloneWorkspace({
      repo: repoInfo.repoRoot,
      baseCommit: repoInfo.head,
      dest: paths.workspace,
      branch: workerBranch(id),
    });
    warnings.push(...workspaceInfo.warnings);
  } catch (err: unknown) {
    fs.rmSync(paths.root, { recursive: true, force: true });
    fail(errMessage(err), 'workspace_failed');
  }

  if (repoInfo.dirty) {
    warnings.push(
      `source repository ${repoInfo.repoRoot} has uncommitted changes; the worker started from commit ${repoInfo.head.slice(0, 12)} so those changes are NOT in the worker copy`,
    );
  }
  warnings.push(
    'the worker runs in a private clone on branch ' +
      workerBranch(id) +
      '; review with "shrimp-pi review" and merge it yourself, the bridge never merges',
  );

  const state = newState({
    workerId: id,
    repo: repoInfo.repoRoot,
    branch: workerBranch(id),
    baseCommit: repoInfo.head,
    workspaceMode: 'clone',
    workspaceDir: paths.workspace,
    workerDir: paths.root,
    sessionFile: path.join(paths.agentDir, 'session.jsonl'),
    configPath: configFile,
    provider: config.provider,
    model: config.model,
    task: {
      file: taskFile,
      sha256: sha256(taskBytes),
      bytes: taskBytes.length,
      promptChars: taskBytes.toString('utf8').length,
    },
    sandbox: { mode: sandboxStatus.mode, detail: sandboxStatus.detail, warnings: sandboxStatus.warnings },
    logs: {
      dir: paths.logsDir,
      piStdout: paths.rpcOutLog,
      piStderr: paths.stderrLog,
      daemon: paths.daemonLog,
      events: paths.eventsLog,
    },
    toolFailureThreshold: config.limits.toolFailureThreshold,
    label: flagString(flags, 'label'),
  });
  for (const warning of warnings) pushWarning(state, warning);
  writeState(paths, state);

  if (flags['no-start'] === true) {
    emit({
      ok: true,
      workerId: id,
      state: state.state,
      revision: state.revision,
      workerDir: paths.root,
      workspaceDir: paths.workspace,
      branch: state.branch,
      baseCommit: state.baseCommit,
      sandbox: state.sandbox,
      warnings: state.warnings,
      note: 'created with --no-start; start it with: shrimp-pi recover (or spawn again without --no-start)',
    });
    return;
  }

  let launched;
  try {
    launched = launchDaemon({
      stateDir: dir,
      workerId: id,
      recover: false,
      daemonEntry: DAEMON_ENTRY,
      forwardEnv: daemonForwardEnv(config),
    });
  } catch (err: unknown) {
    await mutateState(paths, (current) => {
      transition(current, 'FAILED', `daemon could not be launched: ${errMessage(err)}`, { reason: 'daemon_launch_failed' });
    });
    fail(`${errMessage(err)} (worker directory kept: ${paths.root})`, 'daemon_launch_failed');
  }

  const ready = await waitForSocket(paths, Math.min(20_000, config.limits.spawnAckSeconds * 1000));
  if (!ready || !ready.responsive) {
    if (ready && ready.verdict === 'foreign_context') {
      fail(accessContextMismatch(ready), 'access_context_mismatch');
    }
    const updated = (await markDaemonLost(paths, 'daemon did not answer on its socket after spawn', ready ?? undefined)).state;
    emit({
      ok: false,
      workerId: id,
      state: updated?.state ?? 'CREATED',
      revision: updated?.revision ?? state.revision,
      workerDir: paths.root,
      daemonPid: launched.pid,
      error: `the daemon (pid ${launched.pid}) did not answer within ${config.limits.spawnAckSeconds}s; inspect ${paths.daemonLog} and ${paths.daemonErrLog}`,
      warnings: updated?.warnings ?? state.warnings,
    });
    process.exitCode = 1;
    return;
  }

  let start: Record<string, unknown>;
  try {
    start = await socketRequest(
      paths.socket,
      { op: 'start', workerId: id },
      config.limits.spawnAckSeconds * 1000 + 5_000,
    );
  } catch (err: unknown) {
    emit({
      ok: false,
      workerId: id,
      error: `the daemon died while starting the task: ${errMessage(err)}; inspect ${paths.daemonLog}`,
      workerDir: paths.root,
      daemonPid: launched.pid,
    });
    process.exitCode = 1;
    return;
  }
  if (start.ok !== true) {
    fail(`worker failed to start: ${String(start.error ?? 'unknown error')} (logs: ${paths.daemonLog})`, 'start_failed');
  }

  const finalState = readState(paths.stateFile) ?? state;
  emit({
    ok: true,
    workerId: id,
    state: finalState.state,
    revision: finalState.revision,
    disposition: start.disposition ?? null,
    note: start.note ?? null,
    label: finalState.label,
    workerDir: paths.root,
    workspaceDir: paths.workspace,
    branch: finalState.branch,
    baseCommit: finalState.baseCommit,
    sessionFile: finalState.sessionFile,
    daemonPid: finalState.daemon.pid,
    childPid: finalState.daemon.childPid,
    sandbox: finalState.sandbox,
    warnings: finalState.warnings,
    logs: finalState.logs,
    next: [`shrimp-pi wait ${id} --after ${finalState.revision}`, `shrimp-pi status ${id}`],
  });
}

async function cmdStatus(positionals: string[], flags: Flags): Promise<void> {
  const id = needWorkerId(positionals, 'status');
  const paths = workerPaths(stateDir(flags), id);
  const state = loadWorker(paths);
  const daemon = await diagnose(paths, state);
  let current = state;
  if (!daemon.responsive && !TERMINAL_STATES.has(state.state)) {
    const lost = await markDaemonLost(paths, `state was ${state.state} but the daemon is not reachable`, daemon);
    if (lost.marked && lost.state) current = lost.state;
  }
  const view = statusView(current, daemon);
  if (daemon.verdict === 'foreign_context') {
    view.accessContext = { error: accessContextMismatch(daemon), code: 'access_context_mismatch' };
    view.warnings = [...view.warnings, accessContextMismatch(daemon)];
  }
  emit(view);
}

async function cmdList(flags: Flags): Promise<void> {
  const dir = stateDir(flags);
  const root = path.join(dir, 'workers');
  const workers: unknown[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}$/.test(entry)) continue;
    let id: string;
    try {
      id = assertSafeWorkerId(entry);
    } catch {
      continue;
    }
    const paths = workerPaths(dir, id);
    const state = readState(paths.stateFile);
    if (!state) continue;
    workers.push({
      workerId: id,
      label: state.label,
      state: state.state,
      revision: state.revision,
      attention: state.attention?.kind ?? null,
      reason: state.attention?.reason ?? null,
      updatedAt: state.updatedAt,
      repo: state.repo,
      branch: state.branch,
      workerDir: paths.root,
    });
  }
  workers.sort((a, b) => String((b as { updatedAt: string }).updatedAt).localeCompare(String((a as { updatedAt: string }).updatedAt)));
  emit({ ok: true, stateDir: dir, count: workers.length, workers });
}

async function cmdWait(positionals: string[], flags: Flags): Promise<void> {
  const id = needWorkerId(positionals, 'wait');
  const dir = stateDir(flags);
  const paths = workerPaths(dir, id);
  const state = loadWorker(paths);
  const after = flagString(flags, 'after');
  if (after !== null && !/^\d+$/.test(after)) fail('--after must be a state revision number', 'usage');
  const afterRevision = after === null ? null : Number.parseInt(after, 10);
  const config = configOrNull(paths);
  const defaultSeconds = config?.limits.waitTimeoutSeconds ?? 300;
  const maxSeconds = config?.limits.maxWaitSeconds ?? 3600;
  const seconds = clampInt(flagString(flags, 'timeout'), 1, maxSeconds, defaultSeconds);

  const daemon = await diagnose(paths, state);
  if (daemon.verdict === 'foreign_context') fail(accessContextMismatch(daemon), 'access_context_mismatch');
  if (daemon.responsive) {
    try {
      const reply = await socketRequest(
        paths.socket,
        { op: 'wait', workerId: id, afterRevision, timeoutMs: seconds * 1000 },
        seconds * 1000 + 10_000,
      );
      const current = readState(paths.stateFile) ?? state;
      emit({
        ok: true,
        workerId: id,
        outcome: reply.outcome ?? 'unknown',
        state: current.state,
        revision: current.revision,
        attention: current.attention,
        report: current.report
          ? { status: current.report.status, workCompleted: current.report.workCompleted, questions: current.report.questions }
          : null,
        lastError: current.lastError,
        timedOut: reply.outcome === 'timed_out',
        waitedSeconds: seconds,
        daemon: { pid: current.daemon.pid, childPid: current.daemon.childPid },
        next:
          reply.outcome === 'timed_out'
            ? [`shrimp-pi wait ${id} --after ${current.revision} --timeout ${seconds}`]
            : nextActions(current),
      });
      return;
    } catch (err: unknown) {
      fail(`wait failed: ${errMessage(err)}`, 'wait_failed');
    }
  }

  // No daemon: the answer cannot change by itself. Diagnose instead of hanging.
  let current = state;
  if (!waitSatisfied(state, afterRevision)) {
    if (!TERMINAL_STATES.has(state.state)) {
      const lost = await markDaemonLost(paths, `state was ${state.state} but the daemon is not reachable`, daemon);
      if (lost.marked && lost.state) current = lost.state;
    }
    if (!waitSatisfied(current, afterRevision)) {
      emit({
        ok: true,
        workerId: id,
        outcome: 'no_daemon',
        state: current.state,
        revision: current.revision,
        attention: current.attention,
        timedOut: false,
        error: `no daemon is running for ${id} (${daemon.detail}) and there is no attention event after revision ${afterRevision ?? 0}`,
        hint: `shrimp-pi recover ${id}`,
        next: nextActions(current),
      });
      process.exitCode = 1;
      return;
    }
  }
  emit({
    ok: true,
    workerId: id,
    outcome: 'attention',
    state: current.state,
    revision: current.revision,
    attention: current.attention,
    report: current.report
      ? { status: current.report.status, workCompleted: current.report.workCompleted, questions: current.report.questions }
      : null,
    lastError: current.lastError,
    timedOut: false,
    note: 'answered from state.json because no daemon is reachable',
    next: nextActions(current),
  });
}

async function cmdSteer(positionals: string[], flags: Flags): Promise<void> {
  const id = needWorkerId(positionals, 'steer');
  const paths = workerPaths(stateDir(flags), id);
  loadWorker(paths);
  const messageFile = flagString(flags, 'message-file');
  let text = flagString(flags, 'message');
  if (messageFile) text = fs.readFileSync(requireFile(messageFile, 'message file'), 'utf8');
  if (!text || !text.trim()) fail('steer requires --message <text> or --message-file <file>', 'usage');
  const daemon = await diagnose(paths, readState(paths.stateFile));
  if (daemon.verdict === 'foreign_context') fail(accessContextMismatch(daemon), 'access_context_mismatch');
  if (!daemon.responsive) {
    fail(
      `no responsive daemon for ${id} (${daemon.detail}); run "shrimp-pi recover ${id}" first, then steer`,
      'no_daemon',
    );
  }
  const reply = await socketRequest(paths.socket, { op: 'steer', workerId: id, text }, 90_000);
  if (reply.ok !== true) fail(`steer rejected: ${String(reply.error ?? 'unknown error')}`, 'steer_rejected');
  const current = readState(paths.stateFile);
  emit({
    ok: true,
    workerId: id,
    mode: reply.mode ?? null,
    disposition: reply.disposition ?? null,
    state: reply.state ?? current?.state ?? null,
    revision: reply.revision ?? current?.revision ?? null,
    messageChars: (text as string).length,
    note:
      reply.mode === 'steer'
        ? 'delivered as a steering message for the current run'
        : 'worker was idle or without a Pi child; the message started a new run on the same session file',
    next: [`shrimp-pi wait ${id} --after ${String(reply.revision ?? current?.revision ?? 0)}`],
  });
}

async function cmdReview(positionals: string[], flags: Flags): Promise<void> {
  const id = needWorkerId(positionals, 'review');
  const paths = workerPaths(stateDir(flags), id);
  const state = loadWorker(paths);
  const config = configOrNull(paths);
  const summary = await buildReview({ paths, state, config });
  emit({ ok: true, ...summary });
}

async function cmdAccept(positionals: string[], flags: Flags): Promise<void> {
  const id = needWorkerId(positionals, 'accept');
  const paths = workerPaths(stateDir(flags), id);
  const state = loadWorker(paths);
  const note = flagString(flags, 'note');
  const force = flags.force === true;
  const latest = state.reviews[state.reviews.length - 1] ?? null;
  const daemon = await diagnose(paths, state);
  if (daemon.verdict === 'foreign_context') fail(accessContextMismatch(daemon), 'access_context_mismatch');
  let result;
  if (daemon.responsive) {
    const reply = await socketRequest(
      paths.socket,
      { op: 'accept', workerId: id, note, force, reportId: latest?.id ?? null, diffSha256: latest?.diffSha256 ?? null },
      60_000,
    );
    if (reply.ok !== true) fail(`accept failed: ${String(reply.error ?? 'unknown error')}`, 'accept_failed');
    result = {
      accepted: reply.accepted === true,
      message: String(reply.message ?? ''),
      state: String(reply.state ?? ''),
      revision: Number(reply.revision ?? 0),
    };
  } else {
    const applied = await applyAccept(paths, {
      note,
      force,
      reportId: latest?.id ?? null,
      diffSha256: latest?.diffSha256 ?? null,
    });
    result = {
      accepted: applied.accepted,
      message: applied.message,
      state: applied.state.state,
      revision: applied.state.revision,
    };
  }
  if (!result.accepted) fail(result.message, 'accept_refused');
  emit({
    ok: true,
    workerId: id,
    accepted: true,
    state: result.state,
    revision: result.revision,
    message: result.message,
    reportId: latest?.id ?? null,
    note: 'acceptance recorded in state.json; the bridge never merges or deletes anything, so merge the branch yourself when you are ready',
  });
}

async function cmdStop(positionals: string[], flags: Flags): Promise<void> {
  const id = needWorkerId(positionals, 'stop');
  const paths = workerPaths(stateDir(flags), id);
  const state = loadWorker(paths);
  const daemon = await diagnose(paths, state);
  if (daemon.verdict === 'foreign_context') fail(accessContextMismatch(daemon), 'access_context_mismatch');
  if (daemon.verdict === 'alive' || daemon.verdict === 'unresponsive') {
    if (!daemon.responsive) {
      fail(
        `the daemon process for ${id} is running but not answering (${daemon.detail}); stop it with the OS if you must, the bridge will not signal a process it cannot identify`,
        'daemon_unresponsive',
      );
    }
  }
  if (daemon.responsive) {
    const reply = await socketRequest(paths.socket, { op: 'stop', workerId: id, reason: 'supervisor_stop' }, 45_000);
    if (reply.ok !== true) fail(`stop failed: ${String(reply.error ?? 'unknown error')}`, 'stop_failed');
    const current = readState(paths.stateFile) ?? state;
    emit({
      ok: true,
      workerId: id,
      state: current.state,
      revision: current.revision,
      message: 'daemon and Pi child were shut down (stdin closed, then TERM/KILL on the process group); all work products are preserved',
      workspaceDir: current.workspaceDir,
      branch: current.branch,
      logs: current.logs,
    });
    return;
  }
  const { state: updated } = await mutateState(paths, (current) => {
    if (!TERMINAL_STATES.has(current.state)) {
      transition(current, 'STOPPED', `stopped by supervisor (no daemon was running: ${daemon.detail})`, {
        reason: 'supervisor_stop',
      });
      setAttention(current, 'stopped', 'supervisor_stop', 'worker stopped; no process is running');
    }
    current.daemon.childExit = current.daemon.childExit ?? null;
    pushWarning(current, 'stop recorded without a live daemon; the sandbox dies with its parent, so no worker process remains');
  });
  try {
    if (fs.existsSync(paths.socket)) fs.unlinkSync(paths.socket);
  } catch {
    /* ignore */
  }
  emit({
    ok: true,
    workerId: id,
    state: updated.state,
    revision: updated.revision,
    message: 'no daemon was running; state recorded as STOPPED and the stale socket removed',
    workspaceDir: updated.workspaceDir,
    branch: updated.branch,
    daemonWasAlive: daemon.alive,
  });
}

async function cmdRecover(positionals: string[], flags: Flags): Promise<void> {
  const id = needWorkerId(positionals, 'recover');
  const paths = workerPaths(stateDir(flags), id);
  const state = loadWorker(paths);
  const daemon = await diagnose(paths, state);
  if (daemon.verdict === 'foreign_context') fail(accessContextMismatch(daemon), 'access_context_mismatch');
  // Hold a separate launch lock through startup. The state lock alone ends before launch,
  // which would let simultaneous supervisors open two Pi sessions on the same clone.
  await withLock(path.join(paths.root, '.recovery-lock'),
    () => cmdRecoverLocked(positionals, flags), { timeoutMs: 120_000 });
}

async function cmdRecoverLocked(positionals: string[], flags: Flags): Promise<void> {
  const id = needWorkerId(positionals, 'recover');
  const dir = stateDir(flags);
  const paths = workerPaths(dir, id);
  const existing = readState(paths.stateFile);
  const daemon = await diagnose(paths, existing);
  if (daemon.verdict === 'foreign_context') fail(accessContextMismatch(daemon), 'access_context_mismatch');
  if (daemon.responsive || daemon.verdict === 'alive' || daemon.verdict === 'unresponsive') {
    fail(
      `worker ${id} still has a running daemon (pid ${String(daemon.pid)}, ${daemon.detail}); nothing to recover`,
      'already_running',
    );
  }
  if (daemon.verdict !== 'dead') {
    fail(`refusing to recover: ${daemon.detail}`, 'liveness_unclear');
  }
  const config = configOrNull(paths);
  let result: { state: WorkerState };
  try {
    result = await mutateState(paths, (current) => {
      if (current.state === 'RUNNING' || current.state === 'CREATED') {
        transition(current, 'FAILED', 'recover: the daemon died while the worker was running', {
          reason: 'daemon_lost',
          force: true,
        });
      }
      if (!['FAILED', 'BLOCKED'].includes(current.state)) {
        throw new BridgeError(
          `recover applies to FAILED or BLOCKED workers, but this worker is ${current.state}; spawn a new worker instead`,
          'not_recoverable',
        );
      }
      return { state: current };
    });
  } catch (err: unknown) {
    fail(errMessage(err), err instanceof BridgeError ? err.code : 'recover_failed');
  }

  const launched = launchDaemon({
    stateDir: dir,
    workerId: id,
    recover: true,
    daemonEntry: DAEMON_ENTRY,
    forwardEnv: config ? daemonForwardEnv(config) : {},
  });
  const ready = await waitForSocket(paths, 20_000);
  if (!ready || !ready.responsive) {
    fail(
      `recovery daemon (pid ${launched.pid}) did not answer; inspect ${paths.daemonLog} and ${paths.daemonErrLog}`,
      'recover_failed',
    );
  }
  let start: Record<string, unknown>;
  try {
    start = await socketRequest(paths.socket, { op: 'start', workerId: id, recover: true }, 90_000);
  } catch (err: unknown) {
    fail(`recovery daemon died while reopening the session: ${errMessage(err)}`, 'recover_failed');
  }
  if (start.ok !== true) fail(`recover failed: ${String(start.error ?? 'unknown error')}`, 'recover_failed');
  const current = readState(paths.stateFile);
  emit({
    ok: true,
    workerId: id,
    state: current?.state ?? null,
    revision: current?.revision ?? null,
    daemonPid: launched.pid,
    childPid: current?.daemon.childPid ?? null,
    sessionFile: current?.sessionFile ?? null,
    attention: current?.attention ?? null,
    note: 'the daemon reopened the SAME session file and replayed nothing; steer it to resume the interrupted work',
    next: [`shrimp-pi steer ${id} --message "resume: ..."`, `shrimp-pi status ${id}`],
  });
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, positionals, flags } = parseArgs(argv);
  if (flags.help === true || flags.h === true || command === null || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (flags['state-dir'] !== undefined && typeof flags['state-dir'] !== 'string') {
    fail('--state-dir requires a path', 'usage');
  }
  switch (command) {
    case 'spawn':
      await cmdSpawn(flags);
      return;
    case 'status':
      await cmdStatus(positionals, flags);
      return;
    case 'list':
      await cmdList(flags);
      return;
    case 'wait':
      await cmdWait(positionals, flags);
      return;
    case 'steer':
      await cmdSteer(positionals, flags);
      return;
    case 'review':
      await cmdReview(positionals, flags);
      return;
    case 'accept':
      await cmdAccept(positionals, flags);
      return;
    case 'stop':
      await cmdStop(positionals, flags);
      return;
    case 'recover':
      await cmdRecover(positionals, flags);
      return;
    default:
      fail(`unknown command ${JSON.stringify(command)}; run "shrimp-pi help"`, 'usage');
  }
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: errMessage(err),
    code: err instanceof BridgeError ? err.code : 'unexpected_error' })}\n`);
  process.exitCode = 1;
}

if (process.exitCode === undefined) process.exitCode = 0;
