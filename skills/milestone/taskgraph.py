#!/usr/bin/env python3
"""Task graph for one milestone, kept in the project and driven by a lead agent.

The lead plans the work as tasks with dependencies, starts one sub-agent per
ready task, and records how each one ended. Recording an outcome is what
changes the graph: a failure is retried with what went wrong, a task that
keeps failing gets a research task in front of it, an unfinished task gets a
continuation its dependents move to, and a blocked task waits for the user.

Python standard library only. No server: the state is `.milestone/graph.json`
in the project's main checkout, with an append-only `.milestone/events.jsonl`.
See SKILL.md next to this file.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

DIR_NAME = ".milestone"
CLOSED = ("done", "cancelled")
DEFAULTS = {"check": "", "check_timeout": 900, "max_parallel": 3, "max_attempts": 3,
            "refile_research": 2, "worktrees": True}

ENDINGS = """How to end. All four are acceptable endings; pick the one that is true.
- done: the task is finished{committed}.
- failed: you tried and it does not work. Say what you tried and what happened; the next attempt starts from your notes.
- blocked: you cannot finish from where you are: a tool, service, file, credential or decision you do not have. Do not build a stand-in or work around it. Keep what is sound, and say what you did, what is left and exactly what you would need.
- continue: the task is bigger than one run. Keep what works and say what is left; another agent picks it up.
If you notice a problem outside this task, do not fix it. {noticed}"""

BLOCK = """End your final message with this block:
OUTCOME: done | failed | blocked | continue
SUMMARY: what you did and what changed, two or three sentences
WHY: (failed or blocked) what stopped you
LEFT: (blocked or continue) what is not done
NOTICED: anything outside this task that needs attention, or "nothing\""""


class Bad(Exception):
    """The command does not fit the graph's state (exit 1)."""


class Refused(Exception):
    """The work did not pass the merge gate; nothing was recorded (exit 2)."""


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _git(cwd, *args):
    try:
        return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    except FileNotFoundError:  # no git on this machine: behave as outside a repository
        return subprocess.CompletedProcess(args, 127, "", "git not found")


def find_root(start: Path):
    """(main checkout, is_git). The same root is found from inside any of its worktrees."""
    override = os.environ.get("MILESTONE_ROOT")
    if override:
        root = Path(override).resolve()
        return root, _git(root, "rev-parse", "--git-dir").returncode == 0
    r = _git(start, "rev-parse", "--git-common-dir")
    if r.returncode == 0:
        common = (start / r.stdout.strip()).resolve()
        if common.name == ".git":
            return common.parent, True
        top = _git(start, "rev-parse", "--show-toplevel")
        if top.returncode == 0:
            return Path(top.stdout.strip()).resolve(), True
    for d in (start, *start.parents):
        if (d / DIR_NAME / "graph.json").exists():
            return d, False
    return start, False


# ---------------------------------------------------------------- storage

class Store:
    def __init__(self, root: Path, is_git: bool):
        self.root, self.is_git = root, is_git
        self.dir = root / DIR_NAME
        self.path = self.dir / "graph.json"

    def _ensure_dir(self):
        self.dir.mkdir(exist_ok=True)
        ignore = self.dir / ".gitignore"
        if not ignore.exists():
            ignore.write_text("*\n")

    def load(self):
        if not self.path.exists():
            raise Bad(f"no milestone here ({self.path} is missing); start one with: init \"<title>\"")
        return json.loads(self.path.read_text())

    def save(self, g):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(g, indent=1) + "\n")
        os.replace(tmp, self.path)

    @contextlib.contextmanager
    def lock(self, name="lock"):
        self._ensure_dir()
        with open(self.dir / name, "w") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

    @contextlib.contextmanager
    def edit(self):
        """Load, change, save -- saved only when the block ends without an error."""
        with self.lock():
            g = self.load()
            yield g
            self.save(g)

    def event(self, kind, task="", **data):
        self._ensure_dir()
        row = {"at": now(), "event": kind, "task": task, **data}
        with open(self.dir / "events.jsonl", "a") as fh:
            fh.write(json.dumps(row) + "\n")


# ---------------------------------------------------------------- graph

def task(g, tid):
    if tid not in g["tasks"]:
        raise Bad(f"no task {tid}")
    return g["tasks"][tid]


def met(g, t) -> bool:
    return all(g["tasks"][d]["status"] == "done" for d in t["deps"] if d in g["tasks"])


def label(g, t) -> str:
    if t["status"] == "pending":
        return "ready" if met(g, t) else "waiting"
    return t["status"]


def dependents(g, tid):
    return [t for t in g["tasks"].values() if tid in t["deps"]]


def reaches(g, a, b) -> bool:
    """True when task a depends on task b, directly or through other tasks."""
    seen, stack = set(), list(g["tasks"][a]["deps"])
    while stack:
        d = stack.pop()
        if d == b:
            return True
        if d in seen or d not in g["tasks"]:
            continue
        seen.add(d)
        stack.extend(g["tasks"][d]["deps"])
    return False


def find_cycle(g):
    for tid in g["tasks"]:
        if reaches(g, tid, tid):
            return tid
    return None


