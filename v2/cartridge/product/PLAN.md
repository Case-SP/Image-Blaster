# Product cartridge — design plan

A running record of what we're building for the `product` cartridge. Companion to `learnings.md` (§17, §18) and `DISPATCH.md` at the project root.

The cartridge is **deterministic** (`input_mode: "object"`). Each input renders one or more styles. The user wants editorial-grade output that echoes the supplied reference imagery — Barber Osgerby Plan, Norm Architects, nendo working diagrams, MAQL editorial campaign — not a generic "studio render" feel.

## Phases

### Phase 1 — In-situ tone & quality ✓ shipped (2026-05-02)
Loosened in-situ prompts to design-publication register (Apartamento / Cereal / Wallpaper* / Sight Unseen / MAQL). Self-contained `scene` slot collapsed three colliding slots (register / setting / light) into 14 coherent editorial frames — partial-figure interaction with motion blur, sun-lit modernist apartments, tatami rooms, terracotta courtyards with dappled leaf shadow, dark exhibition galleries, etc. `framing` slot adds magazine-double-page and fashion-campaign crops. Closing line *"the references should drive light, surface, palette, and atmosphere"* lets the refs lead.

### Phase 2 — Staged funnel ✓ shipped (2026-05-02)
Three-column UI (`Sketch → Product → In-situ`) for the product cartridge only. Pill input feeds stage 1. **Promote N → <next stage>** with per-tile note inputs. **Per-tile amplify** (`+` badge) and **per-column +more**. Lineage on every render. Other cartridges keep the flat grid.

Wire format:
```json
POST /api/public/runs
{
  "cartridge": "product",
  "stage": "product-shot",
  "parents": [{ "runId": "...", "slug": "...", "filename": "...", "note": "walnut, matte" }],
  "N": 3
}
```

### Phase 3 — Sketch register broadening ✓ shipped (2026-05-02)
Five sketch registers blended on a single nendo base: nendo minimal-process, shape-first chunky-contour, CAD/schematic technical, iPad-thumbnail-sheet, process-diagram. `linework` slot pairs naturally with each. `treatment` slot now lists 17 ways to depict the same object. Paper slot dropped — gesture and approach lead, not surface.

### Phase 4 — Material registers (skin-pattern for materials)
Mirror nolla's `subject_topic` pattern. The `object` subject_type gains material-keyed phrase banks:
- `wood-light` (ash, oak-natural, beech): warm grain, soft cream tone, clear lacquer micro-sheen
- `wood-dark` (walnut, smoked oak, ebonized): deep grain, low-glare matte, brown-black register
- `metal-warm` (brass, bronze, copper): patina, soft golden reflection, honest tarnish
- `metal-cool` (aluminum, brushed steel, chrome): brushed grain, cool reflection, no orange cast
- `wool` / `fabric-textured`: micro-fiber detail, knit weave, soft directional shadow
- `suede` / `leather-soft`: fine nap, fingerprint texture, low matte sheen
- `leather-pull-up`: rich matte color, aged grain, soft folds
- `ceramic-glazed`: glossy break-light, deep saturation in glaze, clean rim
- `ceramic-unglazed` / `terracotta`: porous matte, warm tone, small natural variation
- `glass-clear`: refraction, edge-light, subject-through-subject
- `glass-milky` / `opal`: soft internal glow, even diffused white, no harsh highlights
- `plastic-color` (saturated): clean color block, even matte, no shine
- `mixed-materials`: explicit two-material register with junction emphasis

The cartridge auto-tags inputs with one or more registers (keyword match on the title text). The picked register gets fused into composition skeletons at a `{material}` slot.

### Phase 5 — Palette anchors (run-coherent color tone)
The user wants color variation at the same saturation/tonal level. Add a `palettes` set on the cartridge:
```json
"palettes": {
  "warm-neutral":     { "ground": "...", "accent": "...", "tonal_register": "..." },
  "sage-clay":        { ... },
  "terracotta-oak":   { ... },
  "charcoal-concrete":{ ... },
  "olive-bone":       { ... },
  "milk-glass-brass": { ... }
}
```
Per title we pick **one** palette and lock it across all three styles (same shape as nolla's `theme-lock` for `N <= 5`).

### Phase 6 — Macro-detail compositions
Add new compositions to the rotation:
- **macro-material** (product) — extreme close on the surface itself (weave, joinery, finish, wear)
- **mixed-materials** (product) — two-material study (suede + cotton, oak + steel, ceramic + brass)
- **environmental-only** (in-situ) — pure environment with the object small in the frame, no figure
- **dappled-detail** (in-situ) — the object half-in-shadow, light pattern from foliage or shoji
- **dark-gallery** (in-situ) — installation mode, dramatic dark surround

### Phase 7 — Kontext on promote
Per-composition model override: `cartridge.compositions[name].model`. When promoting from `sketch → product`, optionally route through `fal-ai/flux-pro/kontext` with the parent sketch as `image_url`. Product shot inherits the sketch's geometry while the prompt repaints surface and material.

### Phase 8 — Collections
Group inputs to share palette + material register + environment family. Per-collection notes apply across all titles in that collection.

### Phase 9 — Per-object dossier (Option D)
Once an object accumulates images across all three stages, click the object name in the column header to open a dossier — sketch row, product row, in-situ row, with per-stage notes and amplify buttons. Same data, rotated 90° to show "everything for this one object."

## Open issues being tracked

- **Kontext is single-image only** — no multi-ref style mixing. When wired into promote/amplify, the parent image is the one ref. Future cartridges that want kontext + multi-ref need a different approach.
- **Reference budget alphabet** — with 8 refs/render, files starting with non-digit characters never reach fal. Solution: rename refs `01-`, `02-` for stable ordering, or allow `cartridge.profile.ref_budget` override.
- **flux-pro/v1.1-ultra has no image input** — the new "flux" label runs text-only. References don't apply. If you want flux + refs, that's `flux-pro/kontext` (single image) — wire it on promote.
- **Sketch on photoreal-trained models** — nano-banana-pro can produce line drawings with strong directive prompts but resists. flux-pro/v1.1-ultra and gpt-image-2 may handle line illustrations better. Monitor and consider per-composition model routing as part of Phase 7.
