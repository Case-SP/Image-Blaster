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
