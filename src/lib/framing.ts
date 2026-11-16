/**
 * Strict LF-delimited JSONL framing.
 *
 * The Pi RPC protocol is one JSON object per line terminated by LF. Records may legally
 * contain U+2028 / U+2029 (and any other Unicode) inside JSON strings, so a generic line
 * reader such as readline is unsafe: it also splits on those separators. This framer splits
 * on the single byte 0x0A only and strips an optional preceding CR.
 */

const MAX_PENDING_BYTES = 32 * 1024 * 1024;

export type FramerOverflow = { bytes: number };

export class LfFramer {
  #pending: Buffer = Buffer.alloc(0);
  #overflowed = false;
  #maxBytes: number;

  constructor(maxBytes: number = MAX_PENDING_BYTES) {
    this.#maxBytes = maxBytes;
  }

  get overflowed(): boolean {
    return this.#overflowed;
  }

  /** Feed a raw chunk; returns every complete record (as strings) that became available. */
  push(chunk: Buffer | string): string[] {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (buf.length === 0) return [];
    if (this.#overflowed) return [];
    this.#pending = this.#pending.length === 0 ? buf : Buffer.concat([this.#pending, buf]);
    const records: string[] = [];
    let start = 0;
    for (;;) {
      const idx = this.#pending.indexOf(0x0a, start);
      if (idx === -1) break;
      let end = idx;
      if (end > start && this.#pending[end - 1] === 0x0d) end -= 1;
      const slice = this.#pending.subarray(start, end);
      if (slice.length > 0) records.push(slice.toString('utf8'));
      start = idx + 1;
    }
    if (start > 0) this.#pending = this.#pending.subarray(start);
    if (this.#pending.length > this.#maxBytes) {
      // A peer that never terminates a record must not grow the daemon without bound.
      this.#overflowed = true;
      this.#pending = Buffer.alloc(0);
    }
    return records;
  }

  /** Flush a trailing unterminated record (peer closed the pipe without a final LF). */
  end(): string[] {
    const rest = this.#pending;
    this.#pending = Buffer.alloc(0);
    this.#overflowed = false;
    if (rest.length === 0) return [];
    const text = rest.toString('utf8').replace(/\r$/, '');
    return text.length > 0 ? [text] : [];
  }

  get pendingBytes(): number {
    return this.#pending.length;
  }
}

/** Encode one record for writing: single line, LF terminated. */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
