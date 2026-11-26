/**
 * Native worker isolation: Bubblewrap on Linux, Seatbelt on macOS. Both fail closed.
 * An external launcher can be configured, and "disabled" is only honoured with an
 * explicit --no-sandbox flag for a trusted caller.
 *
 * Two deliberate choices:
 *  - Secrets never go into the bwrap command line. `--setenv` values are visible in the
 *    process list, so the sanitized environment is applied to the spawn() call and bwrap
 *    inherits it (no --clearenv/--setenv in the bwrap argv).
 *  - `--dev /dev` builds a fresh minimal devtmpfs instead of --dev-bind, so host device
 *    nodes are not exposed.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSeatbeltArgv, probeSeatbelt } from './seatbelt.ts';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BridgeConfig } from './types.ts';
import { errMessage, nodeDir, pidAlive, which } from './util.ts';

export class SandboxError extends Error {}

export type SandboxBinds = {
  writable: string[];
  readOnly: string[];
  minimalEtc?: boolean;
  /** bind the host Avahi socket so nss-mdns can resolve .local names (opt-in) */
  mdns?: boolean;
};

/** Avahi's client socket, used by nss-mdns (the mdns4_minimal entry in nsswitch.conf). */
export const AVAHI_SOCKET = '/run/avahi-daemon/socket';

export type SandboxStatus = {
  mode: 'bubblewrap' | 'seatbelt' | 'external' | 'disabled';
  detail: string;
  warnings: string[];
};

export type WrappedCommand = {
  argv: string[];
  cwd: string;
  /** environment for spawn(); bwrap inherits it and passes it to the inner command */
  env: Record<string, string>;
  mode: 'bubblewrap' | 'seatbelt' | 'external' | 'disabled';
  detail: string;
  warnings: string[];
};

const probeCache = new Map<string, { ok: boolean; detail: string }>();

export function detectBwrap(bwrapPath: string): { available: boolean; path: string | null; detail: string } {
  const resolved = which(bwrapPath);
  if (!resolved) {
    return { available: false, path: null, detail: `bubblewrap not found (looked for "${bwrapPath}" on PATH)` };
  }
  const version = spawnSync(resolved, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (version.status !== 0) {
    return {
      available: false,
      path: resolved,
      detail: `${resolved} --version failed: ${version.stderr || version.error?.message || 'unknown error'}`,
    };
  }
  return { available: true, path: resolved, detail: version.stdout.trim() || resolved };
}

/**
 * Real startup probe. A present bwrap binary is not enough: unprivileged user namespaces can
 * be disabled at runtime, which only shows up when a sandbox is actually created.
 */
export function probeBwrap(bwrapPath: string, binds: SandboxBinds): { ok: boolean; detail: string } {
  const detected = detectBwrap(bwrapPath);
  if (!detected.available) return { ok: false, detail: detected.detail };
  const readOnly = Array.from(new Set([...binds.readOnly, nodeDir()]));
  const cacheKey = `${detected.path}|${readOnly.join(',')}|${binds.minimalEtc === true}`;
  const cached = probeCache.get(cacheKey);
  if (cached) return cached;
  const argv = buildBwrapArgv({
    bwrapPath: detected.path as string,
    inner: [process.execPath, '--version'],
    cwd: '/',
    binds: { writable: [], readOnly, minimalEtc: true },
    hostname: 'shrimp-pi-probe',
  });
  const probe = spawnSync(argv[0] as string, argv.slice(1), {
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: '/usr/bin:/bin:/usr/local/bin' },
  });
  const ok = probe.status === 0;
  const detail = ok
    ? `${detected.detail}; startup probe ok (node ${String(probe.stdout || '').trim()})`
    : `${detected.path} present but startup probe failed: ${String(probe.stderr || probe.error?.message || 'unknown error').trim()}`;
  const result = { ok, detail };
  probeCache.set(cacheKey, result);
  return result;
}

