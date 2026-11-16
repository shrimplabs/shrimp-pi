/** Shared record shapes. Types only: nothing here emits runtime code. */

export type WorkerStateName =
  | 'CREATED'
  | 'RUNNING'
  | 'REVIEW_REQUIRED'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED'
  | 'STOPPED';

export type AttentionKind =
  | 'review_required'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'stopped'
  | 'interrupted';

export type Attention = {
  kind: AttentionKind;
  /** state revision the attention was raised at */
  revision: number;
  at: string;
  /** machine readable reason code, e.g. missing_report, tool_failure_threshold */
  reason: string;
  message: string;
};

export type TransitionEvent = {
  revision: number;
  at: string;
  from: WorkerStateName | null;
  to: WorkerStateName;
  message: string;
};

export type Usage = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  totalTokens: number | null;
  /** null unless the provider reported a cost; never estimated */
  costUsd: number | null;
  /** pi's own arithmetic over configured prices: an estimate, never a bill */
  priceEstimateUsd: number | null;
  source: string | null;
  collectedAt: string | null;
};

export type ToolEvidence = {
  at: string;
  run: number;
  toolCallId: string | null;
  toolName: string;
  isError: boolean;
  durationMs: number | null;
  /** command / path argument when the tool exposed one */
  target: string | null;
  outputExcerpt: string | null;
};

export type RunRecord = {
  index: number;
  startedAt: string;
  endedAt: string | null;
  kind: 'task' | 'steer' | 'resume';
  disposition: string | null;
  agentEndCount: number;
  settled: boolean;
  settledAborted: boolean;
  stopReason: string | null;
  errorMessage: string | null;
  reportStatus: string | null;
  outcome: string | null;
  interventionCount: number;
};

export type Intervention = {
  at: string;
  kind: 'steer' | 'resume' | 'abort' | 'accept' | 'recover';
  revision: number;
  textExcerpt?: string | null;
  note?: string | null;
};

export type AgentReport = {
  /** parsed from the agent's final answer; untrusted */
  status: 'review' | 'blocked' | 'checkpoint' | null;
  workCompleted: string | null;
  tests: unknown[];
  decisions: unknown[];
  outstandingProblems: unknown[];
  questions: unknown[];
  rawText: string;
  parsed: boolean;
  parseNotes: string[];
};

export type AcceptRecord = {
  acceptedAt: string;
  revision: number;
  note: string | null;
  reportId: string | null;
  diffSha256: string | null;
  merged: false;
};

export type SandboxStatus = {
  mode: 'bubblewrap' | 'seatbelt' | 'external' | 'disabled';
  detail: string;
  warnings: string[];
};

export type WorkerState = {
  schemaVersion: number;
  workerId: string;
  revision: number;
  state: WorkerStateName;
  createdAt: string;
  updatedAt: string;
  label: string | null;
  repo: string;
  branch: string;
  baseCommit: string;
  /** always "clone": a private `git clone --no-hardlinks` copy, never a linked worktree */
  workspaceMode: 'clone';
  workspaceDir: string;
  workerDir: string;
  sessionFile: string;
  configPath: string;
  provider: string;
  model: string;
  task: { file: string; sha256: string; bytes: number; promptChars: number };
  sandbox: SandboxStatus;
  daemon: {
    pid: number | null;
    childPid: number | null;
    socket: string;
    /** /proc/self/ns/pid of the daemon at startup: identifies the PID namespace it lives in */
    pidNamespace: string | null;
    launchHost: string | null;
    startedAt: string | null;
    lastSeenAt: string | null;
    childExitedAt: string | null;
    childExit: { code: number | null; signal: string | null } | null;
  };
  usage: Usage;
  tool: {
    calls: number;
    failures: number;
    consecutiveFailures: number;
    threshold: number;
    lastFailures: ToolEvidence[];
  };
  runs: RunRecord[];
  interventions: Intervention[];
  evidence: ToolEvidence[];
  report: AgentReport | null;
  lastAssistantText: string | null;
  attention: Attention | null;
  accept: AcceptRecord | null;
  lastError: string | null;
  warnings: string[];
  events: TransitionEvent[];
  logs: { dir: string; piStdout: string; piStderr: string; daemon: string; events: string };
  reviews: { id: string; at: string; reportJson: string; reportMd: string; diff: string; diffSha256?: string }[];
};

export type ReviewSummary = {
  workerId: string;
  originalTask: { text: string; sha256: string; truncated: boolean };
  metrics: Record<string, number | string | boolean | null>;
  state: WorkerStateName;
  revision: number;
  reportId: string;
  reportJson: string;
  reportMd: string;
  diffPath: string;
  diffBytes: number;
  diffSha256: string;
  baseCommit: string;
  headCommit: string | null;
  branch: string;
  commits: { sha: string; subject: string }[];
  filesChanged: string[];
  untrackedFiles: string[];
  ignoredPaths: string[];
  diffTruncated: boolean;
  agentClaims: { label: string; untrusted: true } & Record<string, unknown>;
  evidence: { toolCalls: number; failedToolCalls: number; commands: string[]; notes: string[] };
  usage: Usage;
  sandbox: SandboxStatus;
  warnings: string[];
  logs: { dir: string; piStdout: string; piStderr: string; daemon: string };
  generatedAt: string;
};

export type BridgeConfig = {
  piCommand: string[];
  provider: string;
  model: string;
  api: string;
  baseUrl: string;
  apiKeyEnv: string | null;
  modelOptions: Record<string, unknown>;
  runtimePaths: string[];
  extraPiArgs: string[];
  envAllowlist: string[];
  noContextFiles: boolean;
  thinkingLevel: string | null;
  sandbox: {
    mode: 'bubblewrap' | 'seatbelt' | 'external' | 'disabled';
    bwrapPath: string;
    sandboxExecPath?: string;
    launcher: string[] | null;
    extraRoBinds: string[];
    extraWritableBinds: string[];
    minimalEtc: boolean;
  };
  limits: {
    toolFailureThreshold: number;
    waitTimeoutSeconds: number;
    maxWaitSeconds: number;
    runTimeoutSeconds: number;
    spawnAckSeconds: number;
    maxEvidence: number;
    maxEvents: number;
  };
};
