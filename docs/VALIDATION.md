# Validation

Verified November 11, 2026 (Eastern) on this Linux host with Node 22.23.3, Pi 1.5.0, Git 2.56.0, and Bubblewrap 0.13.1.

- `node --test test/*.test.ts`: **55 passed, 0 failed, 0 skipped** (about 17 seconds). This includes lifecycle and error states, persistent sessions, correction, recovery without replay, simultaneous recovery, concurrent steering, RPC framing/backpressure, secret forwarding, access-context diagnosis, and real Bubblewrap isolation.
- `node --test docs/demo/duration.test.js`: **25 passed, 0 failed**.
- Real remote-model workflow: spawn → wait → review → correct → wait → independently test → accept. Same Pi process and session retained; source unchanged. See [VERIFIED_DEMO.md](VERIFIED_DEMO.md).
- Final review exported the complete three-file parser diff after Git inspection moved inside its own read-only, network-isolated sandbox.

Run the bridge tests with permission to create Unix sockets, start processes and use Bubblewrap/user namespaces. A restricted execution environment may prevent those facilities. Neither these test results nor the demo establishes comparative supervisor token or cost savings.

## Native macOS follow-up

Verified the same project on a Mac mini (Apple Silicon, macOS 26.5, Node 26.10.0, Apple Git 2.50.1)
with a native Seatbelt backend. The expanded suite has 62 tests: **58 pass on macOS** with four
Linux-only skips, and **57 pass on Linux** with five macOS-only skips. There are no failures.
The real Mac/Pi/remote-model workflow passed implementation, independent verification, same-session
correction and acceptance; its 4 initial and 7 corrected tests passed independently.
See [Mac setup and acceptance results](MACOS.md) and [recorded results](mac-demo/result.json).