def new_task(g, title, desc="", type="work", deps=(), files=(), **extra):
    tid = f"t{g['next_id']}"
    g["next_id"] += 1
    t = {"id": tid, "title": title.strip(), "desc": (desc or "").strip(), "type": type or "work",
         "status": "pending", "deps": list(dict.fromkeys(deps)), "attempts": 0,
         "files": [f.strip().removeprefix("./") for f in files if f and f.strip()],
         "history": [], "created": now()}
    t.update({k: v for k, v in extra.items() if v not in (None, "", [])})
    g["tasks"][tid] = t
    return t


def _overlap(a: str, b: str) -> bool:
    a, b = a.rstrip("/"), b.rstrip("/")
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def chain_by_files(g, new):
    """Two open tasks that touch the same file must not run side by side: the later one waits."""
    notes = []
    num = lambda t: int(t["id"][1:])
    for n in new:
        earlier = [t for t in g["tasks"].values()
                   if t["status"] not in CLOSED and num(t) < num(n) and t["files"]]
        for e in sorted(earlier, key=num, reverse=True):
            shared = sorted(f for f in n["files"] if any(_overlap(f, x) for x in e["files"]))
            if not shared or reaches(g, n["id"], e["id"]) or reaches(g, e["id"], n["id"]):
                continue
            n["deps"].append(e["id"])
            notes.append(f"{n['id']} waits for {e['id']} (both touch {', '.join(shared)})")
    return notes


def add_research(g, t, question):
    r = new_task(g, f"Find out why {t['id']} keeps going wrong", question, "research",
                 feeds=t["id"], max_attempts=2)
    t["deps"].append(r["id"])
    t["researched"] = True
    return r


def add_tasks(g, items):
    new, notes = [], []
    for it in items:
        if not isinstance(it, dict) or not str(it.get("title", "")).strip():
            raise Bad("every task needs a title")
        new.append(new_task(g, it["title"], it.get("desc") or it.get("description", ""),
                            it.get("type", "work"), files=it.get("files", []),
                            done_when=it.get("done_when", ""), max_attempts=it.get("max_attempts")))
    for t, it in zip(new, items):
        for i in it.get("depends_on", []):
            if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(new) or new[i] is t:
                raise Bad(f"{t['title']!r}: depends_on takes positions in this list (0-based), got {i!r}; "
                          "use \"after\" for ids of tasks that already exist")
            t["deps"].append(new[i]["id"])
        for dep in it.get("after", []):
            if task(g, dep)["status"] == "cancelled":
                raise Bad(f"{t['title']!r}: {dep} was cancelled, nothing can wait for it")
            t["deps"].append(dep)
        t["deps"] = list(dict.fromkeys(t["deps"]))
        same = it.get("same_as")
        if same:
            old = task(g, same)
            if old["status"] != "done":
                raise Bad(f"same_as {same}: that task is {old['status']}, not done -- add a note to it instead")
            t["refiled_from"] = same
            t["refile_count"] = old.get("refile_count", 0) + 1
            limit = g["config"].get("refile_research", 2)
            if limit and t["refile_count"] >= limit:
                r = add_research(g, t, f"The problem in {t['id']} ({t['title']}) was reported fixed "
                                 f"{t['refile_count']} times and came back. Read what was changed each time "
                                 "(below) and answer one question: can this be fixed inside this project at "
                                 "all, and if so, what is the real cause?")
                r["refiled_from"] = same
                notes.append(f"{t['id']} has come back {t['refile_count']} times: research {r['id']} runs first")
    notes += chain_by_files(g, new)
    bad = find_cycle(g)
    if bad:
        raise Bad(f"these dependencies make a cycle through {bad}; nothing was added")
    return new, notes


# ---------------------------------------------------------------- brief

def _refile_chain(g, t):
    out, seen = [], set()
    cur = t.get("refiled_from")
    while cur and cur in g["tasks"] and cur not in seen:
        seen.add(cur)
        out.append(g["tasks"][cur])
        cur = g["tasks"][cur].get("refiled_from")
    return out


