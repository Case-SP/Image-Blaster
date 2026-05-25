# Logos — Sketch + Render Flow + Aesthetic Variability (Mockup deferred) — Implementation Plan

> **Scope (locked with user, 2026-05-25):** focus on **Sketch + Render only**. Stand up the funnel + UI for those two stages, then **refine both until they produce genuine aesthetic variability**. **Mockup is deferred to last** — not built here.
>
> **Executor:** the `aesthetic` worktree (`wt/render-v3`).
>
> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax. No test runner — every task's verification is a CLI smoke (`scripts/blast.js`) + **trace inspection** (`data/traces/*.json`) + an **eyeball of the rendered grid in Playwright** (per DISPATCH: open the server at its port in the Playwright MCP, own tab; don't judge from logs). Commit only after verification produces the expected evidence.
>
> **⛔ DO NOT WRITE CODE UNTIL TASK 0 IS DONE.** Task 0 is a read-only audit of the *live* code. If reality diverges from any "Current state" claim, **stop and report to the planner** — do not silently adapt.

## Goal

Two things, in order:
1. **Flow + UI** — stand up the logos funnel as **Sketch → Render** (two active columns), logos as its own flow (not a generic engine).
2. **Aesthetic variability (the real goal)** — refine Sketch and Render until two different brands produce **genuinely distinct aesthetic worlds** (the "five references, five different worlds" bar), with Render faithfully carrying the chosen mark forward.

Unlike the flow-skeleton framing, **prompt/register/palette refinement for Sketch + Render IS in scope here.** Mockup (stage 3) is explicitly out — added last, its own spec.

## Guiding principle (locked with user)

**You can't generalize a design process — only simplify it.** Logos is its own flow. Reuse the *mechanism* (orchestrator `style_order` routing, promote chain, SSE, ref pipeline) but keep the *flow definition* per-cartridge. No universal funnel engine.

## Prerequisite (BLOCKING)

Builds on the register-router + per-stage treatment-ceiling + cross-stage promote-key mechanism currently on **`wt/specs`** (`5aeb8ce`, `6af9f50`, `90c7823`, `20bca7a`, `163868d`). That mechanism **must be merged to `main`** (via QA review) before this starts — the sketch variability and the render treatment ceiling both depend on it. Confirm in Task 0 Step 2.

## Architecture

- **Backend (small):** `profile.style_order` → `["sketch","render"]` (mockup appended later); add the `render` (`system-split-4x5`) composition to `compositions.json` with a `{style_mix}` sink + `{palette}` slot + dual-source `ref_sources`. Orchestrator already routes off `style_order` and selects `{from}_to_{to}` promote prefixes (`sketch_to_render` already present).
- **UI:** lift product's hardcoded funnel constants into a **per-cartridge `FLOWS`** def; add the logos flow (`sketch → render`). Column rendering + promote-on-click stay shared (mechanism); the flow definition is per-cartridge.
- **Refinement loop:** with the flow live, iterate on the register-spread prose, palette policy, `style_mix.count`, and the ref-budget cap (sketch) and the render skeleton's expression of the carried-forward register (render) — judged by eye in Playwright across ≥2 contrasting brands.

**Design source for render content:** `v2/cartridge/logos/PLAN.md` (`system-split-4x5`, dual-source 4+4 refs, horizontal split = mark top / wordmark bottom).

**Reference docs (read first):**
- `v2/cartridge/logos/PLAN.md` — Sketch + Render design intent.
- `docs/plans/2026-05-25-logos-generalized-prompting.md` + `v2/cartridge/logos/learnings.md` §8–9 — the mechanism this builds on (prerequisite), incl. the verified root-cause and the accessor `objectContext[title.id]`.
- Product cartridge as the structural mirror: `v2/cartridge/product/{profile,compositions}.json` + the funnel in `v2/ui-client/app.js`.

## File map

**Modify:**
- `v2/cartridge/logos/profile.json` — `style_order` → `["sketch","render"]`; confirm `stage_resolution.render` exists (treatment ceiling) and `promote_prefixes.sketch_to_render` is present.
- `v2/cartridge/logos/compositions.json` — add `render` (`system-split-4x5`): skeleton, `{style_mix}` + `{palette}` sinks, minimal slots, `ref_sources` for dual-source load.
- `v2/ui-client/app.js` — extract a per-cartridge `FLOWS` def from the hardcoded `PRODUCT_STAGES`/`STAGE_LABEL`/`NEXT_STAGE`/`byStage`/`REF_STAGES`/model-routing; add the logos flow (`sketch → render`).

**Create:** none.

---

## Task 0 — MANDATORY: audit the live code before any change

Read-only. Produce a findings block (commit body + `v2/cartridge/logos/learnings.md`).

