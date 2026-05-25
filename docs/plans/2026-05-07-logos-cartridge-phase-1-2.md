# Logos cartridge — Phase 1 + Phase 2 implementation plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Implement task-by-task. Each task has a verification step that produces evidence (CLI output, trace contents, browser smoke); commit only after the verification produces the expected output.

**Goal:** Stand up the `logos` cartridge with end-to-end Stage 1 (Sketch) rendering, plus engine-level cost-policy plumbing that all cartridges can adopt.

**Architecture:** New `v2/cartridge/logos/` riding on the existing `input_mode: "object"` deterministic pipeline. One new factory module (`logoContext.js`), one classifier-dispatch indirection (`classifyByCartridge.js`), small surgery in `orchestrator.js` for promote-prefix table lookup and dual-source ref filter, small surgery in `render/fal.js` for stage-keyed cost policy. UI picks up the cartridge automatically once profile.json exists. No DB schema changes.

**Tech Stack:** Node.js (CommonJS), Express, Supabase JS client, OpenRouter Haiku for classification, fal.ai for renders. No test runner — verification is via CLI smoke commands and trace inspection.

**Reference docs:**
- Design spec: `v2/cartridge/logos/PLAN.md`
- Existing classifier to mirror: `v2/src/factory/objectContext.js`
- Existing cartridge to crib structure from: `v2/cartridge/product/`

---

## File map

**Create:**
- `v2/cartridge/logos/profile.json` — input mode, allowed models, style order, classifier name, stage_resolution policy, promote_prefixes, brand DNA, system role
- `v2/cartridge/logos/compositions.json` — single Stage 1 composition `sketch` with multiple slot-driven registers
- `v2/cartridge/logos/subjects.json` — minimal `logo` subject type, phrase-banks populated per-title at runtime by orchestrator (mirrors product/subjects.json)
- `v2/cartridge/logos/themes.json` — single placeholder theme (object-mode only uses one theme by construction)
- `v2/cartridge/logos/palette.json` — period-unified placeholder palette
- `v2/cartridge/logos/suffix.md` — positives + anti-cliché negatives
- `v2/cartridge/logos/learnings.md` — empty stub for future technical truths
- `v2/cartridge/logos/references/sketch/.gitkeep` — placeholder so the empty folder ships in git
- `v2/cartridge/logos/references/logo-only/.gitkeep`
- `v2/cartridge/logos/references/wordmark/.gitkeep`
- `v2/cartridge/logos/references/mockup/.gitkeep`
- `v2/src/factory/logoContext.js` — Haiku classifier mirroring `objectContext.js` for the logo schema
- `v2/src/factory/classifyByCartridge.js` — thin dispatch that picks the right classifier based on `cartridge.profile.classifier`