def brief(g, root: Path, t) -> str:
    cfg, L = g["config"], []
    research = t["type"] == "research"
    wt = t.get("worktree")
    copy = bool(t.get("copy"))
    L.append(f'You are doing one task of a larger piece of work: "{g["milestone"]}". A lead agent planned it, '
             "runs other tasks next to yours, and will read only your final message.")
    L += ["", f"TASK {t['id']}: {t['title']}"]
    if t["desc"]:
        L.append(t["desc"])
    if t.get("done_when"):
        L.append(f"Done when: {t['done_when']}")
    if t["files"]:
        L.append("Files it is expected to touch: " + ", ".join(t["files"]))
    L.append("")
    if research:
        where = "your own copy of the project (your current directory)" if copy else str(root)
        L.append(f"This is a research task. Read and run whatever helps you find out, in {where}, but do not "
                 "change project files and do not commit. Your SUMMARY is the deliverable: it is handed to "
                 "the agent that does the work, so make it specific.")
    elif copy:
        L.append("You work in your own copy of the project: your current directory, on the branch checked out "
                 "there. Use it for every command and file path. Commit your work on that branch before you "
                 "finish. Do not merge, push or switch branches.")
        if cfg.get("check"):
            L.append(f"Before your work is merged this is run on it and must pass: `{cfg['check']}`. "
                     "Run it yourself first.")
    elif wt:
        L.append(f"Work only in {wt} (git branch {t['branch']}). Use that directory for every command and "
                 f"file path: the main checkout at {root} and the other worktrees belong to other agents. "
                 "Commit your work on this branch before you finish. Do not merge, push or switch branches.")
        if cfg.get("check"):
            L.append(f"Before your branch is merged this is run in your worktree and must pass: "
                     f"`{cfg['check']}`. Run it yourself first.")
    else:
        L.append(f"Work in {root}. There is no separate worktree, so touch only the files this task needs.")

    deps = [g["tasks"][d] for d in t["deps"] if d in g["tasks"] and g["tasks"][d].get("summary")]
    deps = [d for d in deps if d["type"] != "research"]
    if deps:
        L += ["", "What the tasks before yours produced:"]
        L += [f"- {d['id']} {d['title']}: {d['summary']}" + (f" [{d['commit'][:10]}]" if d.get("commit") else "")
              for d in deps]
    if t.get("continues"):
        L += ["", f"This continues {t['continues']}; its work is already merged. What the agent before you left:",
              t.get("left", "")]
    if t.get("fixes"):
        L += ["", f"This fixes a problem found after {t['fixes']} was merged."]
    chain = _refile_chain(g, t)
    if chain:
        L += ["", f"This problem was reported fixed before and came back ({len(chain)} time"
              f"{'s' if len(chain) > 1 else ''}). What was done then:"]
        for old in chain:
            L.append(f"- {old['id']} {old['title']}: {old.get('summary', 'no summary')}"
                     + (f" [{old['commit'][:10]}]" if old.get("commit") else ""))
        if not research:
            L.append("First work out whether this project's code can cause the problem at all. If it can, do "
                     "something different from what was tried. If it cannot, end with blocked and say where "
                     "the cause is.")
    if t.get("research"):
        L += ["", "A research task looked into this. Its findings:"] + [f"- {r}" for r in t["research"]]
    fails = [h for h in t["history"] if h["outcome"] == "failed"]
    if fails:
        L += ["", "Earlier attempts at this task went wrong:"]
        L += [f"- attempt {h['attempt']}: {h['why']}" for h in fails[-4:]]
        if len(fails) >= 2:
            L.append("The same approach has failed more than once. Try a different one.")
        if copy:
            L.append("Your copy may start with commits from those attempts. Build on them or undo them, "
                     "whichever is right.")
        elif wt:
            L.append("Your worktree still holds the earlier commits. Build on them or undo them, whichever is right.")
    holds = [h for h in t["history"] if h["outcome"] == "blocked"]
    if holds:
        h = holds[-1]
        L += ["", "The agent before you stopped and reported it was blocked.",
              f"- done: {h.get('done', '')}", f"- not done: {h.get('left', '')}", f"- why: {h['why']}"]
        if h.get("reply"):
            L.append(f"The answer it was given: {h['reply']}")
    if t.get("notes"):
        L += ["", "Notes from the lead:"] + [f"- {n}" for n in t["notes"][-5:]]
    committed = "" if research else (" and committed" if wt else "")
    if copy:
        L += ["", ENDINGS.format(committed=committed, noticed="Report it and the lead will add it to the plan."),
              "", "The system that runs you says how to format your final report. In it, say which of the four "
              "endings is true; for failed or blocked, what stopped you; for blocked or continue, what is left; "
              "and anything you noticed outside this task."]
    else:
        L += ["", ENDINGS.format(committed=committed,
                                 noticed="List it under NOTICED and the lead will add it to the plan."), "", BLOCK]
    return "\n".join(L)


# ---------------------------------------------------------------- git

def _target(root: Path) -> str:
    r = _git(root, "symbolic-ref", "--short", "-q", "HEAD")
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else _git(root, "rev-parse", "HEAD").stdout.strip()


def make_worktree(store: Store, g, t):
    """Give the task its own branch and worktree; a later attempt gets the same one back."""
    if not store.is_git or not g["config"].get("worktrees", True) or t["type"] == "research":
        return
    if _git(store.root, "rev-parse", "--verify", "-q", "HEAD").returncode != 0:
        return  # a repository with no commit yet cannot have worktrees
    branch = f"milestone/{t['id']}"
    path = Path(t.get("worktree") or store.dir / "wt" / t["id"])
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        have = _git(store.root, "rev-parse", "--verify", "-q", f"refs/heads/{branch}").returncode == 0
        args = ["worktree", "add", str(path), branch] if have else ["worktree", "add", str(path), "-b", branch]
        r = _git(store.root, *args)
        if r.returncode != 0:
            raise Bad(f"could not create a worktree for {t['id']}: {r.stderr.strip()}")
    t["worktree"], t["branch"] = str(path), branch


