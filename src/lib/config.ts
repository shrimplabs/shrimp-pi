/**
 * User-supplied bridge config: how to start Pi, which isolated model endpoint to expose,
 * what the sandbox may see, and which limits apply. No personal credentials, extensions or
 * settings are ever read: the worker gets a generated, isolated agent directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BridgeConfig } from './types.ts';
import { errMessage, nodeDir, realPathOrSelf } from './util.ts';
import { resolveAppleGit } from './seatbelt.ts';

export class ConfigError extends Error {}

const DEFAULTS = {
  provider: 'bridge-local',
  api: 'openai-completions',
  runtimePaths: [] as string[],
  extraPiArgs: [] as string[],
  envAllowlist: [] as string[],
  noContextFiles: false,
  thinkingLevel: null as string | null,
};

/** Names that may be inherited from the supervisor environment, by name only. */
export const BASE_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
];

function isObj(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function reqStringArray(value: unknown, field: string, file: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || !v)) {
    throw new ConfigError(`${file}: ${field} must be a non-empty array of strings (example: ["/opt/node/bin/node","/opt/pi/.../dist/bundle/cli.js"])`);
  }
  return value as string[];
}

function optString(value: unknown, field: string, file: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value) throw new ConfigError(`${file}: ${field} must be a non-empty string`);
  return value;
}