**Modify:**
- `v2/src/orchestrator.js:5` — replace direct import of `objectContext` with the dispatcher
- `v2/src/orchestrator.js:177-203` — call `classifyByCartridge(cartridge, titles)` instead of `classifyObjects(titles)`
- `v2/src/orchestrator.js:207` — rename `objectContext` → `classifierContext` on the trace input (backward-compatible: the field name is internal; consumers in `runOne` read `objectContext[title.id]` and we'll update those refs)
- `v2/src/orchestrator.js:622-629` — extend `refsForComposition` to honor `cartridge.compositions[name].ref_sources` (dual-source style filtering)
- `v2/src/orchestrator.js:631-699` — refactor `runOne` parent-as-subject prefix block to read from `cartridge.profile.promote_prefixes` with fallback to today's hardcoded product prose
- `v2/src/orchestrator.js:705` — pass `stage` and `stageResolution` (from cartridge profile) into `renderOne`
- `v2/src/render/fal.js:20-77` — `renderOne` accepts `stage` + `stageResolution`; thread through to gpt-image-2 `quality` field; document why nano-banana / flux-pro can't honor stage-resolution today

---

## Task 1: Create cartridge folder skeleton (JSON + markdown stubs)

**Files:**
- Create: `v2/cartridge/logos/profile.json`
- Create: `v2/cartridge/logos/compositions.json`
- Create: `v2/cartridge/logos/subjects.json`
- Create: `v2/cartridge/logos/themes.json`
- Create: `v2/cartridge/logos/palette.json`
- Create: `v2/cartridge/logos/suffix.md`
- Create: `v2/cartridge/logos/learnings.md`
- Create: `v2/cartridge/logos/references/{sketch,logo-only,wordmark,mockup}/.gitkeep` (4 files; folders already exist on disk)

- [ ] **Step 1.1: Write `profile.json`**

```json
{
  "brand_name": "Logo System",
  "input_mode": "object",
  "classifier": "logo",
  "default_aspect_ratio": "1:1",
  "style_order": ["sketch"],
  "allowed_models": ["fal-ai/nano-banana-pro", "openai/gpt-image-2"],
  "play_ratio": 0.0,
  "stage_resolution": {
    "sketch": { "gpt_quality": "low" },
    "render": { "gpt_quality": "medium" },
    "mockup": { "gpt_quality": "high" }
  },
  "promote_prefixes": {
    "iterate": "CRITICAL: Iterate on the reference image, which depicts a {parentTitle} brand identity. Use it as the starting point and produce a close variation — keep the silhouette, weight, geometry, and overall identity faithful. Vary only the framing, register, or composition. The output must clearly belong to the same family as the reference.{intent} Apply the following direction:"
  },
  "_promote_prefixes_NOTE": "Cross-stage prefixes (e.g. sketch_to_system-split-4x5, system-split-4x5_to_hero-single-surface) get added in Phase 3/4 once the target compositions are named. Lookup key in orchestrator is `${parentStage}_to_${shot.composition}` — must match the actual composition names in compositions.json, not stage archetypes.",
  "system_role": "You are a brand identity designer. Each input is a brand name plus a short descriptor. You produce considered, period-coherent identity assets — sketches first, then a clean mark-and-wordmark system, then mockups across surfaces. The brand stays consistent across all stages; only the medium changes.",
  "objective": "Produce on-brand identity work — exploratory sketches, clean system sheets, and mockup applications — calibrated to the era, posture, and tone implied by the brand name and descriptor.",
  "brand_dna": {
    "visual_signature": "Considered, period-coherent, restrained. The mark is always the subject. No category clichés (no coffee beans for a roaster, no scales of justice for a law firm). Letterforms and silhouettes do the work, not literal subject illustration.",
    "mandatory_elements": "Honest letterforms. Confident silhouettes. Period-true register: a mid-century mark looks mid-century, a Bauhaus mark looks Bauhaus.",
    "forbidden": "No category-cliché iconography (beans for coffee, gears for engineering, leaves for wellness). No fantasy lighting. No 3D bevels, no gradients, no fake glows on Stage 2 system sheets — flat or near-flat treatment only. No invented copy beyond the brand name itself."
  }
}
```

- [ ] **Step 1.2: Write `compositions.json`** (sketch composition — full slot vocabulary lands in Task 8; minimal stub here so cartridge loads cleanly during smoke tests)

```json
{
  "compositions": {
    "sketch": {
      "category": "logo",
      "skeleton": "a working-document sheet of hand-drawn black-ink brand identity sketches for a {subject} on a pure white ground, {register}, {framing}, {treatment}, {linework}, the entire image is white space with the studies arranged across it — at least 50 percent of the image is plain white, no shading, no fill, no gradients, no shadows, no color besides black ink and white field, NOT a clean vector logo, NOT a 3D render — this is a designer's actual exploration page, hand-drawn with real pen-pressure roughness, multiple thumbnails of marks and wordmark studies shown together",
      "slots": {
        "register": [
          "loose pen exploration register: many small confident black-ink mark studies scattered across the page, mid-design energy, like a designer's working sketchbook"
        ],
        "framing": [
          "the studies arranged across the central two-thirds of the frame with deliberate empty space between them"
        ],
        "treatment": [
          "a thumbnail page — six to ten very small rough mark studies plus one or two wordmark studies arranged across the white"
        ],
        "linework": [
          "thin steady black ink with small overlaps at intersections, working-drawing energy, never perfectly straight, real pen-pressure variation"
        ]
      },
      "wildcard_skeletons": [],
      "cameras": ["centered, vast white space"],
      "lenses": ["small, considered, gesture-led"],
      "mood": "playful, considered, hand-drawn, gesture-led"
    }
  }
}
```

- [ ] **Step 1.3: Write `subjects.json`**

```json
{
  "subjects": {
    "logo": {
      "triggers": [],
      "phrase_banks": {
        "default": ["brand identity"]
      }
    }
  }
}
```

- [ ] **Step 1.4: Write `themes.json`** (object-mode requires at least one theme; single placeholder is fine — orchestrator picks `themeNames[0]` at line 250)

```json
{
  "themes": {
    "neutral-paper": {
      "description": "off-white paper, ink-black, no chroma — period-unified placeholder until palette calibrates"
    }
  }
}
```

- [ ] **Step 1.5: Write `palette.json`** (placeholder; period palette calibrates once refs land)

```json
{
  "name": "neutral-paper",
  "ground": "off-white paper",
  "ink": "ink-black",
  "tonal_register": "no chroma — black on warm off-white"
}
```

- [ ] **Step 1.6: Write `suffix.md`**

```markdown
# Suffix

## Positives
considered, period-coherent, restrained, hand-drawn where appropriate, the letterforms and mark do the work

## Negatives
no category-cliché iconography, no coffee beans, no gears, no scales of justice, no leaves for wellness brands, no 3D bevels, no fake glows, no invented brand copy beyond the brand name itself, no watermarks, no fantasy lighting
```

- [ ] **Step 1.7: Write `learnings.md`**

```markdown
# Logos cartridge — learnings

Technical truths from past sessions live here as we ship. Companion to `PLAN.md`.

(Empty — populated as we observe model quirks, prompt rules, and ref-budget surprises.)
```

- [ ] **Step 1.8: Create `.gitkeep` files in the four reference subfolders**

```bash
touch v2/cartridge/logos/references/sketch/.gitkeep \
      v2/cartridge/logos/references/logo-only/.gitkeep \
      v2/cartridge/logos/references/wordmark/.gitkeep \
      v2/cartridge/logos/references/mockup/.gitkeep
```

- [ ] **Step 1.9: Verify cartridge loads via the existing loader**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client && node -e "const { loadCartridge } = require('./v2/src/factory/cartridge'); const c = loadCartridge('logos'); console.log('OK:', c.name, '| compositions:', Object.keys(c.compositions), '| themes:', Object.keys(c.themes), '| input_mode:', c.profile.input_mode, '| classifier:', c.profile.classifier);"
```

Expected output:
```
OK: logos | compositions: [ 'sketch' ] | themes: [ 'neutral-paper' ] | input_mode: object | classifier: logo
```

- [ ] **Step 1.10: Verify the cartridge appears in /api/public/cartridges**

```bash
curl -s http://localhost:3002/api/public/cartridges | node -e "let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{const j=JSON.parse(s); console.log('cartridges:', j.cartridges?.map(c=>c.name) || j.names || Object.keys(j.profiles || {}))});"
```

Expected: `logos` appears in the list. (Server is already running on :3002.)

- [ ] **Step 1.11: Commit**

```bash
git add v2/cartridge/logos/
git commit -m "scaffold logos cartridge — empty stage 1 skeleton, registers via folder existence"
```

---

## Task 2: Implement `logoContext.js` classifier

**Files:**
- Create: `v2/src/factory/logoContext.js`

- [ ] **Step 2.1: Write the module**

```javascript
// logoContext.js
//
// One Haiku call per BATCH that classifies each input title (brand name +
// optional descriptor) into a brand-attribute schema. Mirrors objectContext.js
// in shape and lifecycle: result is cached on the trace input so promote runs
// reuse the parent's classification (zero re-classify cost).
//
// Schema:
//   {
//     brand_name: "Acme Coffee",
//     sanitized_descriptor: "quiet, considered, neighborhood-scale, urban — beverage hospitality",
//     era: "contemporary-minimal",
//     posture: "quiet",
//     weight: "regular",
//     geometry_bias: "geometric",
//     tone: "utilitarian",
//     formality: "casual"
//   }

const SYSTEM = `You classify brand inputs for a logo-design pipeline.

For each input, return a single JSON object with these fields:

- brand_name (string, ≤60 chars): the brand name extracted from the input. If only a brand name is given, repeat it. Strip taglines.
- sanitized_descriptor (string, ≤120 chars): a comma-separated list of attributes implied by the descriptor (era, posture, weight, geometry, tone, scale). Use SOFT cliché-stripping: keep one rounded-off category word at the end after an em-dash separator (e.g. "— beverage hospitality" or "— professional services"). NEVER include the brand name. NEVER include sector-specific subject nouns ("coffee beans", "scales of justice"). Attributes ONLY, then the rounded category.
- era: exactly one of "mid-century" | "swiss-modern" | "art-deco" | "bauhaus" | "post-modern" | "contemporary-minimal" | "y2k" | "utilitarian-industrial" | "vernacular-handmade".
- posture: exactly one of "quiet" | "assertive" | "playful" | "austere" | "warm" | "technical".
- weight: exactly one of "light" | "regular" | "heavy".
- geometry_bias: exactly one of "geometric" | "organic" | "hand-drawn" | "hybrid".
- tone: exactly one of "utilitarian" | "luxury" | "scholarly" | "irreverent" | "clinical" | "warm-domestic".
- formality: exactly one of "formal" | "casual".

Rules:
- Pick the most plausible values for the actual brand described — be literal, not aspirational.
- For ambiguous inputs (just a brand name, no descriptor), infer from the name's phonetic and lexical character.
- Never return null or empty strings.

Output: ONE JSON object per input, in the same order, separated by newlines. No prose, no markdown, no backticks.`;

function stripFence(s) {
  s = String(s || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  return s.trim();
}

function parseJsonLines(text) {
  const out = [];
  for (const line of stripFence(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); }
    catch { /* tolerate junk lines — caller falls back per-title */ }
  }
  return out;
}

const ALLOWED = {
  era: new Set(['mid-century', 'swiss-modern', 'art-deco', 'bauhaus', 'post-modern', 'contemporary-minimal', 'y2k', 'utilitarian-industrial', 'vernacular-handmade']),
  posture: new Set(['quiet', 'assertive', 'playful', 'austere', 'warm', 'technical']),
  weight: new Set(['light', 'regular', 'heavy']),
  geometry_bias: new Set(['geometric', 'organic', 'hand-drawn', 'hybrid']),
  tone: new Set(['utilitarian', 'luxury', 'scholarly', 'irreverent', 'clinical', 'warm-domestic']),
  formality: new Set(['formal', 'casual'])
};

function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {
    brand_name: String(obj.brand_name || '').slice(0, 60).trim(),
    sanitized_descriptor: String(obj.sanitized_descriptor || '').slice(0, 120).trim(),
    era: ALLOWED.era.has(obj.era) ? obj.era : 'contemporary-minimal',
    posture: ALLOWED.posture.has(obj.posture) ? obj.posture : 'quiet',
    weight: ALLOWED.weight.has(obj.weight) ? obj.weight : 'regular',
    geometry_bias: ALLOWED.geometry_bias.has(obj.geometry_bias) ? obj.geometry_bias : 'geometric',
    tone: ALLOWED.tone.has(obj.tone) ? obj.tone : 'utilitarian',
    formality: ALLOWED.formality.has(obj.formality) ? obj.formality : 'casual'
  };
  if (!out.brand_name) return null;
  return out;
}

