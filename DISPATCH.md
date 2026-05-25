# Dispatch — Image Blaster

State of the project. Updated as work lands.

Cold start: `DISPATCH.md` (here) → `v2/cartridge/product/PLAN.md` (design intent) → `v2/cartridge/product/learnings.md` (technical truths from past sessions).

---

## Worktree roles — logos protocol (2026-05-25)

Logos work runs as a four-window pipeline. Each window is a git worktree on its own branch + port; all share one `.git` and one Supabase backend. Cold-start any window by reading this file to learn its role.

| Window | Path | Branch | Port | Role |
|---|---|---|---|---|
| `specs` | `.worktrees/specs` | `wt/specs` | 3004 | **Planner.** Writes specs (`docs/`) + todo lists the implementers execute. brainstorming → writing-plans. Markdown only, merges clean. Runs *first*. |
| `technical` | `.worktrees/technical` | `wt/technical` | 3002 | **Implementer** — instrumentation & correctness (below). |
| `aesthetic` | `.worktrees/aesthetic` | `wt/render-v3` | 3003 | **Implementer** — Stage 2 render, dialed in (below). |
| `qa` | `.worktrees/qa` | `wt/qa` | 3005 | **Reviewer.** Diffs `main..wt/technical` and `main..wt/render-v3` against the specs, flags issues pre-merge. code-review skill. Edits no code. |
| (main) | repo root | `main` | — | Clean reference + merge target. |

**Flow:** planner drafts specs/todos → technical + aesthetic build in parallel → QA reviews both diffs against specs → merge to `main`. Expect merge conflicts in shared files: `orchestrator.js`, `render/fal.js`, `factory/logoContext.js`, `cartridge/logos/{profile,compositions}.json`.

**▶ Active spec (2026-05-25): logos generalized prompting + per-stage aesthetic ceiling** → `docs/plans/2026-05-25-logos-generalized-prompting.md` (REVISION 2, `50dc5ca`). Root cause is wiring, not the LLM: the 12-register *prose* in `profile.styles` never reaches the model. **Task 2 (wire the prose into the prompt) is load-bearing — do it first;** the model upgrade is Task 1b (secondary).

> **⚠ Coordination — `logoContext.js` lives on two branches.** Task 1 (the register router) was implemented and committed on **`wt/specs`** (`5aeb8ce`, editing `factory/logoContext.js` + `cartridge/logos/learnings.md`) rather than `wt/technical`. The planner branch is meant to be markdown-only, so treat `5aeb8ce` as the exception. **Before `wt/technical` edits `logoContext.js`, cherry-pick / merge `5aeb8ce`** so the two branches don't fork the same file at merge time.

**Viewing the UI — every worktree opens in Playwright.** Don't judge render/UI work from logs; open the running server in the Playwright MCP browser at its port and look. Technical → http://localhost:3002, aesthetic → http://localhost:3003, specs → :3004, qa → :3005. The Playwright MCP is one shared browser across all windows — give each window its own tab (`browser_tabs`) and never navigate another window's tab out from under it. QA in particular should screenshot rendered output, not infer pass/fail from the run listing.

### Worktree `technical` (`wt/technical`) — instrumentation & correctness

1. **No-shows.** May 9–10 logos runs report `status: done` with `renderProgress {ok:4, failed:0, total:0}` but paint nothing in the grid. `total:0` is the tell. Trace why the tiles index returns empty for these runs — start at `GET /api/public/tiles?cartridge=logos` in `routes/public.js`, then the `images` rows + thumbnail bucket in `storage/supabase.js`, and the `runs.cartridge/stage` denorm columns.
2. **Reference + prompt tracing.** Pin down exactly how refs are parsed and passed to each model: cartridge ref loader (`factory/cartridge.js`) → orchestrator ref filtering / dual-source `ref_sources` → `render/fal.js` payload. Capture the literal image-reference list, the assembled image prompt, and the system prompt sent per model (nano-banana-pro vs gpt-image-2). Write findings into `v2/cartridge/logos/learnings.md`.
3. **Image override.** Confirm the per-stage refs-override modal actually *replaces* cartridge refs at the fal call (Sketch tab today) and isn't silently dropped in the orchestrator. Make image override reliable end-to-end.

### Worktree `aesthetic` (`wt/render-v3`) — Stage 2 render, dialed in

1. **Render v3.** Build/iterate Stage 2 (`system-split-4x5` or its v3 successor): composition skeleton, dual-source refs (`logo-only/` + `wordmark/`) vs the curated `system/` set, render slot vocab. Dial output in by eye.
2. **Separate clients.** Server runs on its own port (`PORT=3003`) alongside the technical server. Caveat: open mode keys the Supabase client on a hardcoded `PUBLIC_EMAIL`, so both worktrees share one client/runs pool unless we make the email env-driven — revisit if hard data isolation is needed.

---

## North star

