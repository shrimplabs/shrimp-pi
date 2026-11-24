---
name: shrimp-pi
description: Delegate a self-contained coding task to a persistent Pi worker running in an isolated sandbox via the `shrimp-pi` CLI, then supervise it — wait, review the real diff, correct it, accept, and merge. Use when the user asks to delegate, offload, or hand work to a worker/Pi/shrimp, to run coding tasks in parallel or in the background, or mentions shrimp-pi.
---

# Supervising Pi workers with shrimp-pi

`shrimp-pi` runs a Pi coding agent on a **private clone** of a repository, inside a sandbox, as a
detached worker that persists between commands. You are the supervisor: you write the task, wait,
judge the result from evidence, correct it, and decide what gets merged. The worker never touches
the source repository, and the bridge never merges, pushes, or deletes anything.

Every command prints one JSON document on stdout (errors: JSON on stderr, exit 1). Most responses
include `next`: the commands that make sense from the current state. `shrimp-pi help` is the full
reference.

## Before spawning

- The repo must have at least one commit. The worker starts from **HEAD**: uncommitted changes in
  the source repo are not copied. Commit (or tell the user) first if they matter.
- Config is found automatically (`--config`, then `$SHRIMP_PI_CONFIG`, then
  `~/.config/shrimp-pi/config.json`). Pass `--config` only for a different model/endpoint.
- Write the task to a file. Workers do best with: the goal, concrete acceptance criteria
  (including which test command must pass), constraints, and "if unclear, report blocked with a
  question instead of guessing". Name the files involved when you know them.

## The loop

```sh
shrimp-pi spawn --repo /abs/path/to/repo --task /abs/path/task.md [--label "short name"]
# → keep workerId and revision from the output

shrimp-pi wait <id> --timeout 300 --after <revision>
```

`wait` blocks until the worker needs attention — never poll with `status` in a loop. Always pass
`--after` with the latest `revision` you have seen, or you will get the same event back again.
`"outcome": "timed_out"` is normal (exit 0): the worker is still running; wait again. Run `wait`
with a Bash timeout longer than `--timeout`, or in the background.

Then act on `state`:

| state | meaning | do |
| --- | --- | --- |
| `RUNNING` | still working (timed out) | `wait` again with the same `--after` |
| `REVIEW_REQUIRED` | worker says it is done | **review** (below) |
| `BLOCKED` | worker asked a question, or `reason: missing_report` | read `attention.message` / `report.questions` (or `lastAssistantText` in `status`), then `steer` with the answer |
| `BLOCKED`, `reason: output_truncated` | the model's reply hit its output-token limit (thinking included) before it finished | `steer` it to work in smaller steps (write big files in pieces, keep thinking short); for new workers raise `modelOptions.maxTokens` |
| `FAILED` | daemon died, provider error, run timeout | read `attention.reason`/`lastError`; `recover <id>` then `steer` with "resume: …". A `provider_error` usually means the endpoint is down — check it before resuming |
| `COMPLETED` / `STOPPED` | terminal | nothing more; spawn a new worker for new work |

After every `steer`, `wait` again with the new revision.

## Review: trust the diff, not the worker

```sh
shrimp-pi review <id>
```

- `agentClaims` is the worker's own report and is **untrusted** — treat it as a summary to check,
  never as evidence.
- The evidence is `diffPath` (full patch measured by the bridge, including uncommitted and
  untracked files), `filesChanged`, `commits`, and `evidence.commands` (what the worker actually
  ran). Read the diff. If `diffTruncated` is true, read the patch file.
- Re-run the tests yourself in the worker's workspace (`workspaceDir` from `status`), e.g.
  `cd <workspaceDir> && npm test`. A claimed "tests pass" means nothing until you see it.
- Check the diff against the task's acceptance criteria and for unrelated changes.

If it is not right, correct it in the **same session** — the worker keeps its full context:

```sh
shrimp-pi steer <id> --message "The empty-input case still throws; return [] instead and add a test."
# or --message-file for longer feedback
```

Be specific: what is wrong, where, and what done looks like.

## Accept and merge

Only when you have verified the work:

```sh
shrimp-pi accept <id> --note "diff reviewed; npm test passes (12/12)"
```

`accept` only records the decision. Merging is a separate step — do it only if the user wants the
change in their repository, and follow their branch conventions:

Workers are told to commit their work on `shrimp-pi/<id>` before reporting, so the branch is
normally ready. Stop the worker first so nothing changes underneath you, and confirm the
workspace is clean — anything `status` lists is not on the branch yet:

```sh
shrimp-pi stop <id>
git -C <workspaceDir> status --short
# only if something is listed (e.g. the worker skipped the commit):
#   git -C <workspaceDir> add -A && git -C <workspaceDir> commit -m "<summary of the task>"
git -C /abs/path/to/repo fetch <workspaceDir> shrimp-pi/<id>:shrimp-pi/<id>
git -C /abs/path/to/repo merge --no-ff shrimp-pi/<id>     # or review/cherry-pick as preferred
```

## Other commands

- `status <id>` — full state, the model it runs on (`model`), paths (`workspaceDir`, logs), usage, daemon liveness.
- `stop <id>` — abort and end the worker; all work and logs are kept.
- `list` — every worker in the state directory.

## Rules

- Never `accept --force` or accept work you have not verified from the diff and your own test run.
- Do not tell the user a task is done because the worker said so; report what you verified.
- Several workers can run at once (one per task); track each `workerId` and its revision.
- For several tasks with an order between them (a milestone, a multi-part feature), use the
  `milestone` skill that ships next to this one: it keeps the plan and gates every merge.
- Workers have outbound network access but cannot see the user's home directory, the source
  repo, credentials, or other workers. Do not put secrets in task files.
- Nothing is cleaned up automatically. When the user is finished with a worker, `stop` it; its
  directory under `~/.local/state/shrimp-pi/workers/<id>` can be deleted after the branch is
  merged or discarded. Ask before deleting work that was never merged.
- If a command fails with `access_context_mismatch`, run it from the same environment (host,
  sandbox, user) that spawned the worker.
