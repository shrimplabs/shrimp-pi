# Verified local-model demonstration

On November 11, 2026 (Eastern), Codex used this bridge with installed Pi 1.5.0 and a locally hosted model. The worker ran in a Bubblewrap sandbox with a private Git clone. The source repository was not modified.

1. `spawn` started a detached daemon and submitted a duration-parser task. The CLI exited.
2. `wait` returned `REVIEW_REQUIRED` after Pi's `agent_settled` event.
3. `review` exported the independently measured diff and the worker's claims. The supervisor inspected the implementation and independently ran all **20 tests** successfully.
4. `steer` requested decimal-duration support and additional validation.
5. A 300-second `wait` returned a normal timeout; a subsequent wait returned `REVIEW_REQUIRED`.
6. The supervisor inspected the result, independently ran **25 tests**, and ran extra assertions for decimal values, sub-millisecond rejection, and duplicate units. All passed.
7. `accept` recorded `COMPLETED`. It shut down the daemon and preserved the clone. No changes were merged into the source repository.

The worker retained **both the same Pi process and the same session file** through the correction. It executed 40 tool calls and recovered from two failed edit attempts autonomously. The two active runs took about 10 minutes in total; this is one example, not a throughput benchmark.

Machine-readable observations are in [demo/result.json](demo/result.json). The final parser and tests are retained in [demo/](demo/); reproduce its independent test run with `node --test docs/demo/duration.test.js`.

## What this establishes

This proves the local inference, persistent session, event-driven wait, independent review, and correction workflow. It does not establish token or cost savings versus a direct supervisor implementation. Pi reported token usage (including cached-token reads); supervisory token usage and provider-billed cost were unavailable and are left null.

The integration run also exposed and fixed a review-report variable bug and unsafe cross-namespace liveness diagnosis. Run the bridge CLI in the same host/access context used to spawn the daemon. A restricted supervisor may need permission to access both the inference endpoint and the daemon's Unix socket.
