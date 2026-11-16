# Architecture

## Design goal

Give any supervisor process a durable, auditable, sandboxed Pi worker without making the
supervisor install anything, speak a protocol, or trust the agent's own claims. Everything the
supervisor needs is a CLI that prints JSON; everything the worker needs is a private copy of the
repository and a Pi RPC child it never has to babysit.

## Components

| Piece | Lifetime | Responsibility |
| --- | --- | --- |
| `src/cli.ts` | one process per command | argument parsing, JSON output, git setup, sandbox validation, daemon launch, read-only diagnosis, review generation |
| `src/daemon.ts` → `src/lib/daemoncore.ts` | one detached process per worker | owns the Pi child, the Unix socket, the run state machine, the event pump |
| `src/lib/rpc.ts` | inside the daemon | Pi child process: LF framing, id correlation, backpressure, stderr capture, shutdown escalation |
| `src/lib/state.ts` | pure functions | state machine, atomic `state.json`, attention, bounded history |
| `src/lib/worker.ts` | shared | socket client, liveness diagnosis, detached launch, lock-protected mutations |
| `src/lib/git.ts` | host side | hardened git inspection and the private clone |
| `src/lib/sandbox.ts` | host side | bubblewrap argv, startup probe, fail-closed decisions |
| `src/lib/report.ts` | CLI side | review document: git facts + untrusted claims + observed evidence |
| `src/lib/metrics.ts` | pure function | observation-only metrics (elapsed/run seconds, tool failures, retained history); `supervisorTokens`, `testsPassed` and `testsFailed` stay `null` because the bridge cannot observe them |

## State directory layout

```
$SHRIMP_PI_HOME/                     # default ~/.local/state/shrimp-pi
  workers/<uuid>/                    # 0700, unique per worker, never reused
    state.json                       # atomic, revisioned, the only durable control record
    daemon.sock                      # 0600, supervisor ⇄ daemon
    daemon.pid  pi.pid
    task.md                          # exact bytes the supervisor handed us
    config.json                      # config snapshot (names only, never secret values)
    agent/                           # worker PI_CODING_AGENT_DIR: models.json + session.jsonl
    home/                            # worker HOME
    workspace/                       # private git clone on shrimp-pi/<uuid>
    reports/r<n>/{report.json,report.md,diff.patch}
    logs/{rpc-pi-stdout.jsonl,rpc-pi-stdin.jsonl,pi-stderr.log,daemon.log,events.jsonl}
```

Reports and logs live **outside** the workspace so the worker can never edit its own review.
Nothing is ever deleted by the bridge.

## State machine

```
CREATED ─▶ RUNNING ─▶ REVIEW_REQUIRED ─▶ COMPLETED          (explicit `accept` only)
              │  ▲            │
              ▼  │            │ steer
            BLOCKED ──────────┘        ◀─ recovered (`interrupted`) after a crash
              │
RUNNING ──────┴─▶ FAILED (child exit, provider error, lost daemon) ─▶ recover ─▶ BLOCKED
any non-terminal ─▶ STOPPED (`stop`)
```

- `COMPLETED` is reachable only through `accept`, and `accept` records a decision — it never
  merges, pushes, or deletes.
- `FAILED → BLOCKED` is the only allowed escape from a terminal-looking state, and only via
  `recover`.
- Every transition bumps `revision` and appends a bounded event, so `wait --after <revision>` is
  a durable cursor that survives CLI restarts.

## Run lifecycle (what counts as "done")

The bridge follows the Pi RPC contract exactly:

1. `prompt` is sent **after** the event handler is installed; its response only reports
   `disposition` (`started` / `queued` / `handled`). `handled` means no run started.
2. `agent_end` is recorded but never ends the run: retries, compaction, steering and follow-ups
   can still follow.
3. `agent_settled` is the idle signal the bridge waits for, bounded by `runTimeoutSeconds`.
4. On settle, the last `message_end` assistant text is parsed for the structured report
   (`status: review|blocked|checkpoint`, `workCompleted`, `tests`, `decisions`,
   `outstandingProblems`, `questions`).
   - `review` → `REVIEW_REQUIRED`
   - `blocked` / `checkpoint` → `BLOCKED` with that reason
   - no parseable report → `BLOCKED (missing_report)`; a missing report is never success
   - assistant `stopReason: "error"` → `FAILED (provider_error)`
5. Tool failures are counted per run; `toolFailureThreshold` consecutive failures make the bridge
   send `abort` and mark `BLOCKED (tool_failure_threshold)`. The resulting
   `agent_settled {aborted:true}` never overwrites that reason, because the abort reason is
   recorded before the abort is issued.

## Concurrency rules

- **Ordered event pump.** Every RPC record and the child-exit notification go through one
  queue, so a tool failure can never be processed after the `agent_settled` that follows it.
- **The pump never awaits `abort`.** `abort` answers only once the session is idle, and the pump
  is what delivers that settling event — awaiting it would deadlock.
- **Run ownership.** Each run has a generation number. If the child dies, the exit handler marks
  the run cancelled and writes `FAILED` first; the run's own evaluation then detects it no longer
  owns the outcome and returns without writing.
- **Serialized mutations.** `start`, `steer`, `accept`, `stop` run through one promise chain, so
  two concurrent idle steers cannot both create a run. `status`, `ping` and long-poll `wait` are
  not serialized.
- **Cross-process writes.** `state.json` is only written through a directory lock with stale
  takeover, always read-modify-write, always atomic (temp + fsync + rename + dir fsync).

## Liveness and access context

`probeDaemon` combines a socket ping, `kill(pid, 0)`, `/proc/<pid>/cmdline` matching, and the
PID namespace recorded by the daemon (`/proc/self/ns/pid` at startup) into one of:

