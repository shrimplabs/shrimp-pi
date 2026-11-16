export function add(a, b, offset = 0) {
  if (typeof a !== "number" || !Number.isFinite(a)) {
    throw new TypeError("add: argument 'a' must be a finite number");
  }
  if (typeof b !== "number" || !Number.isFinite(b)) {
    throw new TypeError("add: argument 'b' must be a finite number");
  }
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    throw new TypeError("add: argument 'offset' must be a finite number");
  }
  return a + b + offset;
}