export function checkSandbox(
  config: BridgeConfig,
  opts: { allowDisabled: boolean; binds: SandboxBinds },
): SandboxStatus {
  const warnings: string[] = [];
  const mode = config.sandbox.mode;
  if (mode === 'disabled') {
    if (!opts.allowDisabled) {
      throw new SandboxError(
        'config requests sandbox.mode "disabled" but that requires the explicit --no-sandbox flag (trusted callers only); refusing to start an unsandboxed worker',
      );
    }
    warnings.push(
      "SANDBOX DISABLED: the Pi child runs with the supervisor's filesystem visibility. Only use this for trusted callers.",
    );
    return { mode: 'disabled', detail: 'no sandbox wrapper (explicit --no-sandbox)', warnings };
  }
  if (mode === 'external') {
    const launcher = config.sandbox.launcher;
    if (!launcher || launcher.length === 0) throw new SandboxError('sandbox.mode "external" requires sandbox.launcher');
    const head = which(launcher[0] as string);
    if (!head) throw new SandboxError(`sandbox.launcher program "${launcher[0]}" not found on PATH`);
    warnings.push(
      `sandbox is provided by external launcher ${launcher.join(' ')}; the bridge does not verify what it isolates`,
    );
    return { mode: 'external', detail: `external launcher: ${launcher.join(' ')}`, warnings };
  }
  if (mode === 'seatbelt') {
    const probe = probeSeatbelt(config.sandbox.sandboxExecPath, config.runtimePaths);
    if (!probe.ok) throw new SandboxError(probe.detail + '; refusing to run unsandboxed');
    return { mode: 'seatbelt', detail: probe.detail, warnings: ['Seatbelt sandbox-exec is deprecated by Apple; availability is checked at startup.'] };
  }
  if (process.platform !== 'linux') {
    throw new SandboxError(
      `bubblewrap sandboxing is only supported on linux (platform ${process.platform}); configure sandbox.mode "external" with a sandbox.launcher, or pass --no-sandbox for a trusted caller. The bridge never falls back to unsandboxed silently.`,
    );
  }
  const probe = probeBwrap(config.sandbox.bwrapPath, opts.binds);
  if (!probe.ok) {
    throw new SandboxError(`bubblewrap unavailable, refusing to start unsandboxed: ${probe.detail}`);
  }
  return { mode: 'bubblewrap', detail: probe.detail, warnings };
}

function bindArgsForSystemPath(target: string): string[] {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) {
    // merged-usr: /lib -> usr/lib and friends must exist as symlinks inside the sandbox.
    return ['--symlink', fs.readlinkSync(target), target];
  }
  return ['--ro-bind-try', target, target];
}

const MINIMAL_ETC = [
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/nsswitch.conf',
  '/etc/passwd',
  '/etc/group',
  '/etc/localtime',
  '/etc/timezone',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/pki',
  '/etc/crypto-policies',
];

export function buildBwrapArgv(opts: {
  bwrapPath: string;
  inner: string[];
  cwd: string;
  binds: SandboxBinds & { minimalEtc?: boolean };
  hostname: string;
}): string[] {
  const argv: string[] = [opts.bwrapPath];
  // Everything is isolated except the network, because the worker must reach its inference
  // endpoint. Network egress is NOT restricted (documented limitation).
  argv.push('--unshare-all', '--unshare-user', '--share-net');
  argv.push('--disable-userns');
  argv.push('--die-with-parent'); // parent-death strategy: if the daemon dies, the child dies
  argv.push('--new-session');
  argv.push('--hostname', opts.hostname);
  // No --clearenv/--setenv: the endpoint key must never appear in the process list. The
  // sanitized environment is applied to spawn() and inherited here.
  argv.push('--dev', '/dev');
  argv.push('--proc', '/proc');
  argv.push('--tmpfs', '/tmp');

  argv.push(...bindArgsForSystemPath('/usr'));
  for (const alias of ['/bin', '/lib', '/lib64', '/sbin']) argv.push(...bindArgsForSystemPath(alias));
  if (opts.binds.minimalEtc === false) {
    argv.push('--ro-bind-try', '/etc', '/etc');
  } else {
    for (const entry of MINIMAL_ETC) argv.push('--ro-bind-try', entry, entry);
  }
  argv.push('--dir', '/run');
  // Read-only is enough: connect() on a socket is not refused by a read-only mount.
  if (opts.binds.mdns === true) argv.push('--ro-bind-try', AVAHI_SOCKET, AVAHI_SOCKET);
  argv.push('--dir', '/mnt');
  argv.push('--dir', '/media');

  for (const target of opts.binds.readOnly) argv.push('--ro-bind-try', target, target);
  for (const target of opts.binds.writable) argv.push('--bind', target, target);

  argv.push('--chdir', opts.cwd);
  argv.push('--');
  argv.push(...opts.inner);
  return argv;
}

