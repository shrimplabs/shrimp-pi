---
name: milestone
description: Lead a larger piece of work (a milestone, a multi-part feature, a big refactor) by planning it as a task graph and running sub-agents on it, one per task, each in its own git worktree. Use when the user asks for work too large for one sitting and wants it driven to the end, e.g. "let's do the whole 0.3 milestone", "work through this list with sub-agents". Not for a single change or a quick fix.
---

# Milestone

You are the lead on a piece of work that is too big for one agent in one
sitting. You plan it as tasks with dependencies, hand each task to a
sub-agent, read how each one ended, and keep the plan true to what actually
happened. The user wants to describe the milestone once and then hear from
you only when something needs them, and at the end.

The plan lives on disk, not in your head. `taskgraph.py`, in the same folder
as this file, keeps it in `.milestone/` inside the project (ignored by git)
and applies the rules that change it. Call it from anywhere in the project:

```
G="python3 <folder of this skill>/taskgraph.py"
$G status
```

It needs Python 3.9+ and git, nothing else. Every command prints what it did
and what can happen next, so read its output instead of keeping your own list.

If `$G status` shows a milestone already in progress, you are resuming: go
to "Picking up again" below.

## 1. Plan

Read enough of the project to plan honestly: what exists, how it is tested,
what the milestone needs. Then:

1. Find the command that tells you the project still works (its test suite,
   a build, a linter) and start the milestone with it:
   `$G init "<milestone>" --check "<command>"`. The check runs inside a
   task's worktree before its branch is merged, so it must work from a fresh
   checkout; `$MILESTONE_ROOT` points at the main checkout if it needs
   something that is not in git (a virtualenv, an installed dependency
   folder). If the check already fails, `init` says so: make fixing it the
   first task. With no usable check, leave it out and review each branch
   yourself before recording it done.
2. Write the tasks to a JSON file and add them in one call:
   `$G add --file tasks.json`

```json
[
  {"title": "Parse the config file", "desc": "…", "files": ["src/config.py", "tests/test_config.py"],
   "done_when": "tests/test_config.py passes and covers a missing file"},
  {"title": "CLI reads the config", "desc": "…", "files": ["src/cli.py"], "depends_on": [0]}
]
```

What makes a good task:

- **One agent, one run.** A task that needs more than a few files and a
  clear head is two tasks.
- **A description a stranger can act on.** The sub-agent sees only its
  brief: what to build, where, how it connects to the rest, what done looks
  like (`done_when`).
- **`depends_on` only where it is real.** It takes positions in the same
  list (0-based). Independent tasks run side by side, which is the point.
- **`files` filled in.** Two tasks that name the same file or folder are put
  in sequence automatically, so they cannot collide in a merge. Leave
  `files` empty only when you really do not know.
- `"type": "research"` for a question that must be answered before work can
  be planned. A research task changes nothing; its summary is handed to the
  tasks that depend on it.

Show the user the plan in a few lines (`$G status`) and start. Ask first
only when the milestone leaves a real choice open that is theirs to make.

## 2. Run

Repeat until `$G status` says all tasks are done, or that nothing can run
until the user answers:

1. `$G ready` lists the tasks that can start now, no more than the parallel
   limit allows.
2. For each one, `$G start <id>`. This creates the task's worktree and
   branch and prints its brief. Start a sub-agent with **that brief, whole
   and unchanged, as its prompt**. The brief already carries the worktree
   path, the check, what earlier tasks produced, earlier failures and how to
   end. Add nothing that contradicts it; if a task needs extra guidance, put
   it there with `$G note <id> "<text>"` before starting.
3. Wait for a sub-agent to finish. Do not poll or watch them work.
4. Read its final message and record the outcome (next section).
5. Go to 1.

Starting sub-agents:

- **Claude Code:** the Agent tool, one call per task, several in one message
  when several tasks are ready. They run in the background and you are woken
  when one finishes. Do not use the tool's own worktree isolation; the brief
  names the worktree. Sub-agents do not need your model: a mid-tier model is
  the usual choice for well-described tasks.
