# Logos — Three-Stage Funnel (Sketch → Render → Mockup) — Implementation Plan

> **Executor:** the `aesthetic` worktree (`wt/render-v3`). This is the render/mockup-stage + funnel work.
>
> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax. This project has **no test runner** — every task's verification is a CLI smoke (`scripts/blast.js`) + **trace inspection** (`data/traces/*.json`) + an **eyeball of the rendered grid in Playwright** (per DISPATCH: open the server in the Playwright MCP at its port, don't judge from logs). Commit only after the verification produces the expected evidence.
>
> **⛔ DO NOT WRITE CODE UNTIL TASK 0 IS DONE.** Task 0 is a read-only audit of the *live* code. This plan was written by the planner from a point-in-time read. If reality diverges from any "Current state" claim, **stop and report the divergence to the planner before changing code** — do not silently adapt.

## Goal

Stand up the logos cartridge's full **three-column funnel** end-to-end — Sketch → Render → Mockup, with promote between stages — so the **flow and the aesthetic are smoke-testable**. Prompt/register/palette **refinement is explicitly deferred**; the render/mockup prompts here are skeletons that just need to produce coherent output. The point is a working chain and a first aesthetic read, not polish.

## Guiding principle (locked with user, 2026-05-25)

**You can't generalize a design process — only simplify it.** Logo identity work and product photography are different processes. So **logos is its own flow**, not a case of a universal funnel engine. We reuse the *mechanism* underneath (orchestrator `style_order` stage-routing, the promote chain, SSE, the ref pipeline) but the *flow/process definition* is per-cartridge. No universal abstraction — a future cartridge gets its own flow def.

## Prerequisite (BLOCKING)

This flow builds on the register-router + per-stage treatment-ceiling + cross-stage promote-key mechanism currently committed on **`wt/specs`** (commits `5aeb8ce`, `6af9f50`, `90c7823`, `20bca7a`, `163868d`). That mechanism **must be merged to `main`** (via QA review) before this work starts, or the funnel is built on sand. Confirm `main` contains it in Task 0 Step 6.

## Architecture

- **Backend (small):** flip logos `profile.style_order` from `["sketch"]` to `["sketch","render","mockup"]`; add `render` (`system-split-4x5`) and `mockup` compositions to `compositions.json` with skeleton skeletons + minimal slot vocab. The orchestrator already routes off `style_order` and selects cross-stage promote prefixes by `{from}_to_{to}` (keys already present from the mechanism spec, Task 5). Render's dual-source refs (`logo-only/` + `wordmark/`) load from the cartridge automatically via the composition's `ref_sources` — no refs-modal UI needed for the smoke.
- **UI (the real work):** lift product's hardcoded funnel constants into a **per-flow stage definition keyed by cartridge**, and add the logos flow def. The column-rendering and promote-on-click logic stays shared (it's mechanism); each cartridge declares its own stages/labels/next-map/model-routing/ref-stages.
- **Reuse, don't rebuild:** orchestrator deterministic object-mode block (handles logos per prior learnings §4), promote chain (parent-as-subject), SSE delivery, thumbnail bucket, trace store — all unchanged.

**Design source for render/mockup content:** `v2/cartridge/logos/PLAN.md` (the long-form stage design — `system-split-4x5`, dual-source 4+4 refs, `hero-single-surface` / `brand-sheet-multi-surface` mockups). Mirror it at skeleton fidelity; defer its slot-vocab/prose detail.

**Reference docs (read before starting):**
- `v2/cartridge/logos/PLAN.md` — the three-stage design intent.
- `docs/plans/2026-05-25-logos-generalized-prompting.md` — the mechanism this builds on (prerequisite); see its learnings handoff (`logos/learnings.md` §8–9).
- `docs/plans/2026-05-07-logos-cartridge-phase-1-2.md` — format + verification idiom.
- Product cartridge as the structural mirror: `v2/cartridge/product/{profile,compositions}.json` + the UI funnel in `v2/ui-client/app.js`.