function optStringArray(value: unknown, field: string, file: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) {
    throw new ConfigError(`${file}: ${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function optNumber(value: unknown, field: string, file: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ConfigError(`${file}: ${field} must be a number`);
  if (n < min || n > max) throw new ConfigError(`${file}: ${field} must be between ${min} and ${max}`);
  return Math.trunc(n);
}

/** Where `spawn` looks for a config when --config is not given, in order. */
export function configSearchPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.SHRIMP_PI_CONFIG) out.push(path.resolve(env.SHRIMP_PI_CONFIG));
  const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : null;
  const home = env.HOME || os.homedir();
  out.push(path.join(xdg ?? path.join(home, '.config'), 'shrimp-pi', 'config.json'));
  return out;
}

/**
 * Resolve the config file: an explicit --config wins; otherwise $SHRIMP_PI_CONFIG (which must
 * exist when set), otherwise $XDG_CONFIG_HOME/shrimp-pi/config.json (~/.config/... by default).
 */
export function resolveConfigPath(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit) return path.resolve(explicit);
  if (env.SHRIMP_PI_CONFIG) {
    const file = path.resolve(env.SHRIMP_PI_CONFIG);
    if (!fs.existsSync(file)) throw new ConfigError(`SHRIMP_PI_CONFIG points to ${file}, which does not exist`);
    return file;
  }
  const [fallback] = configSearchPaths({ ...env, SHRIMP_PI_CONFIG: undefined });
  if (fs.existsSync(fallback)) return fallback;
  throw new ConfigError(`no config found: pass --config <file>, set SHRIMP_PI_CONFIG, or create ${fallback} (see examples/config.json)`);
}

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * The running Node as reached through PATH (e.g. /opt/homebrew/bin/node) rather than its
 * versioned real path (/opt/homebrew/Cellar/node/26.5.1/bin/node), so a pinned piCommand
 * survives package-manager upgrades. Falls back to the real path when PATH has no match.
 */
function stableNodePath(env: NodeJS.ProcessEnv): string {
  const real = fs.realpathSync(process.execPath);
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    const candidate = path.join(dir, 'node');
    try { if (fs.realpathSync(candidate) === real) return candidate; } catch { /* not here */ }
  }
  return real;
}

export type DetectedPi = { command: string[]; packageRoot: string; version: string | null };

function piPackageRoot(start: string): string | null {
  for (let dir = start; ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg?.name === PI_PACKAGE) return dir;
    } catch { /* keep walking up */ }
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Find an installed Pi when the config has no piCommand: the `pi` executable on PATH, then the
 * global node_modules next to the running Node. Pi is started with the bridge's own Node and
 * its self-contained bundle entry point, so the result does not depend on the shell's PATH.
 */
export function detectPi(env: NodeJS.ProcessEnv = process.env): DetectedPi | null {
  const roots: string[] = [];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    const candidate = path.join(dir, 'pi');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const root = piPackageRoot(path.dirname(fs.realpathSync(candidate)));
      if (root) roots.push(root);
    } catch { /* not here */ }
  }
  const prefix = path.dirname(nodeDir());
  roots.push(path.join(prefix, 'lib', 'node_modules', PI_PACKAGE));
  for (const root of roots) {
    const entry = [path.join(root, 'dist', 'bundle', 'cli.js'), path.join(root, 'dist', 'cli.js')].find((f) => fs.existsSync(f));
    if (!entry) continue;
    let version: string | null = null;
    try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? null; } catch { /* unknown */ }
    return { command: [stableNodePath(env), fs.realpathSync(entry)], packageRoot: fs.realpathSync(root), version };
  }
  return null;
}

export type LoadedConfig = {
  config: BridgeConfig;
  warnings: string[];
  sourcePath: string;
  /** Set when piCommand was absent and Pi was found automatically. */
  detectedPi: DetectedPi | null;
};

export function loadConfig(file: string): LoadedConfig {
  const sourcePath = path.resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch (err: unknown) {
    throw new ConfigError(`cannot read config ${sourcePath}: ${errMessage(err)}`);
  }
  if (!isObj(raw)) throw new ConfigError(`${sourcePath}: config must be a JSON object`);
  const warnings: string[] = [];
  let detectedPi: DetectedPi | null = null;
  let piCommand: string[];
  if ((raw.piCommand ?? raw.pi_command) === undefined) {
    detectedPi = detectPi();
    if (!detectedPi) {
      throw new ConfigError(`${sourcePath}: no piCommand set and no Pi installation found (looked for "pi" on PATH and ${PI_PACKAGE} next to ${process.execPath}); install it with "npm install -g ${PI_PACKAGE}@1.5.0" or set piCommand`);
    }
    piCommand = detectedPi.command;
    if (detectedPi.version && !detectedPi.version.startsWith('1.5.')) {
      warnings.push(`detected Pi ${detectedPi.version} at ${detectedPi.packageRoot}; shrimp-pi is tested with Pi 1.5.x`);
    }
  } else {
    piCommand = reqStringArray(raw.piCommand ?? raw.pi_command, 'piCommand', sourcePath);
  }
  const model = optString(raw.model, 'model', sourcePath);
  if (!model) throw new ConfigError(`${sourcePath}: model is required (model id sent to the endpoint)`);
  const provider = optString(raw.provider, 'provider', sourcePath) ?? DEFAULTS.provider;
  const api = optString(raw.api, 'api', sourcePath) ?? DEFAULTS.api;
  const baseUrl = optString(raw.baseUrl ?? raw.base_url, 'baseUrl', sourcePath);
  const apiKeyEnv = optString(raw.apiKeyEnv ?? raw.api_key_env, 'apiKeyEnv', sourcePath) ?? null;
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    throw new ConfigError(`${sourcePath}: baseUrl must be an http(s) URL`);
  }
  const modelOptions = isObj(raw.modelOptions ?? raw.model_options) ? (raw.modelOptions ?? raw.model_options) as Record<string, unknown> : {};

  const sandboxRaw = isObj(raw.sandbox) ? raw.sandbox : {};
  const sandboxModeRaw = optString(sandboxRaw.mode, 'sandbox.mode', sourcePath) ?? (process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap');
  if (sandboxModeRaw !== 'bubblewrap' && sandboxModeRaw !== 'seatbelt' && sandboxModeRaw !== 'external' && sandboxModeRaw !== 'disabled') {
    throw new ConfigError(`${sourcePath}: sandbox.mode must be "bubblewrap", "seatbelt", "external" or "disabled"`);
  }
  const launcher = sandboxRaw.launcher === undefined || sandboxRaw.launcher === null
    ? null
    : reqStringArray(sandboxRaw.launcher, 'sandbox.launcher', sourcePath);
  if (sandboxModeRaw === 'external' && !launcher) {
    throw new ConfigError(`${sourcePath}: sandbox.mode "external" requires sandbox.launcher (argv array that execs its arguments)`);
  }

  const limitsRaw = isObj(raw.limits) ? raw.limits : {};
  if (raw.workspaceMode !== undefined || raw.workspace_mode !== undefined) {
    warnings.push(`${sourcePath}: workspaceMode is ignored; the bridge always uses a private "git clone --no-hardlinks" workspace (a git worktree would keep a writable link into the source repository's admin directory)`);
  }

  if (apiKeyEnv && !process.env[apiKeyEnv]) {
    warnings.push(`config names apiKeyEnv "${apiKeyEnv}" but it is not set in the supervisor environment; the worker will fail provider calls until it is exported`);
  }

  const runtimePaths = optStringArray(raw.runtimePaths ?? raw.runtime_paths, 'runtimePaths', sourcePath).map((p) => realPathOrSelf(p));
  for (const entry of piCommand) {
    if (entry.includes('/')) runtimePaths.push(realPathOrSelf(path.dirname(entry)));
  }
  runtimePaths.push(nodeDir());
  if (detectedPi) runtimePaths.push(detectedPi.packageRoot);

  const config: BridgeConfig = {
    piCommand,
    provider,
    model,
    api,
    baseUrl: baseUrl ?? 'http://127.0.0.1:1/v1',
    apiKeyEnv,
    modelOptions,
    runtimePaths: Array.from(new Set(runtimePaths)),
    extraPiArgs: optStringArray(raw.extraPiArgs ?? raw.extra_pi_args, 'extraPiArgs', sourcePath),
    envAllowlist: optStringArray(raw.envAllowlist ?? raw.env_allowlist, 'envAllowlist', sourcePath),
    noContextFiles: raw.noContextFiles === true,
    thinkingLevel: optString(raw.thinkingLevel ?? raw.thinking_level, 'thinkingLevel', sourcePath) ?? null,
    sandbox: {
      mode: sandboxModeRaw,
      sandboxExecPath: optString(sandboxRaw.sandboxExecPath, 'sandbox.sandboxExecPath', sourcePath) ?? '/usr/bin/sandbox-exec',
      bwrapPath: optString(sandboxRaw.bwrapPath ?? sandboxRaw.bwrap_path, 'sandbox.bwrapPath', sourcePath) ?? 'bwrap',
      launcher,
      extraRoBinds: optStringArray(sandboxRaw.extraRoBinds ?? sandboxRaw.extra_ro_binds, 'sandbox.extraRoBinds', sourcePath).map((p) => realPathOrSelf(p)),
      extraWritableBinds: optStringArray(sandboxRaw.extraWritableBinds ?? sandboxRaw.extra_writable_binds, 'sandbox.extraWritableBinds', sourcePath).map((p) => realPathOrSelf(p)),
      // Minimal /etc (DNS, certificates, passwd) is the default; set minimalEtc false to
      // expose the whole /etc read-only.
      minimalEtc: sandboxRaw.minimalEtc !== false,
    },
    limits: {
      toolFailureThreshold: optNumber(limitsRaw.toolFailureThreshold, 'limits.toolFailureThreshold', sourcePath, 1, 1000) ?? 5,
      waitTimeoutSeconds: optNumber(limitsRaw.waitTimeoutSeconds, 'limits.waitTimeoutSeconds', sourcePath, 1, 86_400) ?? 300,
      maxWaitSeconds: optNumber(limitsRaw.maxWaitSeconds, 'limits.maxWaitSeconds', sourcePath, 1, 86_400) ?? 3600,
      runTimeoutSeconds: optNumber(limitsRaw.runTimeoutSeconds, 'limits.runTimeoutSeconds', sourcePath, 5, 86_400) ?? 1800,
      spawnAckSeconds: optNumber(limitsRaw.spawnAckSeconds, 'limits.spawnAckSeconds', sourcePath, 1, 600) ?? 60,
      maxEvidence: optNumber(limitsRaw.maxEvidence, 'limits.maxEvidence', sourcePath, 10, 5000) ?? 200,
      maxEvents: optNumber(limitsRaw.maxEvents, 'limits.maxEvents', sourcePath, 10, 5000) ?? 100,
    },
  };
  return { config, warnings, sourcePath, detectedPi };
}

/**
 * Environment the detached daemon needs. Values are read from the supervisor environment by
 * name (never persisted): without this, the endpoint key named in the config would be lost
 * when the CLI process exits, because the daemon is a detached child.
 */
export function daemonForwardEnv(config: BridgeConfig): Record<string, string> {
  const names = [...BASE_ENV_ALLOWLIST, ...config.envAllowlist, ...(config.apiKeyEnv ? [config.apiKeyEnv] : [])];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) out[name] = value;
  }
  return out;
}

