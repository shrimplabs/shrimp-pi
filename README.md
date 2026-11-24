# shrimp-pi

Run persistent [Pi](https://github.com/earendil-works/pi) coding workers for **any** supervisor:
Codex, Claude, Vibe, a CI job, or a human at a shell. The bridge is a small TypeScript CLI plus
one detached daemon per worker. There is no supervisor SDK, no build step, and no dependency
on npm packages. Git, Pi, and Bubblewrap are required system tools.

```
supervisor (Codex / Claude / Vibe / you)
    │  JSON in, JSON out, exit codes
    ▼
shrimp-pi CLI ──Unix socket──▶ worker daemon ──JSONL RPC──▶ pi --mode rpc (child)
    │                                │                          │
    │                                ▼                          ▼
    └── status/wait/review     state.json, logs,          isolated git clone
        reports live here      session.jsonl              on shrimp-pi/<uuid>
```

## Requirements

- Node **>= 22.18** (built-in TypeScript type stripping; nothing is compiled). `node` does not
  have to be on `PATH` — the launcher honours `SHRIMP_PI_NODE`.
- Linux with [Bubblewrap](https://github.com/containers/bubblewrap), or macOS with the built-in
  `/usr/bin/sandbox-exec` (Seatbelt). The default backend follows the host platform.
  Without a working native backend the bridge **refuses to start a worker** unless you pass
  `--no-sandbox` for a trusted caller, or configure an external sandbox launcher.
- Pi **1.5.0**, tested here. Other versions need the same RPC commands, flags, and
  `agent_settled` event; RPC mode alone is not sufficient compatibility.
- A git repository with at least one commit.

## Install

```sh
npm install -g @earendil-works/pi-coding-agent@1.5.0
ln -s "$PWD/bin/shrimp-pi" ~/.local/bin/shrimp-pi    # any directory on PATH; npm link also works

mkdir -p ~/.config/shrimp-pi
cat > ~/.config/shrimp-pi/config.json <<'JSON'
{ "model": "<model-id>", "baseUrl": "http://<inference-host>:<port>/v1" }
JSON
```

That is a complete config: Pi is found automatically and the sandbox follows the platform.
The same file works on any machine with Pi installed. See [Configuration](#configuration).

## Quick start

```sh
export SHRIMP_PI_NODE=/opt/node/bin/node          # only if node is not on PATH
export SHRIMP_PI_HOME=$HOME/.local/state/shrimp-pi # optional, this is the default
export SHRIMP_PI_API_KEY=...                       # only if your config names apiKeyEnv

shrimp-pi spawn --repo /path/to/repo --task examples/task.md
# → { "ok": true, "workerId": "6f0c…", "state": "RUNNING", "disposition": "started", … }

shrimp-pi wait   6f0c… --timeout 300 --after 2      # long-poll, no polling loop
shrimp-pi status 6f0c…
shrimp-pi review 6f0c…                              # bridge-measured diff + agent claims
shrimp-pi accept 6f0c… --note "tests pass locally"  # records acceptance; merges nothing
```

Every command prints one JSON document on stdout and errors as JSON on stderr with exit code 1.
A `wait` timeout is a normal outcome (`"outcome":"timed_out"`, exit code 0) so supervisors can
loop safely.

## Using it from an AI supervisor

[`skills/shrimp-pi/SKILL.md`](skills/shrimp-pi/SKILL.md) teaches an agent when to delegate and
how to supervise: the `wait --after` loop, what to do in each state, reviewing the bridge-measured
diff instead of trusting the worker's claims, correcting in the same session, and merging.

```sh
ln -s "$PWD/skills/shrimp-pi" ~/.claude/skills/shrimp-pi   # Claude Code
ln -s "$PWD/skills/shrimp-pi" ~/.codex/skills/shrimp-pi    # Codex
```

Other agents can be pointed at the same file from their `AGENTS.md` or system prompt.

## Milestones: one plan, many workers

One worker handles one task. For work that is several tasks with an order between them,
[`skills/milestone/SKILL.md`](skills/milestone/SKILL.md) makes the supervising agent the lead
of a whole milestone: it plans the work as a task graph, hands every ready task to a worker,
and records how each one ended. `skills/milestone/taskgraph.py` keeps the plan in `.milestone/`
inside the project (ignored by git) and applies the rules that change it:

- Tasks that do not depend on each other run side by side; two tasks that name the same file
  are put in sequence.
- A worker's commits reach the project only through `done --from <its clone>`: brought up to
  date with the project, the project's check run on them, then a fast-forward. A refusal
  records nothing, and the worker is still there to be steered with the reason.
- A failed task is tried again with the failure in its brief, then gets a research task in
  front of it, then waits for the user. A blocked task waits for the user's reply without
  spending an attempt. A task that ran out of room hands the rest to a continuation.

```sh
ln -s "$PWD/skills/milestone" ~/.claude/skills/milestone   # next to the shrimp-pi skill
```

The script needs Python 3.9+ and git and nothing from this repository's Node code, so the same
skill also drives a harness's own sub-agents in git worktrees with no Pi worker involved. Its
tests run with `npm run test:milestone` (needs `pytest`).

## Supervisor loop (shell)

```sh
ID=$(bin/shrimp-pi spawn --repo "$REPO" --task task.md --config config.json | jq -r .workerId)
REV=1
while :; do
  OUT=$(bin/shrimp-pi wait "$ID" --timeout 300 --after "$REV")
  STATE=$(jq -r .state <<<"$OUT"); REV=$(jq -r .revision <<<"$OUT")
  case "$STATE" in
    REVIEW_REQUIRED) bin/shrimp-pi review "$ID" | jq '{diffPath, agentClaims, filesChanged}' ;;
    BLOCKED)         bin/shrimp-pi steer "$ID" --message "answer: …" ;;   # then keep waiting
    FAILED)          bin/shrimp-pi recover "$ID" && bin/shrimp-pi steer "$ID" --message "resume: …" ;;
    COMPLETED)       break ;;
    STOPPED)         break ;;
    *) sleep 5 ;;
  esac
done
```

## Commands

| Command | What it does |
| --- | --- |
| `spawn --repo --task --config` | Create a worker: unique directory, private `git clone --no-hardlinks` at HEAD on branch `shrimp-pi/<uuid>`, detached daemon, Pi RPC child, task prompt. |
| `status <id>` | State, revision, attention, runs, tool evidence, usage, observation metrics, daemon/process liveness, paths, next actions. |
| `wait <id> [--timeout s] [--after rev]` | Event-driven long poll. Answers immediately when attention already exists; `--after` requires an attention event raised after that revision. |
| `steer <id> (--message \| --message-file)` | Correction. Uses Pi `streamingBehavior: "steer"` while running, an idle prompt on the same session when idle, and relaunches the child if it died. |
| `review <id>` | Independent review: bridge-run git diff (commits vs the original base, uncommitted edits, untracked contents) + agent claims labelled untrusted + observed tool evidence. Writes `report.json`, `report.md`, `diff.patch` outside the workspace. |
| `accept <id> [--note] [--force]` | Records supervisor acceptance (`COMPLETED`). Never merges, never deletes. |
| `stop <id>` | Abort, close stdin, then TERM/KILL the process group. Preserves all work. Ends the daemon. |
| `recover <id>` | After a crash: reopen the **same** session file, report interrupted work, replay nothing; then `steer` to resume. |
| `list` | Summarise every worker in the state directory. |

Aliases exist for callers that prefer them (`spawn_worker`, `worker_status`, `steer_worker`,
`wait_for_worker`, `review_worker`, `stop_worker`, `recover_worker`, `accept_worker`).
`shrimp-pi help` documents every option.

## Configuration

`spawn` reads the first config it finds:

1. `--config <file>`
2. `$SHRIMP_PI_CONFIG` (an error if set but missing — never a silent fallback)
3. `$XDG_CONFIG_HOME/shrimp-pi/config.json`, i.e. `~/.config/shrimp-pi/config.json` by default

Only `model` is required (plus `baseUrl` for a real endpoint). Each worker stores a snapshot of
its config at spawn, including the Pi it was started with, so `recover` and restarts keep using
the same installation and later edits only affect new workers. Every field
([`examples/config.json`](examples/config.json) shows them all):

| Field | Meaning |
| --- | --- |
| `piCommand` | Optional. argv array that starts Pi, e.g. `["/opt/node/bin/node","/opt/pi/…/dist/bundle/cli.js"]`. When omitted, the bridge follows `pi` on `PATH` (or the global install next to its own Node) to the `@earendil-works/pi-coding-agent` package and runs its bundle with the bridge's Node; versions other than 1.5.x produce a warning. |
| `provider`, `model`, `api`, `baseUrl`, `modelOptions` | Used to **generate** an isolated `models.json` for the worker. Nothing from `~/.pi` is read. |
| `apiKeyEnv` | **Name** of the environment variable holding the endpoint key. Only the name is stored; the value is never written to disk and never appears in `argv`. |
| `runtimePaths` | Extra read-only binds for the Pi install (the Node directory is added automatically). |
| `thinkingLevel`, `noContextFiles`, `extraPiArgs` | Extra control over the Pi command line. Project `AGENTS.md` stays enabled unless `noContextFiles` is set. |
| `envAllowlist` | Additional environment **names** the worker may inherit. Nothing else is copied. |
| `sandbox.mode` | `bubblewrap` (Linux default), `seatbelt` (macOS default), `external` (with `sandbox.launcher`), or `disabled` (needs `--no-sandbox`). |
| `sandbox.minimalEtc` | Default `true`: bind only DNS/cert/passwd files from `/etc`. `false` binds all of `/etc` read-only. |
| `limits.*` | `toolFailureThreshold`, `waitTimeoutSeconds`, `maxWaitSeconds`, `runTimeoutSeconds`, `spawnAckSeconds`, `maxEvidence`. |

## What the worker can and cannot see

Inside the bubblewrap sandbox the worker gets: its workspace copy, its own
`PI_CODING_AGENT_DIR` (session file), an isolated `HOME`, `/usr` + `/etc` (minimal) + `/proc` +
`/dev` + `tmpfs /tmp` read-only, and the Pi/Node runtime paths read-only. It does **not** get:
your home directory, the source repository, the bridge state directory (socket, logs, config),
any credential socket, or any environment variable that is not allowlisted.

Known limitations, stated plainly:

- **Workers have unrestricted outbound IP access** to reach inference and development services.
  Linux shares the host network namespace; macOS allows outbound IP connections but blocks
  supervisor Unix sockets. Independent Git review disables networking on both platforms.
- macOS support is verified on Apple Silicon with macOS 26.5 and 27.2. Intel and older macOS versions
  have not been tested. Apple deprecates `sandbox-exec`; startup probes fail closed if the
  executable or required policy features are unavailable.
- Host-side `git clone`/`checkout` of the repository you pass to `spawn` runs that repository's
  smudge filters like any local checkout would (hooks, external diff, textconv, fsmonitor, and
  user/system config are disabled for every bridge git invocation).
- The bridge never merges, pushes, deletes, or cleans up. Branches, workspaces, logs and session
  files stay on disk until you remove them.

Independent Git review runs in a separate **read-only sandbox with networking disabled**.
This also contains executable Git content filters configured by a worker. The original repository
you explicitly supply at spawn is treated as trusted for clone/checkout.

## Security posture

- Worker ids are UUIDs; anything else is rejected before a path is built.
- `state.json` is written atomically with a monotonic `revision`; mutations are lock-serialised.
- The daemon socket is `0600` inside a `0700` worker directory; the worker cannot reach it.
- Liveness diagnosis refuses to touch state or send signals when it cannot see the daemon
  (foreign PID/socket namespace, `EACCES`/`EPERM`): it returns `access_context_mismatch`.
  Run supervisor commands from the same context that spawned the worker.
- Agent output is untrusted input: the report is parsed, bounded, and always labelled
  `UNTRUSTED AGENT CLAIMS` in reviews. A missing report is never treated as success.
- Costs and test totals are never invented: token counts come from Pi when available, `costUsd`
  stays `null` unless a provider-billed figure with provenance exists, `metrics.testsPassed` /
  `metrics.testsFailed` / `metrics.supervisorTokens` stay `null`, and observed commands are
  listed verbatim instead of summarised.

## Troubleshooting

| Symptom | Where to look |
| --- | --- |
| `bubblewrap unavailable, refusing to start unsandboxed` | Unprivileged user namespaces are disabled (`kernel.unprivileged_userns_clone`, seccomp policy) or `bwrap` is not installed. |
| `access_context_mismatch` | You are running the CLI in a different PID/socket namespace or with different permissions than the spawn. Re-run it where you spawned the worker. |
| `state: FAILED`, `reason: daemon_lost` | The daemon died. `recover <id>` then `steer <id> --message "resume: …"`. |
| `state: BLOCKED`, `reason: missing_report` | The agent settled without the JSON report; read `lastAssistantText` in `status` and steer it. |
| `state: BLOCKED`, `reason: output_truncated` | The model's reply hit its output-token limit (`modelOptions.maxTokens`, thinking included) before it could report. Steer it to work in smaller steps, or raise the limit for new workers. Workers are told their limit in the task prompt. |
| Worker seems stuck | `status <id>` shows `daemon.responsive`; raw frames are in `<worker>/logs/rpc-pi-*.jsonl` and `pi-stderr.log`. |

Development: `node --test test/*.test.ts` (tests create their own temporary repositories and
never touch `/workspace`). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Verified on this machine

Start from `examples/linux-remote.json` and fill in your inference endpoint and model (set `piCommand` only to pin a specific Pi install).
The launcher finds Pi's bundled Node automatically if Node is absent from PATH.
[Verified demonstration](docs/VERIFIED_DEMO.md) records the real implementation, review,
and correction workflow and includes reproducible parser code with 25 passing tests.

```sh
./bin/shrimp-pi spawn --repo /absolute/path/to/a/committed/repo --task examples/task.md --config examples/linux-remote.json
```

## macOS

The same CLI supports worker isolation, independent Git review, correction, stop, and recovery.
See [Mac setup and verified results](docs/MACOS.md). Start with `examples/config.macos.json`
and set the endpoint and model; Node and Pi are found automatically. `sandbox.mode` defaults to `seatbelt` on
macOS, so no external launcher or Linux VM is required.
