# Logos cartridge — design plan

A new cartridge for logo identity work, mirroring the product cartridge's three-stage funnel with the final stage swapped from in-situ environment to product placement / mockup. Companion to `learnings.md` (to be populated as we ship) and `DISPATCH.md` at the project root.

The cartridge is **deterministic** (`input_mode: "logo"`). Each input renders one or more styles. Reuses the product cartridge's machinery wherever possible — orchestrator stage routing, promote chain, amplify, per-stage refs-override modal, `runs.cartridge` denorm column, SSE delivery, thumbnail bucket, trace store. The only piece of new infra is the dual-source reference loader for Stage 2 (see Phase 3).

## North star for this cartridge

A working brand-identity funnel: type a brand name + short descriptor, get a sketch sheet of mark explorations, promote one to a clean 4:5 split-screen system (mark + wordmark), promote that to product/surface mockups. The cartridge is calibrated to a **unified period and style for v1** — the user is curating a tight reference set rather than spreading across eras.

## The three stages

| Stage | Aspect | Output | Refs source | Ref budget |
|---|---|---|---|---|
| Sketch | 1:1 | Each tile is a working-document **sheet** holding multiple thumbnails — several mark explorations + a wordmark or two — shown together as one piece of paper / one screen | `references/sketch/` | 8 from cartridge |
| Render | 4:5 | Split-screen system — primary mark in top half, wordmark in bottom half, neutral ground | `references/logo-only/` (top half anchors) + `references/wordmark/` (bottom half anchors) | **4 + 4 dual-source** |
| Mockup | 4:5 (hero) or 16:9 (sheet) | Hybrid — some tiles single-surface hero application, some tiles multi-surface brand-sheet | `references/mockup/` + parent render tile as subject anchor | 1 parent + 7 cartridge |

The **horizontal split** in Stage 2 (mark on top, wordmark on bottom) is the canonical layout. It exists so Stage 3's "use the mark in the top half of the reference" convention has a stable target. Convention A from the brainstorm: no UI designation tooling for which mark to promote — the layout itself encodes it.

## Input handling

Single free-text pill in the UI (matches product cartridge UX). Internally split into brand name + descriptor by the per-batch classifier.

### Classifier — `v2/src/factory/logoContext.js`

Mirror of `objectContext.js`. One Haiku call per batch on the input text. Output schema cached on `trace.input.logoContext`; promote runs reuse — zero re-classify cost.

```
{
  brand_name,
  sanitized_descriptor,    ← soft cliché-stripping: rounded-off category retained,
                             but explicit subject nouns are demoted to a single-word
                             trailing tag (e.g., "quiet, considered, neighborhood-scale,
                             urban — beverage hospitality")
  era,                     ← mid-century | swiss-modern | art-deco | bauhaus
                             | post-modern | contemporary-minimal | y2k
                             | utilitarian-industrial | ...
  posture,                 ← quiet | assertive | playful | austere | warm | technical
  weight,                  ← light | regular | heavy
  geometry_bias,           ← geometric | organic | hand-drawn | hybrid
  tone,                    ← utilitarian | luxury | scholarly | irreverent | clinical
  formality                ← formal | casual
}
```

The vocabulary above is illustrative. Final bank values calibrate once references land and we see the register the user is targeting.

### Future style/era dropdown (Phase 5, scaffolded day-1)

`/api/public/runs` accepts an optional `style_era` parameter. When set, the classifier short-circuits its `era` field. Cartridge format already supports it (the classifier is the only consumer). UI control lands in Phase 5; wire format is ready from Phase 1.

## Hidden prompt slots — Stage 2 render

Cartridge JSON, not exposed in the UI. The orchestrator's slot sampler picks values from fixed banks, weighted by classifier output:

```
wordmark half:
  font_family        descriptive bank (e.g., "geometric sans, mid-weight cut, similar to Futura/Avenir")
  letter_spacing     tight | default | wide | extra-wide
  weight             light | regular | medium | bold
  case               upper | lower | mixed

mark half:
  silhouette_density open | dense
  stroke_weight      hairline | regular | heavy
  complexity         single-shape | two-element | compound
  geometry           circular | rectilinear | organic

shared:
  era                ← from classifier or dropdown override
  posture            ← from classifier
  ground             off-white | warm-grey | ink-black | cream-paper | ...
```

