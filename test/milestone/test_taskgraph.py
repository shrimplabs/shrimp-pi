"""The milestone skill (skills/milestone): a task graph a lead agent drives with
sub-agents or shrimp-pi workers. Every test runs the script
the way an agent would, as a subprocess inside a throwaway project."""
import ast
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills" / "milestone"
SCRIPT = SKILL / "taskgraph.py"
ENV = {k: v for k, v in os.environ.items() if k != "MILESTONE_ROOT"}
ENV.update(GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t",
           GIT_COMMITTER_EMAIL="t@example.com", GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)


def sh(cwd, *cmd):
    return subprocess.run(cmd, cwd=cwd, env=ENV, capture_output=True, text=True, check=True).stdout.strip()


def tg(cwd, *args, rc=0, stdin=None):
    p = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=cwd, env=ENV, capture_output=True, text=True,
                       input=stdin)
    assert p.returncode == rc, f"{args}: rc={p.returncode}\n{p.stdout}\n{p.stderr}"
    return p.stdout + p.stderr


def add(cwd, tasks, rc=0):
    return tg(cwd, "add", "--file", "-", "--json", stdin=json.dumps(tasks), rc=rc)


def state(cwd):
    s = json.loads(tg(cwd, "status", "--json"))
    return {t["id"]: t for t in s["tasks"]}, s


def commit(wt, name, text="x\n"):
    Path(wt, name).write_text(text)
    sh(wt, "git", "add", "-A")
    sh(wt, "git", "commit", "-qm", f"add {name}")


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "proj"
    r.mkdir()
    sh(r, "git", "init", "-q", "-b", "main")
    commit(r, "README.md", "hello\n")
    return r


@pytest.fixture
def ms(repo):
    """A milestone whose check fails when a file named BROKEN exists."""
    tg(repo, "init", "Ship 0.3", "--check", "test ! -f BROKEN")
    return repo


def wt_of(repo, tid):
    return repo / ".milestone" / "wt" / tid


# ---------------------------------------------------------------- packaging

def test_script_uses_only_the_standard_library():
    tree = ast.parse(SCRIPT.read_text())
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            names.add((node.module or "").split(".")[0])
    assert names <= set(sys.stdlib_module_names), names - set(sys.stdlib_module_names)


def test_skill_has_its_header_and_is_in_the_readme():
    assert (SKILL / "SKILL.md").read_text().startswith("---\nname: milestone\n")
    assert "skills/milestone/SKILL.md" in (ROOT / "README.md").read_text()


def test_state_folder_stays_out_of_git(ms):
    add(ms, [{"title": "a"}])
    tg(ms, "start", "t1")
    assert sh(ms, "git", "status", "--porcelain") == ""


def test_init_twice_is_refused(ms):
    assert "already exists" in tg(ms, "init", "Again", rc=1)


def test_init_warns_when_the_check_already_fails(repo):
    assert "already fails" in tg(repo, "init", "M", "--check", "false")


# ---------------------------------------------------------------- planning

def test_batch_wires_dependencies_by_position(ms):
    out = json.loads(add(ms, [{"title": "core"}, {"title": "cli", "depends_on": [0]},
                              {"title": "docs"}, {"title": "release", "depends_on": [1, 2]}]))
    assert out["ids"] == ["t1", "t2", "t3", "t4"]
    tasks, _ = state(ms)
    assert tasks["t2"]["deps"] == ["t1"] and tasks["t4"]["deps"] == ["t2", "t3"]
    assert [tasks[t]["state"] for t in ("t1", "t2", "t3", "t4")] == ["ready", "waiting", "ready", "waiting"]
    assert "Can start now: t1, t3." in tg(ms, "status")


@pytest.mark.parametrize("deps", [["task-id-1"], [5], [0]])
def test_bad_dependency_adds_nothing(ms, deps):
    assert "depends_on takes positions" in add(ms, [{"title": "a", "depends_on": deps}, {"title": "b"}], rc=1)
    assert state(ms)[0] == {}


def test_cycle_adds_nothing(ms):
    assert "cycle" in add(ms, [{"title": "a", "depends_on": [1]}, {"title": "b", "depends_on": [0]}], rc=1)
    assert state(ms)[0] == {}


