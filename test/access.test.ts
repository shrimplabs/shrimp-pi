/**
 * Cross-boundary guarantees: the named endpoint key must survive the detached daemon and
 * reach the sandboxed Pi child, while nothing else does. Also covers the access-context
 * guard: a CLI that cannot see the daemon must never rewrite durable state.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workerPaths } from '../src/lib/paths.ts';
import { pidNamespace } from '../src/lib/worker.ts';
import path from 'node:path';
import { after, test } from 'node:test';
import { FAKE_PI, NODE, cli, killTree, makeRepo, pidAlive, tempDir, waitFor, waitForState, writeConfig, writeTask, type Handle } from './helpers.ts';

const handles: Handle[] = [];
after(() => {
  for (const handle of handles) handle.cleanup();
});

test('the configured endpoint key reaches the Pi child across the detached daemon boundary', async () => {
  const handle = tempDir();
  handles.push(handle);
  const { repo } = makeRepo(handle);
  const task = writeTask(handle);
  const envFile = path.join(handle.dir, 'child-env.json');
  const config = writeConfig(handle, {
    scenario: 'env',
    apiKeyEnv: 'SHRIMP_PI_DEMO_KEY',
    envAllowlist: ['FAKE_PI_ENV_FILE'],
  });
  // The config must be rewritten to dump the child environment; FAKE_PI_ENV_FILE is
  // allowlisted, which is exactly the mechanism under test.
  const parsed = JSON.parse(fs.readFileSync(config, 'utf8')) as Record<string, unknown>;
  parsed.piCommand = [NODE, FAKE_PI, '--scenario', 'env'];
  fs.writeFileSync(config, `${JSON.stringify(parsed, null, 2)}\n`);

  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const spawned = cli(
    [
      'spawn',
      '--repo',
      repo,
      '--task',
      task,
      '--config',
      config,
      '--no-sandbox',
    ],
    {
      stateDir,
      env: {
        SHRIMP_PI_DEMO_KEY: 'endpoint-secret-value',
        FAKE_PI_ENV_FILE: envFile,
        UNRELATED_SUPERVISOR_SECRET: 'must-not-travel',
        PI_SESSION_FILE: '/agent/session.jsonl',
        PI_CODING_AGENT_DIR: '/agent',
      },
    },
  );
  assert.equal(spawned.code, 0, `spawn failed: ${spawned.stderr}`);
  const workerId = String(spawned.json?.workerId);
  await waitForState(stateDir, workerId, ['REVIEW_REQUIRED'], 25_000);

  const ok = await waitFor(() => fs.existsSync(envFile), 15_000);
  assert.ok(ok, 'the fake agent never dumped its environment');
  const childEnv = JSON.parse(fs.readFileSync(envFile, 'utf8')) as Record<string, string>;
  assert.equal(childEnv.SHRIMP_PI_DEMO_KEY, 'endpoint-secret-value', 'the named key must survive CLI exit -> daemon -> child');
  assert.ok(childEnv.FAKE_PI_ENV_FILE, 'allowlisted names are forwarded deliberately');
  assert.equal(childEnv.UNRELATED_SUPERVISOR_SECRET, undefined, 'unrelated secrets never travel');
  assert.equal(childEnv.PI_SESSION_FILE, undefined, 'the supervisor session file must not leak');
  assert.equal(childEnv.PI_CODING_AGENT_DIR, path.join(stateDir, 'workers', workerId, 'agent'), 'the agent dir is isolated per worker');
  assert.ok(childEnv.PATH.includes(path.dirname(NODE)), 'node is on PATH even when it is not installed system-wide');

  // Nothing secret is persisted: the config snapshot and state.json only reference names.
  const snapshot = fs.readFileSync(path.join(stateDir, 'workers', workerId, 'config.json'), 'utf8');
  assert.ok(!snapshot.includes('endpoint-secret-value'), 'no secret in the config snapshot');
  const stateFile = fs.readFileSync(path.join(stateDir, 'workers', workerId, 'state.json'), 'utf8');
  assert.ok(!stateFile.includes('endpoint-secret-value'), 'no secret in state.json');
  const models = fs.readFileSync(path.join(stateDir, 'workers', workerId, 'agent', 'models.json'), 'utf8');
  assert.match(models, /\$SHRIMP_PI_DEMO_KEY/, 'models.json interpolates the key by name');
  assert.ok(!models.includes('endpoint-secret-value'));
  killTree(Number(spawned.json?.daemonPid));
});

test('a CLI that cannot see the daemon reports access_context_mismatch and changes nothing', async () => {
  const handle = tempDir();
  handles.push(handle);
  const { repo } = makeRepo(handle);
  const task = writeTask(handle);
  const config = writeConfig(handle, { scenario: 'hang', limits: { runTimeoutSeconds: 600 } });
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const spawned = cli(['spawn', '--repo', repo, '--task', task, '--config', config, '--no-sandbox'], { stateDir });
  assert.equal(spawned.code, 0, spawned.stderr);
  const workerId = String(spawned.json?.workerId);
  await waitForState(stateDir, workerId, ['RUNNING'], 25_000);
  const daemonPid = Number(spawned.json?.daemonPid);
  const stateFile = path.join(stateDir, 'workers', workerId, 'state.json');

  // Simulate a supervisor in a restricted PID/socket namespace: the recorded daemon namespace
  // differs from this process' namespace AND the socket is not reachable from here (mode 0000
  // makes connect fail with EACCES, exactly like a foreign socket namespace).
  const socketPath = workerPaths(stateDir, workerId).socket;
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
  const daemon = state.daemon as Record<string, unknown>;
  daemon.pidNamespace = 'pid:[4026539999]';
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  fs.chmodSync(socketPath, 0o000);
  const revisionBefore = Number(state.revision);

  const status = cli(['status', workerId], { stateDir });
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json?.state, 'RUNNING', 'a foreign access context must not change the state');
  assert.equal((status.json?.daemon as Record<string, unknown>).verdict, 'foreign_context');
  assert.match(String(status.json?.accessContext?.code ?? ''), /access_context_mismatch/);

  const wait = cli(['wait', workerId, '--timeout', '2'], { stateDir });
  assert.equal(wait.code, 1, wait.stdout);
  assert.match(wait.stderr, /access_context_mismatch/);

  const stop = cli(['stop', workerId], { stateDir });
  assert.equal(stop.code, 1);
  assert.match(stop.stderr, /access_context_mismatch/);

  const recover = cli(['recover', workerId], { stateDir });
  assert.equal(recover.code, 1);
  assert.match(recover.stderr, /access_context_mismatch/);

  const accept = cli(['accept', workerId], { stateDir });
  assert.equal(accept.code, 1);
  assert.match(accept.stderr, /access_context_mismatch/);

  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
  assert.equal(after.state, 'RUNNING', 'state must be untouched: not FAILED, not STOPPED, not COMPLETED');
  assert.equal(Number(after.revision), revisionBefore, 'no state writes at all');
  assert.ok(pidAlive(daemonPid), 'the daemon must still be running and untouched');
  assert.equal((after.daemon as Record<string, unknown>).pid, daemonPid);

  // Back in the right context everything works again.
  fs.chmodSync(socketPath, 0o600);
  const restored = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
  (restored.daemon as Record<string, unknown>).pidNamespace = pidNamespace();
  fs.writeFileSync(stateFile, `${JSON.stringify(restored, null, 2)}\n`);
  const stopped = cli(['stop', workerId], { stateDir, timeoutMs: 60_000 });
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.json?.state, 'STOPPED');
  assert.ok(await waitFor(() => !pidAlive(daemonPid), 15_000));
});

test('a worker with no daemon at all is diagnosed as dead and recorded FAILED', async () => {
  const handle = tempDir();
  handles.push(handle);
  const { repo } = makeRepo(handle);
  const task = writeTask(handle);
  const config = writeConfig(handle, { scenario: 'hang', limits: { runTimeoutSeconds: 600 } });
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const spawned = cli(['spawn', '--repo', repo, '--task', task, '--config', config, '--no-sandbox'], { stateDir });
  const workerId = String(spawned.json?.workerId);
  await waitForState(stateDir, workerId, ['RUNNING'], 25_000);
  const daemonPid = Number(spawned.json?.daemonPid);
  try {
    process.kill(daemonPid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  await waitFor(() => !pidAlive(daemonPid), 15_000);
  // A dead daemon cannot advance the worker, so wait diagnoses it and answers with the
  // FAILED attention event it just recorded (a normal answer, not an error).
  const wait = cli(['wait', workerId, '--timeout', '3'], { stateDir });
  assert.equal(wait.code, 0, `${wait.stdout}${wait.stderr}`);
  assert.equal(wait.json?.outcome, 'attention');
  assert.equal(wait.json?.state, 'FAILED');
  assert.equal((wait.json?.attention as Record<string, unknown>)?.reason, 'daemon_lost');
  assert.match(String(wait.json?.note), /no daemon/);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'workers', workerId, 'state.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(state.state, 'FAILED');
  assert.equal((state.attention as Record<string, unknown>).reason, 'daemon_lost');
  // A second wait with --after the new revision reports that nothing can progress.
  const stalled = cli(['wait', workerId, '--timeout', '2', '--after', String(state.revision)], { stateDir });
  assert.equal(stalled.code, 1, stalled.stdout);
  assert.equal(stalled.json?.outcome, 'no_daemon');
  assert.match(String(stalled.json?.hint), /recover/);
});