// Inject classification facts into a logo-stage prompt. Keeps shape symmetric
// with objectContextPrefix so the orchestrator can call either by cartridge
// classifier and the rest of the pipeline doesn't care.
function logoContextPrefix(ctx) {
  if (!ctx) return '';
  const parts = [
    `The brand is "${ctx.brand_name}".`,
    `Era: ${ctx.era}. Posture: ${ctx.posture}. Weight: ${ctx.weight}. Geometry bias: ${ctx.geometry_bias}. Tone: ${ctx.tone}. Formality: ${ctx.formality}.`,
    ctx.sanitized_descriptor ? `Attribute summary: ${ctx.sanitized_descriptor}.` : '',
    `Let these attributes drive letterform, silhouette, and register — do NOT illustrate the brand's literal product or category.`
  ].filter(Boolean);
  return parts.join(' ');
}

async function classifyLogos(titles, { model = 'anthropic/claude-haiku-4.5' } = {}) {
  if (!Array.isArray(titles) || !titles.length) return {};
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('[logoContext] OPENROUTER_API_KEY not set — skipping classification');
    return {};
  }
  const userPrompt = titles.map(t => `[ID:${t.id}] "${t.title}"`).join('\n');
  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3002',
        'X-Title': 'Recast Logo Context'
      },
      body: JSON.stringify({
        model,
        max_tokens: 200 * titles.length + 200,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userPrompt }
        ]
      })
    });
  } catch (e) {
    console.warn('[logoContext] fetch failed:', e.message);
    return {};
  }
  if (!response.ok) {
    console.warn('[logoContext] OpenRouter', response.status, await response.text().catch(() => ''));
    return {};
  }
  const result = await response.json().catch(() => null);
  const content = result?.choices?.[0]?.message?.content;
  if (!content) return {};
  const parsed = parseJsonLines(content);
  const out = {};
  for (let i = 0; i < titles.length; i++) {
    const ctx = sanitize(parsed[i]);
    if (ctx) out[titles[i].id] = ctx;
  }
  return out;
}