def test_tasks_touching_the_same_file_are_put_in_sequence(ms):
    out = json.loads(add(ms, [{"title": "a", "files": ["src/app.py"]}, {"title": "b", "files": ["./src/app.py"]},
                              {"title": "c", "files": ["docs/guide.md"]}, {"title": "d", "files": ["src/"]}]))
    tasks, _ = state(ms)
    assert tasks["t2"]["deps"] == ["t1"]
    assert tasks["t3"]["deps"] == [] and tasks["t3"]["state"] == "ready"
    assert tasks["t4"]["deps"] == ["t2"], "a folder overlaps the files in it; one edge to the latest is enough"
    assert any("both touch src/app.py" in n for n in out["chained"])


def test_a_later_task_is_chained_behind_an_open_one(ms):
    add(ms, [{"title": "a", "files": ["x.py"]}])
    tg(ms, "add", "b", "--files", "x.py")
    assert state(ms)[0]["t2"]["deps"] == ["t1"]


def test_ready_holds_back_beyond_the_parallel_limit(repo):
    tg(repo, "init", "M", "--max-parallel", "2")
    add(repo, [{"title": t} for t in "abc"])
    assert json.loads(tg(repo, "ready", "--json"))["ready"] == ["t1", "t2"]
    tg(repo, "start", "t1")
    r = json.loads(tg(repo, "ready", "--json"))
    assert r["ready"] == ["t2"] and r["held_back"] == 1


def test_dep_add_refuses_a_cycle(ms):
    add(ms, [{"title": "a"}, {"title": "b", "depends_on": [0]}])
    assert "cycle" in tg(ms, "dep", "add", "t1", "t2", rc=1)
    tg(ms, "dep", "rm", "t2", "t1")
    assert state(ms)[0]["t2"]["state"] == "ready"


# ---------------------------------------------------------------- running

def test_start_gives_the_task_a_worktree_and_a_brief(ms):
    add(ms, [{"title": "core", "desc": "Build the core.", "done_when": "tests pass", "files": ["core.py"]},
             {"title": "cli", "depends_on": [0]}])
    brief = tg(ms, "start", "t1")
    wt = wt_of(ms, "t1")
    assert wt.is_dir() and sh(wt, "git", "branch", "--show-current") == "milestone/t1"
    for text in ('"Ship 0.3"', "TASK t1: core", "Build the core.", "Done when: tests pass", str(wt),
                 "`test ! -f BROKEN`", "OUTCOME: done | failed | blocked | continue",
                 "Do not build a stand-in"):
        assert text in brief
    assert "waiting for t1" in tg(ms, "start", "t2", rc=1)
    assert "is running" in tg(ms, "start", "t1", rc=1)


def test_done_checks_merges_and_opens_what_waited(ms):
    add(ms, [{"title": "core"}, {"title": "cli", "depends_on": [0]}])
    tg(ms, "start", "t1")
    commit(wt_of(ms, "t1"), "core.py")
    out = tg(ms, "done", "t1", "--summary", "core module with add()")
    assert "now ready: t2" in out
    assert (ms / "core.py").exists() and sh(ms, "git", "status", "--porcelain") == ""
    assert "t1 core: core module with add()" in tg(ms, "start", "t2")


def test_done_is_refused_for_uncommitted_work(ms):
    add(ms, [{"title": "a"}])
    tg(ms, "start", "t1")
    (wt_of(ms, "t1") / "new.py").write_text("x")
    assert "uncommitted changes" in tg(ms, "done", "t1", "--summary", "s", rc=2)
    assert state(ms)[0]["t1"]["state"] == "running"


def test_failed_check_leaves_the_project_untouched_and_feeds_the_retry(ms):
    add(ms, [{"title": "a"}])
    tg(ms, "start", "t1")
    head = sh(ms, "git", "rev-parse", "HEAD")
    commit(wt_of(ms, "t1"), "BROKEN")
    out = tg(ms, "done", "t1", "--summary", "s", rc=2)
    assert "nothing recorded" in out and "test ! -f BROKEN" in out
    assert sh(ms, "git", "rev-parse", "HEAD") == head and not (ms / "BROKEN").exists()
    assert "attempt 2 of 3" in tg(ms, "fail", "t1", "--why", "check failed: BROKEN exists")
    brief = tg(ms, "start", "t1")
    assert "attempt 1: check failed: BROKEN exists" in brief and "still holds the earlier commits" in brief
    assert (wt_of(ms, "t1") / "BROKEN").exists(), "the retry gets the same worktree back"