def gate(store: Store, g, t) -> str:
    """Bring the task's branch up to date, run the check on it, then move the project forward to it.

    The project's own checkout only ever fast-forwards to a branch that passed, so a
    refusal leaves it exactly as it was.
    """
    cfg, root = g["config"], store.root
    wt = t.get("worktree")
    if wt and not Path(wt).exists():
        raise Refused(f"the worktree {wt} is gone; `release {t['id']}` and start the task again")
    where = Path(wt) if wt else root
    if wt:
        dirty = _git(where, "status", "--porcelain").stdout.strip()
        if dirty:
            raise Refused(f"uncommitted changes in {wt}:\n{dirty}\nThe agent has to commit its work on {t['branch']}.")
        target = _target(root)
        m = _git(where, "merge", "--no-edit", target)
        if m.returncode != 0:
            files = _git(where, "diff", "--name-only", "--diff-filter=U").stdout.split()
            _git(where, "merge", "--abort")
            raise Refused(f"{t['branch']} conflicts with {target} in: {', '.join(files) or m.stderr.strip()}. "
                          f"The next attempt has to merge {target} into its branch and resolve these first.")
    if cfg.get("check"):
        env = {**os.environ, "MILESTONE_ROOT": str(root), "MILESTONE_TASK": t["id"]}
        try:
            c = subprocess.run(cfg["check"], shell=True, cwd=where, env=env, capture_output=True, text=True,
                               timeout=cfg.get("check_timeout", 900))
            out, ok = (c.stdout + c.stderr), c.returncode == 0
        except subprocess.TimeoutExpired as e:
            out, ok = f"{e.stdout or ''}\ncheck timed out after {cfg.get('check_timeout', 900)}s", False
        logs = store.dir / "logs"
        logs.mkdir(exist_ok=True)
        log = logs / f"{t['id']}-check-{t['attempts']}.log"
        log.write_text(out if isinstance(out, str) else out.decode(errors="replace"))
        if not ok:
            tail = "\n".join(log.read_text().strip().splitlines()[-25:])
            raise Refused(f"the check `{cfg['check']}` fails on {t.get('branch', 'the project')} "
                          f"(full output: {log}):\n{tail}")
    if wt:
        ff = _git(root, "merge", "--ff-only", t["branch"])
        if ff.returncode != 0:
            raise Refused(f"could not move {_target(root)} forward to {t['branch']}: {ff.stderr.strip()}")
    return _git(root, "rev-parse", "HEAD").stdout.strip() if store.is_git else ""


# ---------------------------------------------------------------- commands

def cmd_init(store, a):
    with store.lock():
        if store.path.exists():
            raise Bad(f"a milestone already exists here ({store.path}); `status` shows it, `archive` puts it away")
        cfg = dict(DEFAULTS, check=a.check or "", max_parallel=a.max_parallel, max_attempts=a.max_attempts,
                   worktrees=not a.no_worktrees)
        store.save({"version": 1, "milestone": a.title, "created": now(), "config": cfg, "next_id": 1, "tasks": {}})
    store.event("init", title=a.title)
    print(f"Milestone \"{a.title}\" started in {store.dir}")
    if not store.is_git:
        print("This is not a git repository: tasks get no worktree, so run them one at a time.")
    if cfg["check"]:
        c = subprocess.run(cfg["check"], shell=True, cwd=store.root, capture_output=True, text=True,
                           env={**os.environ, "MILESTONE_ROOT": str(store.root)})
        if c.returncode != 0:
            print(f"Warning: the check `{cfg['check']}` already fails before any work. Every task will be "
                  "refused until it passes: make fixing it the first task, or change it with `set check`.")


def _print_added(g, new, notes, as_json):
    if as_json:
        print(json.dumps({"ids": [t["id"] for t in new], "chained": notes}))
        return
    for t in new:
        after = f"  after {', '.join(t['deps'])}" if t["deps"] else ""
        print(f"{t['id']}  {t['type']:<8} {t['title']}{after}")
    for n in notes:
        print(f"note: {n}")


def cmd_add(store, a):
    if a.file:
        raw = sys.stdin.read() if a.file == "-" else Path(a.file).read_text()
        data = json.loads(raw)
        items = data["tasks"] if isinstance(data, dict) else data
    elif a.title:
        items = [{"title": a.title, "desc": a.desc, "type": a.type, "after": a.after or [],
                  "files": [f for f in (a.files or "").split(",") if f], "done_when": a.done_when,
                  "same_as": a.same_as}]
    else:
        raise Bad("give a title, or --file tasks.json")
    with store.edit() as g:
        new, notes = add_tasks(g, items)
    for t in new:
        store.event("add", t["id"], title=t["title"], deps=t["deps"])
    _print_added(g, new, notes, a.json)


def _ready(g):
    return [t for t in g["tasks"].values() if label(g, t) == "ready"]


def cmd_ready(store, a):
    g = store.load()
    ready = _ready(g)
    running = [t for t in g["tasks"].values() if t["status"] == "running"]
    slots = max(0, g["config"]["max_parallel"] - len(running))
    show = ready if a.all else ready[:slots]
    if a.json:
        print(json.dumps({"ready": [t["id"] for t in show], "held_back": len(ready) - len(show),
                          "running": [t["id"] for t in running]}))
        return
    for t in show:
        print(f"{t['id']}  {t['type']:<8} {t['title']}")
    if len(ready) > len(show):
        print(f"({len(ready) - len(show)} more ready, waiting for one of the {len(running)} running tasks to finish)")
    if not ready:
        print(_whats_next(g))