module.exports = { classifyLogos, logoContextPrefix };
```

- [ ] **Step 2.2: Smoke-test the classifier in isolation**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client && node -e "require('dotenv').config({path:'./.env'}); const { classifyLogos } = require('./v2/src/factory/logoContext'); classifyLogos([{id:'t1', title:'Acme Coffee — quiet third-wave roaster in Brooklyn'}, {id:'t2', title:'Tessellate Studio'}]).then(r => console.log(JSON.stringify(r, null, 2)));"
```

Expected: a JSON object keyed by `t1` and `t2`, each with all eight schema fields populated, `era`/`posture`/`weight`/`geometry_bias`/`tone`/`formality` from the allowed enums, and `sanitized_descriptor` containing attributes (NOT the literal brand name and NOT bare category nouns like "coffee").

- [ ] **Step 2.3: Commit**

```bash
git add v2/src/factory/logoContext.js
git commit -m "factory: add logoContext classifier (brand attributes + soft cliché stripping)"
```

---

## Task 3: Add classifier dispatch (`classifyByCartridge.js`)

**Files:**
- Create: `v2/src/factory/classifyByCartridge.js`

- [ ] **Step 3.1: Write the dispatcher**

```javascript
// classifyByCartridge.js
//
// Cartridge-keyed classifier dispatch. The orchestrator used to import
// classifyObjects directly; that hardcoded the product cartridge's spatial
// schema as the only classification shape. Cartridges now declare their
// classifier in profile.json (`classifier: "object" | "logo"`); this module
// routes to the right module and the rest of the pipeline stays generic.

const { classifyObjects, objectContextPrefix } = require('./objectContext');
const { classifyLogos, logoContextPrefix } = require('./logoContext');

const CLASSIFIERS = {
  object: { classify: classifyObjects, prefix: objectContextPrefix },
  logo:   { classify: classifyLogos,   prefix: logoContextPrefix }
};

function classifyByCartridge(cartridge, titles) {
  const name = cartridge?.profile?.classifier || 'object';
  const c = CLASSIFIERS[name];
  if (!c) {
    console.warn(`[classifyByCartridge] unknown classifier "${name}" — falling back to object`);
    return CLASSIFIERS.object.classify(titles);
  }
  return c.classify(titles);
}

function prefixByCartridge(cartridge, ctx) {
  const name = cartridge?.profile?.classifier || 'object';
  const c = CLASSIFIERS[name] || CLASSIFIERS.object;
  return c.prefix(ctx);
}

module.exports = { classifyByCartridge, prefixByCartridge };
```

- [ ] **Step 3.2: Commit**

```bash
git add v2/src/factory/classifyByCartridge.js
git commit -m "factory: classifier dispatch by cartridge.profile.classifier"
```

---

## Task 4: Wire orchestrator to use classifier dispatch

**Files:**
- Modify: `v2/src/orchestrator.js:5` (replace import)
- Modify: `v2/src/orchestrator.js:177-203` (call dispatcher)
- Modify: `v2/src/orchestrator.js:638` (inject classifier prefix into fresh-run prompts)
- Modify: `v2/src/orchestrator.js:680-683` (replace `objectContextPrefix(ctx)` with `prefixByCartridge(cartridge, ctx)`)

- [ ] **Step 4.1: Replace the import at line 5**

OLD:
```javascript
const { classifyObjects, objectContextPrefix } = require('./factory/objectContext');
```

NEW:
```javascript
const { classifyByCartridge, prefixByCartridge } = require('./factory/classifyByCartridge');
```

- [ ] **Step 4.2: Update the classification block at lines 191-198**

In the `else` branch (fresh input — line 197), replace:
```javascript
      objectContext = await classifyObjects(titles);
```
with:
```javascript
      objectContext = await classifyByCartridge(cartridge, titles);
```

In the `missing` branch inside the promote block (line 193), replace:
```javascript
        const fresh = await classifyObjects(missing);
```
with:
```javascript
        const fresh = await classifyByCartridge(cartridge, missing);
```