def test_conflicting_branch_is_refused_and_nothing_is_half_merged(ms):
    add(ms, [{"title": "a"}, {"title": "b"}])
    tg(ms, "start", "t1")
    tg(ms, "start", "t2")
    commit(wt_of(ms, "t1"), "README.md", "from a\n")
    commit(wt_of(ms, "t2"), "README.md", "from b\n")
    tg(ms, "done", "t1", "--summary", "a")
    head = sh(ms, "git", "rev-parse", "HEAD")
    out = tg(ms, "done", "t2", "--summary", "b", rc=2)
    assert "conflicts with main in: README.md" in out
    assert sh(ms, "git", "rev-parse", "HEAD") == head
    assert sh(wt_of(ms, "t2"), "git", "status", "--porcelain") == "", "the failed merge was backed out"


def test_parallel_branches_both_land(ms):
    add(ms, [{"title": "a"}, {"title": "b"}])
    tg(ms, "start", "t1")
    tg(ms, "start", "t2")
    commit(wt_of(ms, "t1"), "a.py")
    commit(wt_of(ms, "t2"), "b.py")
    tg(ms, "done", "t1", "--summary", "a")
    assert "All tasks are done." in tg(ms, "done", "t2", "--summary", "b")
    assert (ms / "a.py").exists() and (ms / "b.py").exists()
    assert json.loads(tg(ms, "status", "--json"))["finished"] is True


def worker_copy(repo, tid, tmp_path, name="worker"):
    """What a sandboxed worker gets: its own clone of the task's worktree, on a branch of its own."""
    clone = tmp_path / name
    sh(tmp_path, "git", "clone", "-q", "--no-hardlinks", str(wt_of(repo, tid)), str(clone))
    sh(clone, "git", "checkout", "-q", "-b", f"worker/{name}")
    return clone


def test_copy_brief_names_no_path_and_leaves_the_report_format_to_the_worker(ms):
    add(ms, [{"title": "parser", "desc": "write it"}])
    out = json.loads(tg(ms, "start", "t1", "--copy", "--json"))
    assert out["worktree"] == str(wt_of(ms, "t1"))
    brief = out["brief"]
    assert "your own copy of the project" in brief and "test ! -f BROKEN" in brief
    assert str(ms) not in brief and "OUTCOME:" not in brief
    for ending in ("- done:", "- failed:", "- blocked:", "- continue:"):
        assert ending in brief
    assert tg(ms, "brief", "t1").strip() == brief.strip()
    tg(ms, "release", "t1")
    assert "OUTCOME:" in tg(ms, "start", "t1")


def test_copy_brief_for_research_and_without_worktrees(ms, tmp_path):
    add(ms, [{"title": "why is it slow", "type": "research"}])
    brief = tg(ms, "start", "t1", "--copy")
    assert "your own copy of the project" in brief and str(ms) not in brief and "OUTCOME:" not in brief
    plain = tmp_path / "plain"
    plain.mkdir()
    sh(plain, "git", "init", "-q", "-b", "main")
    commit(plain, "README.md")
    tg(plain, "init", "No worktrees", "--no-worktrees")
    add(plain, [{"title": "a"}])
    assert "without worktrees" in tg(plain, "start", "t1", "--copy", rc=1)
    assert state(plain)[0]["t1"]["state"] == "ready"


def test_done_takes_the_work_from_a_workers_copy(ms, tmp_path):
    add(ms, [{"title": "a"}, {"title": "b", "depends_on": [0]}])
    tg(ms, "start", "t1", "--copy")
    clone = worker_copy(ms, "t1", tmp_path)
    commit(clone, "a.txt")
    out = tg(ms, "done", "t1", "--summary", "a exists", "--from", str(clone))
    assert "merged at" in out and "now ready: t2" in out
    assert (ms / "a.txt").exists()
    assert sh(ms, "git", "rev-parse", "HEAD") == sh(ms, "git", "rev-parse", "milestone/t1")


