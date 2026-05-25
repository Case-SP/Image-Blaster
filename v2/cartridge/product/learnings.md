# Product cartridge — learnings

Operational + technical knowledge captured from past sessions. Companion to `PLAN.md` (which is design intent / roadmap). This file is for facts that would otherwise be re-discovered every conversation.

---

## Model payload quirks

Vision-conditioning (parent image as subject reference) ships different payload shapes per model. Get this wrong and the model silently drops the reference or returns nonsense.

| Model | Reference field | Notes |
|---|---|---|
| `fal-ai/nano-banana-pro` | `image_urls` (array) | Returns 200 even when the field is wrong; degrades silently. |
| `fal-ai/flux-pro/kontext` | `image_url` (string, singular) | Strict — will produce text-only renders if missing the singular field. |
| `openai/gpt-image-2` | (no image input) | Plain text-to-image. The `/edit` endpoint is the one that takes images. |
| `openai/gpt-image-2/edit` | `image_urls` (array) | 422s if `image_urls` is empty, which proves the requirement. Used when a render needs to be parent-conditioned. |

**Auto-route rule**: when `useParentAsSubject === true` and the requested model is `openai/gpt-image-2`, the orchestrator swaps to `openai/gpt-image-2/edit` automatically.

---

## Stage-prefix routing for parent-as-subject

The product cartridge cycles three stages: `sketch → product-shot → in-situ`. Promoting a tile carries its parent's stage. The render prompt gets a stage-aware prefix prepended, otherwise the model averages the parent against the cartridge's style refs and you get a chair-from-a-lamp.

- **sketch parent → product-shot child**: "CRITICAL: The reference image is a hand-drawn design sketch of a {parentTitle}. Render that exact {parentTitle} as a real product photograph — interpret the sketch as the design intent and faithfully preserve its silhouette, proportions, joinery, and every key feature. The output must be a photographic render of a real {parentTitle}, NOT a copy of the line drawing, NOT an icon or illustration. ..."
- **product-shot parent → in-situ child**: similar prefix but framed as "place this exact product in scene".
- **same-stage iterate** (amplify): "iterate on this design".

When `useParentAsSubject` is on, the cartridge style refs are **replaced** with the parent only (otherwise 7 chair refs + 1 lamp parent → model averages to chair).

---

## Play mode

Wildcards (`compDef.wildcard_skeletons`) fire only on **fresh** sketch input runs, not on promote/amplify. The roll is `playRoll < play_ratio` and is gated by:
- `!useParentAsSubject` — never improvise on parent-driven runs
- `!ov` — no per-tile overrides
- `wildcards && wildcards.length` — composition has wildcards defined

Without that gate, promoted runs would silently become wildcards and the user loses the parent's identity.

---

## Database / Supabase

**Required indexes** (without these, `/runs` and `/tiles` time out at 8s+):

```sql
CREATE INDEX IF NOT EXISTS idx_runs_client_started
  ON runs (client_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status_started
  ON runs (status, started_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_images_run_id
  ON images (run_id);
```

**Optional but big win** (`v2/migrations/20260503_runs_cartridge_stage_columns.sql`):
- Adds real `cartridge` and `stage` columns + composite index `(client_id, cartridge, started_at DESC)`.
- Without it, `/tiles` extracts cartridge from `trace->>cartridge` JSON across N runs in batched parallel queries (~5–8 s).
- With it, `/tiles` is a single indexed query (~50–500 ms).

**JSON projection cost**: selecting `trace->input` (full input subtree) across 50 rows pushes the query past 8 s. Project specific sub-paths instead: `input_titles:trace->input->titles`, `input_stage:trace->input->>stage`, `input_n:trace->input->>N`.

---

## Trace persist

- **Coalesce writes**: keep at most one pending snapshot in flight, drop intermediate snapshots. Without this, render-heavy stages (dozens of mutate calls/sec) back up the persist chain until Supabase times out.
- **10 s timeout per write**: a single hung Supabase upsert can otherwise wedge the persist chain forever and `trace.finish()` never lands. Run stays `running` until orphan sweep catches it. Wrap each write in `Promise.race([writeTrace, timeout])`.
- **Orphan sweep window**: 90 s. A render that's been in-flight longer than that is dead (nano p95 is ~60 s). Aggressive auto-cleanup is the rule, not the exception.

---

## SSE-first state

The UI does **not** round-trip to the DB on every render event. SSE is the live source of truth.

- `run.started` → unshift run into `runsList`, render
- `render.item` (ok) → push directly into `flatTiles`, render
- `run.finished` / `run.failed` → patch local run status, render
- DB refresh (`/runs` + `/tiles`) is the **backup**, not the primary path.

When `render.item` arrives but `runsList[id].input.titles` isn't yet populated (race with `run.started`), defer the tile — don't synthesize a slug from the titleId. Synthesized slugs produce 404 URLs because storage uses the real slug derived from the title text.

---

## Things that have broken before

- **Destructive `Clear` button** deleted run rows with cascade — lost ~50 images. Now gated behind `ALLOW_DESTRUCTIVE_CLEAR=1` env. Don't reintroduce a UI clear-all.
- **Server restart kills in-flight runs.** Use the force-sweep script (or wait for the 90 s orphan window) instead of bouncing the server.
- **Stale slugs in caches**: when run rows are returned from `runsLongCache` (DB outage), they may not have `input.titles`. SSE handlers must tolerate this and defer tile insertion.
- **Schema cache lag**: PostgREST caches the `runs` table schema. After a column add (e.g. cartridge denormalization), it can return "Could not find the 'X' column ... in the schema cache" briefly. The persist code retries without the new columns when it sees this error pattern.

---

## Naming conventions

- Generated images: `gen-{NNN}-{model_suffix}.png` where suffix is `nano | gpt2 | gpt2e | flux`.
- Sidecar metadata: `gen-{NNN}-{suffix}.png.json` next to the PNG (used by orphan-recovery script).
- Run ID format: `YYYYMMDD-HHMMSS-{4 random base36}` — sortable as a string.
- Title ID format: `c-{Date.now()}-{i}` for client-generated titles.

---

## Concurrency

- `RENDER_CONCURRENCY=3` — three parallel fal calls. Higher rates hit fal's per-account quota. Tunable via env.
- `RENDER_TIMEOUT_MS=120000` per render call. 60 s is too aggressive for nano on a busy day.
- `DOWNLOAD_TIMEOUT_MS=60000` for the post-render image download.

---

## Things NOT to add

These have all been tried and removed because they masked problems instead of solving them:

- **Skeleton tiles** — visual ornament. The chip already says "running"; adding shimmer placeholders adds DOM complexity without informing the user.
- **Status footer widget** (DB ms / SSE state / in-flight) — debugging tool, not user-facing. Use `tail /tmp/blaster.log` instead.
- **localStorage tile cache** — premature optimization that masks a slow `/tiles` query. Fix the query (run the migration) instead.
- **Dismiss button on chips** — created a separate "is dismissed" state that diverged from server state. The rule is: chip exists ⟺ run is running (or failed within last 60 s). No client-side dismiss tracking.
- **"Show older" column expander** — JS state for "is this column expanded" that breaks reconciliation. Just render every tile.
