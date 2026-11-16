/**
 * state.json: the only durable record of a worker. Written atomically, carries a monotonic
 * revision so supervisors can use it as an event cursor, and stays bounded in size.
 */

import fs from 'node:fs';
import type {
  AcceptRecord,
  AgentReport,
  Attention,
  AttentionKind,
  ToolEvidence,
  TransitionEvent,
  Usage,
  WorkerState,
  WorkerStateName,
} from './types.ts';
import { atomicWrite, ensureDir, errMessage, isNotFound, nowIso, sha256, truncate } from './util.ts';
import { withLock } from './lock.ts';
import type { WorkerPaths } from './paths.ts';

export const SCHEMA_VERSION = 1;

export const WORKER_STATES: WorkerStateName[] = [
  'CREATED',
  'RUNNING',
  'REVIEW_REQUIRED',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'STOPPED',
];

export const TERMINAL_STATES = new Set<WorkerStateName>(['COMPLETED', 'FAILED', 'STOPPED']);

/** States that a supervisor is expected to act on. */
export const ATTENTION_STATES = new Set<WorkerStateName>([
  'REVIEW_REQUIRED',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'STOPPED',
]);

const ALLOWED: Record<WorkerStateName, WorkerStateName[]> = {
  CREATED: ['RUNNING', 'BLOCKED', 'FAILED', 'STOPPED'],
  RUNNING: ['RUNNING', 'REVIEW_REQUIRED', 'BLOCKED', 'FAILED', 'STOPPED'],
  REVIEW_REQUIRED: ['RUNNING', 'REVIEW_REQUIRED', 'BLOCKED', 'COMPLETED', 'FAILED', 'STOPPED'],
  BLOCKED: ['RUNNING', 'REVIEW_REQUIRED', 'BLOCKED', 'STOPPED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['BLOCKED', 'STOPPED'],
  STOPPED: [],
};

export const ATTENTION_FOR_STATE: Partial<Record<WorkerStateName, AttentionKind>> = {
  REVIEW_REQUIRED: 'review_required',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

export class IllegalTransition extends Error {}

export function emptyUsage(): Usage {
  return {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    totalTokens: null,
    costUsd: null,
    priceEstimateUsd: null,
    source: null,
    collectedAt: null,
  };
}

export function newState(input: {
  workerId: string;
  repo: string;
  branch: string;
  baseCommit: string;
  workspaceMode: 'clone' | 'worktree';
  workspaceDir: string;
  workerDir: string;
  sessionFile: string;
  configPath: string;
  provider: string;
  model: string;
  task: WorkerState['task'];
  sandbox: WorkerState['sandbox'];
  logs: WorkerState['logs'];
  toolFailureThreshold: number;
  label: string | null;
}): WorkerState {
  const at = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    workerId: input.workerId,
    revision: 1,
    state: 'CREATED',
    createdAt: at,
    updatedAt: at,
    label: input.label,
    repo: input.repo,
    branch: input.branch,
    baseCommit: input.baseCommit,
    workspaceMode: input.workspaceMode,
    workspaceDir: input.workspaceDir,
    workerDir: input.workerDir,
    sessionFile: input.sessionFile,
    configPath: input.configPath,
    provider: input.provider,
    model: input.model,
    task: input.task,
    sandbox: input.sandbox,
    daemon: {
      pid: null,
      childPid: null,
      socket: '',
      pidNamespace: null,
      launchHost: null,
      startedAt: null,
      lastSeenAt: null,
      childExitedAt: null,
      childExit: null,
    },
    usage: emptyUsage(),
    tool: { calls: 0, failures: 0, consecutiveFailures: 0, threshold: input.toolFailureThreshold, lastFailures: [] },
    runs: [],
    interventions: [],
    evidence: [],
    report: null,
    lastAssistantText: null,
    attention: null,
    accept: null,
    lastError: null,
    warnings: [],
    events: [{ revision: 1, at, from: null, to: 'CREATED', message: 'worker created' }],
    logs: input.logs,
    reviews: [],
  };
}

export function readState(stateFile: string): WorkerState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as WorkerState;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.workerId !== 'string') {
      throw new Error(`state file is not a worker state object: ${stateFile}`);
    }
    return parsed;
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw new Error(`cannot read ${stateFile}: ${errMessage(err)}`);
  }
}