def test_a_workers_uncommitted_work_is_refused(ms, tmp_path):
    add(ms, [{"title": "a"}])
    tg(ms, "start", "t1", "--copy")
    clone = worker_copy(ms, "t1", tmp_path)
    (clone / "a.txt").write_text("x")
    out = tg(ms, "done", "t1", "--summary", "s", "--from", str(clone), rc=2)
    assert "uncommitted changes" in out and "a.txt" in out
    assert "steer it with the reason above" in out
    assert state(ms)[0]["t1"]["state"] == "running" and not (ms / "a.txt").exists()


def test_work_that_fails_the_check_stays_on_the_branch_for_the_next_worker(ms, tmp_path):
    add(ms, [{"title": "a"}])
    tg(ms, "start", "t1", "--copy")
    clone = worker_copy(ms, "t1", tmp_path)
    commit(clone, "BROKEN")
    tg(ms, "done", "t1", "--summary", "s", "--from", str(clone), rc=2)
    assert not (ms / "BROKEN").exists()
    tg(ms, "fail", "t1", "--why", "the check fails")
    assert "may start with commits from those attempts" in tg(ms, "start", "t1", "--copy")
    again = worker_copy(ms, "t1", tmp_path, "second")
    assert (again / "BROKEN").exists()
    sh(again, "git", "rm", "-q", "BROKEN")
    sh(again, "git", "commit", "-qm", "undo")
    commit(again, "a.txt")
    tg(ms, "done", "t1", "--summary", "s", "--from", str(again))
    assert (ms / "a.txt").exists() and not (ms / "BROKEN").exists()


def test_continue_takes_the_work_from_a_workers_copy(ms, tmp_path):
    add(ms, [{"title": "a"}])
    tg(ms, "start", "t1", "--copy")
    clone = worker_copy(ms, "t1", tmp_path)
    commit(clone, "half.txt")
    tg(ms, "continue", "t1", "--summary", "half", "--left", "the rest", "--from", str(clone))
    assert (ms / "half.txt").exists() and state(ms)[0]["t2"]["state"] == "ready"


def test_from_is_turned_down_where_it_cannot_apply(ms, tmp_path):
    add(ms, [{"title": "a"}, {"title": "look", "type": "research"}])
    tg(ms, "start", "t1", "--copy")
    tg(ms, "start", "t2")
    clone = worker_copy(ms, "t1", tmp_path)
    assert "not a git checkout" in tg(ms, "done", "t1", "--summary", "s", "--from", str(tmp_path / "nope"), rc=1)
    assert "--no-merge" in tg(ms, "done", "t1", "--summary", "s", "--from", str(clone), "--no-merge", rc=1)
    assert "research task" in tg(ms, "done", "t2", "--summary", "s", "--from", str(clone), rc=1)
    assert state(ms)[0]["t1"]["state"] == "running"


def test_graph_is_found_from_inside_a_worktree(ms):
    add(ms, [{"title": "a"}])
    tg(ms, "start", "t1")
    assert "Milestone: Ship 0.3" in tg(wt_of(ms, "t1"), "status")


def test_release_returns_a_running_task_without_spending_an_attempt(ms):
    add(ms, [{"title": "a"}])
    tg(ms, "start", "t1")
    tg(ms, "release", "t1")
    t = state(ms)[0]["t1"]
    assert t["state"] == "ready" and t["attempts"] == 0


def test_works_without_git(tmp_path):
    tg(tmp_path, "init", "M")
    add(tmp_path, [{"title": "a"}, {"title": "b", "depends_on": [0]}])
    brief = tg(tmp_path, "start", "t1")
    assert "no separate worktree" in brief and not (tmp_path / ".milestone" / "wt").exists()
    assert "now ready: t2" in tg(tmp_path, "done", "t1", "--summary", "s")


# ---------------------------------------------------------------- when work goes wrong

def fail_times(repo, tid, n, why="tests still red"):
    out = ""
    for _ in range(n):
        tg(repo, "start", tid)
        out = tg(repo, "fail", tid, "--why", why)
    return out


