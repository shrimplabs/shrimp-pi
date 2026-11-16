#!/usr/bin/env sh
# Supervisor-agnostic driver: works from Codex, Claude, Vibe, cron, or a shell.
# Requires only a POSIX shell, jq, and bin/shrimp-pi.
#
#   SHRIMP=./bin/shrimp-pi REPO=/path/to/repo TASK=examples/task.md ./examples/supervisor-loop.sh
#
# CONFIG=<file> is optional; without it spawn uses $SHRIMP_PI_CONFIG or ~/.config/shrimp-pi/config.json.
set -eu

BRIDGE="${SHRIMP:-bin/shrimp-pi}"
REPO="${REPO:?set REPO to the git repository}"
TASK="${TASK:?set TASK to a task file}"
CONFIG="${CONFIG:-}"
MAX_TURNS="${MAX_TURNS:-6}"

spawn() {
  if [ -n "$CONFIG" ]; then set -- --config "$CONFIG"; else set --; fi
  "$BRIDGE" spawn --repo "$REPO" --task "$TASK" "$@" | jq -r .workerId
}

id=$(spawn)
echo "worker $id" >&2
revision=1
turn=0

while [ "$turn" -lt "$MAX_TURNS" ]; do
  turn=$((turn + 1))
  # Long poll: the CLI blocks on the daemon socket until an attention event newer than
  # $revision appears, or the timeout expires (a normal outcome, not an error).
  out=$("$BRIDGE" wait "$id" --timeout 300 --after "$revision" || true)
  state=$(printf '%s' "$out" | jq -r '.state // "UNKNOWN"')
  revision=$(printf '%s' "$out" | jq -r '.revision // 1')

  case "$state" in
    REVIEW_REQUIRED)
      "$BRIDGE" review "$id" | jq '{diffPath, reportMd, filesChanged, untrackedFiles, agentClaims, evidence}' >&2
      # The calling supervisor now inspects the diff and runs independent checks.
      # It can then call steer or accept; this transport example makes no review decision.
      echo "Review the artifacts, verify the changes, then steer or accept worker $id." >&2
      break
      ;;
    BLOCKED)
      printf '%s' "$out" | jq '{attention, report}' >&2
      echo "Supervisor judgment required. Use steer to answer the blocker for worker $id." >&2
      break
      ;;
    FAILED)
      echo "Inspect diagnostics, then recover and explicitly steer worker $id if appropriate." >&2
      break
      ;;
    RUNNING)
      : # still working; the loop waits again
      ;;
    COMPLETED | STOPPED)
      break
      ;;
    *)
      echo "Bridge returned an unexpected response; inspect diagnostics for $id." >&2
      break
      ;;
  esac
done

"$BRIDGE" status "$id" | jq '{workerId, state, revision, attention, usage, warnings}'
