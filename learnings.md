# Learnings — Nolla Image Client

A running log of what we've learned about getting **diverse, on-brand, usable** images at scale. Updated as we ship and observe output.

---

## 1. The diversity crisis is architectural, not a prompt problem

### What we observed
Looking at `output/generations/does-creatine-cause-hair-loss/` (15 generations), **multiple `gen-*.png.json` files contain byte-identical prompts** differing only by theme (`golden-hour`, `sage-green`, `cool-white`). Cross-title, the same `subject_fill` (e.g. `"creatine capsules"`, `"dairy-free moisturizer"`) recurs verbatim.

### Root cause
`generateBatchPrompts()` produces **one prompt per title**. Then `generateForTitle()` calls `generateSingleImage()` N times with the **same `promptData` object** — the only thing that changes between renders is the fal.ai seed and (optionally) the session theme.

```
Title → 1 LLM call → 1 prompt → N renders (same prompt, different seed)
```

**Implication:** the image model is being asked to be the diversity engine. It's not. Nano-banana on seed variation produces near-duplicates. Even Flux falls into near-duplicates on a tight prompt.

### The fix pattern (untested)
```
Title → 1 LLM call → N distinct prompts → N renders
```
Have the LLM propose a **shot list** per title (5–10 distinct compositions) instead of one selection. This is the single highest-leverage change for the 70/100 KPI.

---

## 2. Most of the authored "prompt strategy" is dead code

### What's actually running
`generateBatchPrompts()` (src/server/api/openrouter.js:339) has its own hardcoded system prompt with wellness-blog-specific rules (50/50 person/product, skincare vocab, etc.).

### What's authored but NOT wired in
- `config/studio-rules.md` — loaded by `loadStudioRules()`, exported, **never passed into the live prompt path**
- `config/client/profile.json` (Nolla brand DNA, mandatory elements, forbidden list) — loaded, **never reaches the LLM**
- `config/client/guardrails.md` — loaded, **never reaches the LLM**
- `config/archetypes.json` (90+ archetypes) — **unused**; the system migrated to `subjects.json` + `compositions.json` but never deleted the archetype library
- `buildTieredSystemPrompt()` — defined and exported, **no caller**
- `settings.masterSuffixes.person` / `.product` — defined, **not referenced anywhere in openrouter.js or fal.js**

### Implication
The "tiered" architecture (Studio Rules → Client Profile → Style References → Category) the code suggests **does not exist in the runtime**. What runs is a single hardcoded system prompt plus category suffix plus theme.

This is why brand-specific guidance feels inert: the LLM never sees it.

---

## 3. Theme-locking unifies the batch at the cost of per-title diversity

Session theme (`sessionTheme` in src/server/index.js:119) is set once per session and applied to **every** image in the batch. Good for portfolio coherence, bad for hit-rate:

- When the theme doesn't fit a specific title, every rendering for that title is wrong in the same way.
- A title gets 10 shots at goal with **all 10 locked into the same background**.

**Tradeoff to explore:** unlock theme per-title (keep 1–2 candidate themes per title, chosen by the LLM) while keeping batch coherence via palette/lighting rather than literal background color.

---

## 4. `subject_fill` is the biggest hidden repetition vector

`subject_fill` is free-text 2–4 words chosen by the LLM. For a single topic ("creatine") across the batch and across re-renders, the LLM reliably returns `"creatine capsules"` or `"creatine powder"`. The composition template then anchors the whole image to that phrase.

**Lever:** pre-compute a list of valid subject noun-phrases per topic (e.g. creatine → `"white crystalline powder"`, `"scoop of fine powder"`, `"clear water glass with dissolving tablet"`, `"single capsule"`, `"blister pack"`) and have the LLM **pick from a list**, not invent. This also transfers across brands: you swap the noun-phrase bank, keep the compositions.

---

## 5. Composition templates are too rigid

Each composition in `compositions.json` is a single string template. `overhead-scatter` always renders as *"{subject} scattered artfully, directly overhead bird's eye view, flat lay composition"*. No variance on surface, light direction, density, cropping, motion.