def test_repeated_failure_puts_research_in_front_then_asks_the_user(ms):
    add(ms, [{"title": "hard"}, {"title": "after", "depends_on": [0]}])
    assert "research task t3 now runs first" in fail_times(ms, "t1", 3)
    tasks, _ = state(ms)
    assert tasks["t1"]["deps"] == ["t3"] and tasks["t1"]["state"] == "waiting" and tasks["t1"]["attempts"] == 0
    assert tasks["t3"]["type"] == "research" and tasks["t2"]["deps"] == ["t1"], "dependents never move"

    brief = tg(ms, "start", "t3")
    assert "do not change project files" in brief and "attempt 3: tests still red" in brief
    assert not wt_of(ms, "t3").exists(), "research gets no worktree"
    tg(ms, "done", "t3", "--summary", "the fixture is stale; regenerate it first")
    assert "Its findings:\n- the fixture is stale; regenerate it first" in tg(ms, "brief", "t1")

    assert "waits for the user" in fail_times(ms, "t1", 3)
    _, s = state(ms)
    assert s["stalled"] and s["waiting_on_user"][0]["id"] == "t1"
    assert "failed 3 times after research" in s["waiting_on_user"][0]["why"]

    tg(ms, "unblock", "t1", "--reply", "drop the fixture, use a temp dir")
    assert "the user said: drop the fixture, use a temp dir" in tg(ms, "start", "t1")


def test_blocked_holds_the_task_and_the_reply_opens_the_next_brief(ms):
    add(ms, [{"title": "deploy"}, {"title": "announce", "depends_on": [0]}, {"title": "docs"}])
    tg(ms, "start", "t1")
    tg(ms, "blocked", "t1", "--why", "no API key for the rates service", "--done", "client written",
       "--left", "live call")
    tasks, s = state(ms)
    assert tasks["t1"]["state"] == "blocked" and tasks["t1"]["attempts"] == 0
    assert tasks["t2"]["state"] == "waiting" and tasks["t3"]["state"] == "ready", "other work goes on"
    assert s["waiting_on_user"][0]["why"] == "no API key for the rates service"
    assert "t1 is blocked" in tg(ms, "start", "t1", rc=1)
    assert "not blocked" in tg(ms, "unblock", "t3", "--reply", "x", rc=1)

    tg(ms, "unblock", "t1", "--reply", "key is in RATES_KEY now")
    brief = tg(ms, "start", "t1")
    for text in ("reported it was blocked", "- done: client written", "- not done: live call",
                 "- why: no API key for the rates service", "The answer it was given: key is in RATES_KEY now"):
        assert text in brief


def test_continue_merges_what_exists_and_moves_dependents(ms):
    add(ms, [{"title": "big", "files": ["big.py"]}, {"title": "after", "depends_on": [0]}])
    tg(ms, "start", "t1")
    commit(wt_of(ms, "t1"), "big.py")
    out = tg(ms, "continue", "t1", "--summary", "parser done", "--left", "the writer half")
    assert "t3 continues it and t2 now wait for t3" in out
    tasks, _ = state(ms)
    assert tasks["t1"]["state"] == "done" and tasks["t3"]["deps"] == ["t1"] and tasks["t2"]["deps"] == ["t3"]
    assert (ms / "big.py").exists()
    brief = tg(ms, "start", "t3")
    assert "This continues t1" in brief and "the writer half" in brief


def test_insert_fix_goes_between_a_done_task_and_what_follows(ms):
    add(ms, [{"title": "core"}, {"title": "cli", "depends_on": [0]}])
    tg(ms, "start", "t1")
    tg(ms, "done", "t1", "--summary", "core")
    tg(ms, "insert-fix", "t1", "--title", "core rounds wrongly")
    tasks, _ = state(ms)
    assert tasks["t3"]["type"] == "fix" and tasks["t2"]["deps"] == ["t3"] and tasks["t2"]["state"] == "waiting"


def test_insert_fix_takes_the_fixed_tasks_files_unless_told(ms):
    add(ms, [{"title": "core", "files": ["core.py"]}])
    tg(ms, "start", "t1")
    tg(ms, "done", "t1", "--summary", "core")
    tg(ms, "insert-fix", "t1", "--title", "rounding")
    tg(ms, "insert-fix", "t1", "--title", "callers", "--files", "core.py,cli.py")
    assert json.loads(tg(ms, "show", "t2"))["files"] == ["core.py"]
    assert json.loads(tg(ms, "show", "t3"))["files"] == ["core.py", "cli.py"]


