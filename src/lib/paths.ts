/** State directory layout. Everything lives outside the repositories being worked on. */

import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { assertSafeWorkerId } from './ids.ts';
import { ensureDir } from './util.ts';

export const STATE_DIR_ENV = 'SHRIMP_PI_HOME';

export function resolveStateDir(explicit?: string | null): string {
  const raw = explicit || process.env[STATE_DIR_ENV] || path.join(os.homedir(), '.local', 'state', 'shrimp-pi');
  const resolved = path.resolve(raw);
  ensureDir(resolved);
  ensureDir(path.join(resolved, 'workers'));
  return fs.realpathSync(resolved);
}

export type WorkerPaths = {
  id: string;
  root: string;
  stateFile: string;
  lockDir: string;
  socket: string;
  pidFile: string;
  childPidFile: string;
  taskFile: string;
  configSnapshot: string;
  logsDir: string;
  daemonLog: string;
  daemonErrLog: string;
  rpcOutLog: string;
  rpcInLog: string;
  stderrLog: string;
  eventsLog: string;
  agentDir: string;
  modelsFile: string;
  homeDir: string;
  tmpDir: string;
  workspace: string;
  reportsDir: string;
  metaFile: string;
};

export function workerRoot(stateDir: string, id: string): string {
  return path.join(stateDir, 'workers', assertSafeWorkerId(id));
}

export function workerPaths(stateDir: string, id: string): WorkerPaths {
  const root = workerRoot(stateDir, id);
  const logsDir = path.join(root, 'logs');
  const agentDir = path.join(root, 'agent');
  let socket = path.join(root, 'daemon.sock');
  if (Buffer.byteLength(socket) > 100) {
    // Darwin sun_path is 104 bytes; os.tmpdir() itself is often a long /var/folders path.
    const dir = `/private/tmp/shrimp-pi-${process.getuid?.() ?? 0}`;
    const shortRoot = process.platform === 'darwin' ? dir : dir.replace('/private', '');
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 24);
    socket = path.join(shortRoot, hash + '.sock');
  }
  return {
    id,
    root,
    stateFile: path.join(root, 'state.json'),
    lockDir: path.join(root, '.lock'),
    socket,
    pidFile: path.join(root, 'daemon.pid'),
    childPidFile: path.join(root, 'pi.pid'),
    taskFile: path.join(root, 'task.md'),
    configSnapshot: path.join(root, 'config.json'),
    logsDir,
    daemonLog: path.join(logsDir, 'daemon.log'),
    daemonErrLog: path.join(logsDir, 'daemon.stderr.log'),
    rpcOutLog: path.join(logsDir, 'rpc-pi-stdout.jsonl'),
    rpcInLog: path.join(logsDir, 'rpc-pi-stdin.jsonl'),
    stderrLog: path.join(logsDir, 'pi-stderr.log'),
    eventsLog: path.join(logsDir, 'events.jsonl'),
    agentDir,
    modelsFile: path.join(agentDir, 'models.json'),
    homeDir: path.join(root, 'home'),
    tmpDir: path.join(root, 'pi-tmp'),
    workspace: path.join(root, 'workspace'),
    reportsDir: path.join(root, 'reports'),
    metaFile: path.join(root, 'meta.json'),
  };
}

export function ensureWorkerDirs(paths: WorkerPaths): void {
  if (path.dirname(paths.socket) !== paths.root) {
    const dir = path.dirname(paths.socket);
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('unsafe shared socket directory: ' + dir);
    }
    fs.chmodSync(dir, 0o700);
  }
  ensureDir(paths.root, 0o700);
  ensureDir(paths.logsDir, 0o700);
  ensureDir(paths.agentDir, 0o700);
  ensureDir(paths.homeDir, 0o700);
  ensureDir(paths.tmpDir, 0o700);
  ensureDir(paths.reportsDir, 0o700);
}