- [ ] **Step 1: Confirm/refute** (record `file:line` + verdict):
  1. Logos `style_order` is `["sketch"]`; `compositions.json` has only `sketch`.
  2. UI funnel constants hardcoded to product — exact lines for `PRODUCT_STAGES`, `STAGE_LABEL`, `NEXT_STAGE`, the `byStage` grouping, `REF_STAGES`, per-stage model routing (expected ≈ `app.js:276, 789–791, 875, 1106–1124`).
  3. Orchestrator routes off `cartridge.profile.style_order` (≈ `:237`) and picks promote prefixes by `${parentStage}_to_${composition}` (≈ `:784`).
  4. `promote_prefixes.sketch_to_render` is present (mechanism Task 5).
  5. Dual-source ref loader: confirm `refsForComposition` reads `cartridge.compositions[name].ref_sources` (prior learnings §4). Record function + key.
- [ ] **Step 2: Confirm `main` has the prerequisite mechanism.** `git log --oneline main | grep -E "register router|register shortlist|treatment ceiling|promote-prefix"` — expect the five commits. **If absent, STOP — prerequisite merge hasn't happened; report to planner.**
- [ ] **Step 3: Confirm sketch variability actually fires now** (dev server up, logos selected). The mechanism is supposed to make the register prose reach the model — verify before refining:
  ```bash
  node scripts/blast.js --cartridge logos --count 1 --model fal-ai/nano-banana-pro --titles-prefix "Warp independent electronic music label"
  latest=$(ls -t data/traces/*.json | head -1); grep -o '"style_mix":"[^"]*"' "$latest" | head -1; grep -o '"registers":\[[^]]*\]' "$latest"
  ```
  Expected: `registers` shortlist + the joined register prose in `style_mix`, and that prose inside the resolved prompt. Record the JSON paths. **If the prose is NOT reaching the prompt, the prerequisite didn't actually land — STOP and report.**
- [ ] **Step 4: Write the findings block.** If anything diverged, stop and report. Else proceed.

> No commit for Task 0 (read-only). Findings ship with Task 1.

---

## Task 1 — Backend: add the Render composition + open the two-stage flow

**Files:** `v2/cartridge/logos/compositions.json`, `v2/cartridge/logos/profile.json`.

- [ ] **Step 1: Add the `render` composition** (`system-split-4x5`), mirroring product-shot's shape:
  - `aspect_ratio: "4:5"`.
  - Skeleton (skeleton fidelity; refined in Task 4): a finished split-screen identity system — chosen mark top half, wordmark bottom half, neutral ground. **Include a `{style_mix}` sink + `{palette}` slot** (mirror how the mechanism wired *sketch*; they are not pre-wired on render) so the brand's register/palette carry forward.
  - `ref_sources: ["logo-only","wordmark"]` for the dual-source 4+4 load (confirm key from Task 0).
  - Do **not** re-declare `stage_resolution.render.treatment` — it's already `from_brief` from the mechanism spec.
- [ ] **Step 2: Flip `style_order`** to `["sketch","render"]` (mockup appended in its own spec, last).
- [ ] **Step 3: Verify the stage assembles.** Render can't run fresh (needs a parent); confirm the orchestrator accepts `render` in `style_order` and the dual-source refs resolve. Full chain is Task 3.
- [ ] **Step 4: Commit.**
  ```bash
  git add v2/cartridge/logos/compositions.json v2/cartridge/logos/profile.json v2/cartridge/logos/learnings.md
  git commit -m "feat(logos): add render (system-split-4x5) composition, open sketch->render style_order"
  ```

---

## Task 2 — UI: give logos its own flow (Sketch → Render)

**Files:** `v2/ui-client/app.js`.

- [ ] **Step 1: Introduce a per-cartridge `FLOWS` def**, replacing the hardcoded product constants:
  ```js
  const FLOWS = {
    product: { stages: ['sketch','product-shot','in-situ'],
               labels: { sketch:'Sketch','product-shot':'Product','in-situ':'In-situ' },
               next:   { sketch:'product-shot','product-shot':'in-situ','in-situ':null },
               refStages: ['sketch','in-situ'], freshStage: 'sketch' },
    logos:   { stages: ['sketch','render'],
               labels: { sketch:'Sketch', render:'Render' },
               next:   { sketch:'render', render:null },   // mockup appended last
               refStages: ['sketch'], freshStage: 'sketch' },
  };
  const flow = () => FLOWS[currentCartridge()] || FLOWS.product;
  ```
- [ ] **Step 2: Drive the funnel from `flow()`** — `PRODUCT_STAGES`→`flow().stages`; `STAGE_LABEL`→`flow().labels`; `NEXT_STAGE`→`flow().next`; build `byStage` from `flow().stages`; `REF_STAGES`/`sessionRefs`→`flow().refStages`; `if (cartridge==='product') body.stage='sketch'`→`flow().freshStage`.
- [ ] **Step 3: Per-stage model routing.** Render is a parent-as-subject promote → allow edit-capable models (`gpt-image-2` auto-routes to `/edit`; `flux-pro/v1.1-ultra` filtered server-side). Keep product's `in-situ` lock as-is; give logos/render its own minimal routing in the flow def. Confirm current routing from Task 0.
- [ ] **Step 4: Verify chrome in Playwright** (:3003, own tab): select logos → funnel shows **two columns, Sketch / Render**; refs modal shows sketch-only; promote points sketch→render. Product funnel unchanged when switched back.
- [ ] **Step 5: Commit.**
  ```bash
  git add v2/ui-client/app.js
  git commit -m "feat(logos): logos-specific funnel flow (Sketch -> Render), de-hardcode product"
  ```