def cmd_start(store, a):
    with store.edit() as g:
        t = task(g, a.id)
        state = label(g, t)
        if state != "ready":
            waiting = [d for d in t["deps"] if d in g["tasks"] and g["tasks"][d]["status"] != "done"]
            raise Bad(f"{a.id} is {state}" + (f", waiting for {', '.join(waiting)}" if state == "waiting" else ""))
        make_worktree(store, g, t)
        if a.copy and not (t.get("worktree") or t["type"] == "research"):
            raise Bad("--copy is for a worker in its own clone of the task's worktree, and this milestone runs "
                      "without worktrees")
        t["copy"] = bool(a.copy)
        t["status"], t["attempts"], t["started"] = "running", t["attempts"] + 1, now()
        text = brief(g, store.root, t)
    store.event("start", t["id"], attempt=t["attempts"])
    if a.json:
        print(json.dumps({"id": t["id"], "worktree": t.get("worktree", ""), "branch": t.get("branch", ""),
                          "attempt": t["attempts"], "brief": text}))
    else:
        print(text)


def cmd_brief(store, a):
    g = store.load()
    print(brief(g, store.root, task(g, a.id)))


def _running(g, tid):
    t = task(g, tid)
    if t["status"] != "running":
        raise Bad(f"{tid} is {label(g, t)}, not running" + (" -- `start` it first" if t["status"] == "pending" else ""))
    return t


def take(t, src: str, ref: str):
    """Bring a worker's commits from its own copy of the project onto the task's branch."""
    wt = t.get("worktree")
    if not wt or not Path(wt).exists():
        raise Bad(f"--from needs the task's worktree, and {t['id']} has none")
    src = str(Path(src).expanduser().resolve())
    if not Path(src).is_dir() or _git(src, "rev-parse", "--is-inside-work-tree").stdout.strip() != "true":
        raise Bad(f"{src} is not a git checkout")
    dirty = _git(src, "status", "--porcelain").stdout.strip()
    if dirty:
        raise Refused(f"uncommitted changes in {src}:\n{dirty}\nThe worker has to commit what belongs to the task and remove the rest.")
    f = _git(Path(wt), "fetch", "-q", src, ref)
    if f.returncode != 0:
        raise Refused(f"could not fetch {ref} from {src}: {f.stderr.strip()}")
    m = _git(Path(wt), "merge", "--no-edit", "FETCH_HEAD")
    if m.returncode != 0:
        files = _git(Path(wt), "diff", "--name-only", "--diff-filter=U").stdout.split()
        _git(Path(wt), "merge", "--abort")
        raise Refused(f"the work in {src} conflicts with {t['branch']} in: {', '.join(files) or m.stderr.strip()}. "
                      f"Start the worker's copy from {wt} so it builds on the task's branch.")


def _gated(store, tid, merge=True, src="", ref="HEAD"):
    """Run the merge gate for a running task outside the graph lock (a check can take minutes)."""
    g = store.load()
    t = _running(g, tid)
    if src and t["type"] == "research":
        raise Bad(f"{tid} is a research task; it has no work to take")
    if not merge or t["type"] == "research":
        return ""
    with store.lock("merge.lock"):
        if src:
            take(t, src, ref)
        return gate(store, g, t)


def _finish(g, t, summary, commit, outcome="done"):
    t["status"], t["summary"], t["finished"] = "done", summary.strip(), now()
    if commit:
        t["commit"] = commit
    t["history"].append({"attempt": t["attempts"], "outcome": outcome, "at": now(), "summary": summary.strip()})
    feeds = t.get("feeds")
    if feeds in g["tasks"]:
        g["tasks"][feeds].setdefault("research", []).append(summary.strip())


def cmd_done(store, a):
    if a.src and a.no_merge:
        raise Bad("--from brings work in to be merged; it does not go with --no-merge")
    commit = _gated(store, a.id, merge=not a.no_merge, src=a.src, ref=a.ref)
    with store.edit() as g:
        t = _running(g, a.id)
        before = {x["id"] for x in _ready(g)}
        _finish(g, t, a.summary, commit)
        opened = [x for x in _ready(g) if x["id"] not in before]
    store.event("done", t["id"], commit=commit, summary=a.summary)
    print(f"{t['id']} done" + (f", merged at {commit[:10]}" if commit and t.get("worktree") else ""))
    if opened:
        print("now ready: " + ", ".join(x["id"] for x in opened))
    else:
        print(_whats_next(g))


