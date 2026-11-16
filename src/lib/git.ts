/**
 * Host-side git helpers. The bridge computes diffs itself, with its own hardened git
 * invocations, so review data never depends on what the worker reports. Nothing is ever
 * merged, committed, pushed, or deleted by this module.
 *
 * Hardening (a worker owns the clone's .git/config once it is running, and these commands run
 * in a separate read-only, network-unshared sandbox): every inspection disables external diff, textconv,
 * user attributes, fsmonitor, hooks, the pager, and user/system config, and forbids the ext::
 * transport. Host-side clone/checkout of the supervisor-supplied repository still runs that
 * repository's smudge filters, exactly as any local checkout would; hooks are redirected to an
 * empty directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir, errMessage, which } from './util.ts';
import { buildBwrapArgv } from './sandbox.ts';
import { buildSeatbeltArgv, resolveAppleGit } from './seatbelt.ts';

export class GitError extends Error {}

export type GitResult = { code: number; stdout: string; stderr: string };

let noHooksDir: string | null = null;

function emptyHooksDir(): string {
  if (!noHooksDir) {
    noHooksDir = path.join(os.tmpdir(), `shrimp-pi-no-hooks-${process.getuid?.() ?? 0}`);
    ensureDir(noHooksDir, 0o700);
  }
  return noHooksDir;
}

/** Config overrides that make worker-controlled repositories inert for inspection. */
export function hardeningArgs(): string[] {
  return [
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${emptyHooksDir()}`,
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'core.pager=cat',
    '-c',
    'diff.external=',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'safe.directory=*',
    '-c',
    'status.showUntrackedFiles=all',
  ];
}

function hardeningEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    LANG: 'C',
  };
}

export async function git(
  args: string[],
  cwd?: string,
  opts: { timeoutMs?: number; harden?: boolean; inspection?: boolean } = {},
): Promise<GitResult> {
  const harden = opts.harden !== false;
  const argv = harden ? [...hardeningArgs(), ...args] : args;
  let program = 'git';
  let command = argv;
  let env = hardeningEnv();
  if (opts.inspection) {
    if (!cwd) throw new GitError('Independent inspection requires a workspace');
    // Both native backends isolate executable Git filters from supervisor files and network.
    env = { ...env, HOME: '/nonexistent', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/nonexistent' };
    let wrapped: string[];
    if (process.platform === 'darwin') {
      // Bypass Apple's xcrun shim: it writes a cache even during read-only Git commands.
      const realGit = resolveAppleGit();
      if (!realGit) throw new GitError('Cannot resolve Apple Git with "xcrun --find git"');
      wrapped = buildSeatbeltArgv({ inner: [realGit, ...argv], readOnly: [cwd], writable: [], network: false });
    } else {
      const bwrap = which('bwrap');
      if (process.platform !== 'linux' || !bwrap) throw new GitError('Independent review requires Linux Bubblewrap or macOS Seatbelt; refusing unsandboxed inspection.');
      wrapped = buildBwrapArgv({
        bwrapPath: bwrap, inner: ['/usr/bin/git', ...argv], cwd,
        binds: { writable: [], readOnly: [cwd] }, hostname: 'shrimp-pi-review',
      }).filter((arg) => arg !== '--share-net');
    }
    program = wrapped[0];
    command = wrapped.slice(1);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(program, command, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutDropped = 0;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new GitError(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 16 * 1024 * 1024) stdout += chunk;
      else stdoutDropped += chunk.length;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 256 * 1024) stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new GitError(`failed to run git: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stdoutDropped > 0) {
        stderr = `${stderr}\nwarning: git output exceeded the capture limit, ${stdoutDropped} bytes were dropped`;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export type RepoInfo = {
  repoRoot: string;
  head: string;
  branch: string;
  dirty: boolean;
  dirtyFiles: string[];
};

export async function inspectRepo(repo: string): Promise<RepoInfo> {
  const abs = path.resolve(repo);
  if (!fs.existsSync(abs)) throw new GitError(`repository path does not exist: ${abs}`);
  const inside = await git(['rev-parse', '--is-inside-work-tree'], abs);
  if (inside.code !== 0) throw new GitError(`not a git repository: ${abs} (${inside.stderr.trim()})`);
  const root = await git(['rev-parse', '--show-toplevel'], abs);
  const head = await git(['rev-parse', 'HEAD'], abs);
  if (head.code !== 0) {
    throw new GitError(
      `repository ${abs} has no commits (${head.stderr.trim()}); shrimp-pi needs a committed base, commit something first`,
    );
  }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], abs);
  const status = await git(['status', '--porcelain'], abs);
  const dirtyFiles = status.stdout.split('\n').filter((line) => line.trim().length > 0);
  return {
    repoRoot: root.stdout.trim() || abs,
    head: head.stdout.trim(),
    branch: branch.stdout.trim() || 'HEAD',
    dirty: dirtyFiles.length > 0,
    dirtyFiles: dirtyFiles.slice(0, 50),
  };
}

