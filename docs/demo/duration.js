/**
 * Parse a positive compound duration string into whole milliseconds.
 *
 * Supported units: `h` (hours), `m` (minutes), `s` (seconds).
 * Components are `<number><unit>` where `<number>` is a non-negative decimal
 * (integer or fractional, e.g. "1.5h"), separated by optional whitespace,
 * e.g. "1h 30m", "1h30m", "45s", "1.5h 0.25m".
 *
 * Arithmetic is exact (BigInt based), so "0.1s" is exactly 100 ms rather than
 * the 100.00000000000001 a plain float multiplication would produce. A duration
 * whose exact total is not a whole number of milliseconds is rejected.
 *
 * @param {string} text duration text, e.g. "1h 30m 45s"
 * @returns {number} total duration in whole milliseconds
 * @throws {TypeError} if `text` is not a string
 * @throws {SyntaxError} if `text` is empty or not a valid duration
 * @throws {RangeError} if the exact total is not a whole number of
 *   milliseconds, or exceeds `Number.MAX_SAFE_INTEGER` ms
 */

/** Whole milliseconds per unit, as BigInt for exact decimal arithmetic. */
const MS_PER_UNIT = {
  h: 3_600_000n,
  m: 60_000n,
  s: 1_000n,
};

/** A component: whole digits, optional fractional digits, then a unit. */
const COMPONENT = /(\d+)(?:\.(\d+))?\s*([hms])/gi;

const MAX_SAFE_MS = BigInt(Number.MAX_SAFE_INTEGER);
const TEN = 10n;

export function parseDuration(text) {
  if (typeof text !== 'string') {
    throw new TypeError(
      `parseDuration expects a string, got ${describe(text)}`,
    );
  }

  const input = text.trim();
  if (input === '') {
    throw new SyntaxError(
      'parseDuration expects a non-empty duration, e.g. "1h 30m"',
    );
  }

  if (/^[-−]/.test(input)) {
    throw new SyntaxError(
      `parseDuration does not accept negative durations: "${text}"`,
    );
  }

  const seen = new Set();
  const parts = [];
  let scale = 0; // max number of fractional digits seen, denominator is 10^scale
  let cursor = skipWhitespace(input, 0);
  let match;

  COMPONENT.lastIndex = 0;
  while ((match = COMPONENT.exec(input)) !== null) {
    if (match.index !== cursor) {
      throw invalidAt(input, cursor);
    }

    const [, whole, fraction, rawUnit] = match;
    const unit = rawUnit.toLowerCase();

    if (seen.has(unit)) {
      throw new SyntaxError(
        `parseDuration: duplicate unit "${unit}" in "${text}"`,
      );
    }
    seen.add(unit);

    const digits = fraction === undefined ? whole : whole + fraction;
    const places = fraction === undefined ? 0 : fraction.length;
    scale = Math.max(scale, places);
    // Milliseconds this component represents, times 10^places.
    parts.push({ value: BigInt(digits) * MS_PER_UNIT[unit], places });

    cursor = skipWhitespace(input, COMPONENT.lastIndex);
  }

  if (cursor !== input.length) {
    throw invalidAt(input, cursor);
  }

  const denominator = TEN ** BigInt(scale);
  let numerator = 0n;
  for (const part of parts) {
    numerator += part.value * TEN ** BigInt(scale - part.places);
  }

  if (numerator % denominator !== 0n) {
    throw new RangeError(
      `parseDuration: "${text}" is not a whole number of milliseconds ` +
        `(${formatMs(numerator, denominator)} ms); ` +
        'the total must be an integer number of milliseconds',
    );
  }

  const totalMs = numerator / denominator;

  if (totalMs > MAX_SAFE_MS) {
    throw new RangeError(
      `parseDuration: "${text}" exceeds the maximum supported duration ` +
        `(${Number.MAX_SAFE_INTEGER} ms)`,
    );
  }

  return Number(totalMs);
}

/** Human-readable milliseconds for the exact ratio numerator / denominator. */
function formatMs(numerator, denominator) {
  const places = denominator.toString().length - 1;
  const whole = numerator / denominator;
  const fraction = String(numerator % denominator)
    .padStart(places, '0')
    .replace(/0+$/, '');
  return fraction === '' ? `${whole}` : `${whole}.${fraction}`;
}

/** Index of the first non-whitespace character at or after `from`. */
function skipWhitespace(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/** Build a SyntaxError that points at the first offending chunk of text. */
function invalidAt(input, position) {
  const rest = input.slice(position);
  const token = rest.split(/\s+/)[0] || rest;
  return new SyntaxError(
    `parseDuration: unexpected "${token}" at position ${position} in "${input}"; ` +
      'expected a number followed by h, m, or s (e.g. "1h 30m 45s")',
  );
}

/** Short, safe description of a non-string value for error messages. */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (type === 'object') return value?.constructor?.name ?? 'object';
  return type;
}

export default parseDuration;