Banks are constrained — no LLM free-text invention (per vision-doc principle: pick from banks, don't invent). Classifier output biases bank weighting, e.g., `era=mid-century` + `posture=quiet` → font_family weights toward geometric sans, letter_spacing toward wide, geometry toward circular/rectilinear.

The slots above are descriptive tokens; the model can't actually do pixel-perfect kerning. They exist now so that when user-visible pixel/font controls eventually ship (Phase 6, conditional), the cartridge format is already wired and the UI plugs into existing override inputs without prompt-template surgery.

## Promote chain

Reuses the product cartridge's promote pipeline. Parent image becomes the subject anchor; classifier output prepends as descriptive prefix.

| Transition | Image ref [0] | Cartridge refs added | Prompt prefix |
|---|---|---|---|
| Sketch → Render | parent sketch tile | `logo-only/` + `wordmark/` | "translate this exploration into a 4:5 split-screen system: primary mark in top half, wordmark in bottom half" |
| Render → Mockup | parent render tile | `mockup/` | "use the mark in the top half of the reference image as the brand mark; apply to the surface(s) below" |
| Amplify same-stage | parent tile | same-stage cartridge refs | classifier prefix + user note |

`gpt-image-2` auto-routes to `gpt-image-2/edit` on parent-as-subject runs (same as product). `flux-pro/v1.1-ultra` (no image input) is filtered out. No special-cased per-stage logic beyond what already exists.

## Cost policy — engine-level, stage-keyed

Cross-cutting concern surfaced during brainstorm. Lives at the engine layer, not in the logos cartridge specifically — product can adopt later without engine changes.

### Mechanism

`v2/src/render/fal.js` accepts a `stage` argument. Each cartridge's `profile.json` declares a `stage_resolution` policy; the orchestrator passes the picked stage's policy into the fal call.

### Logos defaults

```json
"stage_resolution": {
  "sketch":  { "size": "768",  "gpt_quality": "low"    },
  "render":  { "size": "1024", "gpt_quality": "medium" },
  "mockup":  { "size": "1024", "gpt_quality": "high"   }
}
```

- Sketch is exploratory — low fidelity is fine and saves the most. `gpt-image-2` low quality is roughly 15× cheaper than high; flux/nano dimensions drop ~40% of token cost at 768 vs 1024.
- Render at medium is enough to read the type and silhouette decisions. Final palette and refinement happens at promote.
- Mockup is the deliverable; full quality.

Per-model resolution mapping table (768 → which `image_size` enum or width/height for nano-banana, flux-pro, gpt-image-2) lives in `fal.js` next to existing payload shaping.

## What's user-visible vs. hidden

**Visible:** brand-name pill (Stage 1 input), the funnel itself, refs-override modal (per-stage, Sketch + Logo-only + Wordmark + Mockup tabs), per-tile amplify notes, eventual style/era dropdown (Phase 5).

**Hidden:** classifier output, slot picks, font/letter-spacing/case/weight banks, ref-source split, stage-keyed resolution policy.

## Phasing

Funnel-order build, not "novel piece first." Each phase produces a usable artifact even if the chain isn't fully wired.

### Phase 1 — Scaffold + cost policy
- Folder + empty cartridge files (`profile.json`, `compositions.json`, `palette.json`, `subjects.json`, `suffix.md`, `learnings.md`)
- Reference folders created (already done): `references/{sketch,logo-only,wordmark,mockup}/`
- Register `logos` in orchestrator stage routing + cartridge loader + UI cartridge picker
- `stage_resolution` policy threading: `fal.js` accepts `stage` arg; orchestrator passes it; profile.json declares the table
- `style_era` wire-format on `/api/public/runs` (no UI consumer yet)

### Phase 2 — Stage 1 Sketch

**Two iterations in 2026-05-08 → 2026-05-09:**

**Initial design (multi-style explorer sheet)** — the sketch tile showed 3 distinct visual style directions in parallel, with separate clusters for each. Smoke produced an explorer-page output with hand-drawn style labels (post-modern / contemporary-minimal / Y2K). Validated the style_mix mechanism worked end-to-end. But the output was visually busy and looked like a notebook page, not a focused brand exploration.

**Pivoted (2026-05-09) — controlled vector grid.** After reviewing the actual reference dump (refs are clean modernist mark grids — Image 25-style 2x3 grids of geometric marks, Image 27-style mark-with-construction-grid pairs, Image 28+ modular-typeface specimens), the sketch composition was replaced with a controlled vector-grid register:
- Skeleton: "a clean controlled grid of exploration marks for the brand {subject}, arranged as {grid}, {palette}, {mark_register}". FINISHED vector marks, not sketches.
- Slots: `grid` (6 layouts: 2x2, 3x2, 2x3, horizontal-4, horizontal-6, marks-with-construction-pair), `palette` (7 entries — oscillates light/dark including 3 inverted white-on-black grounds), `mark_register` (4: chunky-geometric / modular-typeface / compass-and-grid / negative-space).
- 168 unique slot combinations across 3 slots; per-batch slot sampler gives variety across N tiles without forcing multiple styles into one image.
- Removed `style_mix` (the multi-style mechanism is now opt-in by composition declaration; sketch no longer uses it).
- Removed `linework` slot (no hand-drawn).
- Cleaned `themes.json` and `suffix.md` to drop "hand-drawn" / "off-white paper ground" language that contradicted the new vector register. Theme passes ground decision through to the palette slot.

The classifier prefix still steers letterform feel (era / posture / weight / geometry_bias) but no longer drives explicit style mixing on the page. The cartridge's `stage_resolution: { sketch: { gpt_quality: "low" } }` is the credit-saving lever — meaningful when targeting `openai/gpt-image-2`; nano-banana-pro is fixed-resolution.

End-to-end: enter brand name, get clean-vector-grid sketch tiles. No promote yet (Phase 3).

### Phase 3 — Stage 2 Render
- `system-split-4x5` composition (the only render composition for v1)
- Dual-source reference loader: pull 4 from `logo-only/` + 4 from `wordmark/`. Touches `factory/cartridge.js` ref loader.
- Render slot vocabulary (the slot table above)
- Promote sketch → render lights up.

### Phase 4 — Stage 3 Mockup
- Two compositions: `hero-single-surface` (4:5) and `brand-sheet-multi-surface` (16:9)
- Surface bank populated from `mockup/` refs (tee, card, sign, packaging, web header, etc.)
- Promote render → mockup lights up.

### Phase 5 — Style/era dropdown UI
- The picker. Wire format already exists from Phase 1.

### Phase 6 — Pixel/font user-visible controls (conditional)
- Ship only if the descriptive slot vocabulary proves insufficient in practice. The cartridge format is already prepared for it.

## Open questions / calibration items

These resolve once the user drops references:

- **Sketch register vocabulary.** Names + descriptive prose for sketch compositions. Will mirror the product cartridge's pattern of multiple sketch registers on a unified base, calibrated to whatever pencil/marker/vector/notebook register the user's `sketch/` refs imply.
- **Slot bank values for Stage 2.** Era enum, posture enum, font_family bank, ground bank — illustrative above; finalized once `logo-only/` and `wordmark/` refs land.
- **Style dictionary calibration.** The 12 starter styles in `profile.styles` are reasonable defaults. Once a few sketch runs land, prune entries that don't visually distinguish themselves (some pairs like "post-modern" + "contemporary-minimal" may collapse to one), tighten the prose fragments to call out the most legible visual signatures, and consider raising or lowering `style_mix.count` from 3 if the model can't keep three styles distinct on one sheet.
- **Mockup surface bank.** Driven by `mockup/` refs. Likely tee, mug, business card, signage, packaging, web header, tote, book cover — but the actual list comes from what the user provides as anchors.
- **Per-model resolution mapping for the cost policy.** "768" needs to map to a concrete `image_size` enum for nano-banana, a width/height for flux-pro, and to the `low|medium|high` choice for gpt-image-2. Settled in Phase 1 implementation.

## Open issues being tracked

- **Convention A risk.** If the model hybridizes the two halves of the Stage 2 split rather than treating them as separate marks, Convention A breaks. Mitigation: aggressive prompt language ("two distinct marks, separated by a clear horizontal rule, do not blend or merge"), and a fallback to Convention B (UI mark designation) if hybridization shows up in practice.
- **Stage 2 ref budget split.** With 4 refs from each folder, total stage budget is 8 (matches `REF_BUDGET=8`). If a stage refs-override is loaded for either half, the cartridge defaults are replaced for that half only — not both.
- **Promote-chain image pollution.** When promoting render → mockup, the parent render tile contains both the mark *and* the wordmark. The mockup prompt explicitly directs the model to "the mark in the top half" — but if the mockup composition is a multi-surface sheet showing the brand applied across surfaces, the wordmark legitimately belongs in some of those applications. The prompt needs a per-composition variant to either suppress or include the wordmark depending on the surface (e.g., business card → both; signage → mark only).
