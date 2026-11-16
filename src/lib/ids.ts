/** Worker ids are UUIDs. Anything else is rejected so ids can never traverse paths. */

import { newId } from './util.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newWorkerId(): string {
  return newId();
}

export function isSafeWorkerId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function assertSafeWorkerId(value: unknown): string {
  if (!isSafeWorkerId(value)) {
    throw new Error(
      `invalid worker id ${JSON.stringify(value)}: worker ids are lowercase UUIDs (example: 4f2c1e6a-9a37-4c0e-8f2d-3b1a0c5d7e11)`,
    );
  }
  return value;
}

/** Branch names must be safe for git and for use inside paths. */
export function workerBranch(id: string): string {
  return `shrimp-pi/${assertSafeWorkerId(id)}`;
}