A **generalized prompt system** for product imagery — composable systems of art direction (compositions, slots), mood curation (palettes, atmospheres, references), camera, and figure interaction that can be **moved around as needed** and **scaled to any object** (toothbrush → bed → wall lamp).

**KPI:** 70% of generated images are subjectively passable at scale (target: 700 of every 1000). Humans can do this 1:1 all day; this system has to do it automatically.

**Routing inputs (signals from the user):**
1. The input title (text)
2. What the user **selected to promote** (positive signal: this worked)
3. What the user **dropped into refs** (mood / direction)
4. What the user **amplified with a note** (positive + steering)
5. What the user **ignored / didn't promote** (latent negative signal — not yet wired)

The orchestrator's job: turn those signals into the right cartridge slot picks, the right reference set, and the right prompt prefix, for any object.

---

## What's running

- **Local server:** `npm run dev` → `http://localhost:3002`. `--watch` reloads on change. Open mode (`AUTH_MODE=open`).
- **UI:** `v2/ui-client/` only. Three-column funnel for product cartridge: Sketch → Product → In-situ.
- **Cartridge:** product (only active). nolla / demo archived under `v2/cartridge/_archived/`.
- **Models in cycle:** `nano` → `flux` → `gpt-2*` → `both*` → `all*` (stars are experimental, ungated in open mode). On parent-as-subject runs, `gpt-image-2` auto-routes to `/edit`; `flux-pro/v1.1-ultra` (no image input) is filtered out.
- **Storage:** Supabase only. PNGs in private `generations` bucket; pre-baked 384-wide WebP thumbnails in public `generations-thumbs` bucket → tile grid loads from CDN, no Node round-trip.
- **DB indexes (live):** `idx_runs_client_started`, `idx_runs_status_started`, `idx_images_run_id`, `idx_runs_client_cartridge_started`. Real `cartridge` + `stage` columns on `runs`, kept in sync by trigger.

---

## Architecture (current)

### Per-batch classifier
`v2/src/factory/objectContext.js` — one Haiku call per batch on the input title, returns a generalized object schema cached on `trace.input.objectContext`:

```
{ object_kind, form_factor, scale, occupies, use_height, orientation, activity, natural_environments[] }
```

`scale ∈ {hand, desk, human, room}` · `occupies ∈ {free-standing, wall-vertical, ceiling-hung, surface-rest, floor-rest, hand-held, body-worn, embedded}` · `use_height ∈ {floor, knee, hip, torso, task, eye, overhead}`.

Promote runs reuse the parent trace's cached classification — zero re-classify cost. The in-situ prefix injects descriptive facts (`The object is a {kind} ({form_factor})… occupies {occupies} space at {use_height} height…`). No MUST-NOT prose, no hardcoded patches — the structured facts are the input; the cartridge slot vocabulary + user refs are the controls; the model decides.

### Reference override modal
`Sketch` and `In-situ` tabs in the modal (open via the `+` chip above the funnel). Each stage stores its own array in IndexedDB, persistent across hard refresh. When a stage has user refs loaded, the orchestrator **replaces** cartridge style refs with them for that stage. Sketch refs also ride into downstream stages as vibe refs (parent image stays first as subject anchor).

### Promote chain (parent-as-subject)
Selecting a tile and promoting fires a new run with the parent image as the first reference. The orchestrator:
- Reads the parent trace's resolved prompt for that exact filename → injects as **design intent** in the new prefix
- Picks the right cross-stage prefix (sketch → product, product → in-situ, or same-stage iterate)
- Appends user-dropped refs after the parent (vibe / material / lighting cues)
- Cartridge style refs are skipped (prevents subject dilution)
- `gpt-image-2` auto-routes to `gpt-image-2/edit` so it actually sees the parent

### Amplify with note
Per-tile `+` button → optional `prompt()` for steering ("more like this, but chunkier"). Same-stage iterate via parent-as-subject pipeline; note fuses into the prompt the same way promote-with-overrides does.

### State + display
- SSE-first: `run.started` carries the full trace inline, `render.item` adds tiles to `flatTiles` directly. No DB round-trip on the live render path.
- SSE relay authorizes per-connection by reading `clientId` from the `run.started` payload (no per-event DB call).
- Funnel render is incremental — diffs against `tilesByKey`, never wipes `innerHTML`.
- Chip rule: chip exists ⟺ `run.status === 'running'` (or failed within last 60 s for visible feedback). No client-side dismiss tracking.
- Orphan sweep window: 90 s. Stuck = dead, auto-failed.

---

## What just shipped

