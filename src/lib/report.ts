/**
 * Review generation. Everything factual comes from the bridge's own git inspection and from
 * observed RPC events; the agent's own report is included but clearly labelled untrusted.
 * Reports live outside the worker's workspace, so the worker can never edit its own review.
 */

import path from 'node:path';
import fs from 'node:fs';
import { workerMetrics } from './metrics.ts';
import type { BridgeConfig, ReviewSummary, WorkerState } from './types.ts';
import type { WorkerPaths } from './paths.ts';
import { computeDiff, headCommit, listCommits } from './git.ts';
import { emptyUsage } from './state.ts';
import { atomicWrite, ensureDir, newId, nowIso, sha256, truncate } from './util.ts';
import { mutateState } from './state.ts';

export async function buildReview(opts: {
  paths: WorkerPaths;
  state: WorkerState;
  config: BridgeConfig | null;
  allowRunning?: boolean;
}): Promise<ReviewSummary> {
  const { paths, state, config } = opts;
  const taskText = fs.readFileSync(paths.taskFile, 'utf8');
  const warnings: string[] = [...state.warnings];
  const reportId = `r-${newId()}`;
  const dir = path.join(paths.reportsDir, reportId);
  ensureDir(dir, 0o700);

  const diff = await computeDiff(paths.workspace, state.baseCommit);
  warnings.push(...diff.warnings);
  const commits = await listCommits(paths.workspace, state.baseCommit);
  const head = await headCommit(paths.workspace);
  const diffPath = path.join(dir, 'diff.patch');
  atomicWrite(diffPath, diff.patch.length > 0 ? diff.patch : '# no changes detected vs the base commit\n');
  const diffSha256 = sha256(diff.patch);

  const commands: string[] = [];
  for (const item of state.evidence) {
    if (item.toolName === 'bash' && item.target) commands.push(`${item.isError ? 'FAILED ' : ''}${item.target}`);
  }
  const evidenceNotes: string[] = [
    'commands and tool results below are observations from the RPC event stream; the bridge did not run them and does not compute pass or fail counts',
  ];
  if (state.tool.failures > 0) {
    evidenceNotes.push(`${state.tool.failures} tool call(s) reported isError; see toolFailures below and the raw logs for output`);
  }

  const summary: ReviewSummary = {
    workerId: state.workerId,
    originalTask: { text: truncate(taskText, 16_000), sha256: state.task.sha256, truncated: taskText.length > 16_000 },
    metrics: workerMetrics(state),
    state: state.state,
    revision: state.revision,
    reportId,
    reportJson: path.join(dir, 'report.json'),
    reportMd: path.join(dir, 'report.md'),
    diffPath,
    diffBytes: Buffer.byteLength(diff.patch, 'utf8'),
    diffSha256,
    baseCommit: state.baseCommit,
    headCommit: head,
    branch: state.branch,
    commits,
    filesChanged: diff.files,
    untrackedFiles: diff.untracked,
    ignoredPaths: diff.ignored,
    diffTruncated: diff.truncated,
    agentClaims: {
      label: 'UNTRUSTED AGENT CLAIMS: reported by the worker in its final answer, not verified by the bridge',
      untrusted: true,
      status: state.report?.status ?? null,
      workCompleted: state.report?.workCompleted ?? null,
      tests: state.report?.tests ?? [],
      decisions: state.report?.decisions ?? [],
      outstandingProblems: state.report?.outstandingProblems ?? [],
      questions: state.report?.questions ?? [],
      parseNotes: state.report?.parseNotes ?? ['no agent report was produced'],
    },
    evidence: {
      toolCalls: state.tool.calls,
      failedToolCalls: state.tool.failures,
      commands: commands.slice(0, 100),
      notes: evidenceNotes,
    },
    usage: state.usage ?? emptyUsage(),
    sandbox: state.sandbox,
    warnings,
    logs: {
      dir: paths.logsDir,
      piStdout: paths.rpcOutLog,
      piStderr: paths.stderrLog,
      daemon: paths.daemonLog,
      events: paths.eventsLog,
    },
    generatedAt: nowIso(),
  };

  const toolFailures = state.tool.lastFailures.slice(-10).map((item) => ({
    at: item.at,
    toolName: item.toolName,
    target: item.target,
    durationMs: item.durationMs,
    outputExcerpt: item.outputExcerpt,
  }));
  atomicWrite(summary.reportJson, `${JSON.stringify({ ...summary, toolFailures }, null, 2)}\n`);
  atomicWrite(summary.reportMd, renderReviewMarkdown(summary, toolFailures, state, config));

  await mutateState(paths, (current) => {
    current.reviews.push({
      id: reportId,
      at: summary.generatedAt,
      reportJson: summary.reportJson,
      reportMd: summary.reportMd,
      diff: diffPath,
      diffSha256,
    });
    if (current.reviews.length > 20) current.reviews = current.reviews.slice(-20);
  });
  return summary;
}

