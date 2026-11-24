/** Unit level guarantees: framing, ids, state machine, sandbox argv, git inspection. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { LfFramer, encodeFrame } from '../src/lib/framing.ts';
import { buildTaskPrompt } from '../src/lib/prompt.ts';
import { isSafeWorkerId, newWorkerId, workerBranch } from '../src/lib/ids.ts';
import { buildChildEnv, buildModelsJson, buildPiArgv, daemonForwardEnv, loadConfig } from '../src/lib/config.ts';
import { buildBwrapArgv, checkSandbox, defaultBinds, wrapCommand } from '../src/lib/sandbox.ts';
import { computeDiff, createCloneWorkspace, hardeningArgs, inspectRepo } from '../src/lib/git.ts';
import { emptyUsage, newState, transition, IllegalTransition, ATTENTION_STATES, waitSatisfied } from '../src/lib/state.ts';
import type { WorkerState } from '../src/lib/types.ts';
import { git, makeRepo, tempDir, writeConfig, type Handle } from './helpers.ts';

const handles: Handle[] = [];
after(() => {
  for (const handle of handles) handle.cleanup();
});

test('framing splits only on LF and keeps U+2028/U+2029 inside records', () => {
  const framer = new LfFramer();
  const record = JSON.stringify({ text: 'line sep para and a real newline \\n inside' });
  const bytes = Buffer.from(`{"a":1}\n${record}\r\npartial`, 'utf8');
  const first = framer.push(bytes);
  assert.deepEqual(first, ['{"a":1}', record]);
  const rest = framer.push(Buffer.from('-tail\n', 'utf8'));
  assert.deepEqual(rest, [`partial-tail`]);
  assert.equal(encodeFrame({ a: 1 }), '{"a":1}\n');
});

test('framing is bounded and reports overflow instead of growing forever', () => {
  const framer = new LfFramer(64);
  framer.push(Buffer.from('x'.repeat(200), 'utf8'));
  assert.equal(framer.overflowed, true);
  assert.deepEqual(framer.push(Buffer.from('{"ok":true}\n', 'utf8')), []);
  assert.deepEqual(new LfFramer().end(), []);
});

test('worker ids are UUIDs and cannot traverse paths', () => {
  assert.equal(isSafeWorkerId(newWorkerId()), true);
  for (const bad of ['../../etc/passwd', 'nope', '4F2C1E6A-9A37-4C0E-8F2D-3B1A0C5D7E11', '', '4f2c1e6a-9a37-4c0e-8f2d-3b1a0c5d7e1/', 42]) {
    assert.equal(isSafeWorkerId(bad), false, `${String(bad)} must be rejected`);
  }
  const id = '4f2c1e6a-9a37-4c0e-8f2d-3b1a0c5d7e11';
  assert.equal(workerBranch(id), `shrimp-pi/${id}`);
  assert.throws(() => workerBranch('../evil'));
});

function fakeState(): WorkerState {
  return newState({
    workerId: '4f2c1e6a-9a37-4c0e-8f2d-3b1a0c5d7e11',
    repo: '/repo',
    branch: 'shrimp-pi/x',
    baseCommit: 'abc',
    workspaceMode: 'clone',
    workspaceDir: '/w',
    workerDir: '/w',
    sessionFile: '/w/session.jsonl',
    configPath: '/cfg.json',
    provider: 'bridge-local',
    model: 'm',
    task: { file: '/t', sha256: 'x', bytes: 1, promptChars: 1 },
    sandbox: { mode: 'disabled', detail: 'test', warnings: [] },
    logs: { dir: '/logs', piStdout: '/logs/out', piStderr: '/logs/err', daemon: '/logs/d', events: '/logs/e' },
    toolFailureThreshold: 5,
    label: null,
  });
}

test('state transitions are meaningful and guarded', () => {
  const state = fakeState();
  assert.equal(state.state, 'CREATED');
  assert.equal(state.revision, 1);
  assert.equal(state.attention, null);
  assert.throws(() => transition(state, 'COMPLETED', 'nope'), IllegalTransition);
  assert.equal(state.revision, 1, 'a rejected transition must not bump the revision');
  transition(state, 'RUNNING', 'go');
  assert.equal(state.revision, 2);
  assert.equal(state.attention, null);
  transition(state, 'REVIEW_REQUIRED', 'ready');
  assert.equal(state.attention?.kind, 'review_required');
  assert.equal(state.attention?.revision, state.revision);
  assert.throws(() => transition(state, 'CREATED', 'backwards'), IllegalTransition);
  transition(state, 'COMPLETED', 'accepted');
  assert.equal(state.state, 'COMPLETED');
  assert.throws(() => transition(state, 'RUNNING', 'resurrect'), IllegalTransition);
  assert.ok(state.events.length <= 100);
  assert.ok(ATTENTION_STATES.has('STOPPED'));
});

test('wait semantics: attention answers now, --after needs a later attention event', () => {
  const state = fakeState();
  assert.equal(waitSatisfied(state, null), false);
  transition(state, 'RUNNING', 'go');
  assert.equal(waitSatisfied(state, null), false, 'RUNNING is not attention');
  transition(state, 'REVIEW_REQUIRED', 'ready');
  const revision = state.attention?.revision ?? 0;
  assert.equal(waitSatisfied(state, null), true);
  assert.equal(waitSatisfied(state, revision - 1), true);
  assert.equal(waitSatisfied(state, revision), false, 'the revision the supervisor already saw is not new');
  transition(state, 'RUNNING', 'steered');
  assert.equal(waitSatisfied(state, null), false, 'going back to RUNNING clears attention');
  assert.deepEqual(emptyUsage().costUsd, null);
});

test('generated models.json isolates the endpoint and references the key by name only', () => {
  const handle = tempDir();
  handles.push(handle);
  const file = writeConfig(handle, { scenario: 'ok', apiKeyEnv: 'MY_ENDPOINT_KEY' });
  const { config } = loadConfig(file);
  const models = JSON.parse(buildModelsJson(config)) as { providers: Record<string, Record<string, unknown>> };
  assert.equal(models.providers['bridge-local'].apiKey, '$MY_ENDPOINT_KEY');
  assert.equal(models.providers['bridge-local'].api, 'openai-completions');
  assert.ok(JSON.stringify(models).includes('MY_ENDPOINT_KEY'));
  const snapshot = fs.readFileSync(file, 'utf8');
  assert.ok(!snapshot.includes('sk-'), 'the config never stores a secret value');
});

test('pi argv carries every isolation flag the contract requires', () => {
  const handle = tempDir();
  handles.push(handle);
  const { config } = loadConfig(writeConfig(handle, { scenario: 'ok' }));
  const argv = buildPiArgv(config, { sessionFile: '/w/session.jsonl', cwd: '/w' });
  for (const flag of ['--mode', 'rpc', '--session', '/w/session.jsonl', '--provider', 'bridge-local', '--model', 'fake-model', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--offline']) {
    assert.ok(argv.includes(flag), `missing ${flag}`);
  }
});

test('child environment is an allowlist, never a copy of the supervisor environment', () => {
  const handle = tempDir();
  handles.push(handle);
  const previous = process.env.SUPERVISOR_SECRET;
  process.env.SUPERVISOR_SECRET = 'do-not-leak';
  process.env.PI_SESSION_FILE = '/agent/session.jsonl';
  const { config } = loadConfig(writeConfig(handle, { scenario: 'ok', apiKeyEnv: 'MY_ENDPOINT_KEY', envAllowlist: ['SUPERVISOR_SECRET_NOT_SET'] }));
  process.env.MY_ENDPOINT_KEY = 'endpoint-value';
  const env = buildChildEnv(config, { homeDir: '/w/home', agentDir: '/w/agent' });
  assert.equal(env.HOME, '/w/home');
  assert.equal(env.PI_CODING_AGENT_DIR, '/w/agent');
  assert.equal(env.PI_OFFLINE, '1');
  assert.equal(env.MY_ENDPOINT_KEY, 'endpoint-value', 'the named endpoint key is forwarded by name');
  assert.equal(env.SUPERVISOR_SECRET, undefined, 'unlisted variables are never copied');
  assert.equal(env.PI_SESSION_FILE, undefined, 'the supervisor Pi session must not leak');
  assert.ok(env.PATH.includes(path.dirname(process.execPath)), 'node is reachable even when node is not on PATH');
  const forward = daemonForwardEnv(config);
  assert.equal(forward.MY_ENDPOINT_KEY, 'endpoint-value', 'the detached daemon keeps the endpoint key');
  assert.equal(forward.SUPERVISOR_SECRET, undefined);
  if (previous === undefined) delete process.env.SUPERVISOR_SECRET;
  else process.env.SUPERVISOR_SECRET = previous;
});

test('bwrap argv never carries environment values and never exposes host devices', () => {
  const handle = tempDir();
  handles.push(handle);
  const { config } = loadConfig(writeConfig(handle, { scenario: 'ok', sandbox: 'bubblewrap', apiKeyEnv: 'MY_ENDPOINT_KEY' }));
  const binds = defaultBinds({ workspace: '/w/workspace', agentDir: '/w/agent', homeDir: '/w/home' });
  const wrapped = wrapCommand({
    config,
    inner: ['/opt/node/bin/node', 'cli.js', '--mode', 'rpc'],
    cwd: '/w/workspace',
    env: { PATH: '/usr/bin', HOME: '/w/home', MY_ENDPOINT_KEY: 'super-secret-value' },
    binds,
    status: { mode: 'bubblewrap', detail: 'probe ok', warnings: [] },
    hostname: 'pi-test',
  });
  const joined = wrapped.argv.join(' ');
  assert.ok(!joined.includes('--setenv'), 'secrets must not be visible in the process list');
  assert.ok(!joined.includes('--clearenv'));
  assert.ok(!joined.includes('super-secret-value'));
  assert.ok(!joined.includes('--dev-bind /dev'), 'host device nodes must not be exposed');
  assert.ok(wrapped.argv.includes('--dev') && wrapped.argv.includes('/dev'));
  assert.ok(wrapped.argv.includes('--unshare-all') && wrapped.argv.includes('--share-net'));
  assert.ok(wrapped.argv.includes('--die-with-parent'), 'the child must die with the daemon');
  assert.ok(wrapped.argv.includes('--disable-userns'));
  assert.ok(joined.includes('--ro-bind-try /etc/resolv.conf'), 'minimal /etc by default');
  assert.ok(!joined.includes('--ro-bind-try /etc /etc'), 'the whole /etc is not exposed by default');
  assert.ok(wrapped.argv.includes('--bind') && wrapped.argv.includes('/w/workspace'));
  assert.ok(!joined.includes('/w/state'), 'the state directory (socket, logs) is not mounted at all');
  assert.equal(wrapped.env.MY_ENDPOINT_KEY, 'super-secret-value', 'the sanitized env goes through spawn()');
  const minimalOff = buildBwrapArgv({
    bwrapPath: 'bwrap',
    inner: ['true'],
    cwd: '/',
    binds: { writable: [], readOnly: [], minimalEtc: false },
    hostname: 'x',
  });
  assert.ok(minimalOff.join(' ').includes('--ro-bind-try /etc /etc'), 'minimalEtc false is opt-in');
});

test('sandbox fails closed when bubblewrap is missing and disabled needs an explicit flag', () => {
  const handle = tempDir();
  handles.push(handle);
  const file = writeConfig(handle, { scenario: 'ok', sandbox: 'bubblewrap', bwrapPath: '/nonexistent/bwrap' });
  const { config } = loadConfig(file);
  assert.throws(
    () => checkSandbox(config, { allowDisabled: false, binds: { writable: [], readOnly: [] } }),
    /bubblewrap unavailable|not found|only supported/,
  );
  const disabled = writeConfig(handle, { scenario: 'ok', sandbox: 'disabled' });
  const disabledConfig = loadConfig(disabled).config;
  assert.throws(() => checkSandbox(disabledConfig, { allowDisabled: false, binds: { writable: [], readOnly: [] } }), /--no-sandbox/);
  const allowed = checkSandbox(disabledConfig, { allowDisabled: true, binds: { writable: [], readOnly: [] } });
  assert.equal(allowed.mode, 'disabled');
  assert.match(allowed.warnings.join(' '), /SANDBOX DISABLED/);
  const external = writeConfig(handle, { scenario: 'ok', sandbox: 'external', launcher: [process.execPath] });
  assert.equal(checkSandbox(loadConfig(external).config, { allowDisabled: false, binds: { writable: [], readOnly: [] } }).mode, 'external');
});

test('host git inspection is hardened against worker-controlled repository config', () => {
  const args = hardeningArgs().join(' ');
  assert.ok(args.includes('core.fsmonitor=false'));
  assert.ok(args.includes('core.hooksPath='));
  assert.ok(args.includes('core.attributesFile=/dev/null'), 'textconv drivers come from attributes');
  assert.ok(args.includes('diff.external='));
  assert.ok(args.includes('protocol.ext.allow=never'));
  assert.ok(args.includes('--no-pager'));
});

test('review diff covers committed changes vs base, uncommitted edits and untracked files', async () => {
  const handle = tempDir();
  handles.push(handle);
  const { repo, head } = makeRepo(handle);
  const dest = path.join(handle.dir, 'workspace');
  const created = await createCloneWorkspace({ repo, baseCommit: head, dest, branch: 'shrimp-pi/test' });
  assert.match(created.detail, /private clone/);
  assert.equal(git(['remote'], dest), '', 'the clone must not keep an origin remote');

  // committed work by the worker
  fs.writeFileSync(path.join(dest, 'feature.ts'), 'export const feature = 1;\n');
  git(['add', '-A'], dest);
  git(['commit', '-q', '-m', 'worker: feature'], dest);
  // uncommitted tracked edit
  fs.appendFileSync(path.join(dest, 'index.ts'), 'export const extra = 2;\n');
  // untracked file
  fs.mkdirSync(path.join(dest, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'notes', 'scratch.md'), 'scratch\n');
  // ignored file stays out of the diff but is reported
  fs.writeFileSync(path.join(dest, '.gitignore'), 'build/\n');
  fs.mkdirSync(path.join(dest, 'build'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'build', 'out.js'), 'ignored\n');

  const diff = await computeDiff(dest, head);
  assert.ok(diff.files.includes('feature.ts'), 'committed-only changes must be listed');
  assert.match(diff.patch, /export const feature = 1;/);
  assert.match(diff.patch, /export const extra = 2;/);
  assert.match(diff.patch, /notes\/scratch\.md/);
  assert.ok(diff.untracked.includes('notes/scratch.md'));
  assert.ok(diff.ignored.includes('build/out.js'));
  assert.equal(diff.truncated, false);
  assert.ok(diff.warnings.some((warning) => warning.includes('gitignored')));
  assert.ok(!fs.existsSync(path.join(repo, 'feature.ts')), 'the source repository is untouched');

  // Renaming a file that existed at the base commit reports both sides of the rename.
  fs.renameSync(path.join(dest, 'index.ts'), path.join(dest, 'moved.ts'));
  git(['add', '-A'], dest);
  git(['commit', '-q', '-m', 'worker: rename'], dest);
  const renamed = await computeDiff(dest, head);
  assert.ok(renamed.files.includes('index.ts'), `rename source missing: ${renamed.files.join(',')}`);
  assert.ok(renamed.files.includes('moved.ts'), `rename target missing: ${renamed.files.join(',')}`);
  assert.ok(renamed.files.includes('feature.ts'), 'committed additions are still listed after later commits');
});

test('repository inspection requires commits and reports a dirty source', async () => {
  const handle = tempDir();
  handles.push(handle);
  const { repo, head } = makeRepo(handle, { dirty: true });
  const info = await inspectRepo(repo);
  assert.equal(info.head, head);
  assert.equal(info.dirty, true);
  const bare = path.join(handle.dir, 'no-commits');
  fs.mkdirSync(bare, { recursive: true });
  git(['init', '-q', bare], bare);
  await assert.rejects(() => inspectRepo(bare), /no commits/);
  await assert.rejects(() => inspectRepo(handle.dir), /not a git repository/);
});

test('the launcher and CLI run on the built-in type stripper without a build step', () => {
  const result = spawnSync(process.execPath, [path.resolve('src', 'cli.ts'), 'help'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  for (const command of ['spawn', 'status', 'steer', 'wait', 'review', 'stop', 'recover', 'accept', 'list']) {
    assert.ok(result.stdout.includes(command), `help must document ${command}`);
  }
  for (const option of ['--repo', '--task', '--config', '--state-dir', '--timeout', '--after', '--message-file', '--no-sandbox', '--note', '--force', '--label']) {
    assert.ok(result.stdout.includes(option), `help must document ${option}`);
  }
  const launcher = fs.readFileSync(path.resolve('bin', 'shrimp-pi'), 'utf8');
  assert.match(launcher, /SHRIMP_PI_NODE/);
  assert.ok(fs.statSync(path.resolve('bin', 'shrimp-pi')).mode & 0o111, 'launcher must be executable');
});

test('the launcher works through absolute and relative symlink chains (npm link, ~/.local/bin)', () => {
  const handle = tempDir();
  try {
    const absolute = path.join(handle.dir, 'abs-link');
    fs.symlinkSync(path.resolve('bin', 'shrimp-pi'), absolute);
    fs.mkdirSync(path.join(handle.dir, 'bin'));
    const relative = path.join(handle.dir, 'bin', 'shrimp-pi');
    fs.symlinkSync('../abs-link', relative);
    for (const entry of [absolute, relative]) {
      const result = spawnSync(entry, ['help'], { encoding: 'utf8', timeout: 30_000, cwd: handle.dir, env: { ...process.env, SHRIMP_PI_NODE: process.execPath } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /shrimp-pi - run persistent Pi coding workers/);
    }
  } finally { handle.cleanup(); }
});

test('the worker prompt asks for committed work on the current branch and never a push', () => {
  const prompt = buildTaskPrompt('  Add a sum() helper.  ');
  assert.ok(prompt.startsWith('TASK (from supervisor)\nAdd a sum() helper.\n'));
  assert.match(prompt, /Before you report "review" or "checkpoint", commit all of your changes on the current branch/);
  assert.match(prompt, /Do not create or switch branches/);
  assert.match(prompt, /or push/);
  // Steps stay numbered in order so the protocol reads as one list.
  const steps = [...prompt.matchAll(/^(\d)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6]);
});

test('a model with an output-token limit is told about it as the next protocol step', () => {
  const prompt = buildTaskPrompt('Write a large file.', 8192);
  assert.match(prompt, /^7\. Each of your replies is limited to 8192 output tokens, thinking included\./m);
  assert.match(prompt, /write a\s+large file in several steps/);
  const steps = [...prompt.matchAll(/^(\d)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7]);
  assert.doesNotMatch(buildTaskPrompt('Write a large file.'), /output tokens/, 'no limit configured, no note');
});
