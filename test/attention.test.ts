/** Attention states: what the bridge decides when a run ends (and what it must never decide). */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { cli, killTree, makeRepo, tempDir, waitForState, writeConfig, writeTask, type Handle } from './helpers.ts';

const handles: Handle[] = [];
after(() => {
  for (const handle of handles) handle.cleanup();
});

async function start(scenario: string, limits: Record<string, number> = {}, extraPiArgs: string[] = [], modelOptions?: Record<string, unknown>) {
  const handle = tempDir();
  handles.push(handle);
  const { repo, head } = makeRepo(handle);
  const task = writeTask(handle);
  const config = writeConfig(handle, { scenario, limits, extraPiArgs, modelOptions });
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const spawned = cli(['spawn', '--repo', repo, '--task', task, '--config', config, '--no-sandbox'], { stateDir });
  assert.equal(spawned.code, 0, `spawn failed: ${spawned.stderr}`);
  return { handle, stateDir, workerId: String(spawned.json?.workerId), spawned, head };
}

test('agent_end is not completion: the bridge waits for agent_settled and uses the final message', async () => {
  const { stateDir, workerId } = await start('late_settle');
  const waited = cli(['wait', workerId, '--timeout', '25'], { stateDir, timeoutMs: 40_000 });
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(waited.json?.state, 'REVIEW_REQUIRED');
  const state = await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 5_000);
  const runs = state.runs as Record<string, unknown>[];
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.settled, true, 'the run must be marked settled, not merely ended');
  assert.ok(Number(runs[0]?.agentEndCount) >= 1, 'agent_end was observed but did not end the run');
  const report = state.report as Record<string, unknown>;
  assert.equal(report.workCompleted, 'final answer after retry', 'the last assistant message wins');
});

test('a missing structured report is never treated as success', async () => {
  const { stateDir, workerId } = await start('no_report');
  const state = await waitForState(stateDir, workerId, ['BLOCKED', 'REVIEW_REQUIRED'], 25_000);
  assert.equal(state.state, 'BLOCKED');
  const attention = state.attention as Record<string, unknown>;
  assert.equal(attention.reason, 'missing_report');
  assert.match(String(attention.message), /never treated as success/);
});

test('an agent that reports blocked stays blocked for the supervisor', async () => {
  const { stateDir, workerId } = await start('blocked');
  const state = await waitForState(stateDir, workerId, ['BLOCKED'], 25_000);
  const attention = state.attention as Record<string, unknown>;
  assert.equal(attention.reason, 'agent_blocked');
  const report = state.report as Record<string, unknown>;
  assert.equal(report.status, 'blocked');
  assert.ok(Array.isArray(report.outstandingProblems) && (report.outstandingProblems as string[]).length > 0);
});

test('a checkpoint is attention, not progress', async () => {
  const { stateDir, workerId } = await start('checkpoint');
  const state = await waitForState(stateDir, workerId, ['BLOCKED'], 25_000);
  assert.equal((state.attention as Record<string, unknown>).reason, 'agent_checkpoint');
});

test('a reply cut off by the output-token limit says so instead of a bare missing report', async () => {
  const { stateDir, workerId } = await start('truncated', {}, [], { maxTokens: 8192 });
  const state = await waitForState(stateDir, workerId, ['BLOCKED', 'FAILED'], 25_000);
  assert.equal(state.state, 'BLOCKED');
  const attention = state.attention as Record<string, unknown>;
  assert.equal(attention.reason, 'output_truncated');
  assert.match(String(attention.message), /output-token limit \(maxTokens 8192\)/);
  const status = cli(['status', workerId], { stateDir });
  assert.equal(status.code, 0, status.stderr);
  const model = status.json?.model as Record<string, unknown>;
  assert.equal(model.model, 'fake-model', 'status names the model the worker runs on');
  assert.equal(model.maxTokens, 8192);
});

test('provider failures become FAILED, not BLOCKED', async () => {
  const { stateDir, workerId } = await start('provider_error');
  const state = await waitForState(stateDir, workerId, ['FAILED'], 25_000);
  assert.equal((state.attention as Record<string, unknown>).reason, 'provider_error');
  assert.match(String(state.lastError), /HTTP 503/);
});

