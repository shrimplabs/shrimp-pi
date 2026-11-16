import test from 'node:test';
import assert from 'node:assert/strict';

import parseDuration, {
  parseDuration as namedParseDuration,
} from './duration.js';

test('exports the same function as default and named export', () => {
  assert.equal(typeof namedParseDuration, 'function');
  assert.equal(namedParseDuration, parseDuration);
});

test('parses the documented examples', () => {
  assert.equal(parseDuration('1h 30m'), 5_400_000);
  assert.equal(parseDuration('45s'), 45_000);
  assert.equal(parseDuration('1.5h 0.25m'), 5_415_000);
});

test('parses single-unit durations', () => {
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1m'), 60_000);
  assert.equal(parseDuration('90m'), 5_400_000);
  assert.equal(parseDuration('1s'), 1_000);
  assert.equal(parseDuration('59s'), 59_000);
});

test('parses compound durations', () => {
  assert.equal(parseDuration('1h 30m 45s'), 5_445_000);
  assert.equal(parseDuration('2h 15m 9s'), 8_109_000);
  assert.equal(parseDuration('10h 59m 59s'), 39_599_000);
});

test('parses decimal components', () => {
  assert.equal(parseDuration('1.5h'), 5_400_000);
  assert.equal(parseDuration('0.5h'), 1_800_000);
  assert.equal(parseDuration('0.25m'), 15_000);
  assert.equal(parseDuration('0.5m 1.5h'), 5_430_000);
  assert.equal(parseDuration('2.5s'), 2_500);
  assert.equal(parseDuration('1h 30.5m'), 5_430_000);
  assert.equal(parseDuration('1.5h 0.25m 0.5s'), 5_415_500);
});

test('accepts the finest decimal that still lands on whole milliseconds', () => {
  assert.equal(parseDuration('0.001s'), 1);
  assert.equal(parseDuration('0.0005m'), 30); // exactly 30 ms
  assert.equal(parseDuration('0.0005h'), 1_800); // exactly 1800 ms
});

test('computes decimal components exactly, not via float rounding', () => {
  // 0.1 * 1000 === 100.00000000000001 in floating point.
  assert.equal(parseDuration('0.1s'), 100);
  assert.equal(parseDuration('0.3s'), 300);
  assert.equal(parseDuration('0.7s'), 700);
  assert.equal(parseDuration('1.1m'), 66_000);
  assert.ok(Number.isInteger(parseDuration('1.5h 0.25m')));
});

test('rejects durations whose total is not a whole millisecond', () => {
  assert.throws(() => parseDuration('0.0001s'), RangeError); // 0.1 ms
  assert.throws(() => parseDuration('0.0000001s'), RangeError); // 0.0001 ms
  assert.throws(() => parseDuration('1.0001s'), RangeError); // 1000.1 ms
  assert.throws(() => parseDuration('0.00001m'), RangeError); // 0.6 ms
  assert.throws(() => parseDuration('0.0015s'), RangeError); // 1.5 ms
  assert.throws(() => parseDuration('0.000025m'), RangeError); // 1.5 ms
  assert.throws(() => parseDuration('1h 30m 0.0001s'), RangeError);
  assert.throws(() => parseDuration('0.0001s'), /whole number of milliseconds/);
});

test('judges integrality on the total, not on each component', () => {
  // 1.5 ms + 1.5 ms === 3 ms exactly, although neither part is whole alone.
  assert.equal(parseDuration('0.0015s 0.000025m'), 3);
  assert.equal(parseDuration('0.0015s 0.000025m 2h'), 7_200_003);
});

test('accepts trailing fractional zeros that are still whole milliseconds', () => {
  assert.equal(parseDuration('0.0010s'), 1);
  assert.equal(parseDuration('00.500s'), 500);
  assert.equal(parseDuration('1.500h'), 5_400_000);
});

test('accepts components in any order', () => {
  assert.equal(parseDuration('45s 30m 1h'), 5_445_000);
  assert.equal(parseDuration('30m 1h'), 5_400_000);
});

test('accepts surrounding and interleaved whitespace', () => {
  assert.equal(parseDuration('   1h 30m   '), 5_400_000);
  assert.equal(parseDuration('\t1h\n\t30m 45s \n'), 5_445_000);
  assert.equal(parseDuration('1h    30m'), 5_400_000);
  assert.equal(parseDuration('1.5 h 0.25 m'), 5_415_000);
});

test('accepts components with no whitespace between them', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1h30m45s'), 5_445_000);
  assert.equal(parseDuration('1.5h0.25m'), 5_415_000);
});

test('accepts uppercase units', () => {
  assert.equal(parseDuration('1H 30M'), 5_400_000);
  assert.equal(parseDuration('45S'), 45_000);
  assert.equal(parseDuration('1.5H'), 5_400_000);
});

