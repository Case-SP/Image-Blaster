#!/usr/bin/env bash
# TECH watcher: grabs Todo issues labeled agent:tech (or agent:changes-requested),
# implements them headlessly on a fresh branch off main, hands off to QA.
source "$(dirname "$0")/lib.sh"

log "watch-tech up. Project '$PROJECT'. Poll every ${INTERVAL}s for Todo + agent:tech / agent:changes-requested."
while true; do
  id=$(lin_poll "$STATE_TODO" "$LABEL_TECH,$LABEL_CHANGES")
  if [ -n "$id" ]; then
    log "GRABBED $id"
    branch="agent/$(echo "$id" | tr 'A-Z' 'a-z')"
    spec="$LOGDIR/spec-$id.md"
    lin_desc "$id" > "$spec"

    # claim: In Progress, drop the agent:tech/changes-requested label, comment
    lin "In Linear: update issue $id — set status to \"$STATE_PROGRESS\" and set its labels to EXACTLY [$LABEL_KEEP] (removing $LABEL_TECH and $LABEL_CHANGES). Then add a comment: \"🤖 tech agent grabbed this — implementing on branch $branch.\" Output DONE." >/dev/null
    log "$id → In Progress (branch $branch)"

    # fresh worktree on a new branch off main (isolated from wt/technical)
    wt="$REPO/.worktrees/agent-tech"
    git -C "$REPO" worktree remove --force "$wt" 2>/dev/null
    git -C "$REPO" branch -D "$branch" 2>/dev/null
    if ! git -C "$REPO" worktree add -B "$branch" "$wt" main >/dev/null 2>&1; then
      log "$id → FAILED to create worktree; skipping"; sleep "$INTERVAL"; continue
    fi
    # hard no-push guard (per-worktree) if a remote exists
    if git -C "$REPO" remote | grep -q .; then
      git -C "$wt" config extensions.worktreeConfig true 2>/dev/null
      git -C "$wt" config --worktree remote.origin.pushurl "BLOCKED://no-push-soft-test" 2>/dev/null
    fi

    worker_prompt="You are the technical implementer working in an isolated git worktree at $wt (branch $branch, freshly cut from main). Implement the spec below TASK BY TASK. Commit after each task with a clear conventional-commit message. NEVER run 'git push' — commits stay local. You CANNOT use the Playwright MCP (the shared browser is in use elsewhere): implement the code, do static verification instead (run 'node --check' on any JS you change, grep for the new classes/selectors you added), and write 'visual/Playwright verification: pending human review' into your final commit message. When every task is committed, stop and summarize what you did.

----- SPEC ($id) -----
$(cat "$spec")"

    log "$id → launching tech worker (sonnet, cap \$$WORKER_BUDGET)…"
    ( cd "$wt" && claude -p "$worker_prompt" --model "$WORKER_MODEL" \
        --permission-mode acceptEdits \
        --allowedTools "Bash Edit Write Read Glob Grep MultiEdit" \
        --max-budget-usd "$WORKER_BUDGET" --output-format json \
        > "$LOGDIR/worker-$id.json" 2> "$LOGDIR/worker-$id.err" )

    err=$(jq -r '.is_error // true' "$LOGDIR/worker-$id.json" 2>/dev/null)
    sha=$(git -C "$wt" rev-parse --short HEAD 2>/dev/null)
    cost=$(jq -r '.total_cost_usd // 0' "$LOGDIR/worker-$id.json" 2>/dev/null)
    commits=$(git -C "$REPO" rev-list --count "main..$branch" 2>/dev/null)
    log "$id → worker done (is_error=$err, head=$sha, commits=$commits, cost=\$$cost)"

    if [ "${commits:-0}" -gt 0 ]; then
      lin "In Linear: update issue $id — set status to \"$STATE_REVIEW\" and set labels to EXACTLY [$LABEL_QA, $LABEL_KEEP]. Add a comment: \"🤖 tech agent done. Branch $branch @ $sha, $commits commit(s) (worker is_error=$err). Ready for QA.\" Output DONE." >/dev/null
      log "$id → In Review + agent:qa. Handed off to QA."
    else
      lin "In Linear: add a comment to issue $id: \"🤖 tech agent run did not produce commits (is_error=$err). Left In Progress — see worker-$id.json.\" Output DONE." >/dev/null
      log "$id → no commits / error; left In Progress for inspection."
    fi
  else
    log "no tech work; sleeping ${INTERVAL}s"
  fi
  sleep "$INTERVAL"
done