## File map

**Modify:**
- `v2/cartridge/logos/profile.json` — `style_order` → 3 stages; confirm `stage_resolution` covers render/mockup (the treatment ceiling already declares them); confirm `promote_prefixes` has `sketch_to_render` / `render_to_mockup`.
- `v2/cartridge/logos/compositions.json` — add `render` (`system-split-4x5`) and `mockup` compositions: skeleton, minimal slots, `ref_sources` for render's dual-source load.
- `v2/ui-client/app.js` — extract a `FLOWS` (per-cartridge stage definition) from the hardcoded `PRODUCT_STAGES` / `STAGE_LABEL` / `NEXT_STAGE` / `byStage` / `REF_STAGES` / model-routing; add the `logos` flow def; render the funnel from the active cartridge's flow.

**Create:** none — all mechanism rides existing modules.

---

## Task 0 — MANDATORY: audit the live code before any change

**Files:** read-only. Produce a findings block (paste into the commit body and append to `v2/cartridge/logos/learnings.md`).

- [ ] **Step 1: Confirm/refute each claim** (record `file:line` + `confirmed` / `diverged: <what>`):
  1. Logos `profile.style_order` is `["sketch"]` only.
  2. Logos `compositions.json` declares only `sketch` (no `render`/`mockup`).
  3. UI funnel constants are hardcoded to product — find exact lines for `PRODUCT_STAGES`, `STAGE_LABEL`, `NEXT_STAGE`, the `byStage` grouping, `REF_STAGES`, and per-stage model routing (expected ≈ `app.js:276, 789–791, 875`, model routing ≈ `1106–1124`).
  4. Orchestrator routes stages off `cartridge.profile.style_order` (≈ `:237`) and picks promote prefixes by `${parentStage}_to_${composition}` (≈ `:784`).
  5. Logos `promote_prefixes` already contains `sketch_to_render` and `render_to_mockup` (from mechanism spec Task 5).
  6. The dual-source ref loader exists — confirm `refsForComposition` (orchestrator) reads `cartridge.compositions[name].ref_sources` (prior learnings §4 claims it was scaffolded). Record the exact function + key.
- [ ] **Step 2: Confirm `main` has the prerequisite mechanism.** `git log --oneline main | grep -E "register router|register shortlist|treatment ceiling|promote-prefix"` — expect the five mechanism commits present. **If absent, STOP — the prerequisite merge hasn't happened; report to planner.**
- [ ] **Step 3: Confirm the smoke harness works** (dev server up via `npm run dev`, logos cartridge selected):
  ```bash
  node scripts/blast.js --cartridge logos --count 1 --model fal-ai/nano-banana-pro --titles-prefix "Warp independent electronic music label"
  ls -t data/traces/*.json | head -1
  ```
  Expected: `queued: 1 ok`; a fresh trace. Open it, locate the per-shot prompt + the `stage`/`composition` field. Record their JSON paths.
- [ ] **Step 4: Write the findings block.** If any claim diverged, **stop and report**. Otherwise proceed.

> No commit for Task 0 (read-only). The findings ship with Task 1's commit.

---

## Task 1 — Backend: add the Render + Mockup compositions and open the flow

**Files:** Modify `v2/cartridge/logos/compositions.json`, `v2/cartridge/logos/profile.json`.

- [ ] **Step 1: Add the `render` composition** (`system-split-4x5`). Mirror product-shot's shape. Minimal skeleton (skeleton-fidelity, refinement deferred):
  - `aspect_ratio: "4:5"`.
  - Skeleton: a finished split-screen identity system — the chosen mark in the top half, the wordmark in the bottom half, on a neutral ground; **include a `{style_mix}` sink + `{palette}` slot in the render skeleton** (mirroring how the mechanism spec wired *sketch*; they are not pre-wired on render) so the brand's register/palette carry forward.
  - `ref_sources: ["logo-only","wordmark"]` so the dual-source loader pulls 4 + 4 (confirm key name from Task 0 Step 1.6).
  - Inherit the per-stage treatment ceiling: `stage_resolution.render.treatment` is already `from_brief` (mechanism spec Task 4) — do not re-declare.
