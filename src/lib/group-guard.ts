/** macOS has no parent-death signal. Own a detached group and reap descendants if its daemon dies. */
import { spawn, spawnSync } from 'node:child_process';
const [ownerArg, program, ...args] = process.argv.slice(2);
const owner = Number(ownerArg);
if (!program || !Number.isSafeInteger(owner) || owner <= 1) process.exit(2);

function terminateTree(): never {
  // Tool runners may create separate process groups. Snapshot the still-parented tree before
  // killing Pi, otherwise those children would be reparented and lost from the ancestry tree.
  const table = spawnSync('/bin/ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin' },
  });
  const edges = (table.stdout ?? '').trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of edges) if (pid > 1 && descendants.has(ppid) && !descendants.has(pid)) {
      descendants.add(pid); changed = true;
    }
  }
  for (const pid of [...descendants].reverse()) if (pid !== process.pid) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
  process.exit(1);
}
if (process.ppid !== owner) terminateTree();
const child = spawn(program, args, { stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
// Hold Pi's stdin open until we classify the upstream EOF. Otherwise Pi can exit and
// reparent a detached tool before the parent-death timer snapshots its descendants.
process.stdin.on('end', () => {
  if (process.ppid !== owner) terminateTree();
  child.stdin.end();
});
child.stdin.on('error', () => { process.stdin.unpipe(child.stdin); process.stdin.resume(); });
process.stdin.pipe(child.stdin, { end: false });
const timer = setInterval(() => { if (process.ppid !== owner) terminateTree(); }, 250);
process.on('SIGTERM', terminateTree);
process.on('SIGINT', terminateTree);
child.on('error', (err) => { process.stderr.write(`sandbox launch failed: ${err.message}\n`); clearInterval(timer); process.exit(1); });
child.on('exit', (code) => { clearInterval(timer); process.exit(code ?? 1); });
