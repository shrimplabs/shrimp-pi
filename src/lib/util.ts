/** Small shared helpers. No external dependencies. */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function newId(): string {
  return randomUUID();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clamp to an integer inside [min, max]; `dflt` used when value is not a finite number. */
export function clampInt(value: unknown, min: number, max: number, dflt: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
  try {
    fs.chmodSync(dir, mode);
  } catch {
    /* best effort: some filesystems reject chmod on created parents */
  }
}

export function ensureParentDir(file: string, mode = 0o700): void {
  ensureDir(path.dirname(file), mode);
}

export function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT');
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function jsonTryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Write `data` atomically: temp file in the same directory, fsync, rename, dir fsync. */
export function atomicWrite(file: string, data: string | Buffer, mode = 0o600): void {
  ensureParentDir(file);
  const tmp = `${file}.tmp-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* directory fsync is best effort (not supported everywhere) */
  }
}

export function appendLine(file: string, line: string): void {
  try {
    ensureParentDir(file);
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    /* logging must never take the worker down */
  }
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    // EPERM means the process exists but belongs to somebody else.
    return code === 'EPERM';
  }
}

/**
 * Best-effort check that `pid` still looks like the process we launched. Guards against
 * pid reuse before ever sending a signal.
 */
export function pidLooksLike(pid: number | null | undefined, needles: string[]): boolean {
  if (!pidAlive(pid)) return false;
  const cmdline = readProcCmdline(pid as number);
  if (cmdline === null) return true; // platform without /proc: fall back to pidAlive
  return needles.some((needle) => needle.length > 0 && cmdline.includes(needle));
}

export function readProcCmdline(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim();
  } catch {
    if (process.platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1500, env: { PATH: '/usr/bin:/bin' } });
      return result.status === 0 ? result.stdout.trim() : null;
    }
    return null;
  }
}

export function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function which(name: string): string | null {
  if (name.includes('/')) return isExecutable(name) ? name : null;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Directory of the running Node executable (node is often absent from PATH). */
export function nodeDir(): string {
  return path.dirname(fs.realpathSync(process.execPath));
}

export function realPathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export function uniqueStrings(values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value);
  }
  return out;
}