| | What | Why |
|---|---|---|
| 1 | Object-context classifier + cached on trace + in-situ prefix injection | Generalized object reasoning — works for any object class, no per-class rules |
| 2 | Per-stage reference modal (Sketch + In-situ tabs, IndexedDB persistence) | User can override either stage's cartridge refs with curated direction images |
| 3 | Amplify note field | Iteration handle — "more like this, but ___" |
| 4 | Pre-baked thumbnails in public `generations-thumbs` bucket | Tile cold paint went from 600–2000 ms to 50–150 ms; backfill ran for 2,840 existing PNGs |
| 5 | `runs.cartridge` denormalized column + composite index | `/tiles` cold load: 25–40 s → ~500 ms |
| 6 | `/runs` slim listing (no JSON sub-paths) + SSE preserves `input.titles` | `/runs` cold load: 8 s timeout → 161 ms; live tile painting works without refresh |
| 7 | SSE relay no longer hits Postgres for every event | Live updates work even under DB load |
| 8 | Architecture cleanup: archived nolla / demo cartridges, `factory/_archived/` for unused modules, deleted `v2/ui/`, deleted `fs.js` storage | Single source of truth — product cartridge surface only |
| 9 | Storage shim: orchestrator writes `cartridge` + `stage` to runs row directly; trigger keeps it correct | New runs ready for the indexed query path immediately |

## What just got rolled back

- **`HANDS_OFF` runtime patches** (in-situ figure-mode regex filter + MUST-NOT prose clause). Over-specific. The structured classifier output already gives the model what it needs; specific failure modes are signals to rebalance the cartridge, not to add prompt branches.
- **Status footer widget**, **skeleton tiles**, **localStorage flatTiles cache**, **dismiss button**, **"Show older" expander**, **`/healthz` endpoint** — all ornaments that masked real problems or added complexity without value.

---

## What's next (queued, ranked by KPI leverage)

1. **Output critic.** A small Haiku-vision call per render: "does this image plausibly depict the described object?" Yes/no + reason. Auto-suppresses fails from the funnel; tile is still saved, just collapsed. Generates the data we need to measure the 70% KPI and decide what's working. ~$0.0005 per render. **Probably worth 10–20 KPI percentage points by itself.**
2. **Promote-history as positive signal.** When the user promotes 3 tiles in a row, those 3 parents form a private style guide. Feed them as soft references for the next sketch in the same session. Rewards "I'm in a direction" without explicit ref-dropping.
3. **Negative signal from non-promotion.** Per-session, downweight slot picks that produced never-promoted outputs.
4. **Cartridge slot rebalancing.** The product cartridge's `figure_mode` slot is biased 7/13 toward holding poses — fine for handhelds, wrong for wall-mounts and beds. Split slot pools by classifier facts (`scale`-keyed, `occupies`-keyed) at the cartridge JSON level so the controls are movable, not orchestrator-coded.
5. **Cross-session learnings.** Promote patterns across multiple sessions become persistent biases for that user's product cartridge.

The order matters: **#1 ships first** — without it we can't tell whether #2–#5 are actually moving the number.

---

## Repo orientation

```
v2/
  cartridge/
    product/                  ← only active cartridge
      PLAN.md                 ← design intent (long-form)
      learnings.md            ← technical truths (model quirks, prompt rules)
      profile.json            ← style_order, allowed_models, materials, contexts, ...
      compositions.json       ← sketch / product-shot / in-situ skeletons + slot pools
      references/<stage>/*    ← stage-tagged ref images (cartridge defaults)
    _archived/                ← nolla, demo (out of scope)
  src/
    orchestrator.js           ← owns: input modes, stage routing, parent lineage, ref filtering, classifier injection
    factory/
      objectContext.js        ← per-batch object classifier (Haiku)
      cartridge.js            ← loads cartridge data + style-tagged refs
      shotList.js + grammar.js ← slot sampler + prompt builder
      variance.js             ← prompt variance metric
      _archived/              ← critic, gpt2Rewriter, intake (unused)
    render/fal.js             ← fal.run client, per-model payload shaping
    storage/supabase.js       ← only backend; PNG + JSON sidecar + thumbnail in parallel
    routes/public.js          ← runs / tiles / events (SSE) / images / zip
    trace/store.js            ← trace lifecycle, persist coalescing + 10s write timeout
  migrations/
    20260503_runs_cartridge_stage_columns.sql
    20260503_thumbs_bucket.sql
  ui-client/
    app.js  + index.html  + styles.css   ← single-file UI (1200+ LOC, post-cleanup)
scripts/
  backfill-thumbnails.js      ← one-shot PNG → WebP backfill (idempotent)
  recover-orphans.js          ← reconstruct DB rows from storage sidecars
  ...
```

---

## Local commands

```bash
npm run dev              # auto-reload via node --watch
npm start                # plain start
node scripts/backfill-thumbnails.js [--concurrency=10]
```

## Environment

`.env` at repo root: `AUTH_MODE=open` for local dev; `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` required (Supabase is the only backend now); `FAL_KEY` required; `OPENROUTER_API_KEY` for the object-context classifier; `OPEN_MODE_CARTRIDGE=product`; `REF_BUDGET=8` (per-render ref cap); `ORPHAN_MAX_MS=90000` (orphan-sweep window); `PERSIST_TIMEOUT_MS=10000` (per-write timeout).