def cmd_fail(store, a):
    with store.edit() as g:
        t = _running(g, a.id)
        t["history"].append({"attempt": t["attempts"], "outcome": "failed", "at": now(), "why": a.why.strip()})
        limit = t.get("max_attempts") or g["config"]["max_attempts"]
        if t["attempts"] < limit:
            t["status"] = "pending"
            msg = f"{t['id']} will be tried again (attempt {t['attempts'] + 1} of {limit}) with this failure in its brief"
        elif not t.get("researched") and t["type"] != "research":
            fails = "\n".join(f"- attempt {h['attempt']}: {h['why']}" for h in t["history"] if h["outcome"] == "failed")
            r = add_research(g, t, f"{t['id']} ({t['title']}) has failed {t['attempts']} times:\n{fails}\n"
                             "Find the real cause. Say whether the task can be done in this project as it is "
                             "written, and what the next attempt must do differently.")
            t["status"], t["attempts"] = "pending", 0
            msg = f"{t['id']} failed {limit} times: research task {r['id']} now runs first, then {t['id']} is tried again"
        else:
            t["status"] = "blocked"
            t["hold"] = {"kind": "exhausted", "why": f"failed {t['attempts']} times"
                         + (" after research" if t.get("researched") else "") + f"; last: {a.why.strip()}", "at": now()}
            msg = f"{t['id']} is out of attempts and waits for the user (`unblock {t['id']} --reply ...`)"
    store.event("fail", t["id"], why=a.why, status=t["status"])
    print(msg)


def cmd_blocked(store, a):
    with store.edit() as g:
        t = _running(g, a.id)
        t["history"].append({"attempt": t["attempts"], "outcome": "blocked", "at": now(), "why": a.why.strip(),
                             "done": (a.done or "").strip(), "left": (a.left or "").strip()})
        t["status"], t["attempts"] = "blocked", max(0, t["attempts"] - 1)  # no attempt spent
        t["hold"] = {"kind": "blocked", "why": a.why.strip(), "done": (a.done or "").strip(),
                     "left": (a.left or "").strip(), "at": now()}
    store.event("blocked", t["id"], why=a.why)
    print(f"{t['id']} is held until the user answers (`unblock {t['id']} --reply ...`). Tasks after it keep waiting.")


def cmd_unblock(store, a):
    with store.edit() as g:
        t = task(g, a.id)
        if t["status"] != "blocked":
            raise Bad(f"{a.id} is {label(g, t)}, not blocked")
        hold = t.pop("hold", {})
        if hold.get("kind") == "exhausted":
            t["attempts"] = 0
            t.setdefault("notes", []).append(f"After {hold.get('why', 'repeated failures')}, the user said: {a.reply.strip()}")
        else:
            for h in reversed(t["history"]):
                if h["outcome"] == "blocked":
                    h["reply"] = a.reply.strip()
                    break
        t["status"] = "pending"
    store.event("unblock", t["id"], reply=a.reply)
    print(f"{t['id']} released; its next brief opens with the report and this reply")


def cmd_continue(store, a):
    commit = _gated(store, a.id, src=a.src, ref=a.ref)
    with store.edit() as g:
        t = _running(g, a.id)
        movers = [d for d in dependents(g, t["id"]) if d["status"] not in CLOSED]
        _finish(g, t, a.summary, commit, outcome="continued")
        t["partial"] = True
        c = new_task(g, a.title or f"{t['title']} (continued)", t["desc"], t["type"], deps=[t["id"]],
                     files=t["files"], continues=t["id"], left=a.left.strip(), done_when=t.get("done_when", ""))
        for d in movers:
            d["deps"] = [c["id"] if x == t["id"] else x for x in d["deps"]]
        depth, cur = 1, t
        while cur.get("continues") in g["tasks"]:
            depth, cur = depth + 1, g["tasks"][cur["continues"]]
    store.event("continue", t["id"], continuation=c["id"], left=a.left)
    print(f"{t['id']} merged as far as it got; {c['id']} continues it"
          + (f" and {', '.join(d['id'] for d in movers)} now wait for {c['id']}" if movers else ""))
    if depth >= 3:
        print(f"note: this is continuation number {depth} of the same task -- consider splitting what is left")


def cmd_insert_fix(store, a):
    with store.edit() as g:
        t = task(g, a.id)
        if t["status"] != "done":
            raise Bad(f"{a.id} is {label(g, t)}; a fix is inserted after a task that is done")
        movers = [d for d in dependents(g, t["id"]) if d["status"] not in CLOSED]
        files = [x for x in (a.files or "").split(",") if x] or t["files"]
        f = new_task(g, a.title, a.desc, "fix", deps=[t["id"]], files=files, fixes=t["id"])
        for d in movers:
            d["deps"] = [f["id"] if x == t["id"] else x for x in d["deps"]]
    store.event("insert_fix", f["id"], after=t["id"])
    print(f"{f['id']} inserted after {t['id']}" + (f"; {', '.join(d['id'] for d in movers)} now wait for it" if movers else ""))


def cmd_cancel(store, a):
    with store.edit() as g:
        t = task(g, a.id)
        if t["status"] in CLOSED:
            raise Bad(f"{a.id} is already {t['status']}")
        if t["status"] == "running":
            raise Bad(f"{a.id} is running; stop its agent and `release {a.id}` first")
        t["status"], t["cancelled_why"] = "cancelled", a.why.strip()
        t.pop("hold", None)
        for d in dependents(g, t["id"]):  # dependents wait for whatever the cancelled task waited for
            d["deps"] = list(dict.fromkeys(x for dep in d["deps"] for x in (t["deps"] if dep == t["id"] else [dep])))
    store.event("cancel", t["id"], why=a.why)
    print(f"{t['id']} cancelled; the tasks after it no longer wait for it")


