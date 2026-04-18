# Vision — Brand Image Blaster

## One-line

A prompt-engineering system that, given a **brand cartridge** and a **list of topics**, produces a high-volume stream of on-brand images where at least **70 of every 100** are directly usable in production.

## Why

Hero images, social tiles, and editorial illustrations are the bottleneck between having content and shipping it. Humans can art-direct one image in an hour. Image models can render a thousand in an hour but average maybe 10% usable off a naive prompt. The gap is a **prompt strategy problem**, not a model problem.

This tool is the strategy.

## North-star KPI

**Hit rate: usable images ÷ total generations.** Current target **70%**. Current baseline: unmeasured, but inspection suggests ~20–30% in the current pipeline (within-title duplicates count against hit rate).

Secondary KPIs:
- **Diversity-within-title**: ≥ 5 visibly distinct winners per 10 generations for the same topic
- **Brand adherence**: ≥ 90% of outputs visually belong to the same portfolio
- **Cost per usable image**: (render cost + LLM cost) ÷ usable count — the number that makes this economic

## The current instance (Nolla) is a case study

Everything we build for Nolla should be built as if it's **a single instance of a multi-brand system**. The architecture below is the generalization; the Nolla configs live in `config/` and demonstrate the format.

## Core abstraction

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  Brand Cartridge │ → │  Prompt Factory  │ → │     Renderer     │ → │      Judge       │
└──────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘
      per-brand            topic → prompts         prompts → images      images → keep?
```

### 1. Brand Cartridge (swappable per brand)

A folder of declarative config. No code. Today these are the slots we've identified:

- **`profile.json`** — brand name, one-paragraph visual signature, mandatory elements, forbidden list, audience notes
- **`palette.json`** — color system (the thing that ties a portfolio together visually)
- **`themes.json`** — 5–10 background/color-grade recipes consistent with the palette
- **`compositions.json`** — shot library with **slotted variation** (skeleton + modifier banks). The grammar, not a flat template list.
- **`subjects.json`** — topic-type → noun-phrase banks. The "what's in the frame" vocabulary specific to this brand's domain.
- **`categories/*.json`** — soft presets (e.g. "science of skin" vs "lifestyle") that tilt composition weights and palette bias
- **`suffix.md`** — global positives (aesthetic) and negatives (no text, no logos, no stock clichés)
- **`references/`** — 3–8 image files that anchor style for models that accept visual references (nano-banana-pro, kontext)
- **`critic.md`** — the rubric the Judge uses, in the brand's voice

**Portability test:** a new brand should be onboardable by filling out this folder and dropping a reference image set — no code changes.

### 2. Prompt Factory (brand-agnostic logic)

Takes `(topic, cartridge, N=target count)` → list of N distinct image prompts.

Design principles:
- **Shot list, not single shot.** For each topic, ask the LLM for N diverse compositions, not 1. This is the biggest win we haven't taken.
- **Pick from banks, don't invent.** The LLM picks subject nouns, modifiers, cameras from the cartridge's banks. Free-text inventions are where repetition creeps in.
- **Grammar, not templates.** Composition = skeleton + sampled slot values. One "overhead-scatter" yields many concrete prompts.
- **Critic loop.** A second LLM pass reviews the shot list, rejects repeats, forces variance on declared axes (crop, subject, light, surface, mood).
- **Variance budget per batch.** Declared up-front: "of the next 30 prompts, use each composition at most 3×, each surface at most 4×, each theme at most 5×."

### 3. Renderer (pluggable)

Calls fal.ai or any provider. Knobs already exist. Notes:
- Keep model choice per-title (not session-wide) so the Factory can route "heavy subject" shots to flux-pro and "beauty portraits" to nano-banana if data says they win there.
- Optionally pass reference images when the model supports them — this is the single biggest lever for batch coherence we haven't used.

### 4. Judge (to be built)

Post-render pass. Auto-scores each image on the cartridge's critic rubric. Flags near-duplicates (perceptual hash). Surfaces a review UI with the weakest and the strongest so human time goes where it matters.

Human selection still wins — Judge is a filter, not a decider. Its job is to feed the 70%-usable output back to the Factory as signal (which compositions hit, which don't).

## What the UI is for

The current web UI is **the human-in-the-loop interface** for:
- Adding topics
- Previewing prompts before render
- Selecting winners
- Completing and exporting

It's not the product. The product is the pipeline. UI exists so humans can drive batches, inspect hit rate, and tag learnings. A successful future state has the UI still present but optional — most runs can go end-to-end headless.

## What changes next (roadmap, in priority order)

1. **Shot list per title.** Replace one-prompt-per-title with N-distinct-prompts-per-title. Biggest unblock for hit rate. *(Depends on: Factory redesign.)*
2. **Wire brand profile into the live prompt.** Pass `client/profile.json` content into the LLM system prompt so brand DNA actually reaches the model. Today it's loaded and discarded. *(Zero-cost, high-ROI.)*
3. **Slotted composition grammar.** Convert `compositions.json` from flat templates to skeleton + slot banks. *(One-time config work.)*
4. **Subject noun-phrase banks.** Per topic-type, enumerate 8–15 legitimate subjects. LLM picks from the bank. *(Config work, brand-specific.)*
5. **Critic pass.** Second LLM call over the batch JSON to force variance and catch repeats. *(New module.)*
6. **Per-title theme (not session-locked).** Theme becomes part of the shot-list variance. Keep batch coherence via palette, not literal background. *(Small refactor.)*
7. **Reference-image loading.** For models that accept refs, load `cartridge/references/` at render time. *(Already scaffolded in `loadClientReferences()`, not reaching fal.)*
8. **Hit-rate instrumentation.** On every winner/reject, log prompt + metadata. After N batches, mine for which compositions / subjects / themes win. *(Data layer.)*
9. **Auto-Judge.** Perceptual-hash dedup + VLM score against the critic rubric. *(Further out.)*
10. **Multi-brand.** Extract current Nolla config as the reference cartridge. Test onboarding a second brand end-to-end — the point where the abstraction either pays off or reveals what's still Nolla-specific. *(Gated on 1–5.)*

## The moat

The image model is not the moat — it's getting cheaper and better every month and is equally available to everyone. The moat is:

1. **The cartridge format** — the right abstraction of "brand" in prompt terms
2. **The compositions grammar** — the library of proven shot recipes with variance slots
3. **The hit-rate dataset** — over time, which prompts produce usable images for which kinds of brands. Nobody else has this.

Everything else can be rebuilt in a week. The library of learnings is what compounds.

## Non-goals

- **Fine-tuning models.** We're prompt-engineering, not training. The moment you fine-tune you lose brand-swap portability.
- **General-purpose image gen.** This is for **on-brand editorial volume**, not one-off hero shots. Single-image workflows aren't the target.
- **Replacing art directors.** A human still picks winners and revises cartridges. The tool is a volume multiplier, not an autonomous creative.

## Definition of done (current phase)

This phase is done when, for Nolla:
- A run of 100 images produces ≥ 70 that a human reviewer tags as usable, without intervention mid-run
- The same pipeline, pointed at a second brand's cartridge, produces a coherent batch on the first try (even if hit rate is lower initially)
- Each winning image's prompt metadata is logged so future batches can bias toward what worked

## Update log
- 2026-04-16 — initial vision written alongside prompt-strategy audit
