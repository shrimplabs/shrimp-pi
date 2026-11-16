/**
 * Real bubblewrap behaviour. Skipped automatically when bubblewrap or unprivileged user
 * namespaces are unavailable, so the suite still runs on restricted hosts; the fail-closed
 * behaviour itself is covered in unit.test.ts.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { NODE, cli, git, killTree, makeRepo, tempDir, waitForState, writeConfig, writeTask, type Handle } from './helpers.ts';
import { computeDiff } from '../src/lib/git.ts';
import { detectBwrap, probeBwrap, wrapCommand } from '../src/lib/sandbox.ts';
import { loadConfig } from '../src/lib/config.ts';

const handles: Handle[] = [];
after(() => {
  for (const handle of handles) handle.cleanup();
});

const detected = detectBwrap('bwrap');
const probe = detected.available ? probeBwrap('bwrap', { writable: [], readOnly: [] }) : { ok: false, detail: detected.detail };
const reason = probe.ok ? undefined : `bubblewrap unavailable: ${probe.detail}`;
const OUTER_HOME = process.env.HOME ?? '/root';

function insideSandbox(script: string, handle: Handle, binds: { writable: string[]; readOnly: string[] }, env: Record<string, string>): { code: number | null; out: string; err: string } {
  const { config } = loadConfig(writeConfig(handle, { scenario: 'ok', sandbox: 'bubblewrap' }));
  const wrapped = wrapCommand({
    config,
    inner: [NODE, '-e', script],
    cwd: binds.writable[0] as string,
    env: { PATH: `${path.dirname(NODE)}:/usr/bin:/bin`, HOME: binds.writable[2] as string, ...env },
    binds,
    status: { mode: 'bubblewrap', detail: 'probe ok', warnings: [] },
    hostname: 'shrimp-pi-test',
  });
  const result = spawnSync(wrapped.argv[0] as string, wrapped.argv.slice(1), {
    encoding: 'utf8',
    env: wrapped.env,
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
}

test(
  'a sandboxed process sees node, its own workspace and nothing of the source repository',
  { skip: reason },
  () => {
    const handle = tempDir('shrimp-pi-bwrap-');
    handles.push(handle);
    const { repo } = makeRepo(handle);
    const workspace = path.join(handle.dir, 'workspace');
    const agentDir = path.join(handle.dir, 'agent');
    const home = path.join(handle.dir, 'home');
    const stateDir = path.join(handle.dir, 'state');
    for (const dir of [workspace, agentDir, home, stateDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(repo, 'secret-source.txt'), 'source repository contents\n');
    const supervisorPrivate = path.join(handle.dir, 'supervisor-private.txt');
    fs.writeFileSync(supervisorPrivate, 'must remain outside the sandbox');
    fs.writeFileSync(path.join(stateDir, 'daemon.sock'), 'not a socket, just a marker\n');

    const script = `
      const fs = require('fs');
      const out = {
        node: process.version,
        workspaceWritable: (() => { try { fs.writeFileSync(${JSON.stringify(path.join(workspace, 'from-sandbox.txt'))}, 'written', { mode: 0o600 }); return true; } catch { return false; } })(),
        agentWritable: (() => { try { fs.writeFileSync(${JSON.stringify(path.join(agentDir, 'session.jsonl'))}, '{}\\n', { mode: 0o600 }); return true; } catch { return false; } })(),
        sourceVisible: fs.existsSync(${JSON.stringify(repo)}),
        sourceSecretReadable: (() => { try { return fs.readFileSync(${JSON.stringify(path.join(repo, 'secret-source.txt'))}, 'utf8'); } catch { return null; } })(),
        stateVisible: fs.existsSync(${JSON.stringify(path.join(stateDir, 'daemon.sock'))}),
        homeIsolated: process.env.HOME === ${JSON.stringify(home)},
        hostCredentialsReadable: (() => { try { return fs.readFileSync(${JSON.stringify(path.join(OUTER_HOME, '.pi', 'agent', 'auth.json'))}, 'utf8'); } catch { return null; } })(),
        supervisorPrivateReadable: (() => { try { return fs.readFileSync(${JSON.stringify(supervisorPrivate)}, 'utf8'); } catch { return null; } })(),
        etcHosts: fs.existsSync('/etc/hosts'),
        hostname: require('os').hostname(),
        secret: process.env.SANDBOX_SECRET === 'visible-inside',
        devNodes: fs.readdirSync('/dev').includes('null'),
        procVisible: fs.existsSync('/proc/self/status'),
        cwd: process.cwd(),
      };
      process.stdout.write(JSON.stringify(out));
    `;
    const result = insideSandbox(
      script,
      handle,
      { writable: [workspace, agentDir, home], readOnly: [] },
      { SANDBOX_SECRET: 'visible-inside' },
    );
    assert.equal(result.code, 0, `sandbox run failed: ${result.err}`);
    const seen = JSON.parse(result.out) as Record<string, unknown>;
    assert.equal(seen.sourceVisible, false, 'the source repository must not be visible at all');
    assert.equal(seen.sourceSecretReadable, null);
    assert.equal(seen.stateVisible, false, 'the worker must not see the socket, logs or config');
    assert.equal(seen.workspaceWritable, true);
    assert.equal(seen.agentWritable, true, 'the session file must be writable inside the sandbox');
    assert.equal(seen.homeIsolated, true);
    // Runtime mounts below the host home may create visible ancestor directories. Those
    // empty ancestors are harmless; actual private contents must remain inaccessible.
    assert.equal(seen.hostCredentialsReadable, null, 'personal Pi credentials must be hidden');
    assert.equal(seen.supervisorPrivateReadable, null, 'unmounted supervisor files must be hidden');
    assert.equal(seen.etcHosts, true, 'DNS/certificate files are needed for inference');
    assert.equal(seen.hostname, 'shrimp-pi-test');
    assert.equal(seen.secret, true, 'the sanitized environment reaches the child without appearing in argv');
    assert.equal(seen.devNodes, true);
    assert.equal(seen.procVisible, true);
    assert.ok(String(seen.cwd) === workspace);
    assert.ok(fs.existsSync(path.join(workspace, 'from-sandbox.txt')));
    assert.ok(!fs.existsSync(path.join(repo, 'from-sandbox.txt')));
  },
);

test(
  'a sandboxed worker cannot write the source repository even if it tries',
  { skip: reason },
  () => {
    const handle = tempDir('shrimp-pi-bwrap-');
    handles.push(handle);
    const { repo } = makeRepo(handle);
    const workspace = path.join(handle.dir, 'workspace');
    const agentDir = path.join(handle.dir, 'agent');
    const home = path.join(handle.dir, 'home');
    for (const dir of [workspace, agentDir, home]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const script = `
      const fs = require('fs');
      const { spawnSync } = require('child_process');
      let write = 'unknown';
      try { fs.writeFileSync(${JSON.stringify(path.join(repo, 'pwned.txt'))}, 'nope'); write = 'wrote'; }
      catch (err) { write = 'refused:' + err.code; }
      const git = spawnSync('git', ['-C', ${JSON.stringify(repo)}, 'status', '--porcelain'], { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({ write, gitCode: git.status, gitOut: (git.stdout || '').trim(), gitErr: (git.stderr || '').slice(0, 120) }));
    `;
    const result = insideSandbox(script, handle, { writable: [workspace, agentDir, home], readOnly: [] }, {});
    assert.equal(result.code, 0, result.err);
    const seen = JSON.parse(result.out) as Record<string, unknown>;
    assert.match(String(seen.write), /refused/, `writing the source repo must fail, saw ${String(seen.write)}`);
    assert.ok(!fs.existsSync(path.join(repo, 'pwned.txt')));
    assert.notEqual(seen.gitCode, 0, 'the source repository is not even reachable for git');
  },
);

test(
  'a real worker runs end to end inside bubblewrap',
  { skip: reason },
  async () => {
    const handle = tempDir('shrimp-pi-bwrap-');
    handles.push(handle);
    const { repo } = makeRepo(handle);
    const task = writeTask(handle);
    const config = writeConfig(handle, { scenario: 'ok', sandbox: 'bubblewrap', extraPiArgs: ['--touch', 'sandbox-note.txt'] });
    const stateDir = path.join(handle.dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const spawned = cli(['spawn', '--repo', repo, '--task', task, '--config', config], { stateDir });
    assert.equal(spawned.code, 0, `spawn failed: ${spawned.stderr}`);
    const workerId = String(spawned.json?.workerId);
    assert.equal((spawned.json?.sandbox as Record<string, unknown>)?.mode, 'bubblewrap');
    const state = await waitForState(stateDir, workerId, ['REVIEW_REQUIRED', 'BLOCKED', 'FAILED'], 60_000);
    assert.equal(state.state, 'REVIEW_REQUIRED', JSON.stringify(state.attention));
    const workspace = String(state.workspaceDir);
    assert.ok(fs.existsSync(path.join(workspace, 'sandbox-note.txt')), 'the agent wrote inside the sandbox');
    assert.ok(!fs.existsSync(path.join(repo, 'sandbox-note.txt')));
    const reviewed = cli(['review', workerId], { stateDir });
    assert.equal(reviewed.code, 0, reviewed.stderr);
    assert.ok((reviewed.json?.untrackedFiles as string[]).includes('sandbox-note.txt'));
    const stopped = cli(['stop', workerId], { stateDir, timeoutMs: 60_000 });
    assert.equal(stopped.code, 0, stopped.stderr);
    killTree(Number((spawned.json?.daemonPid as number) ?? null));
  },
);

test('review never grants worker-configured Git filters supervisor filesystem access', { skip: reason }, async () => {
  const handle = tempDir('shrimp-pi-filter-');
  handles.push(handle);
  const { repo, head } = makeRepo(handle);
  const marker = path.join(handle.dir, 'filter-ran-on-host');
  fs.writeFileSync(path.join(repo, 'index.ts'), 'export const value = 2;\n');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.ts filter=probe\n');
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.ts filter=probe\n');
  git(['config', 'filter.probe.clean', `touch '${marker}'; cat`], repo);
  const diff = await computeDiff(repo, head);
  assert.ok(diff.files.includes('index.ts'));
  assert.equal(fs.existsSync(marker), false, 'Git filter execution must stay inside the read-only inspection sandbox');
  assert.equal(fs.readFileSync(path.join(repo, 'index.ts'), 'utf8'), 'export const value = 2;\n');
});