def cmd_release(store, a):
    with store.edit() as g:
        t = _running(g, a.id)
        t["status"], t["attempts"] = "pending", max(0, t["attempts"] - 1)
    store.event("release", t["id"])
    print(f"{t['id']} is pending again, no attempt spent")


def cmd_note(store, a):
    with store.edit() as g:
        t = task(g, a.id)
        t.setdefault("notes", []).append(a.text.strip())
    store.event("note", t["id"], text=a.text)
    print(f"note added to {t['id']}; it is shown in the task's next brief")


def cmd_dep(store, a):
    with store.edit() as g:
        t = task(g, a.id)
        task(g, a.dep)
        if a.action == "add":
            if a.dep == a.id or reaches(g, a.dep, a.id):
                raise Bad(f"{a.id} cannot wait for {a.dep}: that would make a cycle")
            if a.dep not in t["deps"]:
                t["deps"].append(a.dep)
        else:
            t["deps"] = [d for d in t["deps"] if d != a.dep]
    store.event(f"dep_{a.action}", t["id"], dep=a.dep)
    print(f"{t['id']} waits for: {', '.join(t['deps']) or 'nothing'}")


def cmd_set(store, a):
    if a.key not in DEFAULTS:
        raise Bad(f"unknown setting {a.key}; known: {', '.join(DEFAULTS)}")
    old = DEFAULTS[a.key]
    value = a.value.lower() in ("1", "true", "yes", "on") if isinstance(old, bool) else type(old)(a.value)
    with store.edit() as g:
        g["config"][a.key] = value
    store.event("set", key=a.key, value=value)
    print(f"{a.key} = {value!r}")


def _whats_next(g) -> str:
    tasks = list(g["tasks"].values())
    if not tasks:
        return "No tasks yet."
    if all(t["status"] in CLOSED for t in tasks):
        return "All tasks are done."
    ready = [t["id"] for t in tasks if label(g, t) == "ready"]
    if ready:
        return f"Can start now: {', '.join(ready)}."
    if any(t["status"] == "running" for t in tasks):
        return "Nothing else can start until a running task finishes."
    held = [t["id"] for t in tasks if t["status"] == "blocked"]
    if held:
        return f"Nothing can run until the user answers: {', '.join(held)}."
    return "Nothing is ready."


def cmd_status(store, a):
    g = store.load()
    tasks = list(g["tasks"].values())
    counts = {}
    for t in tasks:
        counts[label(g, t)] = counts.get(label(g, t), 0) + 1
    held = [t for t in tasks if t["status"] == "blocked"]
    open_ = [t for t in tasks if t["status"] not in CLOSED]
    if a.json:
        print(json.dumps({
            "milestone": g["milestone"], "config": g["config"], "counts": counts,
            "finished": bool(tasks) and not open_,
            "stalled": bool(open_) and not _ready(g) and not any(t["status"] == "running" for t in tasks),
            "waiting_on_user": [{"id": t["id"], "title": t["title"], **t.get("hold", {})} for t in held],
            "tasks": [{"id": t["id"], "title": t["title"], "type": t["type"], "state": label(g, t),
                       "deps": t["deps"], "attempts": t["attempts"], "summary": t.get("summary", "")} for t in tasks]}))
        return
    check = f"   check: {g['config']['check']}" if g["config"].get("check") else ""
    print(f"Milestone: {g['milestone']}{check}")
    order = ("done", "running", "ready", "waiting", "blocked", "cancelled")
    print(f"{len(tasks)} tasks: " + ", ".join(f"{counts[k]} {k}" for k in order if counts.get(k)))
    for t in tasks:
        extra = f"  after {', '.join(t['deps'])}" if t["deps"] and t["status"] not in CLOSED else ""
        tries = f"  attempt {t['attempts']}" if t["status"] == "running" or len(t["history"]) > 1 else ""
        print(f"  {t['id']:<4} {label(g, t):<9} {t['title']}{tries}{extra}")
    if held:
        print("Waiting on the user:")
        for t in held:
            h = t.get("hold", {})
            print(f"  {t['id']} {t['title']}: {h.get('why', '')}" + (f" (left: {h['left']})" if h.get("left") else ""))
    print(_whats_next(g))


def cmd_show(store, a):
    g = store.load()
    t = task(g, a.id)
    print(json.dumps(dict(t, state=label(g, t)), indent=1))


def cmd_log(store, a):
    path = store.dir / "events.jsonl"
    rows = path.read_text().splitlines()[-a.n:] if path.exists() else []
    for line in rows:
        r = json.loads(line)
        rest = " ".join(f"{k}={v!r}" for k, v in r.items() if k not in ("at", "event", "task"))
        print(f"{r['at']}  {r['event']:<10} {r['task']:<4} {rest}"[:200])


def cmd_cleanup(store, a):
    """Remove the worktree folders of finished tasks. Branches stay: they are the record."""
    with store.edit() as g:
        for t in g["tasks"].values():
            wt = t.get("worktree")
            if t["status"] in CLOSED and wt and Path(wt).exists():
                r = _git(store.root, "worktree", "remove", wt)
                print(f"{t['id']}: removed {wt}" if r.returncode == 0 else f"{t['id']}: kept {wt} ({r.stderr.strip()})")


