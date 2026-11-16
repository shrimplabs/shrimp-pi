# macOS implementation

The complete workflow is supported with native Seatbelt isolation: spawn, status, event-driven
wait, correction in the existing session, independent Git review, acceptance, stop and recovery.
The supervisor interface is unchanged for Codex, Claude, Vibe and other shell-capable agents.

## Setup

1. Install Node >=22.18, Git and Pi 1.5.0. Xcode Command Line Tools or Xcode supplies Apple Git.
   Pi can be installed with `npm install -g @earendil-works/pi-coding-agent@1.5.0`.
2. Copy `examples/config.macos.json` to `~/.config/shrimp-pi/config.json` and set the endpoint
   and model. Pi is found from `pi` on `PATH` (Homebrew on Apple Silicon or Intel, nvm, or any
   npm prefix); set `piCommand` only to pin a specific installation.
3. Run the same commands as on Linux (`--config` is optional once the default file exists):

```sh
./bin/shrimp-pi spawn --repo /absolute/path/to/repo --task examples/task.md --config examples/config.macos.json
./bin/shrimp-pi wait WORKER_UUID --timeout 300
./bin/shrimp-pi review WORKER_UUID
./bin/shrimp-pi steer WORKER_UUID --message "Fix the failing test"
```

`seatbelt` is the default on macOS. There is no Linux dependency or automatic unsandboxed
fallback. The launcher also finds Homebrew Node when Node is absent from PATH. Pi's personal
configuration and credentials remain separate from the worker's generated agent directory.

## Verified on real hardware

Tested on **a Mac mini, Apple Silicon, macOS 26.5**, Node 26.10.0, Pi 1.5.0 and Apple Git 2.50.1.
The full suite passed **58 tests**, with **4 Linux-only tests skipped**. Native tests verify
file-content isolation, symlink escapes, outbound IP versus Unix-socket access, network-free
Git review, Git content-filter containment, daemon-death cleanup, recovery, and the full
worker lifecycle through a correction.

A real Mac → bridge → Pi → remote-model run also passed:

- Worker implemented finite-number addition, with **4 tests** independently rerun.
- Supervisor reviewed the changes and requested optional-offset support.
- Worker continued in the **same Pi process and session**, with **7 updated tests** independently
  rerun plus extra supervisor assertions.
- Acceptance recorded `COMPLETED`; the original repository was unchanged.

[Machine-readable results](mac-demo/result.json), generated implementation and test output are
retained in `docs/mac-demo/`. The model was locally hosted.
Pi was installed only into a temporary test directory; personal Pi configuration was not edited.

Reproduce with a configured endpoint (this starts real model work):

```sh
node examples/native-mac-demo.mjs /absolute/path/to/config.json
```

## Boundaries

Seatbelt denies file contents by default, allows only explicit runtime/system/worker roots,
and restricts writes to the worker's directories. Unix sockets (except the system
`mDNSResponder` socket, which hostname resolution requires), user Keychain, SSH-agent
access and Apple Events are not granted. Workers have outbound IP access; review has no
network and no writable workspace. See [architecture](ARCHITECTURE.md) for implementation details.

Apple deprecates `sandbox-exec` and marks its system policy interfaces private. The bridge probes
the actual runtime and refuses to start if the sandbox is unavailable. Intel and older macOS
versions remain untested. No token or cost savings are claimed by these acceptance tests.