export async function headCommit(workspace: string): Promise<string | null> {
  const res = await git(['rev-parse', 'HEAD'], workspace, { inspection: true });
  return res.code === 0 ? res.stdout.trim() : null;
}

/**
 * Private workspace: `git clone --no-hardlinks` gives the worker its own object store with no
 * link back to the source repository (a git worktree is deliberately not offered: its `.git`
 * file links into the source repository's admin directory). The clone gets a dedicated branch
 * at the original base commit; the bridge never merges or deletes it.
 */
export async function createCloneWorkspace(opts: {
  repo: string;
  baseCommit: string;
  dest: string;
  branch: string;
}): Promise<{ detail: string; warnings: string[] }> {
  const warnings: string[] = [];
  ensureDir(path.dirname(opts.dest), 0o700);
  const res = await git(['clone', '--no-hardlinks', opts.repo, opts.dest], undefined, { timeoutMs: 600_000 });
  if (res.code !== 0) {
    throw new GitError(`git clone --no-hardlinks ${opts.repo} ${opts.dest} failed: ${res.stderr.trim()}`);
  }
  const checkout = await git(['checkout', '-b', opts.branch, opts.baseCommit], opts.dest, { timeoutMs: 300_000 });
  if (checkout.code !== 0) {
    throw new GitError(`git checkout -b ${opts.branch} ${opts.baseCommit} failed: ${checkout.stderr.trim()}`);
  }
  await git(['config', 'user.name', 'shrimp-pi worker'], opts.dest);
  await git(['config', 'user.email', 'shrimp-pi@localhost'], opts.dest);
  await git(['config', 'commit.gpgsign', 'false'], opts.dest);
  // No origin: the worker cannot push anywhere, and no credential is reachable from the copy.
  const origin = await git(['remote', 'remove', 'origin'], opts.dest);
  if (origin.code !== 0) warnings.push(`could not drop the clone's origin remote: ${origin.stderr.trim()}`);
  return {
    detail: `private clone of ${opts.repo} at ${opts.baseCommit.slice(0, 12)} on branch ${opts.branch} (own object store, no origin remote)`,
    warnings,
  };
}

export async function listCommits(workspace: string, baseCommit: string): Promise<{ sha: string; subject: string }[]> {
  const res = await git(['log', '--format=%H%x09%s', `${baseCommit}..HEAD`], workspace, { inspection: true });
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [sha, subject] = line.split('\t');
      return { sha: sha as string, subject: subject ?? '' };
    });
}

export type DiffResult = {
  patch: string;
  files: string[];
  untracked: string[];
  ignored: string[];
  warnings: string[];
  truncated: boolean;
};

const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

/**
 * Worker commits vs the original base commit, plus uncommitted tracked edits, plus untracked
 * file contents. `--no-index` is used for untracked files so the git index is never touched.
 */
