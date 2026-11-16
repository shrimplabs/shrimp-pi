/**
 * Daemon entry point. One process per worker. Started detached by `shrimp-pi spawn` /
 * `shrimp-pi recover`; it is never invoked interactively by a supervisor.
 */

import { daemonMain } from './lib/daemoncore.ts';
import { errMessage } from './lib/util.ts';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.worker || !args['state-dir']) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: 'daemon requires --worker <uuid> and --state-dir <path>' })}\n`);
  process.exit(2);
}

try {
  await daemonMain({
    workerId: String(args.worker),
    stateDir: String(args['state-dir']),
    recover: args.recover === 'true',
  });
} catch (err: unknown) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: `daemon failed: ${errMessage(err)}` })}\n`);
  process.exit(1);
}
