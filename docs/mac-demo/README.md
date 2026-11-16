# Native bridge acceptance fixture

## Usage

```js
import { add } from "./index.js";

add(2, 3);      // 5
add(2, 3, 10);  // 15
```

`add(a, b, offset = 0)` is a named export. It returns `a + b + offset`.
All three arguments must be finite numbers; otherwise a `TypeError` is
thrown (e.g. `NaN`, `Infinity`, strings, `null`). The `offset` argument
is optional and defaults to `0` (passing `undefined` explicitly also uses
the default).

Run tests with `npm test`.
