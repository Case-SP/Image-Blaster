# Logos cartridge — learnings

Technical truths from past sessions live here as we ship. Companion to `PLAN.md`.

## 1. Phase 1 + 2 scaffolding landed; live render verification deferred

Phase 1 (scaffold + cost policy) and Phase 2 (Stage 1 sketch) shipped as code on 2026-05-07. Static + unit-level verification all passes:

- `loadCartridge('logos')` loads cleanly: input_mode=object, classifier=logo, stage_resolution declared, sketch composition with 6×6×6×6 slot vocab.
- `/api/public/cartridges` returns logos alongside product (auto-registration via folder existence).
- `classifyLogos` smoke produced plausible attribute output for both `Acme Coffee — quiet third-wave roaster in Brooklyn` (era=contemporary-minimal, posture=quiet, geometry_bias=organic, tone=warm-domestic, sanitized_descriptor stripped "coffee/roaster/Brooklyn" and kept "— beverage hospitality" rounded category) and `Tessellate Studio` (inferred from the name alone: era=swiss-modern, posture=technical, geometry_bias=geometric, tone=utilitarian, formality=formal).
- Dispatcher (`classifyByCartridge`) routes to logo vs object correctly; both prefix functions return well-formed text.
- `buildRenderPrompts` assembles a logos sketch prompt with the classifier prefix prepended, the skeleton substituted, slot picks fused, and the suffix appended. No `undefined` artifacts (after fixing themes.json schema — see point 3 below).

End-to-end fal render through the running dev server was blocked by a pre-existing Supabase trace-persistence failure in the local env (`ensureOpenModeClient timeout` → synthetic UUID `open-mode-fallback` rejected as invalid uuid by the schema). The route accepts the request and starts the orchestrator, but the trace can't persist, the runs listing comes back empty, and no rendered tile is observable in the UI without that path working.

Action item for the next session: fix Supabase env (either valid open-mode client UUID seeded in DB, or fall back to in-memory trace mode) and rerun the smoke from the plan's Task 9.

## 2. Soft cliché-stripping working as designed

The two-input smoke confirmed the classifier respects the soft-stripping rule: it drops the explicit subject noun ("coffee", "roaster") but keeps a rounded-off category word at the end after an em-dash ("— beverage hospitality"). For Tessellate Studio the rounded category landed as "— design services" — also correct. The brand name itself never leaked into `sanitized_descriptor`.

If we observe categories slipping through (e.g. seeing "coffee bean" in actual rendered output), the lever to tighten is in `logoContext.js` SYSTEM prompt — promote "NEVER include sector-specific subject nouns" higher, or add explicit examples of bad outputs.

## 3. Theme schema must include background / color_grade / mood

First version of `themes.json` only declared `description` per theme. The shotList prompt builder reads `theme.background, theme.color_grade, theme.mood` directly — a missing field renders as the literal string `undefined` inside the prompt. Caught it before the smoke run by diffing logos prompt against product's. Fixed `themes.json` to mirror product's schema (`name`, `background`, `color_grade`, `mood`).

If you add new themes to this cartridge, copy the four-field shape — don't shorthand.

## 4. Object-mode reuses cleanly for logos — no new orchestrator mode needed

The product cartridge's `input_mode: "object"` deterministic block (orchestrator.js:228-368) handled the logos cartridge with no special-casing. The product-specific `settings_by_context` / `slot_overrides_by_context` paths silently no-op when those keys are absent from `profile.json`. Confirms the cartridge format is generalizing the way the vision doc claims it should.

The one piece of new infra was the dual-source ref filter (orchestrator.js `refsForComposition` now reads `cartridge.compositions[name].ref_sources`) — needed for Phase 3 Stage 2 dual-folder loading, scaffolded in Phase 1.

## 5. Stage-resolution cost policy is gpt-image-2-only in practice

