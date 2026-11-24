/** Shared test helpers: temp repos, temp state dirs, CLI invocation, state polling. */

import fs from 'node:fs';
import { readProcCmdline } from '../src/lib/util.ts';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'src', 'cli.ts');
export const FAKE_PI = path.join(ROOT, 'test', 'fixtures', 'fake-pi.mjs');
export const NODE = process.execPath;

export type Handle = { dir: string; cleanup(): void };

export function tempDir(prefix = 'shrimp-pi-test-'): Handle {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return {
    dir,
    cleanup() {
      // Fake peers in the explicit unsandboxed tests use separate process groups. A killed
      // daemon cannot reap them; end both groups before removing their diagnostic files.
      const workers = path.join(dir, 'state', 'workers');
      try {
        for (const id of fs.readdirSync(workers)) {
          if (!/^[a-f0-9-]{36}$/.test(id)) continue;
          const record = JSON.parse(fs.readFileSync(path.join(workers, id, 'state.json'), 'utf8'));
          for (const pid of [record.daemon?.childPid, record.daemon?.pid]) {
            if (!Number.isInteger(pid) || pid <= 0) continue;
            try {
              const cmd = readProcCmdline(pid) ?? '';
              if (cmd.includes('/test/fixtures/') || (cmd.includes('/src/daemon.ts') && cmd.includes(dir))) {
                killTree(pid);
              }
            } catch { /* already exited, or not visible in this execution context */ }
          }
        }
      } catch { /* a unit-test temporary directory may have no workers */ }
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* leave for the OS to clean */
      }
    },
  };
}

export function git(args: string[], cwd: string): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** A committed repository; the bridge refuses repos without commits. */
export function makeRepo(handle: Handle, opts: { dirty?: boolean } = {}): { repo: string; head: string } {
  const repo = path.join(handle.dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'supervisor@example.invalid'], repo);
  git(['config', 'user.name', 'Supervisor'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo project\n');
  fs.writeFileSync(path.join(repo, 'index.ts'), 'export const value = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'initial commit'], repo);
  if (opts.dirty) {
    fs.writeFileSync(path.join(repo, 'uncommitted.txt'), 'this change is not committed\n');
  }
  return { repo, head: git(['rev-parse', 'HEAD'], repo) };
}

export function writeTask(handle: Handle, text = 'Add a sum() helper and make the tests pass.'): string {
  const file = path.join(handle.dir, 'task.md');
  fs.writeFileSync(file, `${text}\n`);
  return file;
}

export type ConfigOptions = {
  modelOptions?: Record<string, unknown>;
  scenario?: string;
  sandbox?: 'bubblewrap' | 'seatbelt' | 'external' | 'disabled';
  bwrapPath?: string;
  apiKeyEnv?: string;
  envAllowlist?: string[];
  runtimePaths?: string[];
  limits?: Record<string, number>;
  extraPiArgs?: string[];
  launcher?: string[];
};

export function writeConfig(handle: Handle, options: ConfigOptions = {}): string {
  const file = path.join(handle.dir, 'config.json');
  const config: Record<string, unknown> = {
    piCommand: [NODE, FAKE_PI, '--scenario', options.scenario ?? 'ok'],
    provider: 'bridge-local',
    model: 'fake-model',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
    runtimePaths: options.runtimePaths ?? [],
    limits: {
      waitTimeoutSeconds: 20,
      maxWaitSeconds: 60,
      runTimeoutSeconds: 20,
      spawnAckSeconds: 30,
      toolFailureThreshold: 4,
      ...options.limits,
    },
    sandbox: {
      mode: options.sandbox ?? 'disabled',
      ...(options.bwrapPath ? { bwrapPath: options.bwrapPath } : {}),
      ...(options.launcher ? { launcher: options.launcher } : {}),
    },
  };
  if (options.apiKeyEnv) config.apiKeyEnv = options.apiKeyEnv;
  if (options.envAllowlist) config.envAllowlist = options.envAllowlist;
  if (options.extraPiArgs) config.extraPiArgs = options.extraPiArgs;
  if (options.modelOptions) config.modelOptions = options.modelOptions;
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

export type CliResult = { code: number | null; stdout: string; stderr: string; json: Record<string, unknown> | null };

/** Run the CLI exactly like a supervisor would: separate process, JSON on stdout. */
export function cli(
  args: string[],
  opts: { stateDir: string; env?: Record<string, string>; timeoutMs?: number } = { stateDir: '' },
): CliResult {
  const env: Record<string, string> = {
    PATH: `${path.dirname(NODE)}:/usr/bin:/bin`,
    HOME: opts.stateDir ? path.join(opts.stateDir, 'home') : '/tmp',
    SHRIMP_PI_HOME: opts.stateDir,
    LANG: 'C.UTF-8',
    ...(opts.env ?? {}),
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  const res = spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env, timeout: opts.timeoutMs ?? 90_000 });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  let json: Record<string, unknown> | null = null;
  try {
    json = stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { code: res.status, stdout, stderr, json };
}

export function statePath(stateDir: string, workerId: string): string {
  return path.join(stateDir, 'workers', workerId, 'state.json');
}

export function readState(stateDir: string, workerId: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(stateDir, workerId), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function waitFor(
  predicate: () => boolean | string,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const result = predicate();
    if (result === true) return true;
    if (Date.now() - started > timeoutMs) {
      if (typeof result === 'string') throw new Error(`condition not met within ${timeoutMs}ms: ${result}`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForState(
  stateDir: string,
  workerId: string,
  states: string[],
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = 'none';
  while (Date.now() < deadline) {
    const state = readState(stateDir, workerId);
    last = String(state?.state ?? 'missing');
    if (state && states.includes(last)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`worker never reached ${states.join('|')} (last state: ${last})`);
}

export function spawnWorker(
  handle: Handle,
  opts: { repo: string; task: string; config: string; extraArgs?: string[]; env?: Record<string, string> },
): { cli: CliResult; workerId: string; stateDir: string } {
  const stateDir = path.join(handle.dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const result = cli(
    ['spawn', '--repo', opts.repo, '--task', opts.task, '--config', opts.config, '--no-sandbox', ...(opts.extraArgs ?? [])],
    { stateDir, env: opts.env },
  );
  const workerId = String(result.json?.workerId ?? '');
  return { cli: result, workerId, stateDir };
}

export function killTree(pid: number | null | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readSessionPrompts(sessionFile: string): { index: number; text: string; streamingBehavior: string | null }[] {
  let text = '';
  try {
    text = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { type: string; index: number; text: string; streamingBehavior: string | null })
    .filter((entry) => entry.type === 'prompt');
}