export function writeState(paths: WorkerPaths, state: WorkerState): void {
  ensureDir(paths.root, 0o700);
  state.updatedAt = nowIso();
  atomicWrite(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** Read, mutate, write under the worker lock. Returns the written state. */
export async function mutateState<T>(
  paths: WorkerPaths,
  fn: (state: WorkerState) => T | Promise<T>,
): Promise<{ state: WorkerState; result: T }> {
  return withLock(paths.lockDir, async () => {
    const state = readState(paths.stateFile);
    if (!state) throw new Error(`worker state not found: ${paths.stateFile}`);
    const result = await fn(state);
    writeState(paths, state);
    return { state, result };
  });
}

export function transition(
  state: WorkerState,
  to: WorkerStateName,
  message: string,
  options: { reason?: string; force?: boolean } = {},
): TransitionEvent {
  const from = state.state;
  if (from === to && !options.force) {
    // Self transition is allowed (re-intervention) but still a revision bump.
  } else if (from !== to && !ALLOWED[from].includes(to) && !options.force) {
    throw new IllegalTransition(`illegal worker state transition ${from} -> ${to}: ${message}`);
  }
  state.state = to;
  state.revision += 1;
  const event: TransitionEvent = { revision: state.revision, at: nowIso(), from, to, message };
  state.events.push(event);
  const maxEvents = 100;
  if (state.events.length > maxEvents) state.events = state.events.slice(-maxEvents);
  if (to === 'FAILED') state.lastError = message;
  if (to === 'RUNNING') state.lastError = null;
  const attentionKind = ATTENTION_FOR_STATE[to];
  if (attentionKind) {
    setAttention(state, attentionKind, options.reason ?? defaultReason(to), message);
  } else {
    state.attention = null;
  }
  return event;
}

function defaultReason(to: WorkerStateName): string {
  switch (to) {
    case 'REVIEW_REQUIRED':
      return 'agent_reported_review';
    case 'BLOCKED':
      return 'blocked';
    case 'COMPLETED':
      return 'supervisor_accepted';
    case 'FAILED':
      return 'failed';
    case 'STOPPED':
      return 'supervisor_stop';
    default:
      return 'unknown';
  }
}

export function setAttention(
  state: WorkerState,
  kind: AttentionKind,
  reason: string,
  message: string,
): Attention {
  const attention: Attention = { kind, revision: state.revision, at: nowIso(), reason, message };
  state.attention = attention;
  return attention;
}

export function clearAttention(state: WorkerState): void {
  state.attention = null;
}

export function pushWarning(state: WorkerState, warning: string): void {
  const text = truncate(warning, 600);
  if (!state.warnings.includes(text)) state.warnings.push(text);
  if (state.warnings.length > 40) state.warnings = state.warnings.slice(-40);
}

export function pushIntervention(
  state: WorkerState,
  kind: 'steer' | 'resume' | 'abort' | 'accept' | 'recover',
  textOrNote: string | null,
): void {
  state.interventions.push({
    at: nowIso(),
    kind,
    revision: state.revision,
    textExcerpt: kind === 'steer' && textOrNote ? truncate(textOrNote, 400) : null,
    note: kind === 'steer' ? null : textOrNote ? truncate(textOrNote, 400) : null,
  });
  if (state.interventions.length > 100) state.interventions = state.interventions.slice(-100);
}

export function pushEvidence(state: WorkerState, evidence: ToolEvidence, max: number): void {
  state.evidence.push(evidence);
  if (state.evidence.length > max) state.evidence = state.evidence.slice(-max);
  state.tool.calls += 1;
  if (evidence.isError) {
    state.tool.failures += 1;
    state.tool.consecutiveFailures += 1;
    state.tool.lastFailures.push(evidence);
    if (state.tool.lastFailures.length > 10) state.tool.lastFailures = state.tool.lastFailures.slice(-10);
  } else {
    state.tool.consecutiveFailures = 0;
  }
}

export function emptyReport(): AgentReport {
  return {
    status: null,
    workCompleted: null,
    tests: [],
    decisions: [],
    outstandingProblems: [],
    questions: [],
    rawText: '',
    parsed: false,
    parseNotes: [],
  };
}

export function makeAcceptRecord(state: WorkerState, note: string | null, reportId: string | null, diffSha256: string | null): AcceptRecord {
  return {
    acceptedAt: nowIso(),
    revision: state.revision,
    note: note ? truncate(note, 1000) : null,
    reportId,
    diffSha256,
    merged: false,
  };
}

export function stateFingerprint(state: WorkerState): string {
  return sha256(
    JSON.stringify({
      workerId: state.workerId,
      state: state.state,
      revision: state.revision,
      attention: state.attention,
      report: state.report ? { status: state.report.status, workCompleted: state.report.workCompleted } : null,
    }),
  ).slice(0, 16);
}

/**
 * Does the current state satisfy a wait request?
 * Without `afterRevision` any existing attention answers immediately. With it the caller
 * only wants an attention event raised strictly later than the revision they already saw.
 */
export function waitSatisfied(state: WorkerState, afterRevision: number | null): boolean {
  if (!state.attention) return false;
  if (afterRevision === null) return true;
  return state.attention.revision > afterRevision;
}