The cartridge declares per-stage gpt_quality (sketch=low, render=medium, mockup=high). Threading through `render/fal.js` is straightforward — a new `stage` + `stageResolution` option, gpt-image-2's `quality` field reads from `stageResolution[stage].gpt_quality` with the per-call `quality` override winning when supplied.

Nano-banana-pro and flux-pro/v1.1-ultra don't expose meaningful resolution knobs today (nano fixed, ultra fixed at ~2MP), so the policy only steers gpt-image-2 cost. When a smaller-resolution variant ships for those models, thread it through the same `stageResolution[stage]` object — the cartridge JSON shape doesn't need to change.

## 6. Open calibration items for Phase 3 handoff

Once references land in `references/sketch/` and the user runs Phase 2 against real refs:

- **Sketch register vocabulary.** The six registers in compositions.json are illustrative — drop refs first, then prune/rename to match the visual register the user is actually targeting.
- **Era enum.** The nine values in `logoContext.js` ALLOWED.era are reasonable defaults, but if the user is curating to one period for v1, most of these will never get used. Prune to 2-3 values to bias the classifier harder.
- **Subject phrase bank.** The current logos `subjects.json` puts the full title text into the {subject} slot, so prompts read `"sketches for a Tessellate Studio — small architecture practice on a pure white ground"`. Reads awkwardly. Calibration option: strip the descriptor before substitution, or rephrase the skeleton to read `"sketches exploring a brand identity for {subject}"`.
- **Promote prefixes for cross-stage transitions.** Phase 1 only declared `iterate`. Phase 3 needs `sketch_to_<render-composition-name>`, Phase 4 needs `<render-composition-name>_to_<mockup-composition-name>`. Composition names get chosen when those stages ship.
- **Reference budget split for Stage 2.** When Phase 3 wires the dual-source loader, decide whether 4+4 from logo-only/wordmark/ is the right split or whether one half should weight higher (depends on whether mark or wordmark is the load-bearing piece for the user's first calibration set).

## 7. Fresh-run classifier prefix injection is the load-bearing change for steering

Today's product cartridge only injects the classifier prefix into prompts during cross-stage promote runs (and only into the in-situ prefix template). For Phase 2 to be a real test of whether the classifier shapes output, fresh-run prompts must also receive the prefix. Added that injection at orchestrator.js right after `let prompt = ...`, gated by `!parentRef?.parentRefUrl` so promote runs aren't double-prefixed.

This now applies to product cartridge fresh runs too — the descriptive object facts ("The object is a wall lamp (wall-mounted articulated arm). It naturally occupies wall-vertical space at task height...") prepend to fresh sketch and product-shot prompts. Modest extra context, redundant but not harmful. Watch the next batch of product runs for any visible regression.

## 8. Generalized prompting — Task 0 audit + Register Router contract (2026-05-25)

Executing `docs/plans/2026-05-25-logos-generalized-prompting.md` on `wt/specs`. Task 0 (read-only audit) verdicts:

| Diagnosis claim | Verdict |
|---|---|
| `profile.style_order` is `["sketch"]` only | confirmed |
| `profile.styles` has 12 keys | confirmed — exact match to the router's `STYLE_KEYS` (mid-century…victorian-engraved) |
| `sketch` composition has no `style_mix` and no `{style_mix}` placeholder | confirmed |
| `sketch.slots.palette` is monochrome-only | confirmed |
| flat-only suffix applied globally | confirmed — `grammar.js:54` (`buildPrompt`) + `shotList.js:298` (play path) |
| classifier output accessor | **diverged from plan snippets** |

**Divergence (resolved, not silently adapted):** the plan's Task 2–4 snippets read the brief from `classifierContext[title.id]`. There is no `classifierContext` in the code. The logos classifier (`logoContext.classifyLogos`, routed via `classifyByCartridge` since `profile.classifier: "logo"`) lands per-title output in **`objectContext[title.id]`**, persisted at `trace.input.objectContext`. All later tasks must use `objectContext[title.id]`. (The plan sanctioned this: "use the exact accessor confirmed in Task 0.") The `era` enum is 9 values; `registers` correctly draws from the full 12-key `styles` set.

`{style_mix}` consumption path: `shot.slot_overrides.style_mix` → merged into the slot map at `shotList.js:285` → `buildPrompt` (`grammar.js`) fills the `{style_mix}` placeholder. `__stylesPicked` is trace metadata only.

Collision check: `wt/render-v3` had no commits or working changes touching `logos/`, `orchestrator.js`, `grammar.js`, or `shotList.js` at audit time.

### Register Router contract — for the `wt/render-v3` (aesthetic) worktree

The classifier now emits an aesthetic brief per title (Task 1, done):

- Available per-title at **`objectContext[title.id]`** with fields `{ registers[2-4], palette_policy, mark_bias, render_treatment }` (plus the existing prefix fields). All enum-validated in `logoContext.sanitize()`; never empty/invalid.
- `registers`: 2–4 keys ∈ `profile.styles`, primary = `[0]`. `palette_policy ∈ {mono, muted-brand-color, one-saturated-field}`. `mark_bias ∈ {abstract, pictographic, letterform, system}` (emitted for you to bias `sketch.slots.mark_type`; not yet consumed). `render_treatment ∈ {flat, dimensional, material-expressive}`.
- To give a composition register spread: add `style_mix: { count: N }` to its def + a `{style_mix}` placeholder in its skeleton; the router's registers flow in automatically.
- To set a composition's ceiling: `profile.stage_resolution[<stage>].treatment` (`flat` | `dimensional` | `material-expressive`); `render_treatment` from the brief upgrades it at render time. Sketch is pinned `flat`.

Task 1 verification (one Haiku call, no render): Versace → `[post-modern, art-deco, brutalist-poster]` / one-saturated-field / material-expressive; Acme Law Offices → `[swiss-modern, contemporary-minimal, victorian-engraved]` / mono / flat; Warp → `[y2k, brutalist-poster, contemporary-minimal]` / mono / flat. Brand-appropriate and distinct.

## 9. Tasks 2–5 landed — wiring outcomes, verifications, and deviations (REVISION 2)

Spec reprioritized (REVISION 2): the verified root cause is that the register prose never reached the model, so **Task 2 was the load-bearing fix** and was done first (Task 1 router was its prerequisite).

**Verified end-to-end (real `nano-banana-pro` renders on :3004):**
- **Task 2** — register prose now reaches the prompt. The brand's brief registers fill `{style_mix}` (e.g. Warp → `post-modern / y2k / brutalist-poster` prose in the resolved sketch prompt; `{style_mix}` substituted, not literal). Ref-budget gap closed: `refsAvailable 16 → refsAttached 12`.
- **Task 3** — palette tracks `palette_policy`: New Museum + Iron Bank (mono brief) → mono palette; Versace (one-saturated-field) → "solid black on a single saturated brand-color ground". Sketch stays flat.
- **Task 4** — per-stage ceiling: Versace (`render_treatment=material-expressive`) **sketch** prompt still carries `no 3D bevels … flat finished vector marks only` and leaks no render-stage material prose — ceiling is per-STAGE, not per-brand. Render-stage proof deferred until the render composition exists (mechanism inherited).
- **Task 5** — cross-stage promote-prefix keys present; orchestrator builds `${parentStage}_to_${shot.composition}` and falls back to `iterate`.

**Deviations from the spec snippets (all grounded, flagged here):**
1. **Accessor:** spec snippets read `classifierContext[title.id]`; the real var is **`objectContext[title.id]`** (Task 0). Used throughout Tasks 2–4.
2. **Ref-budget (Task 2 Step 5):** chose a **per-cartridge `profile.ref_budget=12`** (threaded orchestrator → `fal.js` `opts.refBudget`, env fallback) over the spec's global `REF_BUDGET=12` env bump — global would change `product` runs, which the plan forbids. Product unaffected (no `ref_budget` → env default 8).
3. **Cross-stage keys (Task 5):** keyed to the **documented composition names** `system-split-4x5` (render) and `hero-single-surface` (mockup) from `_promote_prefixes_NOTE`, not the spec's placeholder `render`/`mockup` (which would never match the real composition names).

### ⚠️ Action required from the aesthetic worktree (wt/render-v3)
- When you create the render/mockup compositions, confirm their names. If they are **not** `system-split-4x5` / `hero-single-surface`, RENAME the matching keys in `profile.json.promote_prefixes` or cross-stage carry-through silently falls back to `iterate`.
- `mark_bias` is emitted on the brief but **not yet consumed** — wire it into `sketch.slots.mark_type` selection (your tuning surface).
- Register prose wording + exact palette/color values are yours to dial by eye; the mechanism is in place.

### Task 1b — router model is a cartridge setting (DONE, 2026-05-25)
The router model is now `profile.classifier_model` (logos = `anthropic/claude-sonnet-4.6`), threaded through `classifyByCartridge` → `classifyLogos`/`classifyObjects` (both already accept `{ model }`, defaulting to `anthropic/claude-haiku-4.5`). Cartridges without the key fall back to Haiku — `product` is unaffected.

- **OpenRouter slug reality:** request slug `anthropic/claude-sonnet-4.6` is valid; OpenRouter **serves** the dated snapshot `anthropic/claude-4.6-sonnet-20260217` (note the reordered tokens — don't pin the dated form in config, the canonical `anthropic/claude-sonnet-4.6` is the stable alias).
- **Trace recording:** `trace.input.options.classifier_model` records the resolved model (added at `orchestrator.js`, the `createTrace` input.options). Verified on run `20260525-085211-4dmk` = `"anthropic/claude-sonnet-4.6"`.
- **⚠️ Stale verification idiom:** the spec's `data/traces/*.json` grep no longer applies — `fs.js` storage was deleted; traces persist to Supabase. Inspect a trace via `GET /api/public/runs/:id` (full trace, client-scoped) instead.
- **Routing quality (Sonnet, 4 brands):** Versace → `material-expressive`; Acme Law & Iron Bank → `mono`/`flat`; Warp music label → bold (`one-saturated-field`/varied registers). Shortlists are brand-apt and visibly distinct — Sonnet discriminates treatment ceiling and palette policy correctly, not just "different from Haiku."

## §10 — Sketch + Render flow (sketch-render-flow spec, Task 0 audit + Task 1)

### Task 0 findings (live-code audit, 2026-05-25)
- **Stage == composition name.** There is NO stage-archetype layer. The orchestrator stores `stage: shot.composition` (`orchestrator.js:823`) and looks up BOTH the treatment ceiling (`stage_resolution[composition]`, `:392`) and the promote prefix (`${parentStage}_to_${shot.composition}`, `:788`) by the **composition NAME**. `style_order` entries are composition names too (`:237`, filtered against `compositions` keys). `composition` is bound at `:295` = `styleCycle[styleIdx]`.
- **⚠️ DIVERGENCE FOUND + FIXED (Option A, cartridge-only).** The merged mechanism keyed `stage_resolution` by archetype (`render`/`mockup`) but `promote_prefixes` by composition name (`system-split-4x5`/`hero-single-surface`). Since both are looked up by composition name, a render composition named `system-split-4x5` would get `stage_resolution["system-split-4x5"] = undefined` → the `from_brief` treatment ceiling would **never fire** (it only worked for `sketch` because name==key by luck; render-ceiling proof was deferred in the mechanism spec, so this stayed latent). **Fix:** rekeyed `stage_resolution.render → "system-split-4x5"` and `mockup → "hero-single-surface"` so every key = a composition name. No orchestrator edit. See `profile._stage_resolution_NOTE`.
- **STOP-gate PASSED:** register prose reaches the prompt (run `20260525-085211-4dmk` `style_mix` slot = real `profile.styles` prose, not a one-word era). The mechanism works end-to-end on `main`.
- **Ref dirs:** `sketch/`(16), `logo-only/`(12), `wordmark/`(12), `system/`(37), `mockup/` present.
- **Aspect ratio is RUN-level only** (`orchestrator.js:141` — `default_aspect_ratio` or per-request; per-request wins). No per-composition aspect. The render composition declares `aspect_ratio: "4:5"` for intent/forward-compat, but the **UI must send `aspect_ratio: 4:5` on render runs** — wired via the per-cartridge `FLOWS` def in Task 2.

### Task 1 — render composition + two-stage style_order (DONE)
- Added `system-split-4x5` composition (treatment-neutral skeleton: mark top half / wordmark bottom half, "two DISTINCT elements", carry the mark forward faithfully; `{style_mix}`+`{palette}`+`{layout}` sinks; `ref_sources:["logo-only","wordmark"]`; `style_mix.count:1` to carry the PRIMARY register forward — vs sketch's count 3 spread). Treatment (flat/dimensional/material) comes from the `from_brief` ceiling, NOT the skeleton.
- `style_order` → `["sketch","system-split-4x5"]` (composition names, NOT "render").
- Verified (cartridge load harness): style_order includes render; `stage_resolution[system-split-4x5]` = `from_brief` (ceiling fires); dual-source = 24 refs (12 logo-only + 12 wordmark); all skeleton sinks present. Full sketch→render promote chain proven in Task 3.

### Task 2 — per-cartridge FLOWS funnel (DONE, UI)
- `app.js` FLOWS def drives stages/labels/next/refStages/freshStage/aspect/edit per cartridge; funnel columns generated from `flow().stages` (`ensureFunnelColumns`); funnel gate `hasFunnelFlow()`. Verified in Playwright (:3002): logos = 2 cols (Sketch/Render), ref tab sketch-only; product = 3 cols unchanged. Aspect sent per-flow (sketch 1:1 / render 4:5) — aspect is run-level (orch :141) so the UI carries it.

### Task 3 — sketch→render promote chain (DONE, verified live)
- **Chain works:** promote `sketch → system-split-4x5` resolves the `sketch_to_system-split-4x5` prefix (prepended at orchestrator.js:810), parent is ref[0] (subject anchor), aspect 4:5, treatment ceiling holds, render column fills with split-screen system boards. Verified on runs `…125730-8mie` / `…130041-po1l`.
- **⚠️ GAP FOUND + FIXED (orchestrator, surgical):** the parent-as-subject path replaced refs with `[parent, ...overrides]`, dropping ALL cartridge refs (right for product — subject fidelity; wrong for logos render — its dual-source refs are STYLE anchors). Fix at `orchestrator.js` ~759: when the composition declares `ref_sources` AND there are no user overrides, append the dual-source cartridge refs after the parent. Result: refsAvailable 1→25 (parent + 24 dual-source, capped to 12 by ref_budget). Product unaffected (no `ref_sources` on its compositions). Trace prompt note: the trace's shotList stage stores the PRE-prefix skeleton; the final prefixed prompt is only in the image metadata — don't mistake the skeleton for a missing prefix.

### Task 4 — variability (IN PROGRESS — findings)
- **Sketch variability: strong baseline.** 3 contrasting brands show genuinely distinct worlds — Warp = bold letterform on saturated BLUE field + organic blobs + radial rosettes on ORANGE; austere brands trend mono/cream/black-inverted. `palette_policy` (saturated brand-color vs mono) and the register spread are both visibly working. Bar substantially met at sketch.
- **Render carry-through works** (4:5 split-screen, mark top / wordmark bottom, distinct elements; flat treatment held for Warp).
- **⚠️ OPEN ISSUE — wordmark text = full input title.** The render wordmark renders the raw `{subject}` ("WARP INDEPENDENT ELECTRONIC MUSIC LABEL 003"), incl. descriptor + the blast's numeric suffix; one tile rendered just "002". The classifier already extracts `brand_name: "Warp"` — the render skeleton/subject should use the brand NAME for the wordmark, not the raw title. Needs a fix (subject vs brand_name) — pending direction.