---

## Task 3 — Wire the Sketch → Render promote chain

**Files:** verify-only; modify `v2/src/orchestrator.js` only if a gap is found.

- [ ] **Step 1: Promote a sketch.** Confirm the orchestrator uses the parent sketch tile as subject (`image_urls[0]`), resolves the `sketch_to_render` prefix, and appends the render composition's dual-source refs (`logo-only` + `wordmark`) after the parent. Verify in the trace.
- [ ] **Step 2: Treatment ceiling holds.** Sketch prompt keeps the flat negatives; render reads its ceiling from `render_treatment` (mechanism Task 4) — render may go dimensional/material for a brand that warrants it; sketch stays flat regardless.
- [ ] **Step 3: Fix only real gaps** (silent `iterate` fallback, dropped refs). `orchestrator.js` is shared with `wt/technical` — keep edits surgical; record in `learnings.md`.
- [ ] **Step 4: Commit** (only if code changed).
  ```bash
  git commit -am "fix(logos): sketch->render promote-chain wiring"
  ```

---

## Task 4 — ⭐ Aesthetic variability — refine Sketch + Render (the real goal)

**Files:** `v2/cartridge/logos/compositions.json`, `v2/cartridge/logos/profile.json` (`styles` prose, palette), `v2/cartridge/logos/suffix.md`; possibly `v2/src/factory/logoContext.js` (router prose). **Iterate by eye in Playwright** — this is tuning, not one-shot.

- [ ] **Step 1: Establish the variability bar with contrasting brands.** Run the full sketch→render funnel for ≥3 deliberately different brands (e.g. `"Warp electronic music label"`, `"Iron Bank private wealth"`, `"New Museum contemporary art"`). Screenshot each grid.
- [ ] **Step 2: Sketch variability.** Judge: does each brand's sketch grid span **genuinely distinct aesthetic worlds** (not three near-synonyms), and do different brands diverge? Tune the levers until yes:
  - register-spread prose in `profile.styles` (sharpen the most-legible visual signatures);
  - `style_mix.count` (raise/lower if the model can't keep N worlds distinct on one sheet);
  - `palette_policy` honored (color for institutional, mono for austere);
  - the ref-budget cap (sketch has 16 refs, `REF_BUDGET=8` sends only 8 — curate to 8 strongest OR raise the budget for logos; re-benchmark).
- [ ] **Step 3: Render variability + fidelity.** Promote a sketch into render for each brand. Judge: does render **faithfully carry the chosen mark** (silhouette/geometry preserved) AND express the brand's register/treatment with appropriate variability (flat vs dimensional vs material, per the ceiling)? Tune the render skeleton prose + `{style_mix}`/`{palette}` wiring + dual-source ref balance (4+4 vs weighting one half) until both hold.
- [ ] **Step 4: Record the calibrated values + verdicts** in `v2/cartridge/logos/learnings.md` — what worked, what the levers do, remaining weaknesses. Commit cartridge changes incrementally with descriptive messages.

> This task is iterative and eyeball-judged; there's no single "expected output" grep. Done = the variability bar in Step 1 is met for sketch and the carry-through holds for render, documented.

---

## Task 5 — Smoke + definition of done

- [ ] **Step 1: Full two-stage walkthrough in Playwright** (:3003): brand → sketch grid (distinct worlds) → promote → **Render column fills** with split-screen systems that carry the mark. Two columns, promote chain intact.
- [ ] **Step 2: Second contrasting brand** confirms the flow isn't brand-specific and the registers/palettes differ.
- [ ] **Step 3: Hand-back note** in `learnings.md`: state Sketch + Render are calibrated, the variability achieved, and the deferred Mockup contract for its future spec.

## Definition of done

- [ ] Task 0 findings written; prerequisite mechanism confirmed on `main`; sketch register prose confirmed reaching the prompt; no unreported divergence.
- [ ] Logos `style_order` is `["sketch","render"]`; `render` composition assembles valid prompts with dual-source refs.
- [ ] UI funnel shows two logos columns (Sketch / Render) from a per-cartridge `FLOWS` def; product funnel unchanged.
- [ ] Sketch → Render promote works (parent-as-subject, `sketch_to_render` prefix + dual-source refs, treatment ceiling holds).
- [ ] **Aesthetic variability met:** ≥3 contrasting brands show distinct sketch worlds; render faithfully carries the mark with register-appropriate treatment. Screenshots + calibrated levers documented.

## Out of scope (do not build here)

- **Mockup stage** (composition, render→mockup promote, mockup refs, the funnel's third column) — **deferred to last**, its own spec.
- The multi-tab refs-override modal (Logo-only / Wordmark / Mockup tabs) — render refs auto-load from the cartridge.
- Task 1b (Sonnet classifier upgrade) — separate, secondary.
- Any DB/schema change; any `product`/`demo` cartridge change beyond extracting the shared `FLOWS` pattern.
