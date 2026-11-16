/** Process death, recovery without replay, stop, and steering across CLI exits. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workerPaths } from '../src/lib/paths.ts';
import path from 'node:path';
import { after, test } from 'node:test';
import { cli, killTree, makeRepo, pidAlive, readSessionPrompts, tempDir, waitFor, waitForState, writeConfig, writeTask, type Handle } from './helpers.ts';

const handles: Handle[] = [];
after(() => {
  for (const handle of handles) handle.cleanup();
});

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

test('an unexpected Pi child death during a run is FAILED, not BLOCKED', async () => {
  const { stateDir, workerId, spawned } = await start('died');
  const state = await waitForState(stateDir, workerId, ['FAILED'], 25_000);
  const attention = state.attention as Record<string, unknown>;
  assert.equal(attention.reason, 'pi_child_exit', 'the child exit must own the outcome');
  assert.match(String(state.lastError), /exited with code 7/);
  const runs = state.runs as Record<string, unknown>[];
  assert.equal(runs[0]?.outcome, 'pi_child_exit');
  assert.equal(state.state, 'FAILED', 'the run evaluation must not overwrite the exit verdict with BLOCKED');
  killTree(Number(spawned.json?.daemonPid));
});

test('a killed daemon is diagnosed as a lost connection and recovery reopens the session without replay', async () => {
  const { stateDir, workerId, spawned } = await start('hang', { runTimeoutSeconds: 600 });
  const running = await waitForState(stateDir, workerId, ['RUNNING'], 25_000);
  const daemonPid = Number(spawned.json?.daemonPid);
  const originalPeerPid = Number((running.daemon as Record<string, unknown>).childPid);
  const sessionFile = String(running.sessionFile);
  const before = readSessionPrompts(sessionFile);
  assert.equal(before.length, 1, 'the task prompt must have been sent exactly once');

  killTree(daemonPid);
  assert.ok(
    await waitFor(() => !pidAlive(daemonPid)),
    'daemon should be gone',
  );

  // This fixture explicitly disables sandboxing, so clean up its orphan peer.
  killTree(originalPeerPid);
  const status = cli(['status', workerId], { stateDir });
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json?.state, 'FAILED');
  assert.equal((status.json?.attention as Record<string, unknown>)?.reason, 'daemon_lost');
  assert.equal(status.json?.daemon?.verdict, 'dead');

  // The CLI cannot answer a wait for a running worker with no daemon: it diagnoses instead.
  const refused = cli(['accept', workerId], { stateDir });
  assert.equal(refused.code, 1);

  const recovered = cli(['recover', workerId], { stateDir, timeoutMs: 60_000 });
  assert.equal(recovered.code, 0, `recover failed: ${recovered.stderr}`);
  assert.equal(recovered.json?.state, 'BLOCKED');
  assert.equal((recovered.json?.attention as Record<string, unknown>)?.kind, 'interrupted');
  assert.equal(recovered.json?.sessionFile, sessionFile, 'recovery must reuse the same session file');

  const after = readSessionPrompts(sessionFile);
  assert.equal(after.length, 1, 'recovery must NOT replay the original task prompt');

  const state = readStateJson(stateDir, workerId);
  const interventions = state.interventions as Record<string, unknown>[];
  assert.ok(interventions.some((entry) => entry.kind === 'recover'));

  // The supervisor resumes with an explicit steer.
  const steered = cli(['steer', workerId, '--message', 'resume where you left off and finish'], { stateDir });
  assert.equal(steered.code, 0, `steer failed: ${steered.stderr}`);
  assert.equal(['relaunched', 'resume'].includes(String(steered.json?.mode)), true);
  await waitForState(stateDir, workerId, ['RUNNING'], 25_000);
  const prompts = readSessionPrompts(sessionFile);
  assert.equal(prompts.length, 2, 'only the explicit steer was added to the session');
  assert.match(prompts[1]?.text ?? '', /resume where you left off/);
  killTree(Number((readStateJson(stateDir, workerId).daemon as Record<string, unknown>).pid));
});

test('stop aborts, ends the daemon, and preserves every work product', async () => {
  const { stateDir, workerId, spawned } = await start('hang', { runTimeoutSeconds: 600 });
  const state = await waitForState(stateDir, workerId, ['RUNNING'], 25_000);
  const workspace = String(state.workspaceDir);
  fs.writeFileSync(path.join(workspace, 'keep-me.txt'), 'work in progress\n');
  const daemonPid = Number(spawned.json?.daemonPid);
  const childPid = Number((state.daemon as Record<string, unknown>).childPid);

  const stopped = cli(['stop', workerId], { stateDir, timeoutMs: 60_000 });
  assert.equal(stopped.code, 0, `stop failed: ${stopped.stderr}`);
  assert.equal(stopped.json?.state, 'STOPPED');
  assert.ok(
    await waitFor(() => !pidAlive(daemonPid) && !pidAlive(childPid)),
    'neither the daemon nor the pi child may survive stop',
  );
  assert.ok(fs.existsSync(path.join(workspace, 'keep-me.txt')), 'stop must never delete work');
  const final = readStateJson(stateDir, workerId);
  assert.equal((final.attention as Record<string, unknown>).reason, 'supervisor_stop');
  assert.equal(fs.existsSync(workerPaths(stateDir, workerId).socket), false, 'stale socket removed');
  const again = cli(['steer', workerId, '--message', 'anything'], { stateDir });
  assert.equal(again.code, 1, 'a stopped worker is terminal');
  assert.match(again.stderr, /no responsive daemon|STOPPED/);
});

test('steering a running worker uses streamingBehavior steer and survives CLI exits', async () => {
  const { stateDir, workerId, spawned } = await start('steerable', { runTimeoutSeconds: 600 });
  await waitForState(stateDir, workerId, ['RUNNING'], 25_000);
  const sessionFile = String(readStateJson(stateDir, workerId).sessionFile);

  // The daemon, not the CLI, owns the Pi session: this second CLI process steers the live run.
  const steered = cli(['steer', workerId, '--message', 'use a map instead of a switch'], { stateDir });
  assert.equal(steered.code, 0, `steer failed: ${steered.stderr}`);
  assert.equal(steered.json?.mode, 'steer');
  assert.equal(steered.json?.disposition, 'queued');

  const state = await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 25_000);
  const report = state.report as Record<string, unknown>;
  assert.match(String(report.workCompleted), /steered: use a map/);
  const prompts = readSessionPrompts(sessionFile);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1]?.streamingBehavior, 'steer', 'a running worker must be steered, not restarted');
  const runs = state.runs as Record<string, unknown>[];
  assert.equal(runs.length, 1, 'steering must not start a second run');
  const interventions = state.interventions as Record<string, unknown>[];
  assert.equal(interventions.length, 1);
  killTree(Number(spawned.json?.daemonPid));
});

test('steering an idle worker restarts the same session instead of dying', async () => {
  const { stateDir, workerId, spawned } = await start('two_runs');
  const first = await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 25_000);
  const sessionFile = String(first.sessionFile);
  const steered = cli(['steer', workerId, '--message', 'also add a test'], { stateDir });
  assert.equal(steered.code, 0, `steer failed: ${steered.stderr}`);
  assert.equal(steered.json?.mode, 'resume', 'an idle worker is resumed with a plain prompt');
  const second = await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 25_000);
  const report = second.report as Record<string, unknown>;
  assert.match(String(report.workCompleted), /second run finished/);
  assert.equal(second.sessionFile, sessionFile, 'the same session file must be reused');
  killTree(Number(spawned.json?.daemonPid));
});

test('steer after an idle Pi child exit relaunches the child on the same session file', async () => {
  const { stateDir, workerId, spawned } = await start('idle_exit');
  const first = await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 25_000);
  const sessionFile = String(first.sessionFile);
  assert.ok(
    await waitFor(() => {
      const state = readStateJson(stateDir, workerId);
      const daemon = state.daemon as Record<string, unknown>;
      return daemon.childExitedAt !== null;
    }, 15_000),
    'the idle child exit must be recorded',
  );
  const state = readStateJson(stateDir, workerId);
  assert.equal(state.state, 'REVIEW_REQUIRED', 'an idle child exit must not invalidate the work');
  const steered = cli(['steer', workerId, '--message', 'one more thing'], { stateDir });
  assert.equal(steered.code, 0, `steer failed: ${steered.stderr}`);
  assert.equal(steered.json?.mode, 'relaunched');
  await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 25_000);
  assert.ok(readSessionPrompts(sessionFile).length >= 2);
  killTree(Number((readStateJson(stateDir, workerId).daemon as Record<string, unknown>).pid));
});

function readStateJson(stateDir: string, workerId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'workers', workerId, 'state.json'), 'utf8')) as Record<string, unknown>;
}