type ToolFailure = {
  at: string;
  toolName: string;
  target: string | null;
  durationMs: number | null;
  outputExcerpt: string | null;
};

function renderReviewMarkdown(
  summary: ReviewSummary & { ignoredPaths?: string[]; diffTruncated?: boolean },
  toolFailures: ToolFailure[],
  state: WorkerState,
  config: BridgeConfig | null,
): string {
  const claims = summary.agentClaims as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`# shrimp-pi review: worker ${summary.workerId}`);
  lines.push('');
  lines.push(`- worker state: **${state.state}** (revision ${state.revision})`);
  lines.push(`- elapsed seconds: ${summary.metrics.elapsedSeconds}; observed run seconds: ${summary.metrics.observedRunSeconds}`);
  lines.push('');
  lines.push('## Original task');
  lines.push('');
  lines.push(summary.originalTask.text);
  lines.push(`- generated: ${summary.generatedAt}`);
  lines.push(`- attention: ${state.attention ? `${state.attention.kind} (${state.attention.reason})` : 'none'}`);
  lines.push(`- report id: ${summary.reportId}`);
  lines.push('');
  lines.push('## Change (measured by the bridge with its own git inspection)');
  lines.push('');
  lines.push(`- source repo: \`${state.repo}\``);
  lines.push(`- workspace: \`${state.workspaceDir}\` (${state.workspaceMode}; never merged, never deleted by the bridge)`);
  lines.push(`- branch: \`${state.branch}\` from base \`${state.baseCommit}\``);
  lines.push(`- head: \`${summary.headCommit ?? 'none'}\``);
  lines.push(`- diff: \`${summary.diffPath}\` (${summary.diffBytes} bytes, sha256 ${summary.diffSha256.slice(0, 16)}…)`);
  if (summary.diffTruncated) lines.push('- **DIFF TRUNCATED: the patch file is incomplete, inspect the full diff yourself**');
  lines.push(`- worker commits: ${summary.commits.length}`);
  for (const commit of summary.commits.slice(0, 20)) lines.push(`  - \`${commit.sha.slice(0, 10)}\` ${commit.subject}`);
  lines.push(`- files changed vs base (${summary.filesChanged.length}):`);
  for (const file of summary.filesChanged.slice(0, 40)) lines.push(`  - ${file}`);
  if (summary.untrackedFiles.length > 0) {
    lines.push(`- untracked files (included in the diff): ${summary.untrackedFiles.slice(0, 20).join(', ')}`);
  }
  if (summary.ignoredPaths && summary.ignoredPaths.length > 0) {
    lines.push(`- gitignored paths (NOT in the diff): ${summary.ignoredPaths.slice(0, 10).join(', ')}`);
  }
  lines.push('');
  lines.push('## Agent claims (UNTRUSTED)');
  lines.push('');
  lines.push(String(claims.label));
  lines.push('');
  lines.push(`- reported status: ${String(claims.status ?? 'none')}`);
  lines.push(`- workCompleted: ${String(claims.workCompleted ?? 'none')}`);
  const tests = Array.isArray(claims.tests) ? claims.tests : [];
  lines.push(`- tests reported by the agent (${tests.length}; the bridge does not verify or count them):`);
  for (const test of tests.slice(0, 10)) lines.push(`  - ${truncate(JSON.stringify(test), 300)}`);
  const decisions = Array.isArray(claims.decisions) ? claims.decisions : [];
  if (decisions.length > 0) {
    lines.push('- decisions:');
    for (const decision of decisions.slice(0, 10)) lines.push(`  - ${truncate(JSON.stringify(decision), 300)}`);
  }
  const problems = Array.isArray(claims.outstandingProblems) ? claims.outstandingProblems : [];
  if (problems.length > 0) {
    lines.push('- outstanding problems:');
    for (const problem of problems.slice(0, 10)) lines.push(`  - ${truncate(JSON.stringify(problem), 300)}`);
  }
  const questions = Array.isArray(claims.questions) ? claims.questions : [];
  if (questions.length > 0) {
    lines.push('- questions for the supervisor:');
    for (const question of questions.slice(0, 10)) lines.push(`  - ${truncate(JSON.stringify(question), 300)}`);
  }
  const notes = Array.isArray(claims.parseNotes) ? claims.parseNotes : [];
  if (notes.length > 0) lines.push(`- report parse notes: ${notes.join('; ')}`);
  lines.push('');
  lines.push('## Bridge-observed evidence');
  lines.push('');
  lines.push(`- tool calls observed: ${summary.evidence.toolCalls} (${summary.evidence.failedToolCalls} with isError)`);
  lines.push(`- usage: ${summary.usage.totalTokens ?? 'null'} tokens (source: ${summary.usage.source ?? 'none'}); cost: ${summary.usage.costUsd ?? 'null'}`);
  if (summary.evidence.commands.length > 0) {
    lines.push('- commands observed in the event stream:');
    for (const command of summary.evidence.commands.slice(0, 30)) lines.push(`  - \`${command}\``);
  }
  if (toolFailures.length > 0) {
    lines.push('- recent failed tool attempts:');
    for (const failure of toolFailures) {
      lines.push(
        `  - ${failure.at} ${failure.toolName} ${failure.target ?? ''} ${failure.durationMs !== null ? `${failure.durationMs}ms` : ''}`.trim(),
      );
      if (failure.outputExcerpt) lines.push(`    ${truncate(failure.outputExcerpt.replace(/\n/g, ' '), 240)}`);
    }
  }
  for (const note of summary.evidence.notes) lines.push(`- note: ${note}`);
  lines.push('');
  lines.push('## Isolation');
  lines.push('');
  lines.push(`- sandbox: ${state.sandbox.mode} — ${state.sandbox.detail}`);
  for (const warning of state.sandbox.warnings) lines.push(`  - warning: ${warning}`);
  lines.push(`- model endpoint: provider ${state.provider}, model ${state.model}${config?.apiKeyEnv ? `, key from env ${config.apiKeyEnv}` : ''}`);
  lines.push(`- interventions: ${state.interventions.length} (steer/resume/abort/accept log in state.json)`);
  lines.push('');
  lines.push('## Raw logs (kept separate from this report)');
  lines.push('');
  lines.push(`- RPC records from pi: \`${summary.logs.piStdout}\``);
  lines.push(`- commands to pi: \`${path.join(summary.logs.dir, 'rpc-pi-stdin.jsonl')}\``);
  lines.push(`- pi stderr: \`${summary.logs.piStderr}\``);
  lines.push(`- daemon log: \`${summary.logs.daemon}\``);
  lines.push(`- daemon events: \`${summary.logs.events ?? path.join(summary.logs.dir, 'events.jsonl')}\``);
  lines.push('');
  lines.push('## Supervisor actions');
  lines.push('');
  lines.push(`- accept: \`shrimp-pi accept ${state.workerId} --note "why"\` (records acceptance; the bridge never merges or deletes)`);
  lines.push(`- steer:  \`shrimp-pi steer ${state.workerId} --message "instruction"\``);
  lines.push(`- stop:   \`shrimp-pi stop ${state.workerId}\``);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
