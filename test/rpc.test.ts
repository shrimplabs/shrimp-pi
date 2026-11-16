/** RPC child guarantees: correlation, framing anomalies, backpressure, shutdown. */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';
import { PiChild } from '../src/lib/rpc.ts';
import { FAKE_PI, NODE, tempDir, type Handle } from './helpers.ts';
import fs from 'node:fs';

const handles: Handle[] = [];
after(() => {
  for (const handle of handles) handle.cleanup();
});

const PEER = path.join(path.dirname(FAKE_PI), 'rpc-peer.mjs');

type Collected = { events: Record<string, unknown>[]; exit: { code: number | null; signal: string | null } | null };

function makePeer(args: string[], handle: Handle): { child: PiChild; collected: Collected; done: Promise<void> } {
  const events: Record<string, unknown>[] = [];
  const collected: Collected = { events, exit: null };
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const child = new PiChild({
    label: 'peer',
    argv: [NODE, PEER, '--mode-case', ...args],
    cwd: handle.dir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: handle.dir },
    logs: {
      stdout: path.join(handle.dir, 'peer-stdout.jsonl'),
      stdin: path.join(handle.dir, 'peer-stdin.jsonl'),
      stderr: path.join(handle.dir, 'peer-stderr.log'),
    },
    onEvent: (event) => {
      events.push(event);
    },
    onExit: (info) => {
      collected.exit = { code: info.code, signal: info.signal };
      resolveDone();
    },
  });
  child.start();
  return { child, collected, done };
}

test('responses are correlated by id, not by arrival order', async () => {
  const handle = tempDir('shrimp-pi-rpc-');
  handles.push(handle);
  const { child, done } = makePeer(['respond'], handle);
  const slow = child.request({ type: 'slow' }, 10_000);
  const fast = child.request({ type: 'fast' }, 10_000);
  const fastReply = await fast;
  const slowReply = await slow;
  assert.equal(fastReply.command, 'fast');
  assert.equal(slowReply.command, 'slow');
  assert.equal((slowReply.data as Record<string, unknown>).order, 'last');
  assert.equal(fastReply.id, slowReply.id ? fastReply.id : undefined);
  await child.shutdown({ termGraceMs: 1000, killGraceMs: 500 });
  await done;
  assert.ok(child.exited);
});

test('U+2028 and U+2029 inside a record survive the framer', async () => {
  const handle = tempDir('shrimp-pi-rpc-');
  handles.push(handle);
  const { child, collected, done } = makePeer(['unicode'], handle);
  await done;
  const record = collected.events.find((event) => event.type === 'u2028');
  assert.ok(record, `events: ${JSON.stringify(collected.events)}`);
  assert.equal(record?.text, 'a\u2028b\u2029c');
  assert.ok(collected.events.some((event) => event.type === 'done'), 'the record after the separators still arrived');
  void child;
});

test('a malformed line is reported and reading continues', async () => {
  const handle = tempDir('shrimp-pi-rpc-');
  handles.push(handle);
  const { child, collected, done } = makePeer(['garbage'], handle);
  await done;
  assert.ok(collected.events.some((event) => event.type === '$malformed_frame'));
  assert.ok(collected.events.some((event) => event.type === 'ok_after_garbage'));
  void child;
});

test('the final record without a trailing LF is delivered on close, not lost at exit', async () => {
  const handle = tempDir('shrimp-pi-rpc-');
  handles.push(handle);
  const { child, collected, done } = makePeer(['exit-unterminated'], handle);
  await done;
  const final = collected.events.find((event) => event.type === 'final_words');
  assert.ok(final, `expected the flushed record, got ${JSON.stringify(collected.events)}`);
  assert.equal((final as Record<string, unknown>).text, 'flushed after exit');
  assert.ok(collected.exit);
  void child;
});

test('stdin backpressure never duplicates or drops a written record', async () => {
  const handle = tempDir('shrimp-pi-rpc-');
  handles.push(handle);
  const target = 1500;
  const { child, collected, done } = makePeer(['count', '--target', String(target)], handle);
  // Wait for the ready record so the pipe exists, then flood it: writes must queue on drain.
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (collected.events.some((event) => event.type === 'ready')) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
  });
  const payload = 'x'.repeat(4096);
  for (let i = 0; i < target; i += 1) {
    child.writeRecord({ type: 'flood', index: i, payload });
  }
  await done;
  const count = collected.events.find((event) => event.type === 'count');
  assert.equal(Number(count?.count), target, 'every record must be written exactly once under backpressure');
  const logged = fs.readFileSync(path.join(handle.dir, 'peer-stdin.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(logged, target, 'the raw stdin log must match what was written');
  void child;
});

test('shutdown escalates when the child ignores a closed stdin', async () => {
  const handle = tempDir('shrimp-pi-rpc-');
  handles.push(handle);
  const { child, done } = makePeer(['respond'], handle);
  const started = Date.now();
  await child.shutdown({ termGraceMs: 300, killGraceMs: 300 });
  await done;
  assert.ok(child.exited, 'the child must be gone after escalation');
  assert.ok(Date.now() - started < 15_000);
});
