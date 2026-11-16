/**
 * Real lifecycle coverage: the CLI is invoked as a separate process, the daemon runs detached,
 * and a fake Pi peer speaks the real RPC framing. Nothing is stubbed inside the bridge.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { cli, git, killTree, makeRepo, pidAlive, tempDir, waitForState, writeConfig, writeTask, type Handle } from './helpers.ts';

const handles: Handle[] = [];

function setup(scenario: string, extraPiArgs: string[] = [], limits: Record<string, number> = {}) {
  const handle = tempDir();
  handles.push(handle);
  const { repo, head } = makeRepo(handle);
  const task = writeTask(handle);
  const config = writeConfig(handle, { scenario, limits, extraPiArgs });
  return { handle, repo, head, task, config };
}

after(() => {
  for (const handle of handles) handle.cleanup();
});

test('spawn -> wait -> review -> accept completes a worker and leaves the repo untouched', async () => {
  const { handle, repo, head, task, config } = setup('ok', ['--commit', '--touch', 'notes/untracked.txt']);
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const spawned = cli(['spawn', '--repo', repo, '--task', task, '--config', config, '--no-sandbox', '--label', 'lifecycle'], { stateDir });
  assert.equal(spawned.code, 0, `spawn failed: ${spawned.stderr}`);
  const workerId = String(spawned.json?.workerId);
  assert.match(workerId, /^[0-9a-f-]{36}$/);
  assert.equal(spawned.json?.state, 'RUNNING');
  assert.equal(spawned.json?.disposition, 'started');
  assert.equal(spawned.json?.baseCommit, head);
  assert.equal(spawned.json?.sandbox?.mode, 'disabled', 'the explicit no-sandbox mode must be surfaced');

  // The daemon survives the CLI process: it is detached and answers on its own socket.
  const daemonPid = Number(spawned.json?.daemonPid);
  assert.ok(pidAlive(daemonPid), 'daemon should still be running after the CLI exited');

  const waited = cli(['wait', workerId, '--timeout', '25'], { stateDir, timeoutMs: 40_000 });
  assert.equal(waited.code, 0, `wait failed: ${waited.stderr}`);
  assert.equal(waited.json?.outcome, 'attention');
  assert.equal(waited.json?.state, 'REVIEW_REQUIRED');
  assert.equal(waited.json?.attention?.reason, 'agent_reported_review');
  assert.ok(Number(waited.json?.revision) > Number(spawned.json?.revision));

  // --after an attention revision that is already in the past must keep waiting.
  const stale = cli(['wait', workerId, '--timeout', '2', '--after', String(waited.json?.revision)], { stateDir, timeoutMs: 20_000 });
  assert.equal(stale.code, 0, 'a timeout is a normal outcome');
  assert.equal(stale.json?.outcome, 'timed_out');
  assert.equal(stale.json?.timedOut, true);

  const status = cli(['status', workerId], { stateDir });
  assert.equal(status.code, 0);
  assert.equal(status.json?.state, 'REVIEW_REQUIRED');
  assert.equal(status.json?.daemon?.responsive, true);
  assert.equal(status.json?.report?.status, 'review');
  assert.ok(Array.isArray(status.json?.next));

  const reviewed = cli(['review', workerId], { stateDir });
  assert.equal(reviewed.code, 0, `review failed: ${reviewed.stderr}`);
  assert.equal(reviewed.json?.state, 'REVIEW_REQUIRED');
  const diffPath = String(reviewed.json?.diffPath);
  const reportMd = String(reviewed.json?.reportMd);
  const reportJsonPath = String(reviewed.json?.reportJson);
  assert.ok(fs.existsSync(diffPath) && fs.existsSync(reportMd) && fs.existsSync(reportJsonPath));
  const diff = fs.readFileSync(diffPath, 'utf8');
  assert.match(diff, /src\/sum\.ts/, 'the worker commit must appear in the diff');
  assert.match(diff, /notes\/untracked\.txt/, 'untracked files must appear in the diff');
  assert.equal(reviewed.json?.diffTruncated, false);
  assert.ok(Array.isArray(reviewed.json?.filesChanged) && (reviewed.json.filesChanged as string[]).includes('src/sum.ts'));
  const markdown = fs.readFileSync(reportMd, 'utf8');
  assert.match(markdown, /UNTRUSTED AGENT CLAIMS/);
  assert.match(markdown, /measured by the bridge/);
  const reportDoc = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8')) as Record<string, unknown>;
  assert.equal((reportDoc.agentClaims as Record<string, unknown>).untrusted, true);
  assert.ok(diffPath.includes(path.join('workers', workerId, 'reports')), 'reports live outside the workspace');

  // The source repository is untouched by all of this.
  assert.equal(git(['status', '--porcelain'], repo), '', 'the bridge must never touch the source repository');
  assert.ok(!git(['branch', '--list'], repo).includes('shrimp-pi'), 'no worker branch may leak into the source repo');

  const accepted = cli(['accept', workerId, '--note', 'looks good'], { stateDir });
  assert.equal(accepted.code, 0, `accept failed: ${accepted.stderr}`);
  assert.equal(accepted.json?.state, 'COMPLETED');
  assert.equal(accepted.json?.accepted, true);

  const final = await waitForState(stateDir, workerId, ['COMPLETED'], 15_000);
  const accept = final.accept as Record<string, unknown>;
  assert.equal(accept.merged, false, 'acceptance must never merge');
  assert.equal(accept.note, 'looks good');
  assert.equal(final.state, 'COMPLETED');

  // COMPLETED is terminal: the daemon shuts down and the work products stay on disk.
  const gone = await (async () => {
    for (let i = 0; i < 100; i += 1) {
      if (!pidAlive(daemonPid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  })();
  assert.ok(gone, 'the daemon should exit after acceptance');
  const workspace = String(final.workspaceDir);
  assert.ok(fs.existsSync(path.join(workspace, 'src', 'sum.ts')), 'worker work must be preserved');
  assert.ok(fs.existsSync(path.join(workspace, 'notes', 'untracked.txt')));
  assert.equal(git(['remote'], workspace), '', 'the private clone must not keep an origin remote');
  const after = cli(['accept', workerId], { stateDir });
  assert.equal(after.code, 1, 'accepting twice is an error');
  assert.match(after.stderr, /already COMPLETED/);
});

test('accept refuses before review and --force records the override', async () => {
  const { handle, repo, task, config } = setup('blocked');
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const spawned = cli(['spawn', '--repo', repo, '--task', task, '--config', config, '--no-sandbox'], { stateDir });
  const workerId = String(spawned.json?.workerId);
  await waitForState(stateDir, workerId, ['BLOCKED'], 25_000);
  const refused = cli(['accept', workerId], { stateDir });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not REVIEW_REQUIRED/);
  const forced = cli(['accept', workerId, '--force', '--note', 'accepted despite blocked'], { stateDir });
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(forced.json?.state, 'COMPLETED');
  killTree(Number(spawned.json?.daemonPid));
});

test('spawn refuses a repository without commits and leaves no worker behind', () => {
  const handle = tempDir();
  handles.push(handle);
  const repo = path.join(handle.dir, 'empty-repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', repo], repo);
  const task = writeTask(handle);
  const config = writeConfig(handle, { scenario: 'ok' });
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const result = cli(['spawn', '--repo', repo, '--task', task, '--config', config, '--no-sandbox'], { stateDir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no commits/);
  const workers = path.join(stateDir, 'workers');
  const entries = fs.existsSync(workers) ? fs.readdirSync(workers) : [];
  assert.equal(entries.length, 0, 'a failed spawn must not leave a worker directory');
});

test('a dirty source repository is allowed but surfaced as a warning', () => {
  const handle = tempDir();
  handles.push(handle);
  const { repo, head } = makeRepo(handle, { dirty: true });
  const task = writeTask(handle);
  const config = writeConfig(handle, { scenario: 'ok' });
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const spawned = cli(['spawn', '--repo', repo, '--task', task, '--config', config, '--no-sandbox'], { stateDir });
  assert.equal(spawned.code, 0, spawned.stderr);
  const warnings = (spawned.json?.warnings ?? []) as string[];
  assert.ok(warnings.some((warning) => warning.includes('uncommitted changes')), warnings.join('; '));
  assert.equal(spawned.json?.baseCommit, head);
  const workspace = String(spawned.json?.workspaceDir);
  assert.ok(!fs.existsSync(path.join(workspace, 'uncommitted.txt')), 'uncommitted source work must not be copied');
  killTree(Number(spawned.json?.daemonPid));
});

test('unknown worker ids and path traversal ids are rejected', () => {
  const handle = tempDir();
  handles.push(handle);
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const bad = cli(['status', '../../etc/passwd'], { stateDir });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /invalid worker id/);
  const missing = cli(['status', '4f2c1e6a-9a37-4c0e-8f2d-3b1a0c5d7e11'], { stateDir });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no worker/);
});