(Leave the variable name `objectContext` alone — it's an internal label, and product traces already in Supabase are keyed off `trace.input.objectContext`. Renaming it is a bigger refactor for zero behavior change.)

- [ ] **Step 4.3: Update the prefix call inside `runOne` at line 681-683**

OLD:
```javascript
        const contextFacts = (ctx && shot.composition === 'in-situ')
          ? ' ' + objectContextPrefix(ctx)
          : '';
```

NEW:
```javascript
        const contextFacts = ctx
          ? ' ' + prefixByCartridge(cartridge, ctx)
          : '';
```

(Change rationale: the `composition === 'in-situ'` gate was a product-cartridge concern — it suppressed object-context facts for sketch and product-shot stages where they didn't help. With cartridge-keyed prefix dispatch, each classifier's `prefixByCartridge` returns its own appropriate text; the logo prefix is short and useful on every stage. Product cartridge: `objectContextPrefix` will now run on all three stages instead of just in-situ during promote runs. We lose nothing — the prose is descriptive facts; product's sketch and product-shot prompts already accept descriptive prefixes via the parent-as-subject prefix and don't conflict.)

- [ ] **Step 4.4: Inject classifier prefix into fresh-run prompts**

This is the load-bearing change for Phase 2. Today the classifier prefix only flows into prompts during a parent-as-subject promote run (the existing `contextFacts` is inside the `if (parentRef?.parentRefUrl && VISION_MODELS.has(m))` block). For a fresh logos sketch run (no parent), the classifier output is computed and stored on the trace but **never reaches the prompt** — meaning Phase 2's first viable test point can't actually verify whether the classifier shapes output.

Add the prefix prepend right after `let prompt = ...` (line 638). Find:
```javascript
      let prompt = (m === 'openai/gpt-image-2' && shot.__gpt2Prompt) ? shot.__gpt2Prompt : shot.prompt;
      let refs = refsForComposition(shot.composition);
      const stageTag = shot.composition;
      const parentRef = parentByTitleId?.[title.id] || null;
```

Replace with:
```javascript
      let prompt = (m === 'openai/gpt-image-2' && shot.__gpt2Prompt) ? shot.__gpt2Prompt : shot.prompt;
      let refs = refsForComposition(shot.composition);
      const stageTag = shot.composition;
      const parentRef = parentByTitleId?.[title.id] || null;

      // Fresh-run classifier prefix injection. Promote runs handle this inside
      // the parent-as-subject prefix block (see contextFacts below). For fresh
      // input, prepend the classifier's stage-agnostic prefix once so brand
      // attributes / object facts actually steer the prompt. No-op when the
      // classifier returned nothing or there's no parent-as-subject conflict.
      if (!parentRef?.parentRefUrl) {
        const freshCtx = objectContext[title.id] || null;
        const freshPrefix = freshCtx ? prefixByCartridge(cartridge, freshCtx) : '';
        if (freshPrefix) prompt = `${freshPrefix} ${prompt}`;
      }
```

(For product cartridge: `objectContextPrefix` now also prepends to fresh sketch and product-shot prompts. The text is descriptive object facts — `"The object is a wall lamp (wall-mounted articulated arm). It naturally occupies wall-vertical space..."` — modest extra context that's redundant on sketch/product-shot but not harmful. The Step 4.5 regression test catches any visible degradation.)

- [ ] **Step 4.5: Smoke-test product cartridge end-to-end (regression check)**

Curl the existing product cartridge to make sure we haven't broken it. The user has a running server at :3002.

```bash
curl -s -X POST http://localhost:3002/api/public/runs \
  -H "Content-Type: application/json" \
  -d '{"cartridge":"product","titles":["wall lamp"],"N":1,"stage":"sketch","model":"fal-ai/nano-banana-pro"}' \
  | head -c 500
```

Expected: a JSON response with `runId`. Then:
```bash
sleep 30 && curl -s "http://localhost:3002/api/public/runs?limit=1" | head -c 800
```
Expected: the run completes (`status: "ok"` or `status: "running"` then resolves). Open the UI in browser, see a sketch tile painted for "wall lamp" — visually unchanged from before this change. The classifier prefix prepended to the sketch prompt is descriptive object facts; it should not visibly alter the sketch register.

- [ ] **Step 4.6: Commit**

```bash
git add v2/src/orchestrator.js
git commit -m "orchestrator: route classification + context prefix through cartridge dispatcher; inject classifier prefix into fresh-run prompts"
```

---

## Task 5: Engine-level cost policy — `render/fal.js`

**Files:**
- Modify: `v2/src/render/fal.js:20-77`

- [ ] **Step 5.1: Update `renderOne` signature + gpt-image-2 branch**

At line 20, the function declaration is:
```javascript
async function renderOne(prompt, options = {}) {
```

Below the existing destructuring (around line 21-25), add:
```javascript
  const stage = options.stage || null;
  const stageResolution = options.stageResolution || null;
  // gpt-image-2 quality ladder: cartridge declares per-stage quality; per-call
  // override (options.quality) still wins. nano-banana-pro and flux-pro/v1.1-
  // ultra don't expose a meaningful resolution knob today (nano is fixed, ultra
  // is fixed at ~2MP), so the stage policy only steers gpt-image-2. When those
  // models add a low-cost variant we'll thread it here too.
  const stageQuality = stage && stageResolution?.[stage]?.gpt_quality;
```

Then in the gpt-image-2 payload block (around line 50-57), the existing line is:
```javascript
      quality,
```
Replace with:
```javascript
      quality: stageQuality || quality,
```

- [ ] **Step 5.2: Update orchestrator's `renderOne` call site**

In `v2/src/orchestrator.js:705`, the call is:
```javascript
        const img = await renderOne(prompt, { model: m, aspectRatio, quality, references: refs });
```

Replace with:
```javascript
        const img = await renderOne(prompt, {
          model: m,
          aspectRatio,
          quality,
          references: refs,
          stage: shot.composition,
          stageResolution: cartridge.profile?.stage_resolution || null
        });
```

(Using `shot.composition` as the stage key matches the existing `stageTag` variable a few lines above.)

- [ ] **Step 5.3: Verify gpt-image-2 receives `quality: low` for a logo-sketch run**

Add a temporary `console.log` at the top of the gpt-image-2 payload block in `fal.js`:
```javascript
console.log('[fal:debug] payload', { model, stage, gpt_quality: stageQuality });
```

Run a single-tile logo run targeting gpt-image-2:
```bash
curl -s -X POST http://localhost:3002/api/public/runs \
  -H "Content-Type: application/json" \
  -d '{"cartridge":"logos","titles":["Tessellate"],"N":1,"stage":"sketch","model":"openai/gpt-image-2"}' \
  | head -c 300
```

Watch the dev-server output — expected log line:
```
[fal:debug] payload { model: 'openai/gpt-image-2', stage: 'sketch', gpt_quality: 'low' }
```

If you see `gpt_quality: undefined`, the stageResolution didn't thread through — debug before continuing.

- [ ] **Step 5.4: Remove the temporary `console.log` and commit**

```bash
git add v2/src/render/fal.js v2/src/orchestrator.js
git commit -m "fal: stage-keyed cost policy (gpt-image-2 quality from cartridge.stage_resolution)"
```

---

## Task 6: Promote-prefix table support in `runOne`

**Files:**
- Modify: `v2/src/orchestrator.js:684-697` (replace inline if/else prefix branches with table lookup + fallback)

- [ ] **Step 6.1: Refactor the prefix block**

The current code in `runOne` (around lines 684-697) is:
```javascript
        let prefix;
        if (isIterate) {
          prefix = `CRITICAL: Iterate on the reference image, ...`;
        } else if (parentStage === 'sketch') {
          prefix = `CRITICAL: The first reference image is a hand-drawn design sketch ...`;
        } else {
          prefix = `CRITICAL: The first reference image shows the EXACT ${parentTitle} ...`;
        }
        prompt = `${prefix} ${prefix2}`;  // (existing template)
```

Replace with:
```javascript
        // Promote prefix lookup. Cartridges can declare prefixes in
        // profile.promote_prefixes keyed by transition:
        //   - "iterate"           same-stage amplify
        //   - "{from}_to_{to}"    cross-stage promote (e.g. "sketch_to_render")
        // Falls back to today's hardcoded product prose for cartridges that
        // don't declare them. {parentTitle} and {intent} are interpolated.
        const transition = isIterate
          ? 'iterate'
          : `${parentStage || 'unknown'}_to_${shot.composition}`;
        const prefixTemplates = cartridge.profile?.promote_prefixes || {};
        const interp = (tpl) => tpl
          .replace(/\{parentTitle\}/g, parentTitle)
          .replace(/\{intent\}/g, intent);

        let prefix;
        if (prefixTemplates[transition]) {
          prefix = interp(prefixTemplates[transition]);
        } else if (isIterate) {
          prefix = `CRITICAL: Iterate on the reference image, which depicts a ${parentTitle}. Use it as the starting point and produce a close variation of the same design — keep the silhouette, proportions, key features, and overall identity faithful to the reference. Vary only the framing, angle, light, surface treatment, or composition. The output must clearly belong to the same family as the reference.${intent} Apply the following direction to the variation:`;
        } else if (parentStage === 'sketch') {
          prefix = `CRITICAL: The first reference image is a hand-drawn design sketch of a ${parentTitle}.${intent} Render that exact ${parentTitle} as a real product photograph — interpret the sketch as the design intent and faithfully preserve its silhouette, proportions, joinery, and every key feature. The output must be a photographic render of a real ${parentTitle}, NOT a copy of the line drawing, NOT an icon or illustration. If the sketch shows multiple variants or a process diagram, focus on the most resolved final form. Any additional reference images shown after the first are vibe cues — use them for material, surface, lighting, and palette guidance, NOT as alternate subjects. Then place that ${parentTitle} in the following scene:`;
        } else {
          prefix = `CRITICAL: The first reference image shows the EXACT ${parentTitle} to render. The object in the output image must be visually identical to the ${parentTitle} in the reference — same form, silhouette, proportions, construction, materials, finish, and color. Do not invent a new ${parentTitle}.${intent}${contextFacts} Any additional reference images shown after the first are vibe cues — use them for setting, atmosphere, and palette guidance, NOT as alternate subjects. Then place that exact ${parentTitle} in the following scene:`;
        }
        prompt = `${prefix} ${prompt}`;
```

(The fallback prose is byte-identical to today's hardcoded prose so product cartridge keeps behaving identically.)

- [ ] **Step 6.2: Smoke-test product cartridge promote chain (regression)**

Trigger a sketch → product-shot promote on a recent product run. Pick a sketch tile from the existing `product` runs in the UI, click promote → product. Confirm the resulting product-shot tile shows the same object the sketch did (i.e., the prefix still works).

```bash
# Quick automated check: list recent product runs, pick the latest sketch-stage one
curl -s "http://localhost:3002/api/public/runs?limit=5" | head -c 1000
```

Then manually promote in the UI. Expected: behavior identical to before this change.

- [ ] **Step 6.3: Commit**

```bash
git add v2/src/orchestrator.js
git commit -m "orchestrator: promote prefixes via cartridge.profile.promote_prefixes table (product fallback unchanged)"
```

---

## Task 7: Dual-source ref filter — `refsForComposition`

**Files:**
- Modify: `v2/src/orchestrator.js:622-629`

- [ ] **Step 7.1: Update `refsForComposition`**

Current code:
```javascript
    const refsForComposition = (compName) => {
      if (overridesByStage[compName]?.length) return overridesByStage[compName];
      if (!styleTags.size) return cartridge.references;
      const matchTag = styleTags.has(compName) ? compName : null;
      const styleScoped = matchTag ? cartridge.references.filter(r => r.style === matchTag) : [];
      const untagged = cartridge.references.filter(r => !r.style);
      return styleScoped.length ? [...styleScoped, ...untagged] : cartridge.references;
    };
```

Replace with:
```javascript
    const refsForComposition = (compName) => {
      if (overridesByStage[compName]?.length) return overridesByStage[compName];
      if (!styleTags.size) return cartridge.references;
      // Compositions can declare ref_sources to pull from MULTIPLE style tags
      // simultaneously (e.g. logos Stage 2 reads from logo-only/ + wordmark/).
      // Untagged refs always remain as fallback. When ref_sources is absent,
      // fall back to the single-tag match (today's behavior).
      const compDef = cartridge.compositions[compName] || {};
      const declaredSources = Array.isArray(compDef.ref_sources) ? compDef.ref_sources : null;
      const styleScoped = declaredSources
        ? cartridge.references.filter(r => r.style && declaredSources.includes(r.style))
        : (styleTags.has(compName) ? cartridge.references.filter(r => r.style === compName) : []);
      const untagged = cartridge.references.filter(r => !r.style);
      return styleScoped.length ? [...styleScoped, ...untagged] : cartridge.references;
    };
```

- [ ] **Step 7.2: Verify with a unit-style probe**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client && node -e "
const { loadCartridge } = require('./v2/src/factory/cartridge');
const c = loadCartridge('logos');
console.log('refs loaded:', c.references.length, '| styles:', [...new Set(c.references.map(r => r.style))]);
"
```

Expected (with empty ref folders): `refs loaded: 0 | styles: []`. Once you drop test refs into `references/logo-only/` and `references/wordmark/`, the styles list will show those tags.

- [ ] **Step 7.3: Commit**

```bash
git add v2/src/orchestrator.js
git commit -m "orchestrator: refsForComposition supports composition.ref_sources for multi-style filtering"
```

---

## Task 8: Sketch composition — full slot vocabulary

**Files:**
- Modify: `v2/cartridge/logos/compositions.json`

- [ ] **Step 8.1: Replace the minimal-stub composition with a full multi-register vocabulary**

```json
{
  "compositions": {
    "sketch": {
      "category": "logo",
      "skeleton": "a working-document sheet of hand-drawn black-ink brand identity sketches for a {subject} on a pure white ground, {register}, {framing}, {treatment}, {linework}, the entire image is white space with the studies arranged across it — at least 50 percent of the image is plain white, no shading, no fill, no gradients, no shadows, no color besides black ink and white field, NOT a clean vector logo, NOT a 3D render, NOT a final wordmark — this is a designer's actual exploration page, hand-drawn with real pen-pressure roughness, multiple thumbnails of marks and wordmark studies shown together, the gesture and the approach are what matter",
      "slots": {
        "register": [
          "loose pen exploration register: many small confident black-ink mark studies scattered across the page, mid-design energy, like a designer's working sketchbook",
          "iPad / digital-thumbnail-sheet register: a sheet of multiple small confident black-ink gestural sketches exploring marks and a wordmark or two, working-page feel, like a designer's iPad scratch page",
          "process-diagram register: a small numbered or arrowed sequence of mark variations across two to four steps, each step a tiny drawing with a small ALL-CAPS one-word handwritten label below it",
          "shape-first chunky-contour register: a sheet of mark studies built from primitive geometry (circles, squares, triangles, ovals) stacked or joined, bold thick black outline, no interior detail, plus a wordmark study below in heavy hand-lettered block caps",
          "wordmark-led register: the wordmark study dominates the sheet, hand-lettered confidently in the implied era, with smaller mark studies arranged around it",
          "mark-led register: several mark explorations dominate the sheet, with a single small wordmark study placed deliberately at the bottom for scale"
        ],
        "framing": [
          "the studies arranged across the central two-thirds of the frame with deliberate empty space between them",
          "the studies tiled across the upper two-thirds of the frame with a single wordmark study below",
          "the studies in a loose grid across the page, generous white margins on all four sides",
          "the studies clustered on the left half of the page with empty white space on the right",
          "the studies organized into rough columns with a wordmark study running across the bottom",
          "a tiny constellation of mark studies in the upper-left with a larger wordmark study floating in the lower-right"
        ],
        "treatment": [
          "a thumbnail page — six to ten very small rough mark studies plus one or two wordmark studies arranged across the white",
          "a process page — three to five mark variations connected by hairline arrows with tiny ALL-CAPS labels",
          "an exploration page — four to six mark studies at different scales plus a wordmark study, with thin construction-line guides faintly under some of them",
          "a study page focused on letterform — wordmark variations dominating, with smaller mark studies as supporting explorations",
          "a study page focused on silhouette — mark explorations dominating, with a single wordmark variation as a footer",
          "an alternate-form study — a single mark explored across three to five small variants, plus one wordmark study"
        ],
        "linework": [
          "thin steady black ink with small overlaps at intersections, working-drawing energy, never perfectly straight, real pen-pressure variation",
          "thin black hand-drawn fineliner, slightly shaky, faint pressure variation, hand-drawn rather than vector-clean",
          "rough hand-drawn black ink, real pen-pressure variation, slight wobble, occasional doubled-back stroke",
          "soft graphite-pencil-on-white, light wobble, faint smudge texture, no fill",
          "confident black ink built from multiple short hand-drawn strokes, slightly fragmented and human",
          "bold thick black contour line, even weight, confident closed shapes, almost marker-like"
        ]
      },
      "wildcard_skeletons": [],
      "cameras": ["centered, vast white space"],
      "lenses": ["small, considered, gesture-led"],
      "mood": "playful, considered, hand-drawn, gesture-led"
    }
  }
}
```

- [ ] **Step 8.2: Verify cartridge still loads cleanly**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client && node -e "const { loadCartridge } = require('./v2/src/factory/cartridge'); const c = loadCartridge('logos'); console.log('sketch slots:', Object.keys(c.compositions.sketch.slots), '| register count:', c.compositions.sketch.slots.register.length);"
```

Expected:
```
sketch slots: [ 'register', 'framing', 'treatment', 'linework' ]
register count: 6
```

- [ ] **Step 8.3: Commit**

```bash
git add v2/cartridge/logos/compositions.json
git commit -m "logos: stage 1 sketch composition — six registers, hand-drawn slot vocab"
```

---

## Task 9: End-to-end smoke — Stage 1 sketch run

**Files:** none modified; verification only.

- [ ] **Step 9.1: Confirm dev server is running**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/
```
Expected: `200`. If not, run `npm run dev` from the repo root.

- [ ] **Step 9.2: Fire a one-tile logo sketch run**

```bash
curl -s -X POST http://localhost:3002/api/public/runs \
  -H "Content-Type: application/json" \
  -d '{"cartridge":"logos","titles":["Tessellate Studio — small architecture practice, calm and considered"],"N":1,"stage":"sketch","model":"fal-ai/nano-banana-pro"}'
```

Expected: JSON with `{ runId: "...", ... }` returned within ~300ms.

- [ ] **Step 9.3: Wait for the render and inspect the trace**

```bash
sleep 25 && RUN_ID=$(curl -s "http://localhost:3002/api/public/runs?cartridge=logos&limit=1" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);console.log(j.runs?.[0]?.id || j[0]?.id || '')})") && echo "RUN_ID=$RUN_ID" && curl -s "http://localhost:3002/api/public/runs/$RUN_ID" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); console.log('status:', j.status); console.log('classifier:', JSON.stringify(j.input?.objectContext, null, 2)); console.log('renders:', j.stages?.renders?.items);})"
```

Expected:
- `status: "ok"` (or `running` then resolves to ok within another 10s).
- `classifier: { "<titleId>": { brand_name: "Tessellate Studio", era: "...", posture: "...", ... } }` — all eight schema fields populated.
- `renders.items` has one entry with `status: "ok"` and a `filename` like `gen-001.png`.

- [ ] **Step 9.4: Open the UI and confirm the tile paints**

In a browser at `http://localhost:3002/`, switch the cartridge picker to `logos`, view the just-completed run, and confirm the sketch tile renders. Expected: a hand-drawn-looking sheet of small mark/wordmark studies in black ink on white. (Will look mediocre without ref images — that's fine; you'll calibrate against real refs when you drop them in `references/sketch/`.)

- [ ] **Step 9.5: Sanity-check the prompt that was built**

```bash
curl -s "http://localhost:3002/api/public/runs/$RUN_ID" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); const p=j.stages?.resolved?.prompts; const first=Object.values(p||{})[0]?.[0]; console.log('built prompt:'); console.log(first?.prompt || '(none)');})"
```

Expected:
- The prompt starts with the sketch skeleton — "a working-document sheet of hand-drawn black-ink brand identity sketches for a brand identity..."
- Slots are filled with values from the bank (one register, one framing, one treatment, one linework).
- The classifier prefix appears somewhere in the prompt: `The brand is "Tessellate Studio". Era: ... Posture: ... Weight: ... Geometry bias: ...`
- `sanitized_descriptor` value is present and does NOT contain the brand name itself.

- [ ] **Step 9.6: Verify product cartridge still works (regression)**

```bash
curl -s -X POST http://localhost:3002/api/public/runs \
  -H "Content-Type: application/json" \
  -d '{"cartridge":"product","titles":["wall lamp"],"N":1,"stage":"sketch","model":"fal-ai/nano-banana-pro"}'
```

Wait 30s, check the run resolves to `status: "ok"`, view the resulting tile in the UI. Expected: the same product-cartridge sketch behavior as before.

---

## Task 10: Update `learnings.md` with first observations

**Files:**
- Modify: `v2/cartridge/logos/learnings.md`

- [ ] **Step 10.1: Replace the empty stub with a real first-run note**

Overwrite the file with the template below, filling each `[FILL: ...]` slot from the actual smoke-run outputs you observed in Tasks 5.3 and 9. If a check has no signal yet (e.g. you didn't run a gpt-image-2 batch), leave the line as `not yet observed`.

```markdown
# Logos cartridge — learnings

Technical truths from past sessions live here as we ship. Companion to `PLAN.md`.

## 1. Classifier produced sensible attributes for first-batch inputs

Tested with: `[FILL: brand-name strings used in Task 9]`.
Result: `[FILL: era / posture / weight / geometry_bias / tone / formality each input mapped to. Note any that felt off — those are the calibration signal for which enum values to add or rename later.]`
Soft cliché-stripping behavior: `[FILL: did sanitized_descriptor strip subject nouns and keep only attributes plus a rounded category? Quote the actual string for one input.]`

## 2. Slot sampler register pick vs. classifier era

For each test input, the sampler picked register `[FILL: register name]` for an `era: [FILL]` input. Note coherent matches and mismatches — mismatches are a signal that the cartridge needs era-keyed register weighting (parallel to product's classifier-driven slot weighting), Phase 3 work item.

## 3. Stage-resolution cost policy (gpt-image-2)

Verified via the temporary debug log in Task 5.3 that a logos sketch run targeting `openai/gpt-image-2` received `quality: 'low'` in the fal payload. trace.input.options.quality continues to record the per-call default (`medium`) — that's expected; the cost lever is the per-stage override flowing into `payload.quality`, not the trace-level options field.

## 4. Model quirks observed

`[FILL: anything weird the model did. Common candidates: nano-banana-pro resisting pure line-art; gpt-image-2 ignoring the "no shading, no fill" directive; references not actually reaching the model — check refsAttached vs refsAvailable in trace.stages.renders.items.]`

## 5. Open calibration items for Phase 2 → Phase 3 handoff

`[FILL: any cartridge JSON value that should change before Phase 3 starts. Likely candidates: era enum (add or remove values), posture enum, sketch register slot vocabulary (which entries felt right vs which read as gimmicky), the four ref folders that need refs dropped before Phase 3 can be exercised.]`
```

- [ ] **Step 10.2: Commit**

```bash
git add v2/cartridge/logos/learnings.md
git commit -m "logos: first-run learnings from stage 1 sketch smoke"
```

---

## Self-review checklist

After completing tasks 1–10:

- [ ] **Spec coverage:** Trace through `v2/cartridge/logos/PLAN.md` Phase 1 + Phase 2 sections. Every cartridge file mentioned exists. Classifier wired. Cost policy threaded. Promote-prefix table support landed (even though no logos promote chain runs yet — that's Phase 3). Dual-source ref filter landed (no logos render currently uses it — that's Phase 3). UI cartridge picker shows `logos` (auto, via folder existence).
- [ ] **No placeholders in code:** Every `.json` file is valid JSON parseable by `node -e "JSON.parse(require('fs').readFileSync('<path>','utf8'))"`. No `TBD` or `TODO` in committed config.
- [ ] **Regression check:** Product cartridge end-to-end test (Task 4 Step 4 + Task 9 Step 6) both succeeded.
- [ ] **No commented-out code left in `orchestrator.js` or `fal.js`** from the temporary debug log in Task 5.

## What's deferred (Phase 3+)

Out of scope for this plan, addressed in a follow-up:
- Stage 2 (Render) `system-split-4x5` composition + dual-source ref loader exercised end-to-end.
- Stage 3 (Mockup) hero + brand-sheet compositions + surface bank.
- Style/era dropdown UI + `/api/public/runs` `style_era` parameter consumer.
- Pixel/font user-visible controls.
- `runs.cartridge`-aware tile-listing query for logos (the existing index `idx_runs_client_cartridge_started` already covers this — verify after the first batch of logo runs that listing performance is comparable to product).