/** models.json for the worker's isolated PI_CODING_AGENT_DIR. Never touches ~/.pi. */
export function buildModelsJson(config: BridgeConfig): string {
  const provider: Record<string, unknown> = {
    baseUrl: config.baseUrl,
    api: config.api,
    apiKey: config.apiKeyEnv ? `$${config.apiKeyEnv}` : 'shrimp-pi-no-auth',
    models: [{ id: config.model, ...config.modelOptions }],
  };
  const doc = { providers: { [config.provider]: provider } };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export type PiLaunch = {
  /** program + args, without any sandbox wrapper */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};

export function buildPiArgv(
  config: BridgeConfig,
  opts: { sessionFile: string; cwd: string },
): string[] {
  const argv = [
    ...config.piCommand,
    '--mode',
    'rpc',
    '--session',
    opts.sessionFile,
    '--provider',
    config.provider,
    '--model',
    config.model,
    '--no-extensions',
    '--no-mcp',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-approve',
    '--offline',
  ];
  if (config.thinkingLevel) argv.push('--thinking', config.thinkingLevel);
  if (config.noContextFiles) argv.push('--no-context-files');
  argv.push(...config.extraPiArgs);
  return argv;
}

/**
 * Minimal environment. Nothing is inherited unless its name is allowlisted, and the only
 * secret that may be copied is the endpoint key the config explicitly names.
 */
export function buildChildEnv(
  config: BridgeConfig,
  opts: { homeDir: string; agentDir: string; tmpDir?: string; pathExtra?: string[] },
): Record<string, string> {
  const allow = new Set([...BASE_ENV_ALLOWLIST, ...config.envAllowlist, ...(config.apiKeyEnv ? [config.apiKeyEnv] : [])]);
  const env: Record<string, string> = {};
  for (const name of allow) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  }
  // On macOS the real Git directory goes ahead of /usr/bin so workers bypass the xcrun shim.
  const appleGit = resolveAppleGit();
  const pathDirs = [nodeDir(), ...(opts.pathExtra ?? []), ...(appleGit ? [path.dirname(appleGit)] : []), '/usr/bin', '/bin', '/usr/local/bin'];
  env.PATH = Array.from(new Set(pathDirs.filter(Boolean))).join(':');
  env.TMPDIR = opts.tmpDir ?? opts.homeDir;
  env.HOME = opts.homeDir;
  env.PI_CODING_AGENT_DIR = opts.agentDir;
  env.PI_OFFLINE = '1';
  env.PI_TELEMETRY = '0';
  env.PI_SKIP_VERSION_CHECK = '1';
  // Deliberately not forwarded: PI_SESSION_FILE, PI_SESSION_ID, PI_PROVIDER, PI_MODEL,
  // PI_CODING_AGENT, auth.json contents, and every unrelated supervisor secret.
  delete env.PI_AUTH;
  return env;
}
