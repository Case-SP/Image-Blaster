# Linear-Orchestrated Agents — Portable Playbook

A **free, autonomous, multi-agent dev pipeline** driven by Linear. You push an issue; a watcher grabs it, an AI agent implements it in an isolated branch, a second agent reviews the diff, and the issue moves across your Linear board on its own. Idle cost is ~$0 — the heartbeat is a structured Linear GraphQL poll, not an LLM. You pay Claude only for the actual work (implement + review).

> This folder is a **drop-in kit**. Copy `scripts/orchestrate/` into any repo, edit the config block, point it at a Linear project, and go.

---

## How it works

```
you push an issue  ─►  Todo + label  agent:tech
        │
   watch-tech.sh   (polls Linear GraphQL every ~45s — free)
        │ claims → In Progress, cuts a fresh branch off main in an isolated worktree
        │ runs a headless `claude -p` worker (budget-capped, no push) — implements task-by-task, commits each
        │ on commits>0 → In Review + label  agent:qa
        ▼
   watch-qa.sh     (polls for In Review + agent:qa)
        │ reviews the branch diff against the spec (headless `claude -p`)
        ▼
   verdict → Done        (PASS)
          or → Todo + agent:changes-requested   (FAIL → watch-tech re-grabs)
```

**Linear is the baton.** State + labels are the only shared memory between agents. Each watcher owns one stage. You can chain more stages by adding labels + watchers (the SP `research:complete → deck:ready` strategy-deck agent is the same shape).

---

## The pieces

| File | Role |
|------|------|
| `config.sh` | **The only per-project file you edit.** Repo path, Linear project name + UUID, label/state names, models, budgets. |
| `lib.sh` | Generic helpers. `lin_poll <state> <labels>` reads Linear over **GraphQL** (free, structured); `lin <prompt>` does the infrequent **writes** via `claude -p` + the Linear MCP. |
| `watch-tech.sh` | The implementer loop. Grabs `agent:tech`/`agent:changes-requested`, runs the worker in `.worktrees/agent-tech`, hands off to QA. |
| `watch-qa.sh` | The reviewer loop. Grabs `agent:qa`, diffs `main..agent/<id>`, PASS→Done or FAIL→bounce. |
| `logs/` | Per-run logs + the worker/spec artifacts. |

---

## Prerequisites (once per machine)

- **Claude CLI** (`claude`) on PATH, logged in. Headless mode (`-p`) is the worker/reviewer engine.
- **`jq`** and (for live watching) **`tmux`**.
- **A Linear "developer token"** — see setup. This is what makes polling free.

## Setup (per project — ~5 minutes)

1. **Copy the kit:** `cp -r scripts/orchestrate <your-repo>/scripts/`.

2. **Make a Linear agent token** (the key trick):
   - Linear → Settings → **API → Applications → New** (type *Agent*).
   - On the app page, **Developer token → "Create & copy token"** → you get a `lin_oauth_…` token. *(NOT the Client ID/secret — those are for the OAuth flow and won't authenticate the API directly.)*
   - Put it in the repo's **`.env`**: `LINEAR_API_KEY=lin_oauth_…` — and make sure `.env` is gitignored.
   - The agent acts as its own actor in Linear, so its grabs/comments are attributable.

3. **Make the Linear surface:**
   - A **project** for the work.
   - Three labels: `agent:tech`, `agent:qa`, `agent:changes-requested`.
   - Confirm your team's state names (default Linear: `Todo / In Progress / In Review / Done`).

4. **Edit `config.sh`** — the only per-project file:
   - `REPO` — absolute path to the repo.
   - `PROJECT` + `PROJECT_ID` — the Linear project name and UUID (from `list_projects` or the project URL).
   - `LABEL_TECH` / `LABEL_QA` / `LABEL_CHANGES` / `LABEL_KEEP` and `STATE_*` — match the labels you created and your team's state names.
   - `WORKER_MODEL` / `WORKER_BUDGET` / `QA_BUDGET` / `INTERVAL` to taste.

5. **Tune the worker prompt** in `watch-tech.sh` to your project's verification (it currently tells the agent it can't drive Playwright and to do static checks instead — adjust for your stack: run tests, typecheck, lint, etc.).