**Lever:** turn each composition into a **grammar** (template with slotted modifiers):

```json
"overhead-scatter": {
  "skeleton": "{subject} scattered, overhead bird's eye, {surface}, {density}, {light}",
  "slots": {
    "surface": ["linen cloth", "marble slab", "raw plaster", "...", "..."],
    "density": ["sparse with negative space", "overlapping abundance", "..."],
    "light": ["hard raking side light", "soft diffused overhead", "..."]
  }
}
```

One composition = many concrete prompts. Diversity compounds multiplicatively.

---

## 6. Person-shot prompts have no "variation axes" declared

For `person-beauty`, the LLM picks `model: "Black woman"` (ethnicity + gender). That's the only variance. Missing: age, hair, expression, wardrobe, skin finish, gaze direction, crop height, mood modifier. The model defaults to the same editorial-beauty look because the prompt defaults are flat.

**Known weak spots from looking at generations:**
- Portraits trend toward narrow age range (~25–35)
- Same direct-gaze, dewy-skin, centered-crop pattern
- "Skin texture visible" is requested but output often looks smoothed

---

## 7. Category suffixes are adding repetition, not character

Every category suffix ends with `"no labels, no text, no product branding"` and variations of `"no plants, no foliage, no greenery"`. These appear in **every single prompt**. The negative clauses are load-bearing (we'd get stock-photo smoothies without them) but they also occupy a lot of the prompt and drown out style hints.

**Open question:** does the image model actually respect the negatives, or are we paying prompt-length cost for placebo? Worth A/B testing with and without.

---

## 8. The LLM batcher is cost-efficient, but losing instructions

Batch size is 30 titles per OpenRouter call using Haiku (cheap model). Pros: cheap, fast. Cons: at 30 titles, the LLM often:
- Drifts away from the 50/50 person/product target (observed clustering into one mode)
- Repeats compositions within the batch despite the rule against it
- Picks default subject_fills for all titles in a category

**Lever:** after batch generation, run a **critic pass** (same LLM) that inspects the batch JSON and forces re-rolls on repeats. Or batch smaller (10) with explicit variance budgets.

---

## 9. Model behavior notes (add as we learn)

### nano-banana-pro (current default)
- Fast, cheap, decent beauty portraits
- Tends to smooth skin texture even when asked for macro detail
- Respects "no text" reasonably well
- Shallow DOF is weak — deep focus by default
- _(fill in more as we test)_

### flux-2-pro / flux-1.1-ultra
- _(not yet stress-tested against nano)_

### seedream 4.5
- _(untested in current batch)_

---

## 10. What "usable" actually means (still to define)

Current KPI aspiration: **70 of 100 usable**. We haven't defined "usable." Candidate rubric, to be refined:
1. On-brand (palette + mood match the brand cartridge)
2. Title-relevant (subject or mood connects to the post)
3. Free of model failure (warped hands, text artifacts, melted faces)
4. Distinctive (not a near-duplicate of another winner in the same batch)

Until this rubric is written down, the KPI is vibes. Propose: after every generation batch, tag each output `usable | not-usable | winner` and record the reason. Over time this becomes the training signal for both the prompt factory and the critic pass.

---

## 11. Unused knobs worth wiring up

| Knob | Status | Leverage |
|---|---|---|
| `archetypes.json` (90+ archetypes) | dead code | **high** if we merge into compositions as variations |
| `client/profile.json` brand DNA | loaded, not passed to LLM | **high** — this is where brand voice lives |
| `masterSuffixes.person/product` | defined, never referenced | medium — could de-dupe suffix logic |
| `buildTieredSystemPrompt()` | exported, no caller | low — ghost architecture, decide keep/delete |
| `studio-rules.md` | loaded, not passed | medium — useful floor rules |
| Reference images | supported in `nano-banana-pro` + `kontext` | **high, untested** — load 3–5 brand refs, let the model anchor style |

---

## Update log
- 2026-04-16 — initial audit of prompt strategy, diversity crisis identified as architectural
