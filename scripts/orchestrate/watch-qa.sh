#!/usr/bin/env bash
# QA watcher: grabs In-Review issues labeled agent:qa, reviews the tech branch
# diff against the spec, marks Done (pass) or bounces to Todo + changes-requested.
source "$(dirname "$0")/lib.sh"

log "watch-qa up. Project '$PROJECT'. Poll every ${INTERVAL}s for In Review + agent:qa."
while true; do
  id=$(lin_poll "$STATE_REVIEW" "$LABEL_QA")
  if [ -n "$id" ]; then
    log "GRABBED $id for review"
    branch="agent/$(echo "$id" | tr 'A-Z' 'a-z')"
    spec="$LOGDIR/spec-$id.md"
    [ -s "$spec" ] || lin_desc "$id" > "$spec"
    diff=$(git -C "$REPO" diff "main..$branch" 2>/dev/null | head -c 60000)

    lin "In Linear: add a comment to issue $id: \"🤖 QA agent grabbed this — reviewing $branch.\" Output DONE." >/dev/null

    review_prompt="You are a QA reviewer for a SOFT TEST. Decide whether the diff is a reasonable implementation of the spec. Output EXACTLY one line: start with PASS or FAIL, then one sentence why. Be fair — accept a sensible partial implementation that follows the spec's intent; FAIL only for clearly wrong or empty work.

----- SPEC -----
$(cat "$spec")

----- DIFF (main..$branch) -----
${diff:-(empty diff)}"

    verdict=$(claude -p "$review_prompt" --model "$WORKER_MODEL" --max-budget-usd "$QA_BUDGET" --output-format json 2>/dev/null | jq -r '.result // empty' | head -c 400)
    log "$id → verdict: $verdict"
    safe=$(echo "$verdict" | tr '\n' ' ' | sed "s/\"/'/g")

    if echo "$verdict" | grep -qi '^[[:space:]]*PASS'; then
      lin "In Linear: update issue $id — set status to \"$STATE_DONE\" and labels to EXACTLY [$LABEL_KEEP]. Add a comment: \"✅ QA PASS — $safe\" Output DONE." >/dev/null
      log "$id → Done (PASS)"
    else
      lin "In Linear: update issue $id — set status to \"$STATE_TODO\" and labels to EXACTLY [$LABEL_CHANGES, $LABEL_KEEP]. Add a comment: \"❌ QA FAIL — $safe\" Output DONE." >/dev/null
      log "$id → bounced to Todo (FAIL / changes-requested)"
    fi
  else
    log "no QA work; sleeping ${INTERVAL}s"
  fi
  sleep "$INTERVAL"
done