- [ ] **Step 2: Add the `mockup` composition.** Two variants per PLAN.md (`hero-single-surface` 4:5, `brand-sheet-multi-surface` 16:9) — for the smoke, ONE is enough (`hero-single-surface`); note the second as a follow-up. Skeleton: apply the parent identity to a real surface with believable material + lighting. `ref_sources: ["mockup"]`.
- [ ] **Step 3: Flip `style_order`** in `profile.json` to `["sketch","render","mockup"]`.
- [ ] **Step 4: Smoke each stage in isolation** (dev server up). Render and mockup can't run fresh (they need a parent) — verify the orchestrator *accepts* the stage and assembles a prompt:
  ```bash
  node scripts/blast.js --cartridge logos --count 1 --stage sketch --titles-prefix "Warp independent electronic music label"
  ```
  Then confirm in the trace that `render` and `mockup` are now in the cartridge's resolved `style_order`. Full promote chain is Task 3.
- [ ] **Step 5: Commit.**
  ```bash
  git add v2/cartridge/logos/compositions.json v2/cartridge/logos/profile.json v2/cartridge/logos/learnings.md
  git commit -m "feat(logos): add render + mockup compositions, open three-stage style_order"
  ```

---

## Task 2 — UI: give logos its own flow definition (de-hardcode the funnel)

**Files:** Modify `v2/ui-client/app.js`.

- [ ] **Step 1: Introduce a per-cartridge `FLOWS` definition.** Replace the hardcoded product constants with a lookup keyed by cartridge, e.g.:
  ```js
  const FLOWS = {
    product: {
      stages: ['sketch', 'product-shot', 'in-situ'],
      labels: { sketch: 'Sketch', 'product-shot': 'Product', 'in-situ': 'In-situ' },
      next:   { sketch: 'product-shot', 'product-shot': 'in-situ', 'in-situ': null },
      refStages: ['sketch', 'in-situ'],
      freshStage: 'sketch',
    },
    logos: {
      stages: ['sketch', 'render', 'mockup'],
      labels: { sketch: 'Sketch', render: 'Render', mockup: 'Mockup' },
      next:   { sketch: 'render', render: 'mockup', mockup: null },
      refStages: ['sketch'],          // smoke: sketch-only override; render/mockup refs auto-load from cartridge
      freshStage: 'sketch',
    },
  };
  const flow = () => FLOWS[currentCartridge()] || FLOWS.product;
  ```
