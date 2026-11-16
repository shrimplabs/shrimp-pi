import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./index.js";

test("adds two positive numbers", () => {
  assert.equal(add(2, 3), 5);
});

test("adds negative and zero values", () => {
  assert.equal(add(-2, 2), 0);
  assert.equal(add(0, 0), 0);
  assert.equal(add(1.5, 2.25), 3.75);
});

test("throws TypeError for non-number inputs", () => {
  assert.throws(() => add("1", 2), TypeError);
  assert.throws(() => add(1, "2"), TypeError);
  assert.throws(() => add(null, 1), TypeError);
  assert.throws(() => add(undefined, 1), TypeError);
  assert.throws(() => add(1, NaN), TypeError);
});

test("applies optional offset", () => {
  assert.equal(add(2, 3, 10), 15);
  assert.equal(add(2, 3, -5), 0);
  assert.equal(add(1, 1, 0.5), 2.5);
});

test("offset defaults to zero", () => {
  assert.equal(add(2, 3), add(2, 3, 0));
  assert.equal(add(2, 3, undefined), 5);
});

test("throws TypeError for invalid offset", () => {
  assert.throws(() => add(1, 2, "3"), TypeError);
  assert.throws(() => add(1, 2, null), TypeError);
  assert.throws(() => add(1, 2, NaN), TypeError);
  assert.throws(() => add(1, 2, Infinity), TypeError);
});

test("throws TypeError for non-finite numbers", () => {
  assert.throws(() => add(Infinity, 1), TypeError);
  assert.throws(() => add(1, -Infinity), TypeError);
  assert.throws(() => add(NaN, NaN), TypeError);
});