- **Other harnesses:** whatever starts a separate agent run with a prompt
  (a sub-agent tool, or a headless run of the same CLI started in the
  task's worktree). If only one can run at a time, `$G set max_parallel 1`.
- **Sandboxed workers that get their own clone** (Pi workers through
  shrimp-pi): see "Workers in their own copy" below.

## 3. Record how each task ended

Every sub-agent ends with an `OUTCOME:` block. Record it with one command.
You are the one thing in this loop that can read, so do not record what the
agent claims without looking: for `done`, glance at what it changed
(`git -C <worktree> log --stat <main branch>..`) when the summary is vague
or the task was risky.

| The agent says | You run | What changes |
|---|---|---|
| done | `$G done <id> --summary "<what changed>"` | Its branch is brought up to date with the project, the check is run on it, and the project moves forward to it. Tasks waiting on it become ready. |
| failed | `$G fail <id> --why "<what was tried and what happened>"` | Tried again with the failure in the next brief. After 3 failures a research task is put in front of it; if it still fails after that, it waits for the user. |
| blocked | `$G blocked <id> --why "<what it needs>" --done "<…>" --left "<…>"` | Held, no attempt spent. Tasks after it keep waiting. Tell the user (below). |
| continue | `$G continue <id> --summary "<done so far>" --left "<what is left>"` | What exists is checked and merged; a new task takes the rest and everything that waited on the old task waits on the new one. |

`done` and `continue` can refuse (exit code 2) and record nothing: the
branch has uncommitted work, conflicts with the project, or fails the
check. The project is untouched when that happens. The message says why;
normally you pass that reason to `$G fail <id> --why "…"`, and the next
attempt gets the same worktree and the reason. If the reason is not the
agent's fault (the check itself is broken), fix that instead.

A sub-agent that ends without an `OUTCOME:` block, or crashes, is a `fail`
with what you can see as the reason.

Things the graph cannot know and you can:

- **NOTICED.** When a report lists a problem outside its task, decide: a
  new task (`$G add "<title>" --desc … --files … --after <id>`), or nothing.
- **A merged task turns out wrong.** `$G insert-fix <id> --title "<what to
  fix>" --desc "…"` puts a fix between that task and everything after it.
  It is expected to touch the same files as the task it fixes; name them
  with `--files` when the fix reaches further.
- **A problem that was fixed comes back.** Add it with `--same-as <the task
  that fixed it>`. The new brief then shows what was already tried, and the
  second time it comes back a research task runs first.
- **The plan was wrong.** Change it: `$G add`, `$G cancel <id> --why …`,
  `$G dep add|rm <id> <dep>`. A plan that no longer matches the work is worse
  than a changed plan.
- **The same failure twice.** Before a third attempt, read the two reasons.
  If the task description is the problem, fix the description with a note
  or split the task; another identical attempt teaches nothing.

## 4. Talking to the user

Blocked reports are the main thing the user needs to see, and they are
worth relaying exactly. An agent that says "I could not do this because X
is missing" has done its job; do not send another agent to work around X,
and do not solve it yourself by lowering the bar.

When a task is held, tell the user in a few lines: which task, what was
done, what is left, what is needed. Keep running whatever else is ready
while you wait. When they answer: `$G unblock <id> --reply "<their answer>"`
and the next agent on that task starts from the report and the reply.

If several things need the user, bring them together in one message.

Otherwise stay quiet while it runs. At the end, report: what was built
(task by task, one line each), what is still held and why, anything the
agents noticed that you did not act on, and where the record is
(`.milestone/`, branches `milestone/<id>`).

## Workers in their own copy (shrimp-pi)

A sandboxed worker cannot work in the task's worktree: it gets a private
clone of the project and sees nothing else on the machine.
[shrimp-pi](https://github.com/shrimplabs/shrimp-pi), which this skill ships
with, runs Pi coding agents this way, so a milestone can hand its tasks to
another model (a cheaper or a local one) while you stay the lead. The
`shrimp-pi` skill explains its commands; this is how they fit the loop. You
can mix: `--copy` is chosen per start.

**Start.** `$G start <id> --copy --json` gives a brief that names no path
and leaves the format of the final report to the worker's own system. Save
the brief to a file and spawn from the task's worktree, not from the
project:

```
shrimp-pi spawn --repo <worktree from the json> --task <brief file> --label <id>
```

The worktree holds everything merged so far plus whatever earlier attempts
at this task left. The label lets `shrimp-pi list` tell you later which
worker belongs to which task. A research task has no worktree: spawn it
from the project folder.

The shell that spawns must export the variable the shrimp-pi config names
as `apiKeyEnv`; a worker without it fails its first model call.

**Wait** with `shrimp-pi wait <worker> --timeout 300 --after <revision>`,
in the background when several workers run.

**Record.** Read `shrimp-pi review <worker>`: the diff and the commands it
ran are measured, the worker's own report is a claim. Then:

| The worker | You run |
|---|---|
| reports its work ready for review | `$G done <id> --summary "…" --from <workspaceDir>` |
| reports a checkpoint: more than one run | `$G continue <id> --summary "…" --left "…" --from <workspaceDir>` |
| asks something the brief or the plan answers | `shrimp-pi steer <worker> --message "…"`, wait again. Nothing to record. |
| is blocked on what only the user can give | `$G blocked <id> …` and tell the user. After `$G unblock`, `$G start <id> --copy` and steer the same worker with the reply; spawn a new one only if it is gone. |
| tried and says it does not work | `$G fail <id> --why "…"` |
| died (`FAILED`: daemon lost, provider error, timeout) | Not the task's fault. `shrimp-pi recover <worker>` and steer it to resume; if that fails, `$G release <id>`, which spends no attempt. |

`--from` brings the worker's commits onto the task's branch, then the usual
gate runs: up to date with the project, check, merge. If it refuses
(uncommitted files, a failing check), the worker is still there with its
whole context: steer it with the refusal message (the folder it names is
the worker's current directory), wait, and record again. That costs no
attempt. Use `$G fail` when steering has stopped helping.

Once a task is recorded, `shrimp-pi accept <worker> --note "merged as <id>"`
and `shrimp-pi stop <worker>`. Its folder is kept; nothing is cleaned up
for you.

Two things differ from a worktree sub-agent: the worker cannot reach
`$MILESTONE_ROOT`, so a check that needs something outside git (a
virtualenv in the main checkout) runs only at the gate, not in the
worker; and the parallel limit should be what the model endpoint can
serve (`$G set max_parallel <n>`).

## Picking up again

The graph survives a closed session. On return, `$G status`:

- A task shown as `running` whose agent is gone: look at its worktree. If
  the work is complete and committed, record it `done`; otherwise
  `$G release <id>` returns it to the queue without spending an attempt.
- With shrimp-pi workers, `shrimp-pi list` shows which are still alive
  (the label is the task id); wait on those instead of releasing them.
- Then continue the loop in section 2.

## Reference

```
init "<title>" [--check CMD] [--max-parallel N] [--max-attempts N] [--no-worktrees]
add --file tasks.json | add "<title>" [--desc] [--type] [--after ID] [--files a,b] [--done-when] [--same-as ID]
ready [--all] [--json]        start ID [--json] [--copy]      brief ID
done ID --summary S [--no-merge] [--from DIR [--ref R]]       fail ID --why S
blocked ID --why S [--done S] [--left S]      unblock ID --reply S
continue ID --summary S --left S [--title S] [--from DIR [--ref R]]
insert-fix ID --title S [--desc S] [--files a,b]
cancel ID --why S    release ID    note ID "text"    dep add|rm ID DEP
set KEY VALUE        status [--json]    show ID      log [-n N]
cleanup              remove worktree folders of finished tasks; branches are kept
archive              put a finished milestone away so the next one can start
```

Limits worth knowing: the loop runs only while your session does; worktrees
live under `.milestone/wt/`, which a few build tools dislike (Cargo
workspaces: start with `--no-worktrees` and `max_parallel 1`); the check is
the only automatic quality gate, so its strength is the floor for the work.
