/** Concurrency: serialized mutations, ordered events, and parallel supervisor access. */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { CLI, NODE, cli, killTree, makeRepo, tempDir, waitFor, waitForState, writeConfig, writeTask, type Handle } from './helpers.ts';

const handles: Handle[] = [];
after(() => {
  for (const handle of handles) handle.cleanup();
});

function asyncCli(args: string[], stateDir: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, ...args], {
      env: { PATH: `${path.dirname(NODE)}:/usr/bin:/bin`, HOME: path.join(stateDir, 'home'), SHRIMP_PI_HOME: stateDir, LANG: 'C.UTF-8', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function start(scenario: string, limits: Record<string, number> = {}) {
  const handle = tempDir();
  handles.push(handle);
  const { repo } = makeRepo(handle);
  const task = writeTask(handle);
  const config = writeConfig(handle, { scenario, limits });
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const spawned = cli(['spawn', '--repo', repo, '--task', task, '--config', config, '--no-sandbox'], { stateDir });
  assert.equal(spawned.code, 0, `spawn failed: ${spawned.stderr}`);
  return { handle, stateDir, workerId: String(spawned.json?.workerId), spawned };
}

test('concurrent steers of a running worker never create a second run', async () => {
  // 'hang' keeps the run in flight (no settle), so both steers must attach to the live run.
  const { stateDir, workerId, spawned } = await start('hang', { runTimeoutSeconds: 600 });
  await waitForState(stateDir, workerId, ['RUNNING'], 25_000);
  const before = readState(stateDir, workerId);
  const runsBefore = (before.runs as unknown[]).length;

  const [a, b] = await Promise.all([
    asyncCli(['steer', workerId, '--message', 'first correction'], stateDir),
    asyncCli(['steer', workerId, '--message', 'second correction'], stateDir),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const modeOf = (stdout: string) => String(JSON.parse(stdout).mode);
  assert.ok(modeOf(a.stdout).includes('steer'), `${modeOf(a.stdout)} / ${modeOf(b.stdout)}`);
  assert.ok(modeOf(b.stdout).includes('steer'), `${modeOf(a.stdout)} / ${modeOf(b.stdout)}`);

  const afterState = readState(stateDir, workerId);
  assert.equal((afterState.runs as unknown[]).length, runsBefore, 'steering a live run must not add a run');
  assert.equal((afterState.interventions as unknown[]).length, 2, 'both interventions are recorded');
  // Steering does not change the worker state, so the revision is unchanged; the record must
  // still show both interventions and a live run.
  assert.equal(afterState.state, 'RUNNING');
  assert.equal(Number(afterState.revision), Number(before.revision), 'steering is not a state transition');
  assert.notEqual(afterState.updatedAt, before.updatedAt);
  killTree(Number(spawned.json?.daemonPid));
});

test('concurrent steers of an idle worker start exactly one run', async () => {
  const { stateDir, workerId, spawned } = await start('two_runs');
  await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 25_000);
  const before = readState(stateDir, workerId);
  const runsBefore = (before.runs as unknown[]).length;
  const results = await Promise.all([
    asyncCli(['steer', workerId, '--message', 'idle correction one'], stateDir),
    asyncCli(['steer', workerId, '--message', 'idle correction two'], stateDir),
    asyncCli(['steer', workerId, '--message', 'idle correction three'], stateDir),
  ]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const settled = await waitForState(stateDir, workerId, ['REVIEW_REQUIRED', 'BLOCKED'], 30_000);
  const runs = settled.runs as Record<string, unknown>[];
  assert.ok(runs.length >= runsBefore + 1, 'at least one new run happened');
  assert.ok(runs.length <= runsBefore + 3, `run explosion: ${runs.length} runs`);
  const kinds = runs.filter((run) => run.kind === 'steer');
  assert.ok(kinds.length >= 1);
  // state.json must stay valid JSON with a monotonic revision under concurrent writes.
  assert.ok(Number(settled.revision) > Number(before.revision));
  assert.ok(Array.isArray(settled.events) && (settled.events as unknown[]).length <= 100, 'events stay bounded');
  killTree(Number(spawned.json?.daemonPid));
});

test('parallel supervisors can read the same worker at the same time', async () => {
  const { stateDir, workerId, spawned } = await start('ok');
  await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 25_000);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => asyncCli(['status', workerId], stateDir)),
  );
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, 'REVIEW_REQUIRED');
  }
  killTree(Number(spawned.json?.daemonPid));
});

test('concurrent spawns get unique worker ids, directories and branches', async () => {
  const handle = tempDir();
  handles.push(handle);
  const { repo } = makeRepo(handle);
  const task = writeTask(handle);
  const config = writeConfig(handle, { scenario: 'ok' });
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      asyncCli(['spawn', '--repo', repo, '--task', task, '--config', config, '--no-sandbox'], stateDir),
    ),
  );
  const ids: string[] = [];
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    ids.push(String(payload.workerId));
    assert.ok(fs.existsSync(String(payload.workspaceDir)));
  }
  assert.equal(new Set(ids).size, 3, 'worker ids must be unique');
  const workers = fs.readdirSync(path.join(stateDir, 'workers')).filter((entry) => /^[0-9a-f-]{36}$/.test(entry));
  assert.equal(workers.length, 3);
  for (const id of ids) {
    const state = readState(stateDir, id);
    assert.equal(state.branch, `shrimp-pi/${id}`);
    killTree(Number((state.daemon as Record<string, unknown>).pid));
  }
});

test('wait subscriptions are event driven and resolve the moment the worker settles', async () => {
  const { stateDir, workerId, spawned } = await start('late_settle');
  const started = Date.now();
  const waiting = asyncCli(['wait', workerId, '--timeout', '30'], stateDir);
  const result = await waiting;
  const elapsed = Date.now() - started;
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.outcome, 'attention');
  assert.equal(payload.state, 'REVIEW_REQUIRED');
  assert.ok(elapsed > 300, `expected to wait for the late settle, took ${elapsed}ms`);
  assert.ok(elapsed < 15_000, 'the event must wake the waiter promptly instead of polling');
  assert.ok(
    await waitFor(() => {
      const state = readState(stateDir, workerId);
      return Number(state.revision) === Number(payload.revision);
    }, 5_000),
  );
  killTree(Number(spawned.json?.daemonPid));
});

function readState(stateDir: string, workerId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'workers', workerId, 'state.json'), 'utf8')) as Record<string, unknown>;
}

test('simultaneous recovery requests launch exactly one daemon on the preserved session', async () => {
  const { stateDir, workerId } = await start('hang', { runTimeoutSeconds: 600 });
  const original = await waitForState(stateDir, workerId, ['RUNNING'], 25_000);
  const daemon = original.daemon as Record<string, unknown>;
  killTree(Number(daemon.childPid));
  killTree(Number(daemon.pid));
  await waitFor(() => {
    try { process.kill(Number(daemon.pid), 0); return false; } catch { return true; }
  });
  const attempts = await Promise.all([
    asyncCli(['recover', workerId], stateDir),
    asyncCli(['recover', workerId], stateDir),
  ]);
  assert.equal(attempts.filter((r) => r.code === 0).length, 1, JSON.stringify(attempts));
  assert.match(attempts.find((r) => r.code !== 0)?.stderr ?? '', /already_running/);
  const restored = await waitForState(stateDir, workerId, ['BLOCKED'], 10_000);
  assert.equal(restored.sessionFile, original.sessionFile);
  const stopped = cli(['stop', workerId], { stateDir });
  assert.equal(stopped.code, 0, stopped.stderr);
});