## Run

```bash
# live, watchable:
tmux new-session -d -s orchestra -n tech "cd $REPO && exec bash scripts/orchestrate/watch-tech.sh"
tmux new-window  -t orchestra -n qa   "cd $REPO && exec bash scripts/orchestrate/watch-qa.sh"
# or background:
bash scripts/orchestrate/watch-tech.sh >> scripts/orchestrate/logs/watch-tech.run.log 2>&1 &
bash scripts/orchestrate/watch-qa.sh   >> scripts/orchestrate/logs/watch-qa.run.log   2>&1 &
```

**Push work** = create a Linear issue in the project, `Todo` + `agent:tech`, with the **full spec as the description** (the worker reads the description as its brief — make it self-contained: goal, files, tasks, done-when, out-of-scope).

---

## The contract (issue lifecycle)

| Stage | State | Label |
|-------|-------|-------|
| pushed | Todo | `agent:tech` |
| tech building | In Progress | (cleared) |
| tech done | In Review | `agent:qa` |
| passed | Done | (cleared) |
| bounced | Todo | `agent:changes-requested` (tech re-grabs) |

## Safety envelope

- **Isolated worktree** per task: `agent/<issue>` branched off `main` in `.worktrees/agent-tech` — never touches your working branches.
- **No push:** a per-worktree blocked `pushurl` is set, and the worker is told never to push. Commits stay local for you to review/merge.
- **Budget cap:** `--max-budget-usd` on every worker and reviewer run.
- **Scoped permissions:** headless `--allowedTools` pre-approves exactly what's needed (plain `acceptEdits` stalls headless on MCP/git calls).
- **One issue at a time** per watcher.

## Cost model

| | Cost |
|---|---|
| Idle polling | **$0** — Linear GraphQL is free within your plan; no Claude tokens. |
| Tech worker run | Claude tokens (the real work) — capped by `WORKER_BUDGET`. |
| QA review run | Claude tokens — capped by `QA_BUDGET`. |
| MCP writes (claim/handoff/verdict) | ~$0.05 each via `claude -p` (infrequent). Convert to GraphQL mutations to zero these out too. |

---

## Hard-won lessons (we hit every one of these)

1. **Never parse an LLM's poll output.** An LLM asked for "the id or NONE" will helpfully append "…no issues found", defeating a `!= NONE` guard and making the watcher "grab" garbage. **Poll over GraphQL** — structured data can't hallucinate prose into your control flow. (This is the single biggest reason the agent token matters; cost is secondary.)
2. **Gate handoffs on ground truth, not the agent's self-report.** Hand off when `commits > 0` (or tests pass), not when the agent *says* it succeeded.
3. **Never merge stderr into a parsed result file.** `> out.json 2>&1` corrupts the JSON; `jq` then misreads it. Keep stderr separate (`2> out.err`).
4. **Headless agents can't share one Playwright/MCP browser** (single driver). Visual/UI verification stays a human step — have the worker note it as "pending human review."
5. **OAuth Client ID/secret ≠ API token.** Use the app's **Developer token** (`lin_oauth_…`) as the bearer.
6. **`acceptEdits` alone isn't enough headless** — pre-approve tools with `--allowedTools` (or `--dangerously-skip-permissions` only inside a trusted, no-push sandbox).

## Extending it

- **More stages:** add a label + a watcher per stage (e.g. `design:ready`, `deploy:ready`). Same pattern.
- **Full Claude-independence:** convert the `lin` writes to GraphQL mutations (`issueUpdate`, `commentCreate`) so the agent token does everything and the only Claude spend is the work itself.
- **Instant trigger:** swap polling for a Linear **webhook** + a tiny local listener (needs a public endpoint/tunnel) if 45s latency matters.
- **Concurrency:** add a claim-lock (e.g., assign the issue to the agent on grab) before running multiple workers in parallel.

---

*Born from the Image Blaster soft test, 2026-05-25. Linear project "Image Blaster — Agent Orchestration", agent actor "Tetsuo".*