def test_cancel_lets_dependents_wait_for_what_it_waited_for(ms):
    add(ms, [{"title": "a"}, {"title": "b", "depends_on": [0]}, {"title": "c", "depends_on": [1]}])
    tg(ms, "cancel", "t2", "--why", "not needed")
    tasks, _ = state(ms)
    assert tasks["t3"]["deps"] == ["t1"] and tasks["t2"]["state"] == "cancelled"
    assert "was cancelled" in tg(ms, "add", "d", "--after", "t2", rc=1)


def test_a_problem_that_comes_back_shows_what_was_tried(ms):
    add(ms, [{"title": "fix flicker"}])
    tg(ms, "start", "t1")
    tg(ms, "done", "t1", "--summary", "debounced the redraw")
    tg(ms, "add", "flicker is back", "--same-as", "t1")
    brief = tg(ms, "start", "t2")
    assert "reported fixed before and came back (1 time)" in brief
    assert "t1 fix flicker: debounced the redraw" in brief and "end with blocked" in brief
    tg(ms, "done", "t2", "--summary", "moved the redraw to idle")

    out = tg(ms, "add", "flicker again", "--same-as", "t2")
    assert "research t4 runs first" in out
    tasks, _ = state(ms)
    assert tasks["t3"]["deps"] == ["t4"] and tasks["t4"]["type"] == "research"
    research = tg(ms, "start", "t4")
    assert "debounced the redraw" in research and "moved the redraw to idle" in research
    assert "that task is" in tg(ms, "add", "x", "--same-as", "t3", rc=1)


def test_note_reaches_the_next_brief_and_every_step_is_logged(ms):
    add(ms, [{"title": "a"}])
    tg(ms, "note", "t1", "use the v2 endpoint")
    assert "Notes from the lead:\n- use the v2 endpoint" in tg(ms, "start", "t1")
    events = [json.loads(line)["event"] for line in (ms / ".milestone" / "events.jsonl").read_text().splitlines()]
    assert events == ["init", "add", "note", "start"]


def test_archive_makes_room_for_the_next_milestone(ms):
    add(ms, [{"title": "a"}])
    tg(ms, "archive")
    assert list((ms / ".milestone" / "archive").glob("*/graph.json"))
    tg(ms, "init", "Ship 0.4")


# ---------------------------------------------------------------- merge now, verify later

def test_unverified_merge_holds_what_waits_until_verify(ms):
    add(ms, [{"title": "a"}, {"title": "b", "depends_on": [0]}])
    tg(ms, "start", "t1")
    commit(wt_of(ms, "t1"), "a.txt")
    out = tg(ms, "done", "t1", "--summary", "a exists", "--unverified")
    assert "held until you verify it" in out and (ms / "a.txt").exists()
    tasks, s = state(ms)
    assert tasks["t1"]["state"] == "unverified" and tasks["t2"]["state"] == "waiting" and not s["stalled"]
    assert "Waiting for you to verify: t1" in tg(ms, "status")
    assert "only a task merged" in tg(ms, "verify", "t2", rc=1)
    out = tg(ms, "verify", "t1", "--note", "built and ran it")
    assert "now ready: t2" in out
    assert state(ms)[0]["t1"]["summary"] == "a exists (verified: built and ran it)"


def test_insert_fix_on_an_unverified_task_lets_the_fix_run_next(ms):
    add(ms, [{"title": "a", "files": ["a.txt"]}, {"title": "b", "depends_on": [0]}])
    tg(ms, "start", "t1")
    commit(wt_of(ms, "t1"), "a.txt")
    tg(ms, "done", "t1", "--summary", "a", "--unverified")
    tg(ms, "insert-fix", "t1", "--title", "a is off by one")
    tasks, _ = state(ms)
    assert tasks["t1"]["state"] == "done" and tasks["t3"]["state"] == "ready" and tasks["t2"]["state"] == "waiting"


# ---------------------------------------------------------------- spawning shrimp-pi workers from start

