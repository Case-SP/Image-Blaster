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
