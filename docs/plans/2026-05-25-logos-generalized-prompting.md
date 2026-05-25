# Logos — Generalized Prompting + Per-Stage Aesthetic Ceiling — Implementation Plan

> **For agentic workers (the `technical` worktree):** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax. This project has **no test runner** — every task's verification is a CLI smoke (`scripts/blast.js`) + **trace inspection** (`data/traces/*.json`) + an eyeball of the rendered grid. Commit only after the verification produces the expected evidence.
>
> **⛔ DO NOT WRITE CODE UNTIL TASK 0 IS DONE.** Task 0 is a mandatory audit of the *live* code. This plan was written by the planner from a point-in-time read; the `aesthetic` worktree (`wt/render-v3`) is editing shared files in parallel. If reality diverges from any "Current state" claim below, **stop and report the divergence to the planner before changing code** — do not silently adapt and push.

**Goal:** Turn a brand name + one-line descriptor into a brand-appropriate *spread of flat exploration marks* at the Sketch stage (the "generalized prompting methodology"), and make the flat-only aesthetic ceiling **per-stage** so the Render stage can later go dimensional/material — with as little user input as possible.

**Architecture:** Extend the existing `logoContext.js` Haiku classifier into a **Register Router** that emits an *aesthetic brief* (a brand-appropriate register shortlist + palette policy + render-treatment ceiling). Feed that brief into the *already-present-but-inert* `style_mix` injection path in `orchestrator.js` (replacing its brand-agnostic random picker), give the sketch skeleton a `{style_mix}` sink and a color-capable palette, and convert the global flat-only negatives into a **stage-scoped** ceiling. No new pipeline; no DB changes.

**Tech Stack:** Node.js (CommonJS), Express, Supabase JS, OpenRouter for classification (model becomes a cartridge setting — default `anthropic/claude-sonnet-4.6`; see Task 1b), fal.ai for renders. Verification via `scripts/blast.js` + `data/traces/*.json`.