/** Compose the exact child command line: sandbox wrapper (if any) around the Pi argv. */
export function wrapCommand(opts: {
  config: BridgeConfig;
  inner: string[];
  cwd: string;
  env: Record<string, string>;
  binds: SandboxBinds;
  status: SandboxStatus;
  hostname: string;
}): WrappedCommand {
  const { config, status } = opts;
  if (status.mode === 'disabled') {
    return { argv: opts.inner, cwd: opts.cwd, env: opts.env, mode: 'disabled', detail: status.detail, warnings: status.warnings };
  }
  if (status.mode === 'external') {
    const launcher = config.sandbox.launcher as string[];
    return {
      argv: [...launcher, ...opts.inner],
      cwd: opts.cwd,
      env: opts.env,
      mode: 'external',
      detail: status.detail,
      warnings: status.warnings,
    };
  }
  if (status.mode === 'seatbelt') {
    const inner = buildSeatbeltArgv({
      executable: config.sandbox.sandboxExecPath, inner: opts.inner,
      readOnly: [...config.runtimePaths, ...config.sandbox.extraRoBinds],
      writable: opts.binds.writable, network: true,
    });
    return {
      argv: [process.execPath, fileURLToPath(new URL('./group-guard.ts', import.meta.url)), String(process.pid), ...inner],
      cwd: opts.cwd, env: opts.env, mode: 'seatbelt', detail: status.detail,
      warnings: [...status.warnings, 'Outbound IP network access is unrestricted; Unix sockets and other host files remain denied.'],
    };
  }
  const detected = detectBwrap(config.sandbox.bwrapPath);
  const readOnly = Array.from(
    new Set([
      ...config.runtimePaths,
      ...config.sandbox.extraRoBinds,
      path.dirname(fs.realpathSync(process.execPath)),
    ]),
  );
  const argv = buildBwrapArgv({
    bwrapPath: (detected.path ?? config.sandbox.bwrapPath) as string,
    inner: opts.inner,
    cwd: opts.cwd,
    binds: { writable: opts.binds.writable, readOnly, minimalEtc: config.sandbox.minimalEtc, mdns: config.sandbox.mdns },
    hostname: opts.hostname,
  });
  return {
    argv,
    cwd: opts.cwd,
    env: opts.env,
    mode: 'bubblewrap',
    detail: status.detail,
    warnings: [
      ...status.warnings,
      `network is not restricted inside the bubblewrap sandbox (shared network namespace is required to reach ${config.baseUrl})`,
    ],
  };
}

export function defaultBinds(paths: { workspace: string; agentDir: string; homeDir: string; tmpDir?: string }): SandboxBinds {
  // Writable: only the isolated workspace copy, the worker's own PI_CODING_AGENT_DIR (session
  // data) and its HOME. The state directory (socket, logs, config) and the source repository
  // are not visible at all.
  return { writable: [paths.workspace, paths.agentDir, paths.homeDir, ...(paths.tmpDir ? [paths.tmpDir] : [])], readOnly: [] };
}

export function describeSandboxError(err: unknown): string {
  return errMessage(err);
}

export function safeKillTargets(pids: (number | null | undefined)[]): number[] {
  return pids.filter((pid): pid is number => typeof pid === 'number' && pidAlive(pid));
}
