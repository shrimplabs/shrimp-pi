import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, configSearchPaths, detectPi, piVersionTested, resolveConfigPath } from '../src/lib/config.ts';
import { FAKE_PI, NODE, cli, makeRepo, tempDir, writeTask, type Handle } from './helpers.ts';

/** A fake global npm install of Pi: <prefix>/lib/node_modules/<pkg> plus a <prefix>/bin/pi symlink. */
function fakePiInstall(handle: Handle, opts: { version?: string; bundle?: boolean } = {}): { bin: string; root: string; entry: string } {
  const prefix = path.join(handle.dir, 'prefix');
  const root = path.join(prefix, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(path.join(root, 'dist', 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: opts.version ?? '1.5.0' }));
  fs.copyFileSync(FAKE_PI, path.join(root, 'dist', 'cli.js'));
  const entry = path.join(root, 'dist', opts.bundle === false ? 'cli.js' : path.join('bundle', 'cli.js'));
  if (opts.bundle !== false) fs.copyFileSync(FAKE_PI, entry);
  const bin = path.join(prefix, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync('../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js', path.join(bin, 'pi'));
  return { bin, root, entry };
}

test('config lookup: --config, then SHRIMP_PI_CONFIG, then XDG_CONFIG_HOME, then ~/.config', () => {
  const h = tempDir();
  try {
    const home = path.join(h.dir, 'home');
    const xdg = path.join(h.dir, 'xdg');
    const homeConfig = path.join(home, '.config', 'shrimp-pi', 'config.json');
    const xdgConfig = path.join(xdg, 'shrimp-pi', 'config.json');
    const envConfig = path.join(h.dir, 'env.json');
    for (const f of [homeConfig, xdgConfig, envConfig]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{}'); }

    assert.equal(resolveConfigPath('explicit.json', { HOME: home, SHRIMP_PI_CONFIG: envConfig }), path.resolve('explicit.json'));
    assert.equal(resolveConfigPath(undefined, { HOME: home, XDG_CONFIG_HOME: xdg, SHRIMP_PI_CONFIG: envConfig }), envConfig);
    assert.equal(resolveConfigPath(undefined, { HOME: home, XDG_CONFIG_HOME: xdg }), xdgConfig);
    assert.equal(resolveConfigPath(undefined, { HOME: home }), homeConfig);
    // A relative XDG_CONFIG_HOME is invalid per the spec and ignored.
    assert.equal(resolveConfigPath(undefined, { HOME: home, XDG_CONFIG_HOME: 'relative' }), homeConfig);
    assert.deepEqual(configSearchPaths({ HOME: home, SHRIMP_PI_CONFIG: envConfig }), [envConfig, homeConfig]);

    // A SHRIMP_PI_CONFIG that points nowhere is an error, never a silent fallback.
    assert.throws(() => resolveConfigPath(undefined, { HOME: home, SHRIMP_PI_CONFIG: path.join(h.dir, 'missing.json') }), ConfigError);
    fs.rmSync(homeConfig);
    assert.throws(() => resolveConfigPath(undefined, { HOME: home }), /no config found: pass --config/);
  } finally { h.cleanup(); }
});

test('detectPi follows the pi symlink on PATH to the package and prefers the bundle entry', () => {
  const h = tempDir();
  try {
    const { bin, root, entry } = fakePiInstall(h, { version: '1.5.0' });
    const found = detectPi({ PATH: `${path.join(h.dir, 'empty')}:${bin}` });
    assert.ok(found);
    assert.equal(fs.realpathSync(found.command[0]), fs.realpathSync(NODE));
    assert.equal(found.command[1], fs.realpathSync(entry));
    assert.equal(found.packageRoot, fs.realpathSync(root));
    assert.equal(found.version, '1.5.0');
  } finally { h.cleanup(); }
});

test('detectPi pins Node by its PATH entry, not a versioned real path that upgrades remove', () => {
  const h = tempDir();
  try {
    const { bin } = fakePiInstall(h);
    const stable = path.join(h.dir, 'stable-bin');
    fs.mkdirSync(stable);
    fs.symlinkSync(NODE, path.join(stable, 'node'));
    assert.equal(detectPi({ PATH: `${bin}:${stable}` })?.command[0], path.join(stable, 'node'));
    // Without a matching PATH entry the real path is the only safe choice.
    assert.equal(detectPi({ PATH: bin })?.command[0], fs.realpathSync(NODE));
  } finally { h.cleanup(); }
});

test('detectPi falls back to dist/cli.js when an install has no bundle', () => {
  const h = tempDir();
  try {
    const { bin, entry } = fakePiInstall(h, { bundle: false });
    assert.equal(detectPi({ PATH: bin })?.command[1], fs.realpathSync(entry));
  } finally { h.cleanup(); }
});

test('spawn without --config uses SHRIMP_PI_CONFIG, detects Pi, and pins it in the worker snapshot', () => {
  const h = tempDir();
  const stateDir = path.join(h.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    const { repo } = makeRepo(h);
    const task = writeTask(h);
    const { bin, entry } = fakePiInstall(h, { version: '1.4.9' });
    const config = path.join(h.dir, 'portable.json');
    fs.writeFileSync(config, JSON.stringify({ model: 'fake-model', baseUrl: 'http://127.0.0.1:9/v1', sandbox: { mode: 'disabled' } }));
    const env = { PATH: `${bin}:${path.dirname(NODE)}:/usr/bin:/bin`, SHRIMP_PI_CONFIG: config };

    const spawned = cli(['spawn', '--repo', repo, '--task', task, '--no-sandbox'], { stateDir, env });
    assert.equal(spawned.code, 0, spawned.stderr);
    const id = String(spawned.json?.workerId);
    const warnings = spawned.json?.warnings as string[];
    assert.ok(warnings.some((w) => w.includes('detected Pi 1.4.9')), 'an untested Pi version must be surfaced');

    const snapshot = JSON.parse(fs.readFileSync(path.join(String(spawned.json?.workerDir), 'config.json'), 'utf8'));
    assert.equal(fs.realpathSync(snapshot.piCommand[0]), fs.realpathSync(NODE));
    assert.equal(snapshot.piCommand[1], fs.realpathSync(entry));
    assert.equal(snapshot.model, 'fake-model');
    assert.equal(fs.readFileSync(config, 'utf8').includes('piCommand'), false, 'the user config is never rewritten');

    const waited = cli(['wait', id, '--timeout', '20', '--after', '2'], { stateDir, env });
    assert.equal(waited.json?.state, 'REVIEW_REQUIRED', waited.stdout + waited.stderr);
    cli(['stop', id], { stateDir, env });
  } finally { h.cleanup(); }
});

test('spawn without any config explains every place it looked', () => {
  const h = tempDir();
  const stateDir = path.join(h.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    const { repo } = makeRepo(h);
    const result = cli(['spawn', '--repo', repo, '--task', writeTask(h)], { stateDir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no config found: pass --config <file>, set SHRIMP_PI_CONFIG, or create .*\.config\/shrimp-pi\/config\.json/);
  } finally { h.cleanup(); }
});

test('Pi 1.5.x and 1.6.x count as tested; other versions are surfaced', () => {
  for (const v of ['1.5.0', '1.5.2', '1.6.0', '1.6.1']) assert.ok(piVersionTested(v), v);
  for (const v of ['1.4.9', '1.7.0', '1.60.0', '2.0.0']) assert.ok(!piVersionTested(v), v);
});