test('repeated tool failures abort the run and block, without the settle overwriting the reason', async () => {
  const { stateDir, workerId } = await start('toolfail', { toolFailureThreshold: 4 });
  const state = await waitForState(stateDir, workerId, ['BLOCKED'], 25_000);
  const attention = state.attention as Record<string, unknown>;
  assert.equal(attention.reason, 'tool_failure_threshold');
  const tool = state.tool as Record<string, unknown>;
  assert.ok(Number(tool.failures) >= 4, `expected at least 4 failures, saw ${String(tool.failures)}`);
  assert.equal(Number(tool.threshold), 4);
  const runs = state.runs as Record<string, unknown>[];
  assert.equal(runs[0]?.outcome, 'tool_failure_threshold');
  assert.equal(runs[0]?.settled, true, 'the abort settle was observed but did not change the outcome');
  const evidence = state.evidence as Record<string, unknown>[];
  assert.ok(evidence.length > 0 && evidence[0]?.isError === true);
  assert.equal(evidence[0]?.toolName, 'bash');
  assert.match(String(evidence[0]?.target), /false/);
});

test('a burst of failures followed immediately by agent_settled keeps the abort reason', async () => {
  const { stateDir, workerId } = await start('burst', { toolFailureThreshold: 3 });
  const state = await waitForState(stateDir, workerId, ['BLOCKED', 'REVIEW_REQUIRED'], 25_000);
  assert.equal(state.state, 'BLOCKED');
  assert.equal((state.attention as Record<string, unknown>).reason, 'tool_failure_threshold');
});

test('a hung run hits the bounded run timeout and blocks instead of running forever', async () => {
  const { stateDir, workerId } = await start('hang', { runTimeoutSeconds: 5 });
  const state = await waitForState(stateDir, workerId, ['BLOCKED'], 40_000);
  const attention = state.attention as Record<string, unknown>;
  assert.equal(attention.reason, 'run_timeout');
  assert.match(String(attention.message), /agent_settled within 5s/);
});

test('malformed framing and U+2028 inside a record are recorded but never fatal', async () => {
  const { stateDir, workerId } = await start('malformed');
  const state = await waitForState(stateDir, workerId, ['REVIEW_REQUIRED', 'BLOCKED'], 25_000);
  assert.equal(state.state, 'REVIEW_REQUIRED', 'the valid record after the garbage still produced a report');
  const warnings = state.warnings as string[];
  assert.ok(warnings.some((warning) => warning.includes('$malformed_frame')), warnings.join('; '));
  const report = state.report as Record<string, unknown>;
  assert.match(String(report.rawText), /line separator/);
});

test('usage reports provider tokens but never invents a cost', async () => {
  const { stateDir, workerId } = await start('ok');
  const state = await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 25_000);
  const usage = state.usage as Record<string, unknown>;
  assert.equal(usage.totalTokens, 1250);
  assert.equal(usage.costUsd, null, 'pi computes cost from configured prices; that is not provider-billed');
  assert.equal(usage.priceEstimateUsd, 0.042);
  assert.equal(usage.source, 'pi:get_session_stats');
});

test('wait answers immediately from an existing attention state and times out otherwise', async () => {
  // maxWaitSeconds is tiny so the clamp is observable without a slow test.
  const { stateDir, workerId } = await start('ok', { waitTimeoutSeconds: 4, maxWaitSeconds: 6 });
  await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 25_000);
  const started = Date.now();
  const immediate = cli(['wait', workerId, '--timeout', '30'], { stateDir, timeoutMs: 40_000 });
  assert.equal(immediate.json?.outcome, 'attention');
  assert.ok(Date.now() - started < 5_000, 'an existing attention state must answer immediately');
  const revision = Number(immediate.json?.revision);
  const later = cli(['wait', workerId, '--timeout', '2', '--after', String(revision)], { stateDir, timeoutMs: 30_000 });
  assert.equal(later.code, 0);
  assert.equal(later.json?.outcome, 'timed_out');
  assert.equal(later.json?.state, 'REVIEW_REQUIRED');
  // An over-long timeout is clamped to limits.maxWaitSeconds instead of rejected, and an
  // existing attention state still answers immediately.
  const immediateAgain = cli(['wait', workerId, '--timeout', '99999'], { stateDir, timeoutMs: 30_000 });
  assert.equal(immediateAgain.code, 0, immediateAgain.stderr);
  assert.equal(immediateAgain.json?.outcome, 'attention');
  const clamped = cli(['wait', workerId, '--timeout', '99999', '--after', String(revision)], { stateDir, timeoutMs: 30_000 });
  assert.ok(Number(clamped.json?.waitedSeconds) <= 6, 'the requested timeout must be clamped to limits.maxWaitSeconds');
  assert.equal(clamped.code, 0, clamped.stderr);
  assert.equal(clamped.json?.outcome, 'timed_out', 'the clamped wait ran out instead of hanging');
  killTree(Number((await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 5_000)).daemon?.pid ?? null));
});