> **Execution order matters:** Do **Task 2 first** (it's the load-bearing fix per Root cause), then Task 3/4/5, then Task 1/1b. Task 1's better router output is inert until Task 2 wires the prose into the prompt — sequencing this way also lets you prove the wiring fix *before* spending on a bigger model.

**Reference docs (read before starting):**
- Prior cartridge plan (format + verification idiom to mirror): `docs/plans/2026-05-07-logos-cartridge-phase-1-2.md`
- Planner's reference analysis (what "good" looks like, anti-patterns): `docs/logo-refs-analysis.html`
- The classifier you are extending: `v2/src/factory/logoContext.js`
- The cartridge: `v2/cartridge/logos/{profile,compositions,palette,suffix}.json|md`

---

## Why this plan exists — the diagnosis (verify in Task 0)

The user's diversity bar is "five references in five different aesthetic *worlds*" (WARP mid-century badge, UNIQLO swiss-modern system, New Museum brutalist block, etc.). Today the logos cartridge produces samey output because:

1. **Only one stage is live.** `profile.json` → `style_order: ["sketch"]`. `render` + `mockup` exist only in `stage_resolution` config; they have no compositions.
2. **The 12-register style vocabulary is dormant.** `profile.json` defines a rich `styles` dict (`mid-century`, `swiss-modern`, `art-deco`, `bauhaus`, `post-modern`, `contemporary-minimal`, `y2k`, `utilitarian-industrial`, `vernacular-handmade`, `brutalist-poster`, `art-nouveau`, `victorian-engraved`). It only reaches `orchestrator.js` at the `style_mix` block (~line 326–349), which is **inert** because the `sketch` composition declares no `style_mix: { count }` and the skeleton has no `{style_mix}` placeholder.
3. **Register selection, even if fired, is brand-agnostic.** The `style_mix` block picks registers by seeded RNG — it ignores the brand. That's "Approach 3" (random). We want **Approach 2**: a brand-appropriate shortlist chosen by the router.
4. **Palette is monochrome-only.** `compositions.json` → `sketch.slots.palette` is all black/white/inverted. No brand color, so UNIQLO-red / New-Museum-pink can't happen.
5. **The flat-only guardrail is global.** `suffix.md` negatives (`no 3D bevels, no gradients, no fake glows…`) apply to every stage via the cartridge suffix. The user wants flat at **Sketch** but dimensional/material allowed at **Render**.

### Root cause — verified by end-to-end data-flow trace (2026-05-25)

A boundary-by-boundary trace of a fresh sketch render (`nano-banana-pro`) shows **the model never sees the register prose**, and this — not model intelligence — is why output is samey:

| Boundary | Behavior (file:line) |
|---|---|
| Classifier `logoContext.js` | emits a single `era` word (1 of 9) — the only register signal it produces |
| Shot list `orchestrator.js:332` | `style_mix` block gated on `compDef.style_mix`; sketch declares none → **never fires** |
| Assembly `grammar.js:27–31,37` | slots filled **only for placeholders present in the skeleton**; no `{style_mix}` → any `slot_overrides.style_mix` is **silently dropped**. Skeleton hardcodes *"…mid-century corporate identity catalogs…"* for **every** brand. |
| Fresh prefix `orchestrator.js:682` | brand register reaches the prompt only as `"Era: <era>."` — a one-word label, not the rich `profile.styles` prose |
| Payload `fal.js:82` | refs attach correctly (`image_urls`), but `REF_BUDGET=8` caps the 16 sketch refs to the first 8 alphabetically |

**Conclusion:**
- The richest art-direction asset (`profile.styles` prose) is **disconnected** at two points (no `style_mix.count`, no `{style_mix}` placeholder) and elsewhere **collapsed to a one-word `era`**. The hardcoded skeleton register anchor then homogenizes every brand toward "mid-century catalog."
- **The model is NOT the bottleneck.** A perfect router's register choice is discarded at the assembly boundary. **Task 2 (wire the prose) is the load-bearing fix and must land first.** The model upgrade (Task 1b) is a real but *secondary* improvement — it sharpens a decision that is worthless until Task 2 reads it.
- Secondary finding: half the curated sketch refs never reach the model (8/16 budget cap) — address in Task 2 Step 6.

**Locked product decisions (from planner ↔ user):**
- **Approach 2 — shortlist spread.** Router picks 2–4 brand-appropriate registers; the sketch grid spreads across them; primary register carries forward to later stages.
- **Sketch stays flat; Render gets the expressive ceiling (3D / material / molten).** Mockup = realistic application.
- The classifier `era` enum currently lists only **9** registers; `profile.styles` has **12**. The router's `registers` field must draw from the **full `profile.styles` key set** (confirm exact keys in Task 0).

---

## Scope — what THIS (technical) agent builds vs. the aesthetic worktree

**In scope (this plan — `wt/technical`):** the *mechanism* and the *Sketch-stage proof*.
- The Register Router (classifier schema + validation).
- Wiring the brief into the `style_mix` injection path (replacing the random picker).
- A `{style_mix}` sink + color-capable palette on the **sketch** composition.
- The **per-stage treatment-ceiling mechanism** (stage-scoped positives/negatives, gated by `render_treatment`).
- Cross-stage promote-prefix *plumbing* (lookup keys), so carry-through works once later stages exist.

**Out of scope (hand to `wt/render-v3` / aesthetic):** the *visual content*.
- The Render (`system-split-4x5`) and Mockup composition skeletons + slot vocab.
- Tuning the register *prose* wording and the actual color palette values by eye.
- Reference-image curation per stage.

**Contract handed to the aesthetic worktree** (state this in `v2/cartridge/logos/learnings.md` when done):
- The brief is available per-title at `classifierContext[title.id]` with fields `{ registers[], palette_policy, render_treatment, mark_bias, … }` (see Data Contract below).
- A composition gets register spread by adding `style_mix: { count: N }` to its def + a `{style_mix}` placeholder in its skeleton; the router's registers flow in automatically.
- A composition declares its ceiling via `profile.stage_resolution[<stage>].treatment` (`flat` | `dimensional` | `material-expressive`); `render_treatment` from the brief upgrades it at render time. Sketch is pinned `flat`.

**Coordination:** `compositions.json` and `profile.json` are shared with `wt/render-v3`. Touch **only** the `sketch` composition + the `styles`/`stage_resolution`/`promote_prefixes`/router keys. Do **not** add `render`/`mockup` compositions here — that's the aesthetic worktree's surface. Expect merge conflicts; keep edits surgical and localized.

---

## Data Contract — the aesthetic brief

The router (`classifyLogos`) returns one object per title, **extending** today's schema (keep all existing fields):

```jsonc
{
  // --- existing fields (keep, still used by logoContextPrefix) ---
  "brand_name": "Warp",
  "sanitized_descriptor": "independent, rhythmic, bold — music label",
  "era": "mid-century",
  "posture": "assertive",
  "weight": "heavy",
  "geometry_bias": "geometric",
  "tone": "irreverent",
  "formality": "casual",

  // --- NEW: the aesthetic brief ---
  "registers": ["mid-century", "y2k", "brutalist-poster"], // 2–4 keys, all ∈ profile.styles, primary = [0]
  "palette_policy": "muted-brand-color",                    // "mono" | "muted-brand-color" | "one-saturated-field"
  "mark_bias": "abstract",                                  // "abstract" | "pictographic" | "letterform" | "system"
  "render_treatment": "flat"                                // "flat" | "dimensional" | "material-expressive"
}
```

**Validation rules (enforced in `sanitize()`):**
- `registers`: keep only values present in `profile.styles` keys; dedupe; clamp to length 2–4. If fewer than 2 survive, backfill deterministically from `[era, "contemporary-minimal", "swiss-modern"]` (whichever are valid `profile.styles` keys). Never empty.
- `palette_policy`, `mark_bias`, `render_treatment`: enum-validate with safe defaults `"mono"`, `"abstract"`, `"flat"`.
- All new fields independent of the existing prefix fields — `logoContextPrefix` is unchanged.

> **`mark_bias` is emitted but not consumed in this plan.** It is a deliberate contract output for the **aesthetic worktree** to bias `sketch.slots.mark_type` selection (so a `letterform` brand doesn't get all-abstract marks). The router producing it is in scope here; wiring it into `mark_type` selection is the aesthetic worktree's tuning surface. Do not leave it unvalidated.

---

## File map

**Modify:**
- `v2/src/factory/logoContext.js` — extend `SYSTEM` prompt, `ALLOWED`, `sanitize()` to emit + validate the brief (Task 1).
- `v2/cartridge/logos/profile.json` — add `style_mix` enablement note + `stage_resolution.sketch.treatment: "flat"` + (confirm) full 12-key `styles`; add cross-stage `promote_prefixes` keys (Tasks 2, 4, 5).
- `v2/cartridge/logos/compositions.json` — `sketch`: add `style_mix: { count: <from brief> }`, add `{style_mix}` to skeleton, add `{palette}` color values driven by policy (Tasks 2, 3).
- `v2/src/orchestrator.js` — replace the random `style_mix` picker (~326–349) with brief-driven register spread; thread `palette_policy`; thread per-stage `treatment` into the suffix path (Tasks 2, 3, 4, 5).
- `v2/src/factory/grammar.js` and/or `v2/src/factory/shotList.js` — confirm/ wire `{style_mix}` slot substitution + stage-scoped suffix selection (Tasks 2, 4). *(Exact file determined in Task 0 — the suffix is assembled in the prompt-build layer.)*

**Create:**
- (none new in this plan — all mechanism rides existing modules. The aesthetic worktree creates the render/mockup composition surfaces.)

---

## Task 0 — MANDATORY: audit the live code before any change

**Files:** read-only. Produce a short written findings block (paste into the PR/commit body and append to `v2/cartridge/logos/learnings.md`).

- [ ] **Step 1: Confirm or refute each diagnosis claim.** For each, record the file:line and a one-line verdict (`confirmed` / `diverged: <what>`):
  1. `profile.json` `style_order` is `["sketch"]` only.
  2. `profile.styles` exists — **list the exact keys** (the router validates against these).
  3. The `sketch` composition declares **no** `style_mix` and its skeleton has **no** `{style_mix}` placeholder.
  4. `sketch.slots.palette` is monochrome-only.
  5. `suffix.md` negatives are applied globally (find where the cartridge suffix is concatenated into the final prompt — grep `suffix` in `v2/src/factory/`).
  6. `classifyLogos` output is stored per-title — **find the exact path** (grep `classifyByCartridge` / `classifierContext` / `objectContext` in `orchestrator.js`; confirm the key used in `runOne`).

- [ ] **Step 2: Trace the `{style_mix}` consumption path.** Confirm how `shot.slot_overrides.style_mix` becomes prompt text:

Run:
```bash
grep -rn "style_mix\|slot_overrides\|__stylesPicked" v2/src
```
Expected: `slot_overrides.style_mix` is set in `orchestrator.js` (~347) and substituted into a `{style_mix}` placeholder by the slot-filling code in `grammar.js`/`shotList.js`. **Record the exact substitution function.** (Note: `__stylesPicked` is trace metadata only — not the injection path. Do not rely on it for injection.)

- [ ] **Step 3: Confirm the smoke + trace harness works end-to-end** (no code changes yet):

Run (dev server in another shell: `npm run dev`):
```bash
node scripts/blast.js --cartridge logos --count 1 --model fal-ai/nano-banana-pro --titles-prefix "Warp independent electronic music label"
ls -t data/traces/*.json | head -1
```
Expected: blast prints `queued: 1 ok`; a fresh trace JSON exists. Open it and **locate** (a) the classifier output object and (b) the final per-shot prompt string. Record their JSON paths — every later task greps these.

- [ ] **Step 4: Check for collisions with `wt/render-v3`.**

Run:
```bash
git fetch -q 2>/dev/null; git log --oneline main..wt/render-v3 -- v2/cartridge/logos v2/src/orchestrator.js
```
Expected: note any commits touching `sketch` composition / `profile.styles` / the `style_mix` block. If the aesthetic worktree has already added `render`/`mockup` or a `{style_mix}` sink, **stop and report** — the scope split may need re-cutting.

- [ ] **Step 5: Write the findings block** (verdicts + the JSON paths from Step 3 + the substitution function from Step 2). **If any claim diverged, stop and report to the planner.** Otherwise proceed.

> No commit for Task 0 (read-only). The findings block ships with Task 1's commit.

---

## Task 1 — Register Router: extend the classifier to emit the aesthetic brief

**Files:** Modify `v2/src/factory/logoContext.js`

- [ ] **Step 1: Extend the `SYSTEM` prompt.** After the existing field list (the `formality` line), append these field instructions (keep the full 12-key list returned by Task 0 Step 1.2 — the keys below are the expected set; reconcile if Task 0 found different):

```
- registers (array of 2-4 strings): the brand-appropriate aesthetic registers, MOST-fitting first. Each MUST be one of: "mid-century" | "swiss-modern" | "art-deco" | "bauhaus" | "post-modern" | "contemporary-minimal" | "y2k" | "utilitarian-industrial" | "vernacular-handmade" | "brutalist-poster" | "art-nouveau" | "victorian-engraved". Choose registers that genuinely suit the brand's posture and era — a record label might be ["mid-century","y2k","brutalist-poster"]; a law firm ["swiss-modern","contemporary-minimal","victorian-engraved"]. Pick a REAL spread of distinct worlds, not three near-synonyms.
- palette_policy: exactly one of "mono" (black/white only) | "muted-brand-color" (one restrained brand hue) | "one-saturated-field" (a single bold saturated ground, e.g. institutional). Default to "mono" for austere/scholarly/clinical brands.
- mark_bias: exactly one of "abstract" | "pictographic" | "letterform" | "system".
- render_treatment: exactly one of "flat" | "dimensional" | "material-expressive". Reserve "material-expressive" for luxury/fashion/experimental brands; default "flat".
```

- [ ] **Step 2: Add the new enums + register key set to `ALLOWED`.** Add:

```js
const STYLE_KEYS = new Set([
  'mid-century','swiss-modern','art-deco','bauhaus','post-modern','contemporary-minimal',
  'y2k','utilitarian-industrial','vernacular-handmade','brutalist-poster','art-nouveau','victorian-engraved'
]); // reconcile with profile.styles keys from Task 0
ALLOWED.palette_policy = new Set(['mono','muted-brand-color','one-saturated-field']);
ALLOWED.mark_bias = new Set(['abstract','pictographic','letterform','system']);
ALLOWED.render_treatment = new Set(['flat','dimensional','material-expressive']);
```

- [ ] **Step 3: Extend `sanitize()`** to validate the brief. Add before `if (!out.brand_name) return null;`:

```js
let registers = Array.isArray(obj.registers) ? obj.registers.filter(r => STYLE_KEYS.has(r)) : [];
registers = [...new Set(registers)].slice(0, 4);
if (registers.length < 2) {
  for (const fb of [out.era, 'contemporary-minimal', 'swiss-modern']) {
    if (STYLE_KEYS.has(fb) && !registers.includes(fb)) registers.push(fb);
    if (registers.length >= 2) break;
  }
}
out.registers = registers;
out.palette_policy   = ALLOWED.palette_policy.has(obj.palette_policy) ? obj.palette_policy : 'mono';
out.mark_bias        = ALLOWED.mark_bias.has(obj.mark_bias) ? obj.mark_bias : 'abstract';
out.render_treatment = ALLOWED.render_treatment.has(obj.render_treatment) ? obj.render_treatment : 'flat';
```

- [ ] **Step 4: Bump the token budget** so the larger schema fits. In `classifyLogos`, change `max_tokens: 200 * titles.length + 200` → `max_tokens: 320 * titles.length + 240`.

- [ ] **Step 5: Smoke + verify the brief appears in the trace.**

Run (dev server up):
```bash
node scripts/blast.js --cartridge logos --count 3 --model fal-ai/nano-banana-pro --titles-prefix "Versace luxury fashion house"
latest=$(ls -t data/traces/*.json | head -1); grep -o '"registers":\[[^]]*\]' "$latest"; grep -o '"palette_policy":"[^"]*"' "$latest"; grep -o '"render_treatment":"[^"]*"' "$latest"
```
Expected: `registers` array with 2–4 valid keys; a valid `palette_policy`; a valid `render_treatment`. Try a second brand (`"Acme County Law Offices"`) and confirm the register shortlist visibly **differs** from the fashion brand's.

- [ ] **Step 6: Commit** (include the Task 0 findings block in the message body).

```bash
git add v2/src/factory/logoContext.js v2/cartridge/logos/learnings.md
git commit -m "feat(logos): register router — classifier emits aesthetic brief (registers/palette/treatment)"
```

---

## Task 1b (SECONDARY — do after Task 2 proves out) — make the router model a cartridge setting, default Sonnet

> **Why secondary:** per Root cause, the router's output is inert until Task 2 wires the prose into the prompt. Land Task 2 first, confirm register prose reaches the model, *then* do this — so you can judge whether the bigger model actually improves routing rather than guessing. The user chose **Sonnet 4.6**.

**Files:** Modify `v2/src/factory/logoContext.js`, `v2/cartridge/logos/profile.json`, and the classifier dispatch in `v2/src/factory/classifyByCartridge.js` (confirm in Task 0).

- [ ] **Step 1: Add a cartridge profile setting.** In `v2/cartridge/logos/profile.json`, add a top-level key:

```json
"classifier_model": "anthropic/claude-sonnet-4.6"
```

> Confirm the exact OpenRouter slug before committing — list models or check the dashboard. If `anthropic/claude-sonnet-4.6` 404s, use the current Sonnet 4.x slug OpenRouter exposes and record it in `learnings.md`.

- [ ] **Step 2: Thread it through.** In `classifyByCartridge.js`, pass `cartridge.profile?.classifier_model` into `classifyLogos(titles, { model })`. In `logoContext.js`, the existing default param stays as the fallback (`anthropic/claude-haiku-4.5`) so other callers are unaffected.

- [ ] **Step 3: Verify the model actually changed.**

Run (dev server up):
```bash
node scripts/blast.js --cartridge logos --count 1 --titles-prefix "Warp independent electronic music label"
latest=$(ls -t data/traces/*.json | head -1); grep -o '"classifier_model":"[^"]*"\|claude-sonnet' "$latest" | head
```
Expected: the trace records the Sonnet model for the classify stage (add the model to the classify trace stage if not already recorded). Compare the `registers` shortlist for 3–4 varied brands against Haiku's picks from Task 1 Step 5 — confirm the shortlists are more apt, not just different.

- [ ] **Step 4: Commit.**

```bash
git add v2/src/factory/logoContext.js v2/src/factory/classifyByCartridge.js v2/cartridge/logos/profile.json
git commit -m "feat(logos): router model is a cartridge setting (default Sonnet 4.6)"
```

---

## Task 2 — Wire the brief into the sketch register spread (replace the random picker)
### ⭐ LOAD-BEARING — this is the actual root-cause fix; do this task first.

**Files:** Modify `v2/src/orchestrator.js` (the `style_mix` block ~326–349), `v2/cartridge/logos/compositions.json` (sketch), `v2/cartridge/logos/profile.json`.

- [ ] **Step 1: Add the `{style_mix}` sink to the sketch skeleton.** In `compositions.json` → `sketch.skeleton`, replace the hardcoded register tail *"in the visual register of mid-century corporate identity catalogs and contemporary mark-system reference sheets"* with:

```
spanning these registers across the grid while remaining recognizably ONE brand: {style_mix}
```

- [ ] **Step 2: Enable style_mix on the sketch composition.** In `compositions.json` → `sketch`, add a sibling key:

```json
"style_mix": { "count": 3 }
```

- [ ] **Step 3: Make the picker brand-driven.** In `orchestrator.js`, in the `style_mix` block (verify line numbers from Task 0), replace the seeded-RNG pick with the brief's registers when present. The brief is at `classifierContext[title.id]` (use the exact accessor confirmed in Task 0). New logic:

```js
const styleMixCfg = compDef?.style_mix;
const stylesDict = cartridge.profile?.styles;
if (!isPlay && styleMixCfg?.count && stylesDict && Object.keys(stylesDict).length) {
  const brief = classifierContext[title.id]; // accessor per Task 0
  let picks;
  if (brief?.registers?.length) {
    // Approach 2: brand-appropriate shortlist from the router. Rotate the
    // shortlist by shot index so consecutive sketches lead with a different
    // primary, but stay within the brand's register set.
    const regs = brief.registers.filter(k => stylesDict[k]);
    const rotated = regs.map((_, j) => regs[(j + i) % regs.length]);
    picks = rotated.slice(0, Math.min(styleMixCfg.count, rotated.length));
  } else {
    // Fallback: original seeded random pick (brand-agnostic) when no brief.
    const styleKeys = Object.keys(stylesDict);
    const targetCount = Math.min(styleMixCfg.count, styleKeys.length);
    picks = [];
    let s = shotSeed * 73 + 17;
    while (picks.length < targetCount) {
      s = (s * 9301 + 49297) % 233280;
      const key = styleKeys[s % styleKeys.length];
      if (!picks.includes(key)) picks.push(key);
    }
  }
  const proseList = picks.map(k => stylesDict[k]).join(' / ');
  shot.slot_overrides = shot.slot_overrides || {};
  if (!shot.slot_overrides.style_mix) shot.slot_overrides.style_mix = proseList;
  shot.__stylesPicked = picks;
}
```

- [ ] **Step 4: Smoke + verify the register prose reaches the final prompt.**

Run:
```bash
node scripts/blast.js --cartridge logos --count 1 --model fal-ai/nano-banana-pro --titles-prefix "Warp independent electronic music label"
latest=$(ls -t data/traces/*.json | head -1); grep -o '"style_mix":"[^"]*"' "$latest" | head -1; grep -c "geometric simplicity\|chrome-feeling\|raw heavy slab" "$latest"
```
Expected: `style_mix` slot contains the **joined prose** of the brand's registers (e.g. mid-century + y2k + brutalist-poster prose), and that prose appears inside the resolved per-shot prompt string (count ≥ 1). Open the rendered grid (UI at `http://localhost:3002/` or `data/`/output) — the marks should show visibly **different worlds**, still reading as one brand.

- [ ] **Step 5: Close the ref-budget coverage gap (secondary finding).** `data/.../references/sketch/` holds 16 refs but `REF_BUDGET=8` (`fal.js:41`) sends only `01–08` alphabetically — half are dead weight. Pick ONE:
  - (a) Curate `references/sketch/` down to the 8 strongest, OR
  - (b) Set `REF_BUDGET=12` for logos runs (env) and re-benchmark latency/quality.

Verify: after the change, the trace's `refsAvailable` vs `refsAttached` (recorded at `orchestrator.js:772`) should show all intended refs reach fal.

- [ ] **Step 6: Commit.**

```bash
git add v2/src/orchestrator.js v2/cartridge/logos/compositions.json
git commit -m "feat(logos): sketch grid spreads across the router's brand-appropriate register shortlist"
```

---

## Task 3 — Controlled color: palette driven by `palette_policy`

**Files:** Modify `v2/cartridge/logos/compositions.json` (sketch `palette` slot), `v2/src/orchestrator.js`.

- [ ] **Step 1: Add color-capable palette values.** In `compositions.json` → `sketch.slots.palette`, keep the existing mono values and append (kept flat — solid fills, no gradients):

```json
"rendered in a single restrained brand hue on a warm off-white ground (flat solid color, no gradient)",
"rendered in solid black on a single saturated brand-color ground (flat, poster-like, no gradient)",
"rendered in a deep brand hue on a soft neutral ground (flat solid color)"
```

- [ ] **Step 2: Force the palette pick by policy.** In `orchestrator.js`, right after the `style_mix` block, add a brand-policy palette override (so `mono` brands never pick color, and color-policy brands do):

```js
const pol = classifierContext[title.id]?.palette_policy || 'mono';
if (composition === 'sketch') {
  shot.slot_overrides = shot.slot_overrides || {};
  if (!shot.slot_overrides.palette) {
    const palettes = compDef.slots.palette || [];
    const monos = palettes.filter(p => !/brand[- ]color|brand hue|saturated/.test(p));
    const colors = palettes.filter(p => /brand[- ]color|brand hue|saturated/.test(p));
    const pickFrom = (pol === 'mono' || !colors.length) ? monos
      : (pol === 'one-saturated-field' ? colors.filter(p => /saturated/.test(p)).concat(colors) : colors);
    if (pickFrom.length) shot.slot_overrides.palette = pickFrom[Math.abs(shotSeed) % pickFrom.length];
  }
}
```

- [ ] **Step 3: Smoke + verify policy is honored.**

Run:
```bash
node scripts/blast.js --cartridge logos --count 1 --titles-prefix "New Museum contemporary art institution"   # expect one-saturated-field
node scripts/blast.js --cartridge logos --count 1 --titles-prefix "Iron Bank private wealth management"          # expect mono
latest=$(ls -t data/traces/*.json | head -1); grep -o '"palette":"[^"]*"' "$latest" | head -1
```
Expected: the institution run resolves a saturated/brand-color palette; the finance run resolves a mono palette. Eyeball both grids.

- [ ] **Step 4: Commit.**

```bash
git add v2/src/orchestrator.js v2/cartridge/logos/compositions.json
git commit -m "feat(logos): brand-color palette gated by router palette_policy (sketch stays flat)"
```

---

## Task 4 — Per-stage treatment ceiling (stage-scoped suffix/negatives)

**Files:** Modify `v2/cartridge/logos/profile.json`, the suffix-assembly file confirmed in Task 0 (`v2/src/factory/grammar.js` or `shotList.js`), `v2/src/orchestrator.js`.

- [ ] **Step 1: Declare per-stage ceilings in `profile.json`.** Extend `stage_resolution`:

```json
"stage_resolution": {
  "sketch": { "gpt_quality": "low",    "treatment": "flat",
              "negatives": "no 3D bevels, no gradients, no fake glows, no drop shadows, no hand-drawn pen-stroke roughness — flat finished vector marks only" },
  "render": { "gpt_quality": "medium", "treatment": "from_brief",
              "positives_by_treatment": {
                "flat": "flat finished vector treatment, crisp edges",
                "dimensional": "subtle dimensional form, controlled studio rendering, restrained depth",
                "material-expressive": "expressive material treatment — molten metal, chrome, glass, or sculptural form as the brand demands"
              } },
  "mockup": { "gpt_quality": "high",   "treatment": "realistic",
              "positives": "applied to a real-world surface with believable material and lighting" }
}
```

- [ ] **Step 2: Resolve the active ceiling per shot.** In `orchestrator.js`, where the shot's stage/resolution is determined (near where `stageResolution` is passed to `renderOne` — confirm in Task 0), compute the effective suffix:

```js
const sr = cartridge.profile?.stage_resolution?.[composition] || {};
let stageNegatives = sr.negatives || '';
let stagePositives = sr.positives || '';
if (sr.treatment === 'from_brief') {
  const t = classifierContext[title.id]?.render_treatment || 'flat';
  stagePositives = sr.positives_by_treatment?.[t] || sr.positives_by_treatment?.flat || '';
  if (t === 'flat') stageNegatives = 'no fake glows, no drop shadows'; // still tame, but 3D allowed for dimensional/material
}
shot.__stageSuffix = { positives: stagePositives, negatives: stageNegatives };
```

- [ ] **Step 3: Make the prompt builder prefer the stage suffix over the global one.** In the suffix-assembly function (Task 0 Step 2 located it), when `shot.__stageSuffix` is present, use its `positives`/`negatives` **instead of** the cartridge-level `suffix.md` negatives. Keep `suffix.md` as the fallback when no stage suffix exists (so `product` cartridge is unaffected).

- [ ] **Step 4: Smoke + verify the ceiling is stage-correct.**

Run:
```bash
node scripts/blast.js --cartridge logos --count 1 --stage sketch --titles-prefix "Versace luxury fashion house"
latest=$(ls -t data/traces/*.json | head -1); grep -c "flat finished vector\|no 3D bevels" "$latest"
```
Expected: the **sketch** prompt still carries the flat negatives (no 3D) *even for a `material-expressive` brand* — proving the ceiling is per-stage, not per-brand. (Render-stage proof is deferred: there is no `render` composition yet — the aesthetic worktree builds it and inherits this mechanism. Confirm the `render` branch is reachable by temporarily pointing `--stage` at a throwaway composition only if one exists; otherwise note "render path proven once aesthetic ships the composition" in learnings.)

- [ ] **Step 5: Commit.**

```bash
git add v2/cartridge/logos/profile.json v2/src/orchestrator.js v2/src/factory/grammar.js
git commit -m "feat(logos): per-stage treatment ceiling — sketch flat, render gated by brief.render_treatment"
```

---

## Task 5 — Cross-stage carry-through plumbing

**Files:** Modify `v2/cartridge/logos/profile.json` (`promote_prefixes`).

> The lookup key in the orchestrator is `${parentStage}_to_${shot.composition}` (per the existing `_promote_prefixes_NOTE`). The target composition names are owned by the aesthetic worktree; add the keys defensively so carry-through works the moment those compositions land, and keep `iterate` as the same-stage fallback.

- [ ] **Step 1: Add cross-stage prefixes.** In `profile.json` → `promote_prefixes`, add (use the composition names the aesthetic worktree will ship — confirm with them; placeholder names `render` / `mockup` shown):

```json
"sketch_to_render": "CRITICAL: The first reference image is a flat exploration sketch for the {parentTitle} brand. Develop the SAME chosen mark into a finished mark-and-wordmark system — preserve its silhouette, geometry, and register exactly; only the medium becomes a clean finished system sheet.{intent} Apply this direction:",
"render_to_mockup": "CRITICAL: The first reference image is the finished {parentTitle} identity. Apply that EXACT mark and wordmark — identical form, weight, and color — onto the surface described, with believable material and lighting. Do not redesign the mark.{intent} Apply this direction:"
```

- [ ] **Step 2: Verify the lookup resolves (no render composition yet → assert fallback).**

Run:
```bash
grep -n "promote_prefixes\|parentStage}_to_\|_to_" v2/src/orchestrator.js | head
```
Expected: confirm the orchestrator builds the key `${parentStage}_to_${shot.composition}` and falls back to `iterate` when the cross-stage key is absent. Record the exact composition-name requirement for the aesthetic worktree in `learnings.md`.

- [ ] **Step 3: Commit.**

```bash
git add v2/cartridge/logos/profile.json
git commit -m "feat(logos): cross-stage promote-prefix keys for sketch→render→mockup carry-through"
```

---

## Definition of done

- [ ] Task 0 findings block written; no unreported divergence.
- [ ] Two different brand titles yield **visibly different** register shortlists in the trace (Task 1).
- [ ] The brand's register prose appears in the resolved sketch prompt; one grid shows multiple worlds reading as one brand (Task 2).
- [ ] `palette_policy` is honored: color for institutional/color brands, mono for austere brands (Task 3).
- [ ] Sketch prompt stays flat (carries no-3D negatives) even for a `material-expressive` brand; the render ceiling reads from `render_treatment` (Task 4).
- [ ] Cross-stage prefix keys present; lookup falls back cleanly until the aesthetic worktree ships `render`/`mockup` (Task 5).
- [ ] `v2/cartridge/logos/learnings.md` updated with the contract for the aesthetic worktree + any divergences found.

## Out of scope (do not build here)
- `render` (`system-split-4x5`) and `mockup` composition skeletons + slots — **aesthetic worktree**.
- Register prose wording polish and exact palette hex values — **aesthetic worktree** (dial by eye).
- Any DB/schema change, any `product`/`demo` cartridge change.
