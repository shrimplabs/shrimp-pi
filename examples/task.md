# Task: add a decimal-safe money helper

## Goal

`src/money.ts` should expose a `Money` helper that adds two amounts without floating point
drift, because the billing code keeps producing penny errors.

## Acceptance criteria

- `add(a, b)` returns the exact decimal sum for the amounts in `test/amounts.json`.
- Existing exports keep their names and behaviour.
- `node --test` passes.
- No new runtime dependencies.

## Constraints

- Work only inside this working copy; do not push anywhere.
- Keep the change small and add one test file for the new helper.
- If the intent is unclear, stop and report `status: "blocked"` with a question instead of
  guessing.
