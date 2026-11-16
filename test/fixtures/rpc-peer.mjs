#!/usr/bin/env node
/** RPC peer fixture: exercises correlation, malformed frames, Unicode separators,
 *  backpressure, and the exit/close ordering the daemon depends on. */

import fs from 'node:fs';

const argv = process.argv.slice(2);
const mode = argv.includes('--mode-case') ? argv[argv.indexOf('--mode-case') + 1] : 'respond';

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

if (mode === 'count') {
  // Backpressure probe: count complete LF-terminated records and report the exact total.
  const target = Number(argv[argv.indexOf('--target') + 1] || '0');
  let buffer = Buffer.alloc(0);
  let count = 0;
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const index = buffer.indexOf(0x0a);
      if (index === -1) break;
      buffer = buffer.subarray(index + 1);
      count += 1;
    }
    if (count >= target) {
      send({ type: 'count', count });
      process.exit(0);
    }
  });
  process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);
} else if (mode === 'exit-unterminated') {
  // The last record has no trailing LF and the process exits immediately: the client must
  // still see it, because stdout can be delivered after 'exit' and only 'close' is final.
  process.stdout.write(`${JSON.stringify({ type: 'final_words', text: 'flushed after exit' })}`);
  process.exit(0);
} else if (mode === 'unicode') {
  send({ type: 'u2028', text: 'a b c' });
  send({ type: 'done' });
} else if (mode === 'garbage') {
  process.stdout.write('not json\n');
  send({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' });
  send({ type: 'ok_after_garbage' });
} else {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const index = buffer.indexOf(0x0a);
      if (index === -1) break;
      const line = buffer.subarray(0, index).toString('utf8');
      buffer = buffer.subarray(index + 1);
      if (!line.trim()) continue;
      let command;
      try {
        command = JSON.parse(line);
      } catch {
        send({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' });
        continue;
      }
      if (command.type === 'slow') {
        // Answer the older request last: correlation must be by id, not by order.
        setTimeout(() => send({ id: command.id, type: 'response', command: 'slow', success: true, data: { order: 'last' } }), 250);
        continue;
      }
      if (command.type === 'never') continue;
      send({ id: command.id, type: 'response', command: command.type, success: true, data: { echo: command.id } });
    }
  });
}

process.stdin.on('end', () => process.exit(0));