| verdict | meaning | callers may |
| --- | --- | --- |
| `alive` | socket answered | mutate through the daemon |
| `dead` | same namespace, process gone, socket absent/refused | record `FAILED (daemon_lost)`, recover |
| `foreign_context` | namespace mismatch, or `EACCES`/`EPERM` on the socket or pid | **nothing**: return `access_context_mismatch` |
| `unresponsive` | process alive, socket silent | report only; never signal a process we cannot identify |

This exists because a supervisor running in a restricted PID/socket namespace legitimately
cannot see a host daemon; that must never be mistaken for the worker having died.

## Sandbox contract

`bubblewrap` argv is built, never guessed:

- `--unshare-all --unshare-user --share-net --disable-userns --die-with-parent --new-session`
- `--dev /dev` (fresh minimal devtmpfs, not the host devices), `--proc /proc`, `--tmpfs /tmp`
- `/usr` read-only plus merged-usr symlinks (`/bin`, `/lib`, `/lib64`, `/sbin`)
- minimal `/etc` by default (resolv.conf, hosts, nsswitch, passwd, group, certs, timezone)
- read-only: `runtimePaths`, the Pi install directory, the Node directory
- writable: only `workspace/`, `agent/`, `home/`
- **no `--clearenv`/`--setenv`**: the sanitized environment is applied to `spawn()` so the
  endpoint key never appears in the process list
- `--die-with-parent` is the parent-death strategy: if the daemon is killed, the sandbox and Pi
  child die with it

Availability is proven by actually starting a probe sandbox (unprivileged user namespaces can be
disabled at runtime), and any failure is fatal to `spawn` unless `--no-sandbox` was passed.

## Review generation

`review` computes everything with the bridge's own git calls:

- committed changes vs the **original base commit** (`git diff --name-status <base>` — `git
  status` alone would miss them), including both sides of a rename
- uncommitted tracked edits (the same diff covers them)
- untracked file contents via `git diff --no-index /dev/null <file>` (the index is never touched)
- gitignored paths are listed but excluded, and a truncated diff is always flagged
  (`diffTruncated` plus an explicit warning), never silently shortened

Every host git call runs with `--no-pager -c core.fsmonitor=false -c core.hooksPath=<empty>
-c core.attributesFile=/dev/null -c diff.external= -c protocol.ext.allow=never` and with
`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`, because the worker owns the clone's `.git/config` and must
not be able to execute anything on the host through it.

## Testing strategy

`node --test test/*.test.ts` — 62 tests across Linux and macOS, no npm dependencies:

- unit: framing (LF only, U+2028/U+2029, overflow), ids, state machine, config, env allowlist,
  bwrap argv, git hardening, diff semantics
- rpc: id correlation under out-of-order answers, malformed frames, flush-on-close, forced
  stdin backpressure (1500 records, exactly-once), shutdown escalation
- lifecycle/attention/crash/concurrency/access: real CLI processes, detached daemons, temp git
  repositories, and a fake Pi peer that speaks the real framing
- sandbox: real bubblewrap probes, skipped automatically when user namespaces are unavailable

## Independent Git inspection boundary

Worker-controlled Git configuration can run clean/process content filters even when external
diff, textconv, hooks and fsmonitor are disabled. Therefore all review-time Git calls run in a
separate Bubblewrap sandbox with only the worker clone mounted read-only, a minimal system
view, sanitized environment, and an unshared network namespace. Startup failures abort review
instead of producing an empty successful diff. Inspection selects Linux Bubblewrap or macOS Seatbelt automatically, including when an
external launcher runs the worker. Both backends refuse unsandboxed inspection. Source-repository
clone and checkout occur before any worker runs and treat the explicitly supplied source as trusted.

## macOS backend

`seatbelt.ts` generates a default-deny profile for `/usr/bin/sandbox-exec`. Read access covers
system runtime files, the selected Xcode toolchain, public Homebrew OpenSSL configuration and
certificates, configured runtime roots, and the worker's own directories. Writes are limited
to the private clone, isolated agent directory, HOME and TMPDIR. Paths are canonicalized
(including `/var` symlinks) and policy strings reject control characters and escape quotes.
Metadata access is broader than content access; this is a Seatbelt policy, not a container.

Workers may use outbound IP networking but cannot connect to supervisor Unix sockets. The one
Unix socket they may reach is `/private/var/run/mDNSResponder`: macOS `getaddrinfo()` resolves
every hostname through it, so without it workers could only reach endpoints by IP address. Review
gets no writable roots and no network permissions, and therefore no name resolution. It resolves the real Apple Git executable
before entering the sandbox so the xcrun shim does not need writable cache access.

Apple's installed `dyld-support.sb` supplies version-specific loader permissions where available.
Startup probes execute Node code (not only `--version`) to catch runtime configuration denials.
No user Keychain, SSH-agent, Apple Events, or broad Mach-service grants are added.
Unlike Linux PID namespaces, Seatbelt does not contain process ancestry: deliberately
double-forked/reparented background daemons are outside the guard's descendant tracking.

`group-guard.ts` runs outside the sandbox with a sanitized environment, in the worker's detached
process group. It receives the owning daemon PID and kills its descendant tree and process group if reparented,
including the daemon-death-before-guard-start race. It owns the input pipe and checks
upstream EOF before forwarding it to Pi, preserving child ancestry long enough to clean up
separate tool process groups. Graceful stop still uses the common RPC
abort, stdin close, TERM and KILL path. A short private hashed socket path handles macOS's
104-byte Unix-socket limit and long `/var/folders` temporary directories.
