# Standing Up Linear Orchestration on a New Project — and Scaling to More Agents

Companion to `README.md`. This is the **set-it-up-elsewhere** guide: how to drop the kit onto a fresh repo, and how to grow from the 2-agent (tech → QA) soft test to a **multi-agent pipeline**.

The core idea is unchanged: **Linear is the baton.** Each agent is a small loop that polls Linear over **free GraphQL**, does work only when its label appears, and passes the baton by flipping a label. Idle cost ≈ $0; you pay Claude only for the work itself.

---

## 1. Per-machine prerequisites (once)
- `claude` CLI on PATH + logged in (the worker/reviewer engine, headless `-p`).
- `jq`, and `tmux` if you want to watch the loops live.

## 2. Per-project setup (checklist)

1. **Copy the kit:** `cp -r scripts/orchestrate <new-repo>/scripts/`.
2. **Make a Linear agent token** (this is what makes polling free *and* reliable):
   - Linear → Settings → **API → Applications → New** (type *Agent*).
   - **Developer token → "Create & copy token"** → `lin_oauth_…`. *(NOT the Client ID/secret — those need the OAuth flow and won't authenticate the API.)*
   - Repo `.env`: `LINEAR_API_KEY=lin_oauth_…` — and **gitignore `.env`**.
3. **Create the Linear project + one label per stage** (see the label graph below).
4. **Edit `config.sh`** — the only per-project file: `REPO`, `PROJECT`, `PROJECT_ID`, the `LABEL_*` / `STATE_*` names, models, budgets, `INTERVAL`.
5. **Tune each watcher's worker prompt** to the project's real verification (run its tests / typecheck / lint; note visual checks as pending human review — headless agents can't drive a browser).
6. **Run** the watchers (tmux or background) and **push an issue** carrying the entry label, with the full spec as the description.

---

## 3. Scaling to more agents

There are **two independent axes**. Do Axis A first — it's robust and needs no locking. Add Axis B only when throughput demands it.

### Axis A — more STAGES (sequential pipeline; the safe scale)

Model the pipeline as a **label graph**. Each stage = one label + one watcher. An issue sits at exactly one stage at a time, so **no two agents ever touch the same issue** — concurrency is free.

```
push → spec:ready ─► research:ready ─► build:ready ─► test:ready ─► review
                       (researcher)      (implementer)   (tester)     (reviewer)
                                                                       │
                                                          Done ◄───────┤
                                              changes-requested ◄───────┘  (loops back to build:ready)
```

**To add a stage:** copy `watch-tech.sh` → `watch-<stage>.sh` and change exactly three things:
1. **Poll** — `lin_poll "$STATE_X" "$LABEL_THIS_STAGE"` (what it grabs).
2. **Worker prompt** — what this agent does (research / implement / test / write docs…), and its verification.
3. **Handoff** — the `lin "...set status ... labels [$LABEL_NEXT_STAGE,$LABEL_KEEP]..."` call (where it passes the baton).

`lib.sh` + `config.sh` are shared across all watchers — add the new `LABEL_*` to `config.sh`.

> Different agents can use different `WORKER_MODEL`s — a cheap model for mechanical stages, a strong one for design/review. Set per-watcher by overriding `WORKER_MODEL` before the `claude -p` call.

### Axis B — more PARALLELISM (many issues / many workers at once)

The soft-test kit runs **one issue at a time** with a **fixed** worktree (`.worktrees/agent-tech`). To run workers concurrently, two changes:

**1. Per-issue worktrees** — never share a checkout between concurrent workers:
```bash
wt="$REPO/.worktrees/agent-$id"          # was: .worktrees/agent-tech
git -C "$REPO" worktree add -B "agent/$id" "$wt" main
# … run worker in $wt … then on completion:
git -C "$REPO" worktree remove --force "$wt"
```
Each issue gets its own branch `agent/<id>` off `main` — so two workers never collide.

**2. A claim-lock** so two pollers don't grab the same issue. Use Linear **assignment** as the lock:
- Give each agent its **own** agent token (so each has a distinct actor), or assign to one shared agent.
- Poll filter adds `assignee: { null: true }` (only unclaimed issues).
- On grab, **assign + move state in one mutation** (atomic-enough claim) *before* doing any work. A second poller then sees it assigned and skips it.

```graphql
# poll: unclaimed work at this stage
issues(first:1, filter:{ project:{id:{eq:$p}}, state:{name:{eq:$st}},
        labels:{some:{name:{in:$l}}}, assignee:{null:true} }) { nodes{ identifier id } }
# claim: assign to this agent + advance state (do this immediately on grab)
issueUpdate(id:$id, input:{ assigneeId:$agentUserId, stateId:$inProgressId })
```

**Budget at scale:** `--max-budget-usd` is *per run*. N concurrent workers = up to N × budget. Set a ceiling you're comfortable with and cap `INTERVAL` so you're not spinning up workers faster than they finish.

---

## 4. Gotchas at scale (learned the hard way)

- **Never parse an LLM's poll output** — always GraphQL. (An LLM asked for "the id or NONE" will append prose and defeat your guard. This bit us; it's why polling is GraphQL-only.)
- **Gate handoffs on ground truth** (commit count / tests pass), never the agent's self-report. And never `2>&1` a worker's result into the JSON you parse — keep stderr separate.
- **One shared Playwright browser = one driver.** Headless agents can't all screenshot; visual QA stays human, or give the review agent its own isolated browser (`--isolated`). Don't let agents fight over it.
- **No two workers on one branch** — per-issue branches enforce this.
- **Keep the no-push guard.** Workers commit locally; integrate via a human merge or a dedicated "merge" stage-agent. Don't let autonomous workers push to `origin`.
- **GraphQL rate limits** — fine at `INTERVAL ≥ ~30s` per watcher; don't run 20 watchers at 5s.

---

## 5. Recommended shape for the pressing project

Start sequential (Axis A), 3–4 agents:

| Agent | Grabs | Does | Hands to |
|-------|-------|------|----------|
| **Planner** | `spec:ready` | turns a brief into a self-contained spec on the issue | `build:ready` |
| **Implementer** | `build:ready` | writes code in a per-issue worktree, commits, tests | `review:ready` |
| **Reviewer** | `review:ready` | diffs vs spec, verdict | `Done` / `changes-requested` |
| *(optional)* **Merger** | `merge:ready` | fast-forwards approved branches to a staging branch | `Done` |

Add a second Implementer (Axis B: per-issue worktrees + assignment lock) only once one agent can't keep up. Ship the pipeline before you parallelize it.

*Derived from the Image Blaster soft test, 2026-05-25 — tech → QA, run end-to-end, with the two parsing/handoff bugs already fixed in this kit.*
