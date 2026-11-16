/**
 * Cross-process mutation lock. Node has no flock binding, so this is an O_EXCL directory
 * lock with a bounded wait and stale takeover based on the recorded holder pid.
 */

import fs from 'node:fs';
import { errMessage, pidLooksLike, sleep } from './util.ts';

export type LockOptions = {
  timeoutMs?: number;
  staleMs?: number;
  /** needles used to verify the recorded holder pid before stealing a stale lock */
  needles?: string[];
};

export class LockTimeout extends Error {}

export async function withLock<T>(lockDir: string, fn: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 60_000;
  const started = Date.now();
  let acquired = false;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, 0o700);
      acquired = true;
      try {
        fs.writeFileSync(`${lockDir}/owner`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
          mode: 0o600,
        });
      } catch {
        /* informational only */
      }
      break;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== 'EEXIST') throw err;
      if (await maybeSteal(lockDir, staleMs, options.needles ?? [])) continue;
      if (Date.now() - started > timeoutMs) {
        throw new LockTimeout(
          `timed out after ${timeoutMs}ms waiting for worker lock ${lockDir}: ${errMessage(err)}`,
        );
      }
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        fs.rmSync(`${lockDir}/owner`, { force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmdirSync(lockDir);
      } catch {
        /* ignore */
      }
    }
  }
}

async function maybeSteal(lockDir: string, staleMs: number, needles: string[]): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch {
    return true; // vanished: retry acquisition
  }
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs < staleMs) return false;
  let holderPid = 0;
  try {
    holderPid = Number(JSON.parse(fs.readFileSync(`${lockDir}/owner`, 'utf8')).pid) || 0;
  } catch {
    holderPid = 0;
  }
  if (holderPid > 0 && needles.length > 0 && pidLooksLike(holderPid, needles)) return false;
  if (holderPid > 0 && needles.length === 0 && pidAliveSync(holderPid)) return false;
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function pidAliveSync(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as { code?: string })?.code === 'EPERM';
  }
}