export async function computeDiff(workspace: string, baseCommit: string): Promise<DiffResult> {
  const warnings: string[] = [];
  const files: string[] = [];
  const addFile = (name: string | undefined): void => {
    if (name && !files.includes(name)) files.push(name);
  };

  // Committed changes vs base are invisible to `git status`: read the file list from the diff.
  const nameStatus = await git(
    ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', baseCommit],
    workspace,
    { timeoutMs: 300_000, inspection: true },
  );
  if (nameStatus.code === 0) {
    for (const line of nameStatus.stdout.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = parts[0] ?? '';
      if (status.startsWith('R') || status.startsWith('C')) {
        addFile(parts[1]);
        addFile(parts[2]);
      } else {
        addFile(parts[1]);
      }
    }
  } else {
    throw new GitError(`independent file inspection failed: ${nameStatus.stderr.trim()}`);
  }

  const tracked = await git(
    ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', baseCommit],
    workspace,
    { timeoutMs: 300_000, inspection: true },
  );
  if (tracked.code !== 0) {
    throw new GitError(`independent diff inspection failed: ${tracked.stderr.trim()}`);
  }

  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], workspace, { inspection: true });
  const untracked: string[] = [];
  if (status.code === 0) {
    for (const entry of status.stdout.split('\0').filter((item) => item.length > 2)) {
      const xy = entry.slice(0, 2);
      const file = entry.slice(3);
      if (!file) continue;
      if (xy === '??') untracked.push(file);
      addFile(file);
    }
  } else {
    throw new GitError(`independent status inspection failed: ${status.stderr.trim()}`);
  }

  const ignoredStatus = await git(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all'], workspace, { inspection: true });
  const ignored: string[] = [];
  if (ignoredStatus.code === 0) {
    for (const entry of ignoredStatus.stdout.split('\0').filter((item) => item.length > 2)) {
      if (entry.slice(0, 2) === '!!') ignored.push(entry.slice(3));
    }
  }

  const chunks: string[] = [];
  if (tracked.stdout.trim()) chunks.push(tracked.stdout);
  for (const rel of untracked) {
    const abs = path.join(workspace, rel);
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue;
    }
    if (size > MAX_UNTRACKED_FILE_BYTES) {
      warnings.push(
        `untracked file NOT included in the diff (over ${MAX_UNTRACKED_FILE_BYTES} bytes): ${rel}; inspect it with: git -C ${workspace} status --porcelain`,
      );
      continue;
    }
    // Relative paths keep the patch headers readable (a/<path>) while staying inside the copy.
    const nullDevice = fs.existsSync('/dev/null') ? '/dev/null' : rel;
    const res = await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', '--', nullDevice, rel], workspace, {
      timeoutMs: 120_000, inspection: true,
    });
    if (res.code > 1) {
      warnings.push(`could not diff untracked file ${rel}: ${res.stderr.trim()}`);
      continue;
    }
    if (res.stdout.trim()) chunks.push(res.stdout);
  }
  if (ignored.length > 0) {
    warnings.push(
      `${ignored.length} gitignored path(s) are excluded from the diff by design (example: ${ignored[0]}); they are listed in the review report as ignoredPaths`,
    );
  }

  let patch = chunks.join('');
  let truncated = false;
  if (patch.length > MAX_PATCH_BYTES) {
    truncated = true;
    patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n\n[shrimp-pi] DIFF TRUNCATED: full diff is larger than ${MAX_PATCH_BYTES} bytes\n`;
    warnings.push(
      `DIFF TRUNCATED at ${MAX_PATCH_BYTES} bytes: the patch below is incomplete. Inspect the full change with: git -C ${workspace} diff ${baseCommit}`,
    );
  }
  return { patch, files, untracked, ignored: ignored.slice(0, 200), warnings, truncated };
}
