# Duration parser demo

`parseDuration(text)` parses a positive compound duration written with `h`, `m`
and `s` units into whole milliseconds. Numbers may be integers or decimals.

```js
import parseDuration from './duration.js';
// or: import { parseDuration } from './duration.js';

parseDuration('1h 30m');        // 5400000
parseDuration('45s');           // 45000
parseDuration('1h 30m 45s');    // 5445000
parseDuration('1.5h 0.25m');    // 5415000   decimal components
parseDuration('0.001s');        // 1         one millisecond
parseDuration('0.1s');          // 100       exact, not 100.00000000000001
parseDuration('1h30m');         // 5400000   whitespace is optional
parseDuration('  45s  ');       // 45000     surrounding whitespace is trimmed
parseDuration('45s 30m 1h');    // 5445000   component order is free
parseDuration('1H 30M');        // 5400000   units are case-insensitive
parseDuration('0h 5m');         // 300000    zero components are allowed
```

## Syntax

A duration is one or more `<number><unit>` components, optionally separated by
whitespace (spaces, tabs or newlines); whitespace inside a component
(`1 h 30 m`) is also tolerated. Units:

| unit | meaning  |
| ---- | -------- |
| `h`  | hours    |
| `m`  | minutes  |
| `s`  | seconds  |

`<number>` is a non-negative decimal written in plain form: `45`, `1.5`,
`0.001`, `00.500`. A decimal must have at least one digit before and after the
decimal point, so `.5h`, `1.h`, `1..5h`, `1,5h` and `1e3s` are invalid. Each
unit may appear at most once, so a duration has at most three components.

## Precision

Components are converted with exact decimal (BigInt) arithmetic rather than
binary floating point, so `0.1s` is exactly `100`, `0.3s` is exactly `300`. The
**total** must be a whole number of milliseconds; a duration whose exact total is
fractional is rejected. Because integrality is checked on the total, parts that
are individually sub-millisecond are fine as long as they add up to whole
milliseconds:

```js
parseDuration('0.001s');            // 1     OK
parseDuration('0.0015s 0.000025m'); // 3     OK (1.5 ms + 1.5 ms)
parseDuration('0.0001s');           // RangeError: 0.1 ms is not whole
parseDuration('0.0015s');           // RangeError: 1.5 ms is not whole
```

## Errors

| input                   | error         | reason                                  |
| ----------------------- | ------------- | --------------------------------------- |
| `42`, `null`, ...        | `TypeError`   | not a string                            |
| `''`, `'   '`           | `SyntaxError` | empty / whitespace only                 |
| `'-5m'`, `'-0.5s'`      | `SyntaxError` | negative durations are unsupported      |
| `'1d'`, `'2 hours'`, `'1ms'` | `SyntaxError` | unknown unit                      |
| `'.5h'`, `'1.h'`, `'1..5h'`, `'1e3s'` | `SyntaxError` | malformed decimal syntax       |
| `'10'`, `'1h 30'`, `'1.5'` | `SyntaxError` | number without a unit                 |
| `'abc'`                 | `SyntaxError` | no parseable component                  |
| `'1h 2h'`, `'1.5h 2h'`  | `SyntaxError` | duplicate unit                          |
| `'0.0001s'`, `'0.0015s'` | `RangeError` | total is not a whole number of milliseconds |
| `'999999999999999999h'` | `RangeError`  | result exceeds `Number.MAX_SAFE_INTEGER` ms |

Every `SyntaxError` message points at the offending text and its position, e.g.
`parseDuration: unexpected "2x" at position 3 in "1h 2x"; expected a number
followed by h, m, or s (e.g. "1h 30m 45s")`. Every non-integer-total
`RangeError` names the exact value, e.g.
`parseDuration: "0.0015s" is not a whole number of milliseconds (1.5 ms); the
total must be an integer number of milliseconds`.

## Development

```sh
npm test   # runs `node --test`, which executes duration.test.js
```