test('accepts zero components and returns whole milliseconds', () => {
  assert.equal(parseDuration('0s'), 0);
  assert.equal(parseDuration('0h 5m'), 300_000);
  assert.equal(parseDuration('0h 0m 1s'), 1_000);
  assert.equal(parseDuration('0.0s'), 0);
  assert.ok(Number.isInteger(parseDuration('1h 30m')));
});

test('rejects empty or whitespace-only input', () => {
  assert.throws(() => parseDuration(''), SyntaxError);
  assert.throws(() => parseDuration('   '), SyntaxError);
  assert.throws(() => parseDuration('\n\t '), SyntaxError);
});

test('rejects unknown units', () => {
  assert.throws(() => parseDuration('1x'), SyntaxError);
  assert.throws(() => parseDuration('1d'), SyntaxError);
  assert.throws(() => parseDuration('1h 2w'), SyntaxError);
  assert.throws(() => parseDuration('2 hours'), SyntaxError);
  assert.throws(() => parseDuration('1ms'), SyntaxError);
  assert.throws(() => parseDuration('1mss'), SyntaxError);
  assert.throws(() => parseDuration('1.5ms'), SyntaxError);
});

test('rejects text that is not a duration at all', () => {
  assert.throws(() => parseDuration('abc'), SyntaxError);
  assert.throws(() => parseDuration('h'), SyntaxError);
  assert.throws(() => parseDuration('h m s'), SyntaxError);
});

test('rejects numbers without a unit', () => {
  assert.throws(() => parseDuration('10'), SyntaxError);
  assert.throws(() => parseDuration('1.5'), SyntaxError);
  assert.throws(() => parseDuration('1h 30'), SyntaxError);
  assert.throws(() => parseDuration('30m1'), SyntaxError);
});

test('rejects malformed decimal syntax', () => {
  assert.throws(() => parseDuration('.5h'), SyntaxError); // needs a leading digit
  assert.throws(() => parseDuration('1.h'), SyntaxError); // needs a fractional digit
  assert.throws(() => parseDuration('1..5h'), SyntaxError);
  assert.throws(() => parseDuration('1.5.5h'), SyntaxError);
  assert.throws(() => parseDuration('1e3s'), SyntaxError); // no exponent form
  assert.throws(() => parseDuration('1,5h'), SyntaxError); // no comma decimals
  assert.throws(() => parseDuration('1h.'), SyntaxError);
});

test('rejects negative durations', () => {
  assert.throws(() => parseDuration('-5m'), SyntaxError);
  assert.throws(() => parseDuration('-1h 30m'), SyntaxError);
  assert.throws(() => parseDuration('-0.5s'), SyntaxError);
  assert.throws(() => parseDuration('1h -30m'), SyntaxError);
  assert.throws(() => parseDuration('1h -0.5m'), SyntaxError);
  assert.throws(() => parseDuration('+5m'), SyntaxError);
});

test('rejects duplicate units', () => {
  assert.throws(() => parseDuration('1h 2h'), SyntaxError);
  assert.throws(() => parseDuration('1.5h 2h'), SyntaxError);
  assert.throws(() => parseDuration('1m 30m 10s'), SyntaxError);
  assert.throws(() => parseDuration('1s 2s 3s'), SyntaxError);
  assert.throws(() => parseDuration('1H 2h'), SyntaxError);
  assert.throws(() => parseDuration('0.5h 1.5h'), SyntaxError);
});

test('error messages name the problem', () => {
  assert.throws(() => parseDuration(''), /non-empty/);
  assert.throws(() => parseDuration('-5m'), /negative/);
  assert.throws(() => parseDuration('1h 2h'), /duplicate unit "h"/);
  assert.throws(() => parseDuration('1x'), /unexpected "1x"/);
  assert.throws(() => parseDuration('1h 2x'), /unexpected "2x"/);
  assert.throws(() => parseDuration('0.0001s'), /whole number of milliseconds/);
  assert.throws(() => parseDuration('0.0015s'), /\(1\.5 ms\)/);
});

test('rejects non-string input with a TypeError', () => {
  for (const value of [
    undefined,
    null,
    42,
    1.5,
    Number.NaN,
    true,
    ['1h'],
    { text: '1h' },
    Symbol('1h'),
    () => '1h',
  ]) {
    assert.throws(() => parseDuration(value), TypeError);
  }
});

test('rejects durations beyond the safe integer range', () => {
  assert.throws(() => parseDuration('999999999999999999h'), RangeError);
  assert.throws(() => parseDuration('9007199254740991s'), RangeError);
  assert.throws(
    () => parseDuration('99999999999999999999999999999999h'),
    RangeError,
  );
  assert.equal(parseDuration('2739726h'), 2_739_726 * 3_600_000);
});