- [ ] **Step 2: Drive the funnel from `flow()`.** Replace the hardcoded reads:
  - `PRODUCT_STAGES` → `flow().stages`; `STAGE_LABEL` → `flow().labels`; `NEXT_STAGE` → `flow().next`.
  - The `byStage` grouping object → build from `flow().stages` (don't hardcode `{sketch,product-shot,in-situ}`).
  - `REF_STAGES` / `sessionRefs` → `flow().refStages`.
  - `if (cartridge === 'product') body.stage = 'sketch'` → use `flow().freshStage` for any cartridge whose flow declares one.
- [ ] **Step 3: Per-stage model routing.** Product locks `in-situ → gpt-2-edit`. Generalize to a per-flow rule OR keep product's special-case and give logos its own: render + mockup are parent-as-subject promotes → allow edit-capable models (`gpt-image-2` auto-routes to `/edit`; `flux-pro/v1.1-ultra` filtered out server-side). Pick the minimal correct routing and record it in the flow def. Confirm exact current routing from Task 0 Step 1.3.
- [ ] **Step 4: Verify in Playwright** (per DISPATCH — own tab, port 3003). Select the logos cartridge; confirm the funnel now shows **three columns labeled Sketch / Render / Mockup**, the refs modal shows the logos ref-stages, and promote affordances point sketch→render→mockup. No generation yet — this is the chrome.
- [ ] **Step 5: Commit.**
  ```bash
  git add v2/ui-client/app.js
  git commit -m "feat(logos): logos-specific funnel flow (Sketch -> Render -> Mockup), de-hardcode product"
  ```

---

## Task 3 — Wire the promote chain end-to-end (sketch → render → mockup)

**Files:** verify-only first; modify `v2/src/orchestrator.js` only if a gap is found.

- [ ] **Step 1: Sketch → Render promote.** Generate sketches, promote one. Confirm the orchestrator: uses the parent sketch tile as subject (parent-as-subject), resolves the `sketch_to_render` prefix, and adds the render composition's dual-source refs (`logo-only` + `wordmark`) after the parent. Verify in the trace: parent ref is `image_urls[0]`; cartridge dual-source refs follow.
- [ ] **Step 2: Render → Mockup promote.** Promote a render tile. Confirm `render_to_mockup` prefix resolves and the parent render (mark+wordmark) rides as subject with `mockup` refs added.
- [ ] **Step 3: Treatment ceiling holds across the chain.** Confirm sketch prompts still carry the flat negatives, while render's prompt reads its ceiling from `render_treatment` (mechanism spec Task 4). Sketch stays flat even for a `material-expressive` brand.
- [ ] **Step 4: Fix only real gaps.** If a transition silently falls back to `iterate` or drops refs, patch the orchestrator surgically (it's shared with `wt/technical` — keep edits localized; expect merge coordination). Record any change in `learnings.md`.
- [ ] **Step 5: Commit** (only if code changed).
  ```bash
  git commit -am "fix(logos): promote-chain wiring for sketch->render->mockup"
  ```

---

## Task 4 — End-to-end smoke + aesthetic read (definition of done)

**Files:** none (verification + learnings).

- [ ] **Step 1: Full walkthrough in Playwright** (logos cartridge, :3003): type a brand (`"Warp independent electronic music label"`) → sketch grid renders → promote one → **Render column fills** with split-screen systems → promote one → **Mockup column fills** with surface applications. Three columns, promote chain intact.
- [ ] **Step 2: Run a second, different brand** (`"Iron Bank private wealth management"`) to confirm the flow isn't brand-specific and the register/palette differ.
- [ ] **Step 3: Capture the aesthetic read.** Screenshot each stage's grid. In `learnings.md`, note what's coherent vs. what needs prompt refinement (the follow-up). This is the hand-back to the planner for the refinement spec.
- [ ] **Step 4: Update `learnings.md`** with the flow contract: logos stages, the `FLOWS` UI pattern, dual-source render refs, and the deferred items.

## Definition of done

- [ ] Task 0 findings written; prerequisite mechanism confirmed on `main`; no unreported divergence.
- [ ] Logos `style_order` is three stages; `render` + `mockup` compositions exist and assemble valid prompts.
- [ ] UI funnel shows three logos columns (Sketch / Render / Mockup) driven by a per-cartridge flow def; product funnel unchanged.
- [ ] Promote chain works end-to-end: sketch → render → mockup, parent-as-subject, correct prefixes + refs, treatment ceiling holds.
- [ ] Two brands walk the full funnel in Playwright; screenshots captured; aesthetic read written to `learnings.md`.

## Out of scope (do not build here)

- Prompt / register-prose / palette-hex **refinement** — the follow-up spec (mechanism already built).
- The `brand-sheet-multi-surface` mockup variant — note as follow-up; `hero-single-surface` is enough for the smoke.
- The multi-tab refs-override modal (Sketch + Logo-only + Wordmark + Mockup) — render/mockup refs auto-load from the cartridge for now.
- Task 1b (Sonnet classifier upgrade) — separate, secondary.
- Any DB/schema change; any `product`/`demo` cartridge change beyond extracting the shared `FLOWS` pattern.