def cmd_archive(store, a):
    with store.lock():
        g = store.load()
        if any(t["status"] == "running" for t in g["tasks"].values()):
            raise Bad("tasks are still running; finish or `release` them first")
        dest = store.dir / "archive" / time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        dest.mkdir(parents=True)
        for name in ("graph.json", "events.jsonl", "logs"):
            if (store.dir / name).exists():
                shutil.move(str(store.dir / name), str(dest / name))
    print(f"archived to {dest}")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="taskgraph", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    def cmd(name, fn, help, *args):
        sp = sub.add_parser(name, help=help)
        for flags, kw in args:
            sp.add_argument(*flags, **kw)
        sp.set_defaults(fn=fn)

    ID = (("id",), {})
    JSON = (("--json",), {"action": "store_true"})
    cmd("init", cmd_init, "start a milestone in this project", (("title",), {}),
        (("--check",), {"help": "command that must pass on a task's branch before it is merged"}),
        (("--max-parallel",), {"type": int, "default": DEFAULTS["max_parallel"]}),
        (("--max-attempts",), {"type": int, "default": DEFAULTS["max_attempts"]}),
        (("--no-worktrees",), {"action": "store_true"}))
    cmd("add", cmd_add, "add one task, or many from a JSON file", (("title",), {"nargs": "?"}),
        (("--file",), {"help": "JSON list of tasks ('-' for stdin)"}), (("--desc",), {"default": ""}),
        (("--type",), {"default": "work"}), (("--after",), {"action": "append"}),
        (("--files",), {"help": "comma-separated paths the task will touch"}),
        (("--done-when",), {"default": ""}), (("--same-as",), {"help": "a done task whose problem came back"}), JSON)
    cmd("ready", cmd_ready, "tasks that can start now", (("--all",), {"action": "store_true"}), JSON)
    FROM = ((("--from",), {"dest": "src", "default": "",
                           "help": "the worker's own copy of the project; its commits are brought onto the task's branch first"}),
            (("--ref",), {"default": "HEAD", "help": "what to take from --from (default: what is checked out there)"}))
    cmd("start", cmd_start, "mark a ready task running and print its sub-agent brief", ID, JSON,
        (("--copy",), {"action": "store_true",
                       "help": "the sub-agent works in its own copy of the project (a sandboxed worker), not in the worktree"}))
    cmd("brief", cmd_brief, "print a task's brief again", ID)
    cmd("done", cmd_done, "check, merge and record a finished task", ID, (("--summary",), {"required": True}),
        (("--no-merge",), {"action": "store_true"}), *FROM)
    cmd("fail", cmd_fail, "record a failed attempt", ID, (("--why",), {"required": True}))
    cmd("blocked", cmd_blocked, "hold a task the agent could not finish", ID, (("--why",), {"required": True}),
        (("--done",), {}), (("--left",), {}))
    cmd("unblock", cmd_unblock, "release a held task with the user's answer", ID, (("--reply",), {"required": True}))
    cmd("continue", cmd_continue, "merge what exists and hand the rest to a new task", ID,
        (("--summary",), {"required": True}), (("--left",), {"required": True}), (("--title",), {}), *FROM)
    cmd("insert-fix", cmd_insert_fix, "put a fix task between a done task and what follows it", ID,
        (("--title",), {"required": True}), (("--desc",), {"default": ""}),
        (("--files",), {"help": "comma-separated paths the fix will touch (default: the fixed task's)"}))
    cmd("cancel", cmd_cancel, "drop a task; what follows no longer waits for it", ID, (("--why",), {"required": True}))
    cmd("release", cmd_release, "return a running task to pending (its agent is gone)", ID)
    cmd("note", cmd_note, "add a note shown in the task's next brief", ID, (("text",), {}))
    cmd("dep", cmd_dep, "add or remove one dependency", (("action",), {"choices": ["add", "rm"]}), ID, (("dep",), {}))
    cmd("set", cmd_set, "change a setting (check, max_parallel, max_attempts, ...)", (("key",), {}), (("value",), {}))
    cmd("status", cmd_status, "the whole graph and what is waiting on the user", JSON)
    cmd("show", cmd_show, "everything recorded about one task", ID)
    cmd("log", cmd_log, "recent events", (("-n",), {"type": int, "default": 30}))
    cmd("cleanup", cmd_cleanup, "remove worktree folders of finished tasks (branches stay)")
    cmd("archive", cmd_archive, "put a finished milestone away so a new one can start")

    a = p.parse_args(argv)
    store = Store(*find_root(Path.cwd().resolve()))
    try:
        a.fn(store, a)
    except Bad as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except Refused as e:
        again = f"fail {getattr(a, 'id', '<id>')} --why \"<the reason above>\""
        hint = (f"If the worker is still there, steer it with the reason above and record again; that spends "
                f"no attempt. Otherwise: {again}" if getattr(a, "src", "")
                else f"If the agent should try again: {again}")
        print(f"refused, nothing recorded: {e}\n{hint}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