def fake_shrimp(tmp_path, workspace):
    """A stand-in shrimp-pi: records its arguments and answers spawn and status like the real one."""
    log = tmp_path / "shrimp-calls.jsonl"
    exe = tmp_path / "fake-shrimp-pi"
    exe.write_text(f"""#!{sys.executable}
import json, sys
open({str(log)!r}, "a").write(json.dumps(sys.argv[1:]) + "\\n")
cmd = sys.argv[1]
if cmd == "spawn":
    print(json.dumps({{"ok": True, "workerId": "w-1234567890", "revision": 2, "workspaceDir": {str(workspace)!r}}}))
elif cmd == "status":
    print(json.dumps({{"ok": True, "workerId": sys.argv[2], "workspaceDir": {str(workspace)!r}}}))
else:
    print(json.dumps({{"ok": False, "error": "unexpected"}})); sys.exit(1)
""")
    exe.chmod(0o755)
    return exe, log


def test_start_spawn_hands_the_brief_to_a_worker_and_done_takes_its_work(ms, tmp_path):
    add(ms, [{"title": "a", "desc": "make a.txt"}, {"title": "b", "depends_on": [0]}])
    clone = tmp_path / "worker"
    exe, log = fake_shrimp(tmp_path, clone)
    ENV["SHRIMP_PI_BIN"] = str(exe)
    try:
        out = json.loads(tg(ms, "start", "t1", "--spawn", "--json", "--config", "other-model.json"))
        assert out["worker"] == "w-1234567890" and out["revision"] == 2
        spawn = json.loads(log.read_text().splitlines()[0])
        assert spawn[:3] == ["spawn", "--repo", str(wt_of(ms, "t1"))] and "--label" in spawn and "t1" in spawn
        assert spawn[spawn.index("--config") + 1].endswith("other-model.json")
        brief = Path(spawn[spawn.index("--task") + 1]).read_text()
        assert "make a.txt" in brief and "your own copy of the project" in brief
        assert state(ms)[0]["t1"]["worker"] == "w-1234567890"
        sh(tmp_path, "git", "clone", "-q", "--no-hardlinks", str(wt_of(ms, "t1")), str(clone))
        commit(clone, "a.txt")
        out = tg(ms, "done", "t1", "--summary", "a exists", "--from-worker")
        assert "merged at" in out and "now ready: t2" in out and (ms / "a.txt").exists()
        assert "not both" in tg(ms, "done", "t2", "--summary", "x", "--from", str(clone), "--from-worker", rc=1)
    finally:
        ENV.pop("SHRIMP_PI_BIN", None)


def test_a_failed_spawn_puts_the_task_back_without_spending_an_attempt(ms, tmp_path):
    add(ms, [{"title": "a"}])
    ENV["SHRIMP_PI_BIN"] = str(tmp_path / "no-such-shrimp-pi")
    try:
        assert "could not run" in tg(ms, "start", "t1", "--spawn", rc=1)
    finally:
        ENV.pop("SHRIMP_PI_BIN", None)
    tasks, _ = state(ms)
    assert tasks["t1"]["state"] == "ready" and tasks["t1"]["attempts"] == 0
    tg(ms, "start", "t1", "--copy")
    assert "no shrimp-pi worker on record" in tg(ms, "done", "t1", "--summary", "s", "--from-worker", rc=1)


def test_the_next_milestone_never_builds_on_an_old_branch(ms):
    add(ms, [{"title": "a"}])
    tg(ms, "start", "t1")
    commit(ms / ".milestone" / "wt" / "t1", "old.txt")
    tg(ms, "done", "t1", "--summary", "old work")
    commit(ms, "newer.txt")  # main moves on after the milestone
    out = tg(ms, "archive")
    assert "milestone/t1 -> milestone-old/" in out
    tg(ms, "init", "Ship 0.4")
    add(ms, [{"title": "b"}])
    tg(ms, "start", "t1")
    wt = ms / ".milestone" / "wt" / "t1"
    assert sh(wt, "git", "rev-parse", "HEAD") == sh(ms, "git", "rev-parse", "main")


def test_a_leftover_branch_is_set_aside_on_first_start(ms):
    sh(ms, "git", "branch", "milestone/t1")  # e.g. archived before branches were moved
    commit(ms, "newer.txt")
    add(ms, [{"title": "a"}])
    out = tg(ms, "start", "t1")
    assert "starts fresh" in out
    wt = ms / ".milestone" / "wt" / "t1"
    assert sh(wt, "git", "rev-parse", "HEAD") == sh(ms, "git", "rev-parse", "main")
