/** Native macOS Seatbelt policy. Only explicit runtime and workspace roots grant file data access. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  if (/[\x00-\x1f\x7f]/.test(absolute)) throw new Error('sandbox paths cannot contain control characters');
  try { return fs.realpathSync(absolute); } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}

export const MAC_SYSTEM_READ_ROOTS = [
  '/System', '/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share', '/bin', '/sbin',
  '/Library/Apple/System', '/Library/Developer/CommandLineTools',
  '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/bin', '/opt/homebrew/lib',
  '/usr/local/Cellar', '/usr/local/opt', '/usr/local/bin', '/usr/local/lib',
  '/opt/homebrew/etc/openssl@3/openssl.cnf', '/opt/homebrew/etc/ca-certificates/cert.pem',
  '/usr/local/etc/openssl@3/openssl.cnf', '/usr/local/etc/ca-certificates/cert.pem',
  '/private/etc/ssl', '/private/etc/resolv.conf', '/private/etc/hosts',
  '/private/etc/localtime', '/private/var/db/timezone', '/private/var/db/dyld',
];

export const MDNS_RESPONDER_SOCKET = '/private/var/run/mDNSResponder';

let appleGit: string | null | undefined;
/**
 * The real Apple Git binary (e.g. /Applications/Xcode.app/Contents/Developer/usr/bin/git).
 * /usr/bin/git is an xcrun shim that fails inside Seatbelt: it cannot read the host's
 * xcode-select link or write its cache, and Xcode's copy needs frameworks outside the policy.
 */
export function resolveAppleGit(): string | null {
  if (process.platform !== 'darwin') return null;
  if (appleGit === undefined) {
    const found = spawnSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8', timeout: 5000, cwd: '/', env: { PATH: '/usr/bin:/bin' } });
    const out = found.status === 0 ? found.stdout.trim() : '';
    appleGit = out.startsWith('/') ? out : null;
  }
  return appleGit;
}

let developerRoot: string | undefined;
function macDeveloperRoots(): string[] {
  if (process.platform !== 'darwin') return [];
  if (developerRoot === undefined) {
    const result = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 3000, cwd: '/', env: { PATH: '/usr/bin:/bin' } });
    developerRoot = result.status === 0 ? result.stdout.trim() : '';
  }
  return developerRoot.startsWith('/') ? [developerRoot] : [];
}

export function buildSeatbeltProfile(opts: { readOnly: string[]; writable: string[]; network: boolean }): string {
  const read = [...new Set([...MAC_SYSTEM_READ_ROOTS, ...macDeveloperRoots(), ...opts.readOnly, ...opts.writable].map(canonicalPath))];
  const write = [...new Set(opts.writable.map(canonicalPath))];
  // JSON quoting escapes quote and backslash; controls are rejected before interpolation.
  const subpaths = (roots: string[]) => roots.map((root) => `(subpath ${JSON.stringify(root)})`).join(' ');
  const rules = [
    '(version 1)', '(deny default)',
    ...(fs.existsSync('/System/Library/Sandbox/Profiles/dyld-support.sb') ? ['(import "dyld-support.sb")'] : []),
    '(allow file-read* (literal "/"))',
    '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
    '(allow file-read-metadata)',
    `(allow file-read* file-map-executable ${subpaths(read)})`,
    '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-write-data file-ioctl (literal "/dev/null"))',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.logd") (global-name "com.apple.bsd.dirhelper"))',
  ];
  if (write.length) rules.push(`(allow file-write* ${subpaths(write)})`);
  if (opts.network) rules.push(
    '(allow network-outbound (remote ip "*:*"))',
    '(allow network-bind (local ip "*:*"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.mDNSResponder"))',
    // getaddrinfo() talks to mDNSResponder over this one Unix socket; without it no hostname
    // resolves. Every other Unix socket (supervisor daemons, ssh-agent, ...) stays denied.
    `(allow network-outbound (remote unix-socket (path-literal ${JSON.stringify(MDNS_RESPONDER_SOCKET)})))`,
  );
  return rules.join('\n') + '\n';
}

export function buildSeatbeltArgv(opts: { executable?: string; inner: string[]; readOnly: string[]; writable: string[]; network: boolean }): string[] {
  return [opts.executable ?? '/usr/bin/sandbox-exec', '-p', buildSeatbeltProfile(opts), ...opts.inner];
}

export function probeSeatbelt(executable = '/usr/bin/sandbox-exec', runtimePaths: string[] = []): { ok: boolean; detail: string } {
  if (process.platform !== 'darwin') return { ok: false, detail: 'Seatbelt requires macOS' };
  const argv = buildSeatbeltArgv({ executable, inner: [process.execPath, '-e', 'process.stdout.write(process.version)'], readOnly: [...runtimePaths, path.dirname(process.execPath)], writable: [], network: false });
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
  return { ok: result.status === 0, detail: result.status === 0 ? `Seatbelt startup probe ok (${result.stdout.trim()})` : `Seatbelt startup probe failed: ${result.stderr || result.error?.message || result.signal || result.status}` };
}
