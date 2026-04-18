# Implementation Plan — v2 Parallel Codebase

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development (parallel dispatch). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a parallel v2 pipeline that fixes the diversity crisis AND gives us a live web UI to **judge the prompting chain as a chain** — inspect every stage (shot-list LLM → critic diff → slot resolution → render → verdict) so we can tell exactly where variance is won or lost.

**Architecture:** **Brand Cartridge → Prompt Factory → Renderer → Trace → Live Inspector UI.** Every batch run emits a **`trace.json`** that records inputs, every intermediate LLM output, diffs, variance scores, and render results. A live web UI (port 3002) streams trace events via Server-Sent Events as the run executes, and lets you tag each image `usable | not-usable | winner` inline. Past runs are browsable. No build tooling — vanilla JS, no bundler.

**Tech Stack:** Node 18+, Express, SSE, OpenRouter, fal.ai, vanilla JS frontend. Native `node --test` for verification.

**Layout:**
```
v2/
├── README.md
├── cartridge/nolla/            # profile, themes, compositions, subjects, suffix, critic, references
├── src/
│   ├── factory/
│   │   ├── cartridge.js        # loader
│   │   ├── grammar.js          # slot sampling
│   │   ├── shotList.js         # LLM → N shots/title + variance score
│   │   ├── critic.js           # critic LLM → revised shots + diff
│   │   └── variance.js         # variance metrics used by both
│   ├── render/fal.js
│   ├── trace/
│   │   ├── store.js            # read/write trace files + event bus
│   │   └── schema.js           # type definitions / validators
│   ├── orchestrator.js         # runs a batch, emits events into trace store
│   └── server.js               # SSE + REST API + static UI
├── ui/
│   ├── index.html              # runs list
│   ├── run.html                # run detail (chain inspector)
│   ├── styles.css
│   └── app.js
├── data/
│   └── traces/                 # <runId>.json
└── output/
    └── generations/<slug>/gen-NNN.png  (+ .json siblings)
```

---

## Phase 0 — Scaffolding

### Task 0.1: Create tree

- [ ] **Step 1**

```bash
mkdir -p v2/cartridge/nolla/{categories,references}
mkdir -p v2/src/{factory,render,trace}
mkdir -p v2/ui v2/data/traces v2/output/{generations,final}
```

- [ ] **Step 2: Write `v2/README.md`**

```markdown
# v2 — Brand Image Blaster

Parallel pipeline with live chain-inspection UI. Runs on port 3002.

## Run
```
cd v2
node src/server.js                        # UI at http://localhost:3002
```

## CLI (for scripting)
```
node -e "require('./src/orchestrator').runBatch({ titles: [...], N: 10 })"
```

## What this gives you
Every batch produces a trace at `data/traces/<runId>.json` capturing every stage of the prompt chain. Open the UI to inspect runs live or historically. Tag images `usable | not-usable | winner` to build the hit-rate dataset.

## Cartridge
`cartridge/<brand>/` — drop a folder, swap brands. See cartridge/nolla/ as reference.
```

---

## Phase 1 — Port Nolla config to cartridge format

(unchanged content from previous revision)

### Task 1.1

- [ ] **Step 1: Copy existing configs**

```bash
cp config/client/profile.json    v2/cartridge/nolla/profile.json
cp config/client/guardrails.md   v2/cartridge/nolla/guardrails.md
cp config/themes.json            v2/cartridge/nolla/themes.json
cp config/subjects.json          v2/cartridge/nolla/subjects.json
cp config/studio-rules.md        v2/cartridge/nolla/studio-rules.md
cp -r config/categories          v2/cartridge/nolla/categories
# compositions.json: will be rewritten in Phase 3 (slotted grammar), don't copy yet
```

- [ ] **Step 2: Write `v2/cartridge/nolla/palette.json`**

```json
{
  "primary": ["#d4c5a9", "#9aaa91", "#c4917a"],
  "neutrals": ["#f5f1ea", "#ebe4d7", "#2b2a27"],
  "accent": ["#8a9a8b"],
  "notes": "warm muted earth tones, sage + terracotta + cream. Avoid saturated primaries."
}
```

- [ ] **Step 3: Write `v2/cartridge/nolla/suffix.md`**

```markdown
# Global Prompt Suffix

## Positives
editorial photography, soft diffused natural light, subtle film grain, shallow depth of field, photorealistic.

## Negatives
no text, no logos, no watermarks, no product branding, no stock-photo clichés, no oversaturation, no cluttered composition.
```

- [ ] **Step 4: Write `v2/cartridge/nolla/critic.md`**

```markdown
# Critic Rubric — Nolla

An image is **usable** only if ALL of the following hold:

1. **Palette match** — dominant colors within the Nolla palette (warm earth tones, sage, cream, terracotta). Not saturated, not neon.
2. **Title-relevant** — the subject or mood connects to the blog title. Not generic.
3. **Free of artifacts** — no warped hands, no text, no melted faces, no obvious duplicate features.
4. **Editorial, not stock** — composition is intentional, not centered-and-obvious.
5. **Distinct** — not a near-duplicate of another winner in the same batch.
```

---

## Phase 2 — Cartridge loader

### Task 2.1: `v2/src/factory/cartridge.js`

- [ ] **Step 1: Test** (`v2/src/factory/cartridge.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const { loadCartridge } = require('./cartridge');

test('loads nolla cartridge', () => {
  const c = loadCartridge('nolla');
  assert.equal(c.name, 'nolla');
  assert.ok(c.profile.brand_name);
  assert.ok(Object.keys(c.themes).length);
  assert.ok(Object.keys(c.subjects).length);
  assert.ok(typeof c.suffix.positives === 'string');
  assert.ok(typeof c.critic === 'string');
});

test('throws on missing', () => {
  assert.throws(() => loadCartridge('nope'));
});
```

- [ ] **Step 2: Implement `v2/src/factory/cartridge.js`**

```js
const fs = require('fs');
const path = require('path');

const CARTRIDGE_ROOT = path.join(__dirname, '../../cartridge');

const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const readTextOr = (p, fb = '') => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fb;

function parseSuffix(md) {
  const grab = label => (md.match(new RegExp(`## ${label}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i')) || [])[1]?.trim() || '';
  return { positives: grab('Positives'), negatives: grab('Negatives') };
}

function loadCartridge(name) {
  const dir = path.join(CARTRIDGE_ROOT, name);
  if (!fs.existsSync(dir)) throw new Error(`Cartridge not found: ${name}`);

  const profile = readJSON(path.join(dir, 'profile.json'));
  const themes = readJSON(path.join(dir, 'themes.json')).themes || {};
  const compositionsPath = path.join(dir, 'compositions.json');
  const compositions = fs.existsSync(compositionsPath) ? (readJSON(compositionsPath).compositions || {}) : {};
  const subjects = readJSON(path.join(dir, 'subjects.json')).subjects || {};
  const palette = fs.existsSync(path.join(dir, 'palette.json')) ? readJSON(path.join(dir, 'palette.json')) : null;
  const suffix = parseSuffix(readTextOr(path.join(dir, 'suffix.md')));
  const critic = readTextOr(path.join(dir, 'critic.md'));
  const guardrails = readTextOr(path.join(dir, 'guardrails.md'));
  const studioRules = readTextOr(path.join(dir, 'studio-rules.md'));

  const refsDir = path.join(dir, 'references');
  const references = fs.existsSync(refsDir) ? fs.readdirSync(refsDir)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .slice(0, 8)
    .map(f => {
      const b = fs.readFileSync(path.join(refsDir, f));
      const ext = path.extname(f).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return { filename: f, url: `data:${mime};base64,${b.toString('base64')}` };
    }) : [];

  const catDir = path.join(dir, 'categories');
  const categories = {};
  if (fs.existsSync(catDir)) {
    fs.readdirSync(catDir).filter(f => f.endsWith('.json')).forEach(f => {
      categories[f.replace(/\.json$/, '')] = readJSON(path.join(catDir, f));
    });
  }

  return { name, profile, themes, compositions, subjects, palette, suffix, critic, guardrails, studioRules, references, categories };
}

module.exports = { loadCartridge };
```

- [ ] **Step 3: Run — PASS**

```bash
cd v2 && node --test src/factory/cartridge.test.js
```

---

## Phase 3 — Slotted composition grammar

### Task 3.1: Write `v2/cartridge/nolla/compositions.json`

Full slotted grammar — replaces v1's flat templates. Each composition: `skeleton` with `{subject}` and slot placeholders, `slots` with arrays of modifier options, `cameras`, `lenses`, `category`, `mood`.

- [ ] **Step 1: Write the file** (full content as in previous revision — 20+ compositions with slots for surface/light/density/pose/etc.)

```json
{
  "compositions": {
    "overhead-scatter": {
      "category": "product",
      "skeleton": "{subject} scattered overhead bird's eye view, {surface}, {density}, {light}, flat lay",
      "slots": {
        "surface": ["raw linen cloth", "polished marble slab", "matte paper", "warm plaster", "aged parchment", "brushed wood grain", "cold stone"],
        "density": ["sparse with vast negative space", "overlapping abundance", "single row precise", "clustered in corner with empty right third"],
        "light": ["hard raking side light", "soft diffused overhead", "warm golden rim", "cool clinical even"]
      },
      "cameras": ["MS", "WS"],
      "lenses": ["35mm", "50mm"],
      "mood": "organized, editorial"
    },
    "cloud": {
      "category": "product",
      "skeleton": "{subject} suspended mid-air, frozen particles, {light}, {background}",
      "slots": {
        "light": ["dramatic spotlight", "raking side beam", "warm golden rim", "cold top-down beam"],
        "background": ["deep charcoal", "soft cream fade", "dark sage void", "warm terracotta gradient"]
      },
      "cameras": ["ECU", "CU"], "lenses": ["100mm macro", "85mm"], "mood": "dramatic, dynamic"
    },
    "scoop": {
      "category": "product",
      "skeleton": "{subject} in {vessel}, {pose}, {light}",
      "slots": {
        "vessel": ["wooden scoop heaping over rim", "ceramic bowl with mound", "paper cup overflowing slightly", "metal measuring scoop"],
        "pose": ["product spilling onto surface", "single spill line", "clean filled rim", "tipped on its side"],
        "light": ["warm side light", "soft overhead", "golden rim", "cool clinical"]
      },
      "cameras": ["CU", "MCU"], "lenses": ["50mm", "85mm"], "mood": "abundant, appetizing"
    },
    "pour": {
      "category": "product",
      "skeleton": "{subject} poured in {stream}, {motion}, {light}",
      "slots": {
        "stream": ["smooth cascading stream", "gentle arc", "thin precise line", "splashing ribbon"],
        "motion": ["motion blur on falling particles", "frozen mid-fall", "slow-shutter trail", "splash droplets frozen"],
        "light": ["backlit glow", "side-lit rim", "soft warm wash", "hard clinical"]
      },
      "cameras": ["MCU", "MS"], "lenses": ["50mm", "85mm"], "mood": "dynamic, action"
    },
    "macro-texture": {
      "category": "product",
      "skeleton": "extreme macro of {subject} surface, {feature}, abstract surface landscape",
      "slots": { "feature": ["granular detail", "peaks and ridges", "wet gleam", "matte dust", "refractive crystal facets"] },
      "cameras": ["ECU"], "lenses": ["100mm macro"], "mood": "abstract, detailed"
    },
    "jar-overhead": {
      "category": "product",
      "skeleton": "open jar of {subject} directly overhead, {marking}, {surface}, {light}",
      "slots": {
        "marking": ["finger swipe mark in product", "clean untouched top", "shallow divot near rim", "small dollop lifted out"],
        "surface": ["linen cloth", "pale marble", "raw plaster", "aged parchment"],
        "light": ["soft diffused overhead", "warm side light", "cool clinical even", "golden rim"]
      },
      "cameras": ["overhead"], "lenses": ["50mm"], "mood": "editorial, used"
    },
    "jar-angle": {
      "category": "product",
      "skeleton": "open jar of {subject} at 45-degree angle, texture visible, {light}, {background}",
      "slots": {
        "light": ["dramatic side lighting", "warm rim light", "soft window light", "cool top-down"],
        "background": ["charcoal fade", "cream backdrop", "sage seamless", "terracotta gradient"]
      },
      "cameras": ["CU"], "lenses": ["50mm", "85mm"], "mood": "dramatic, textural"
    },
    "dollop-finger": {
      "category": "product",
      "skeleton": "{subject} pearl on {digit}, {light}, {background}",
      "slots": {
        "digit": ["fingertip", "knuckle", "side of hand", "two fingertips"],
        "light": ["delicate macro soft", "warm golden side", "cool clinical even", "backlit halo"],
        "background": ["soft out-of-focus cream", "dark blur", "warm bokeh", "pale sage blur"]
      },
      "cameras": ["ECU", "CU"], "lenses": ["100mm macro", "85mm"], "mood": "delicate, intimate"
    },
    "swirl-texture": {
      "category": "product",
      "skeleton": "{subject} in {stroke}, macro {detail}, abstract",
      "slots": {
        "stroke": ["artistic swirl", "long smooth arc", "spiral inward", "figure-eight"],
        "detail": ["peaks and valleys", "glossy sheen", "matte surface", "visible brush marks"]
      },
      "cameras": ["ECU"], "lenses": ["100mm macro"], "mood": "abstract, textural"
    },
    "smear-swatch": {
      "category": "product",
      "skeleton": "{subject} {stroke} on {surface}, {view}",
      "slots": {
        "stroke": ["elegant swatch", "long confident stroke", "pulled thin", "layered double stroke"],
        "surface": ["clean glass", "marble slab", "plaster panel", "warm paper"],
        "view": ["overhead direct", "raking side", "subtle shadow"]
      },
      "cameras": ["CU", "MCU"], "lenses": ["50mm", "85mm"], "mood": "artistic, demonstrative"
    },
    "tube-squeeze": {
      "category": "product",
      "skeleton": "tube being squeezed, {subject} emerging, {pose}, {light}",
      "slots": {
        "pose": ["ribbon of cream emerging", "single dollop forming", "motion frozen mid-squeeze", "long fresh line on surface"],
        "light": ["warm studio", "cool clinical", "golden side", "dramatic rim"]
      },
      "cameras": ["CU"], "lenses": ["50mm", "85mm"], "mood": "active, product-focused"
    },
    "tube-flat": {
      "category": "product",
      "skeleton": "flat tube of {subject} laying on surface, {surface}, {extras}",
      "slots": {
        "surface": ["linen cloth", "pale marble", "warm paper", "sage backdrop"],
        "extras": ["small product ribbon beside", "tube alone minimal", "cap off lying beside", "paired with small dish"]
      },
      "cameras": ["CU", "MCU"], "lenses": ["50mm"], "mood": "minimal"
    },
    "hand-apply": {
      "category": "product",
      "skeleton": "hand applying {subject} to {area}, {light}, {crop}",
      "slots": {
        "area": ["cheek", "forearm back", "jawline", "back of hand"],
        "light": ["soft warm", "cool clinical", "golden side", "dramatic rim"],
        "crop": ["tight on hand only", "face and hand", "partial arm", "shoulder angle"]
      },
      "cameras": ["CU"], "lenses": ["50mm", "85mm"], "mood": "demonstrative"
    },
    "bottle-elegant": {
      "category": "product",
      "skeleton": "elegant bottle of {subject}, {light}, {background}",
      "slots": {
        "light": ["light passing through liquid", "backlit glow", "side rim light", "soft diffused overhead"],
        "background": ["minimal cream", "dark sage", "warm terracotta fade", "cool white"]
      },
      "cameras": ["CU"], "lenses": ["50mm", "85mm"], "mood": "elegant, luxe"
    },
    "pipette-drop": {
      "category": "product",
      "skeleton": "glass pipette releasing drop of {subject}, {droplet}, {background}",
      "slots": {
        "droplet": ["single golden drop forming", "drop mid-fall", "surface tension on glass", "series of three drops"],
        "background": ["dark blur", "warm bokeh", "cool studio", "sage seamless"]
      },
      "cameras": ["ECU", "CU"], "lenses": ["100mm macro", "85mm"], "mood": "precise"
    },
    "portrait-direct": {
      "category": "beauty",
      "skeleton": "editorial beauty portrait, {subject}, direct gaze, {makeup}, {hair}, {wardrobe}, {light}",
      "slots": {
        "makeup": ["minimal natural", "bare-faced visible skin texture", "subtle luminous", "glossy lip only"],
        "hair": ["slicked back", "natural loose", "pulled tight bun", "side part fallen"],
        "wardrobe": ["bare shoulders", "white cotton tank", "soft linen", "cream knit collar"],
        "light": ["soft window side", "warm golden hour", "cool even studio", "dramatic single-source"]
      },
      "cameras": ["CU", "MCU"], "lenses": ["85mm", "50mm"], "mood": "confident, editorial"
    },
    "portrait-profile": {
      "category": "beauty",
      "skeleton": "profile portrait of {subject}, {pose}, {light}, elegant neck line",
      "slots": {
        "pose": ["chin slightly lifted", "eyes closed", "head tilted back", "gaze forward"],
        "light": ["warm side window", "golden rim", "cool soft even", "dramatic single beam"]
      },
      "cameras": ["CU", "MCU"], "lenses": ["85mm"], "mood": "elegant, sculptural"
    },
    "gaze-intense": {
      "category": "beauty",
      "skeleton": "intense direct gaze close-up, {subject}, {expression}, {light}",
      "slots": {
        "expression": ["calm neutral", "faint smile", "serious", "contemplative"],
        "light": ["soft warm window", "clinical even", "dramatic side", "golden hour amber"]
      },
      "cameras": ["CU"], "lenses": ["85mm"], "mood": "intense, intimate"
    },
    "applying-touch": {
      "category": "beauty",
      "skeleton": "{subject} gently touching face with {digit}, {area}, {light}",
      "slots": {
        "digit": ["fingertips", "ring finger", "two fingers flat", "knuckle"],
        "area": ["cheekbone", "under eye", "jawline", "forehead"],
        "light": ["soft natural window", "warm golden", "cool even", "dramatic rim"]
      },
      "cameras": ["CU", "MCU"], "lenses": ["85mm", "50mm"], "mood": "soft, ritualistic"
    },
    "mirror-reflection": {
      "category": "beauty",
      "skeleton": "{subject} in mirror reflection, {setting}, {light}",
      "slots": {
        "setting": ["intimate bathroom vanity", "morning dresser", "softly-lit hallway mirror", "handheld compact"],
        "light": ["warm morning window", "cool overhead bathroom", "golden hour side", "soft diffused cloudy"]
      },
      "cameras": ["MCU", "MS"], "lenses": ["50mm", "35mm"], "mood": "intimate, real"
    },
    "fragment-crop": {
      "category": "beauty",
      "skeleton": "cropped fragment of {area} of {subject}, {feature}, {light}",
      "slots": {
        "area": ["lips and chin", "cheekbone only", "eye and brow", "collarbone and neck"],
        "feature": ["visible pores", "faint freckles", "dewy glow", "matte smooth"],
        "light": ["soft side", "warm golden", "cool clinical", "dramatic rim"]
      },
      "cameras": ["ECU", "CU"], "lenses": ["85mm", "100mm macro"], "mood": "abstract, editorial"
    },
    "serene-eyes-closed": {
      "category": "beauty",
      "skeleton": "{subject} with eyes closed, {pose}, {light}",
      "slots": {
        "pose": ["head tilted back slightly", "chin down", "face up to light", "side turn"],
        "light": ["soft warm window", "golden hour", "cool even", "dramatic rim"]
      },
      "cameras": ["CU", "MCU"], "lenses": ["85mm"], "mood": "peaceful, meditative"
    },
    "natural-candid": {
      "category": "beauty",
      "skeleton": "natural candid of {subject}, {action}, {setting}, {light}",
      "slots": {
        "action": ["mid-laugh", "looking away", "about to speak", "hand brushing hair back"],
        "setting": ["soft indoor blur", "outdoor afternoon", "window bokeh", "minimal backdrop"],
        "light": ["soft warm", "golden hour", "overcast soft", "side window"]
      },
      "cameras": ["MCU", "MS"], "lenses": ["50mm", "35mm"], "mood": "authentic, lifestyle"
    },
    "macro-pores": {
      "category": "skin",
      "skeleton": "extreme macro of {area} skin of {subject}, {feature}, {light}",
      "slots": {
        "area": ["cheek", "nose side", "forehead", "under-eye"],
        "feature": ["pores and texture clinical", "dewy droplets", "faint fine lines", "soft fuzz visible"],
        "light": ["clinical even", "warm side", "cool top-down", "soft diffused"]
      },
      "cameras": ["ECU"], "lenses": ["100mm macro"], "mood": "clinical, detailed"
    },
    "texture-dewy": {
      "category": "skin",
      "skeleton": "{subject} skin with {feature}, {area}, {light}",
      "slots": {
        "feature": ["moisture droplets", "luminous highlight", "glossy sheen", "fine dew mist"],
        "area": ["cheekbone", "décolletage", "forehead", "neck side"],
        "light": ["warm rim", "cool top-down", "soft overhead", "golden side"]
      },
      "cameras": ["ECU", "CU"], "lenses": ["100mm macro", "85mm"], "mood": "fresh, healthy"
    },
    "duo-intimate": {
      "category": "lifestyle",
      "skeleton": "two people in {relation}, {subject}, {setting}, {light}",
      "slots": {
        "relation": ["intimate close moment", "supportive side-by-side", "forehead touch", "quiet parallel"],
        "setting": ["warm indoor", "morning window", "soft outdoor shade", "neutral studio"],
        "light": ["golden hour", "soft diffused", "warm window side", "cool natural"]
      },
      "cameras": ["MCU", "MS"], "lenses": ["50mm", "35mm"], "mood": "intimate, connected"
    },
    "solo-contemplative": {
      "category": "lifestyle",
      "skeleton": "single person in {moment} of {subject}, {crop}, {light}",
      "slots": {
        "moment": ["quiet introspection", "morning pause", "post-activity rest", "preparing to act"],
        "crop": ["shoulder-up", "hands-and-face", "environmental wide", "fragment face"],
        "light": ["warm window", "golden hour", "cool overcast", "soft indoor"]
      },
      "cameras": ["CU", "MCU"], "lenses": ["85mm", "50mm"], "mood": "introspective, quiet"
    }
  }
}
```

### Task 3.2: Grammar sampler + variance helper

**Files:** Create `v2/src/factory/grammar.js`, `v2/src/factory/variance.js`, tests.

- [ ] **Step 1: Tests** (`v2/src/factory/grammar.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const { sampleComposition, buildPrompt } = require('./grammar');

const composition = {
  skeleton: "{subject} on {surface} with {light}",
  slots: { surface: ["marble", "linen", "wood"], light: ["warm side", "cool even"] },
  cameras: ["CU"], lenses: ["50mm"]
};

test('seed determinism', () => {
  const a = sampleComposition(composition, { subject: "x", seed: 42 });
  const b = sampleComposition(composition, { subject: "x", seed: 42 });
  assert.equal(a.prompt, b.prompt);
});

test('different seeds diverge', () => {
  const s = new Set();
  for (let i = 0; i < 20; i++) s.add(sampleComposition(composition, { subject: "x", seed: i }).prompt);
  assert.ok(s.size >= 3);
});

test('buildPrompt composes camera/lens/suffix', () => {
  const out = buildPrompt({
    composition, subject: "x", seed: 1,
    suffix: { positives: "editorial", negatives: "no text" }
  });
  assert.match(out.prompt, /CU/);
  assert.match(out.prompt, /editorial/);
  assert.match(out.prompt, /no text/);
});
```

- [ ] **Step 2: Implement `v2/src/factory/grammar.js`**

```js
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];

function sampleComposition(composition, { subject, seed = Date.now() }) {
  const rand = rng(seed);
  let prompt = composition.skeleton.replace(/\{subject\}/g, subject || 'subject');

  const slotsUsed = {};
  const slotNames = new Set();
  let m; const re = /\{([a-z_]+)\}/gi;
  while ((m = re.exec(composition.skeleton)) !== null) {
    if (m[1] !== 'subject') slotNames.add(m[1]);
  }
  for (const slot of slotNames) {
    const bank = composition.slots?.[slot];
    if (!bank?.length) continue;
    const value = pick(bank, rand);
    slotsUsed[slot] = value;
    prompt = prompt.replace(new RegExp(`\\{${slot}\\}`, 'g'), value);
  }
  const camera = pick(composition.cameras || ['CU'], rand);
  const lens = pick(composition.lenses || ['50mm'], rand);
  return { prompt, camera, lens, slotsUsed };
}

function buildPrompt({ composition, subject, seed, suffix, themeSuffix, modelSpec }) {
  const s = sampleComposition(composition, { subject, seed });
  const parts = [];
  if (modelSpec) parts.push(modelSpec);
  parts.push(`${s.prompt}, ${s.camera}, ${s.lens}`);
  if (themeSuffix) parts.push(themeSuffix);
  if (suffix?.positives) parts.push(suffix.positives);
  if (suffix?.negatives) parts.push(suffix.negatives);
  return { prompt: parts.join('. '), camera: s.camera, lens: s.lens, slotsUsed: s.slotsUsed };
}

module.exports = { sampleComposition, buildPrompt, rng };
```

- [ ] **Step 3: Implement `v2/src/factory/variance.js`**

```js
/**
 * Variance metrics for a list of shots (per-title).
 * Shots are raw LLM selections: {composition, subject_type, subject_topic, theme, model_spec}
 */
function shotListVariance(shots) {
  if (!shots?.length) return { total: 0, score: 0 };
  const counts = { composition: {}, subject_type: {}, theme: {}, model_spec: {} };
  for (const s of shots) {
    for (const k of Object.keys(counts)) {
      const v = s[k] || '(null)';
      counts[k][v] = (counts[k][v] || 0) + 1;
    }
  }
  const distinct = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Object.keys(v).length]));
  const N = shots.length;
  // Score: average of distinct/N per axis, capped at 1
  const axes = ['composition', 'subject_type', 'theme', 'model_spec'];
  const score = axes.reduce((acc, k) => acc + Math.min(1, distinct[k] / N), 0) / axes.length;
  return { total: N, distinct, counts, score: Number(score.toFixed(3)) };
}

/**
 * Prompt-level variance: distinct prompt strings and average pairwise token-jaccard distance.
 */
function promptVariance(prompts) {
  if (!prompts?.length) return { total: 0, distinct: 0, avgDistance: 0 };
  const distinctSet = new Set(prompts);
  const tokens = prompts.map(p => new Set(p.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)));
  let total = 0, pairs = 0;
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const inter = [...tokens[i]].filter(x => tokens[j].has(x)).length;
      const union = new Set([...tokens[i], ...tokens[j]]).size;
      total += 1 - (union ? inter / union : 0);
      pairs += 1;
    }
  }
  return { total: prompts.length, distinct: distinctSet.size, avgDistance: pairs ? Number((total / pairs).toFixed(3)) : 0 };
}

/**
 * Diff between two shot lists (before vs after critic).
 */
function shotListDiff(before, after) {
  const out = [];
  const len = Math.max(before.length, after.length);
  for (let i = 0; i < len; i++) {
    const b = before[i], a = after[i];
    if (!b) { out.push({ idx: i, kind: 'added', after: a }); continue; }
    if (!a) { out.push({ idx: i, kind: 'removed', before: b }); continue; }
    const changedKeys = Object.keys({ ...b, ...a }).filter(k => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
    if (changedKeys.length) out.push({ idx: i, kind: 'changed', keys: changedKeys, before: b, after: a });
  }
  return out;
}

module.exports = { shotListVariance, promptVariance, shotListDiff };
```

- [ ] **Step 4: Run — PASS**

```bash
cd v2 && node --test src/factory/grammar.test.js
```

---

## Phase 4 — Subject phrase banks

### Task 4.1: Rewrite `v2/cartridge/nolla/subjects.json`

(content as in previous revision — every subject type gets `phrase_banks: { default: [...], <topic>: [...] }`)

- [ ] **Step 1: Write the file** (full phrase-banks content, see prior revision)

Full JSON with `powder` / `liquid` / `food` / `device` / `skincare-bottle` / `skincare-cream` / `skincare-tube` / `supplement-pill` / `person-beauty` / `person-lifestyle` / `skin-close`, each with `triggers` and `phrase_banks` by topic. For brevity copy verbatim from the prior plan revision's `Phase 4 Task 4.1 Step 1`.

---

## Phase 5 — Shot-list generator (emits variance)

### Task 5.1: `v2/src/factory/shotList.js`

- [ ] **Step 1: Implement**

```js
const { buildPrompt } = require('./grammar');
const { shotListVariance } = require('./variance');

function buildShotListSystemPrompt(cartridge, N) {
  const compList = Object.entries(cartridge.compositions)
    .map(([k, v]) => `  - ${k} [${v.category}]: ${v.skeleton.slice(0, 80)}...`).join('\n');
  const subjList = Object.entries(cartridge.subjects).map(([k, v]) => {
    const triggers = (v.triggers || []).slice(0, 6).join(', ') || '(any)';
    const topics = Object.keys(v.phrase_banks || {}).join(', ');
    return `  - ${k}: triggers=[${triggers}] topics=[${topics}]`;
  }).join('\n');
  const themes = Object.keys(cartridge.themes).join(', ');

  return `You are the shot-list generator for ${cartridge.profile.brand_name}.

# BRAND DNA
${cartridge.profile.brand_dna ? `Visual signature: ${cartridge.profile.brand_dna.visual_signature}
Mandatory: ${cartridge.profile.brand_dna.mandatory_elements}
FORBIDDEN: ${cartridge.profile.brand_dna.forbidden}` : ''}

# STUDIO RULES
${cartridge.studioRules || '(none)'}

# GUARDRAILS
${cartridge.guardrails || '(none)'}

# JOB
For EACH title, produce EXACTLY ${N} DISTINCT shots.

Each shot: { composition, subject_type, subject_topic, theme, model_spec (or null) }

# COMPOSITIONS
${compList}

# SUBJECTS (topics = phrase-bank keys)
${subjList}

# THEMES
${themes}

# VARIANCE
1. Within a title's ${N} shots: composition repeats ≤2, subject_type ≤3, theme ≤3.
2. ~50% person shots (person-beauty/person-lifestyle/skin-close) when both person and product make sense.
3. Person shots: vary ethnicity AND gender — do NOT default to one look.
4. Every shot must be visibly distinct from the others.

# OUTPUT (strict JSON)
{"<titleId>": {"shots": [{composition, subject_type, subject_topic, theme, model_spec}, ...]}}

No markdown, no explanation.`;
}

async function buildShotList(cartridge, titles, { N = 10, model = 'anthropic/claude-3-haiku' } = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');

  const systemPrompt = buildShotListSystemPrompt(cartridge, N);
  const userPrompt = `Generate ${N} shots for each title:\n\n` +
    titles.map(t => `[ID:${t.id}] [CAT:${t.category || 'general'}] "${t.title}"`).join('\n');

  const t0 = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3002',
      'X-Title': 'Brand Image Blaster v2'
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(titles.length * N * 80, 16000),
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
    })
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  const result = await response.json();
  let content = result.choices[0].message.content.trim();
  const md = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/); if (md) content = md[1];
  const raw = JSON.parse(content);

  const variance = {};
  for (const [tid, sel] of Object.entries(raw)) variance[tid] = shotListVariance(sel.shots);

  return {
    raw,
    variance,
    meta: {
      model,
      elapsedMs: Date.now() - t0,
      systemPromptChars: systemPrompt.length,
      userPromptChars: userPrompt.length,
      tokensUsed: result.usage
    }
  };
}

function resolveShot(cartridge, shot, seed) {
  const composition = cartridge.compositions[shot.composition];
  if (!composition) throw new Error(`Unknown composition: ${shot.composition}`);
  const subjectDef = cartridge.subjects[shot.subject_type];
  if (!subjectDef) throw new Error(`Unknown subject type: ${shot.subject_type}`);

  const topic = shot.subject_topic || 'default';
  const bank = subjectDef.phrase_banks?.[topic] || subjectDef.phrase_banks?.default || ['subject'];
  const subject = bank[(seed + (shot.phrase_idx || 0)) % bank.length];

  const theme = cartridge.themes[shot.theme];
  const themeSuffix = theme ? `${theme.background}, ${theme.color_grade}` : null;

  const isPerson = ['person-beauty', 'person-lifestyle', 'skin-close'].includes(shot.subject_type);
  const hasEthnicityInPhrase = /^(Black|White|Latina|Latino|Asian|South Asian|East Asian|mixed-race|middle-aged|older|young|dark|olive|pale|medium|deep|light)/i.test(subject);
  const modelSpec = isPerson && shot.model_spec && !hasEthnicityInPhrase ? shot.model_spec : null;

  const built = buildPrompt({ composition, subject, seed, suffix: cartridge.suffix, themeSuffix, modelSpec });
  return {
    prompt: built.prompt,
    hasPerson: isPerson,
    composition: shot.composition, subject_type: shot.subject_type, subject_topic: topic,
    subject_phrase: subject, theme: shot.theme,
    camera: built.camera, lens: built.lens, slots_used: built.slotsUsed,
    model_spec: modelSpec
  };
}

function buildRenderPrompts(cartridge, titles, shotMap, { batchSeed = Date.now() } = {}) {
  const out = {};
  for (const title of titles) {
    const sel = shotMap[title.id];
    if (!sel?.shots) continue;
    out[title.id] = sel.shots.map((shot, idx) => {
      const seed = batchSeed + idx * 101 + parseInt(String(title.id).replace(/\D/g, '').slice(-6) || '0', 10);
      return resolveShot(cartridge, shot, seed);
    });
  }
  return out;
}

module.exports = { buildShotList, buildShotListSystemPrompt, buildRenderPrompts, resolveShot };
```

---

## Phase 6 — Critic (emits diff)

### Task 6.1: `v2/src/factory/critic.js`

```js
const { shotListDiff } = require('./variance');

async function critiqueShotList(cartridge, titles, shotMap, { model = 'anthropic/claude-3-haiku', N = 10 } = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');

  const system = `You are the critic for ${cartridge.profile.brand_name} shot lists.

Review the batch shot list JSON and enforce variance:
1. Each title has ${N} shots.
2. Per title: composition repeats ≤2, subject_type ≤3, theme ≤3.
3. Person shots: model_spec must vary (ethnicity + gender) — do NOT accept all one look.
4. FORBIDDEN: ${cartridge.profile.brand_dna?.forbidden || '(none)'}

Return the REVISED shot list JSON, same shape. No markdown, no explanation.

COMPOSITIONS: ${Object.keys(cartridge.compositions).join(', ')}
SUBJECTS: ${Object.keys(cartridge.subjects).join(', ')}
THEMES: ${Object.keys(cartridge.themes).join(', ')}`;

  const t0 = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3002',
      'X-Title': 'Brand Image Blaster v2 — Critic'
    },
    body: JSON.stringify({
      model, max_tokens: Math.min(Object.keys(shotMap).length * N * 80, 16000),
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(shotMap) }]
    })
  });
  if (!response.ok) throw new Error(`Critic ${response.status}: ${await response.text()}`);
  const result = await response.json();
  let content = result.choices[0].message.content.trim();
  const md = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/); if (md) content = md[1];
  const revised = JSON.parse(content);

  // Compute diff per title
  const diff = {};
  for (const tid of Object.keys(shotMap)) {
    diff[tid] = shotListDiff(shotMap[tid].shots || [], revised[tid]?.shots || []);
  }

  return {
    revised, diff,
    meta: { model, elapsedMs: Date.now() - t0, tokensUsed: result.usage }
  };
}

module.exports = { critiqueShotList };
```

---

## Phase 7 — Renderer

### Task 7.1: `v2/src/render/fal.js`

(unchanged from prior revision — wraps fal with reference-image support for nano-banana-pro and kontext)

```js
async function renderOne(prompt, options = {}) {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY not set');
  const model = options.model || 'fal-ai/nano-banana-pro';
  const aspectRatio = options.aspectRatio || '16:9';
  const references = options.references || [];
  const supportsRefs = ['fal-ai/nano-banana-pro', 'fal-ai/flux-pro/kontext'].includes(model);

  const payload = { prompt, aspect_ratio: aspectRatio, resolution: '1K', num_images: 1, output_format: 'png', safety_tolerance: '6' };
  if (supportsRefs && references.length) payload.image_urls = references.slice(0, 4).map(r => r.url);

  const t0 = Date.now();
  const response = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`fal ${response.status}: ${await response.text()}`);
  const r = await response.json();
  if (!r.images?.length) throw new Error('No image returned');
  return { url: r.images[0].url, width: r.images[0].width || 1920, height: r.images[0].height || 1080, model, elapsedMs: Date.now() - t0 };
}

async function downloadImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { renderOne, downloadImage };
```

---

## Phase 8 — Trace Store (the backbone)

The trace is the durable, inspectable artifact. Every run writes one trace file. The store also broadcasts events over an in-process EventEmitter; the server wires it to SSE clients.

### Task 8.1: Schema + store

- [ ] **Step 1: `v2/src/trace/schema.js`**

```js
/**
 * Trace shape — documented here as a reference. JS, so no enforcement at runtime.
 *
 * {
 *   id: string,                       // "20260416-153000-abc"
 *   cartridge: string,
 *   status: "running" | "done" | "failed",
 *   startedAt: ISO, finishedAt: ISO|null,
 *   input: { titles: [{id,title,slug,category}], N, options },
 *   stages: {
 *     shotList:  { status, startedAt, finishedAt, model, elapsedMs, tokensUsed,
 *                  raw: {tid: {shots:[]}}, variance: {tid: {...}},
 *                  systemPromptChars, userPromptChars,
 *                  systemPrompt?, userPrompt?  // kept for "show me the prompt sent to LLM"
 *                },
 *     critic:    { status, enabled, startedAt, finishedAt, model, elapsedMs,
 *                  revised: {tid: {shots:[]}}, diff: {tid: [...]} },
 *     resolved:  { status, startedAt, finishedAt,
 *                  prompts: {tid: [{prompt, composition, subject_phrase, slots_used, theme, ...}]},
 *                  promptVariance: {tid: {distinct, avgDistance}} },
 *     renders:   { status, startedAt, finishedAt,
 *                  items: {tid: [{promptIdx, filename, status, elapsedMs, error?}]} }
 *   },
 *   verdicts: { "<tid>/<filename>": { verdict, reasons, taggedAt } },
 *   error: string|null
 * }
 */
const EVENTS = {
  RUN_STARTED: 'run.started',
  STAGE_STARTED: 'stage.started',
  STAGE_UPDATED: 'stage.updated',
  STAGE_FINISHED: 'stage.finished',
  RENDER_ITEM: 'render.item',
  VERDICT_SET: 'verdict.set',
  RUN_FINISHED: 'run.finished',
  RUN_FAILED: 'run.failed'
};
module.exports = { EVENTS };
```

- [ ] **Step 2: `v2/src/trace/store.js`**

```js
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { EVENTS } = require('./schema');

const TRACE_DIR = path.join(__dirname, '../../data/traces');
if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });

const bus = new EventEmitter();
bus.setMaxListeners(50);

function newRunId() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rnd}`;
}

function tracePath(id) { return path.join(TRACE_DIR, `${id}.json`); }

function writeTrace(trace) {
  fs.writeFileSync(tracePath(trace.id), JSON.stringify(trace, null, 2));
}
function readTrace(id) {
  const p = tracePath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function listTraces() {
  return fs.readdirSync(TRACE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .map(f => {
      const t = JSON.parse(fs.readFileSync(path.join(TRACE_DIR, f), 'utf8'));
      return {
        id: t.id, cartridge: t.cartridge, status: t.status,
        startedAt: t.startedAt, finishedAt: t.finishedAt,
        titleCount: t.input?.titles?.length || 0,
        N: t.input?.N,
        hitRate: computeHitRate(t)
      };
    });
}
function computeHitRate(trace) {
  const verdicts = Object.values(trace.verdicts || {});
  const total = verdicts.length;
  const usable = verdicts.filter(v => v.verdict === 'usable' || v.verdict === 'winner').length;
  return { total, usable, rate: total ? Number((usable / total).toFixed(3)) : null };
}

/**
 * Create a new in-memory trace, register it, emit run.started, and return a handle
 * for the orchestrator to update. Every update persists to disk AND emits an event.
 */
function createTrace({ cartridge, input }) {
  const trace = {
    id: newRunId(),
    cartridge,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    input,
    stages: {
      shotList: { status: 'pending' },
      critic:   { status: 'pending' },
      resolved: { status: 'pending' },
      renders:  { status: 'pending', items: {} }
    },
    verdicts: {},
    error: null
  };
  writeTrace(trace);
  bus.emit(EVENTS.RUN_STARTED, { id: trace.id, trace });
  return {
    id: trace.id,
    get: () => readTrace(trace.id),
    updateStage(name, patch) {
      const t = readTrace(trace.id);
      t.stages[name] = { ...t.stages[name], ...patch };
      writeTrace(t);
      bus.emit(EVENTS.STAGE_UPDATED, { id: trace.id, stage: name, value: t.stages[name] });
    },
    startStage(name, meta = {}) {
      this.updateStage(name, { status: 'running', startedAt: new Date().toISOString(), ...meta });
      bus.emit(EVENTS.STAGE_STARTED, { id: trace.id, stage: name });
    },
    finishStage(name, patch = {}) {
      this.updateStage(name, { status: 'done', finishedAt: new Date().toISOString(), ...patch });
      bus.emit(EVENTS.STAGE_FINISHED, { id: trace.id, stage: name });
    },
    failStage(name, err) {
      this.updateStage(name, { status: 'failed', finishedAt: new Date().toISOString(), error: err?.message || String(err) });
    },
    recordRenderItem(tid, item) {
      const t = readTrace(trace.id);
      t.stages.renders.items[tid] = t.stages.renders.items[tid] || [];
      t.stages.renders.items[tid].push(item);
      writeTrace(t);
      bus.emit(EVENTS.RENDER_ITEM, { id: trace.id, titleId: tid, item });
    },
    setVerdict(tid, filename, verdict, reasons = []) {
      const t = readTrace(trace.id);
      t.verdicts[`${tid}/${filename}`] = { verdict, reasons, taggedAt: new Date().toISOString() };
      writeTrace(t);
      bus.emit(EVENTS.VERDICT_SET, { id: trace.id, key: `${tid}/${filename}`, verdict, reasons });
    },
    finish(patch = {}) {
      const t = readTrace(trace.id);
      Object.assign(t, { status: 'done', finishedAt: new Date().toISOString(), ...patch });
      writeTrace(t);
      bus.emit(EVENTS.RUN_FINISHED, { id: trace.id });
    },
    fail(err) {
      const t = readTrace(trace.id);
      Object.assign(t, { status: 'failed', finishedAt: new Date().toISOString(), error: err?.message || String(err) });
      writeTrace(t);
      bus.emit(EVENTS.RUN_FAILED, { id: trace.id, error: err?.message });
    }
  };
}

module.exports = { bus, createTrace, readTrace, listTraces, computeHitRate, EVENTS };
```

---

## Phase 9 — Orchestrator

### Task 9.1: `v2/src/orchestrator.js`

```js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { loadCartridge } = require('./factory/cartridge');
const { buildShotList, buildRenderPrompts, buildShotListSystemPrompt } = require('./factory/shotList');
const { critiqueShotList } = require('./factory/critic');
const { promptVariance } = require('./factory/variance');
const { renderOne, downloadImage } = require('./render/fal');
const { createTrace } = require('./trace/store');

const OUT_DIR = path.join(__dirname, '../output/generations');

async function runBatch({ cartridgeName = 'nolla', titles, N = 10, critic = true, model, aspectRatio, debug = true }) {
  const cartridge = loadCartridge(cartridgeName);
  const trace = createTrace({
    cartridge: cartridgeName,
    input: { titles, N, options: { critic, model, aspectRatio } }
  });

  try {
    // STAGE 1: shot list
    trace.startStage('shotList');
    const systemPrompt = debug ? buildShotListSystemPrompt(cartridge, N) : null;
    const shotResult = await buildShotList(cartridge, titles, { N });
    trace.finishStage('shotList', {
      model: shotResult.meta.model,
      elapsedMs: shotResult.meta.elapsedMs,
      tokensUsed: shotResult.meta.tokensUsed,
      systemPromptChars: shotResult.meta.systemPromptChars,
      userPromptChars: shotResult.meta.userPromptChars,
      systemPrompt: debug ? systemPrompt : undefined,
      raw: shotResult.raw,
      variance: shotResult.variance
    });

    // STAGE 2: critic
    let shotMap = shotResult.raw;
    if (critic) {
      trace.startStage('critic', { enabled: true });
      try {
        const crit = await critiqueShotList(cartridge, titles, shotMap, { N });
        shotMap = crit.revised;
        trace.finishStage('critic', { model: crit.meta.model, elapsedMs: crit.meta.elapsedMs, revised: crit.revised, diff: crit.diff });
      } catch (e) {
        trace.failStage('critic', e);
      }
    } else {
      trace.updateStage('critic', { status: 'skipped', enabled: false });
    }

    // STAGE 3: resolve prompts
    trace.startStage('resolved');
    const resolved = buildRenderPrompts(cartridge, titles, shotMap, { batchSeed: Date.now() });
    const promptVar = {};
    for (const [tid, arr] of Object.entries(resolved)) {
      promptVar[tid] = promptVariance(arr.map(p => p.prompt));
    }
    trace.finishStage('resolved', { prompts: resolved, promptVariance: promptVar });

    // STAGE 4: render
    trace.startStage('renders');
    for (const title of titles) {
      const titleDir = path.join(OUT_DIR, title.slug);
      if (!fs.existsSync(titleDir)) fs.mkdirSync(titleDir, { recursive: true });
      const shots = resolved[title.id] || [];
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i];
        const filename = `gen-${String(i + 1).padStart(3, '0')}.png`;
        try {
          const img = await renderOne(s.prompt, { model, aspectRatio, references: cartridge.references });
          const buf = await downloadImage(img.url);
          fs.writeFileSync(path.join(titleDir, filename), buf);
          fs.writeFileSync(path.join(titleDir, `${filename}.json`), JSON.stringify({ ...s, model: img.model, generatedAt: new Date().toISOString(), runId: trace.id }, null, 2));
          trace.recordRenderItem(title.id, { promptIdx: i, filename, status: 'ok', elapsedMs: img.elapsedMs, model: img.model });
        } catch (e) {
          trace.recordRenderItem(title.id, { promptIdx: i, filename, status: 'failed', error: e.message });
        }
      }
    }
    trace.finishStage('renders');
    trace.finish();
  } catch (e) {
    trace.fail(e);
    throw e;
  }

  return trace.id;
}

module.exports = { runBatch };
```

---

## Phase 10 — Server (SSE + REST + static UI)

### Task 10.1: `v2/src/server.js`

```js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');
const { runBatch } = require('./orchestrator');
const { loadCartridge } = require('./factory/cartridge');
const { readTrace, listTraces, bus, EVENTS } = require('./trace/store');

const app = express();
app.use(express.json({ limit: '10mb' }));
const PORT = 3002;
const OUT_DIR = path.join(__dirname, '../output/generations');

app.use(express.static(path.join(__dirname, '../ui')));

// ---- REST ----
app.get('/api/cartridges', (req, res) => {
  const dir = path.join(__dirname, '../cartridge');
  res.json({ cartridges: fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isDirectory()) });
});

app.get('/api/cartridges/:name', (req, res) => {
  try {
    const c = loadCartridge(req.params.name);
    // Strip large reference binaries for list display
    res.json({
      name: c.name, profile: c.profile, themes: c.themes,
      compositions: Object.fromEntries(Object.entries(c.compositions).map(([k, v]) => [k, { category: v.category, skeleton: v.skeleton, slots: v.slots, mood: v.mood }])),
      subjects: c.subjects, palette: c.palette, suffix: c.suffix,
      referenceCount: c.references.length,
      categoriesKnown: Object.keys(c.categories)
    });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/api/runs', (req, res) => res.json(listTraces()));
app.get('/api/runs/:id', (req, res) => {
  const t = readTrace(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

app.post('/api/runs', async (req, res) => {
  try {
    const { cartridge = 'nolla', titles = [], N = 10, critic = true, model, aspectRatio } = req.body;
    if (!titles.length) return res.status(400).json({ error: 'titles[] required' });
    // Fire-and-forget; client watches via SSE
    const titlesNormalized = titles.map((t, i) => ({
      id: t.id || `run-${i}`,
      title: t.title,
      slug: t.slug || t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50),
      category: t.category || 'general'
    }));
    const runIdPromise = runBatch({ cartridgeName: cartridge, titles: titlesNormalized, N, critic, model, aspectRatio });
    // runBatch returns the id after finishing; for immediate UI, we grab it synchronously via a side channel
    // Simpler: resolve when it finishes, but the UI connects SSE as soon as run.started fires
    res.json({ status: 'started' });
    runIdPromise.catch(e => console.error('[runBatch]', e));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/runs/:id/verdict', (req, res) => {
  // Load trace, set verdict, persist. Use EventEmitter so SSE clients update.
  const { readTrace: rt } = require('./trace/store');
  const fs2 = require('fs');
  const p = path.join(__dirname, '../data/traces', `${req.params.id}.json`);
  if (!fs2.existsSync(p)) return res.status(404).json({ error: 'not found' });
  const t = rt(req.params.id);
  const { titleId, filename, verdict, reasons = [] } = req.body;
  t.verdicts[`${titleId}/${filename}`] = { verdict, reasons, taggedAt: new Date().toISOString() };
  fs2.writeFileSync(p, JSON.stringify(t, null, 2));
  bus.emit(EVENTS.VERDICT_SET, { id: t.id, key: `${titleId}/${filename}`, verdict, reasons });
  res.json({ ok: true });
});

app.get('/api/images/:slug/:filename', (req, res) => {
  const p = path.join(OUT_DIR, req.params.slug, req.params.filename);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ---- SSE ----
// Clients connect to /api/runs/:id/events (or 'all' for the runs list)
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders();
  const runFilter = req.query.run || null;

  const send = (event, data) => {
    if (runFilter && data.id && data.id !== runFilter) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const handlers = {};
  for (const [k, v] of Object.entries(EVENTS)) {
    handlers[v] = (data) => send(v, data);
    bus.on(v, handlers[v]);
  }
  req.on('close', () => { for (const [v, h] of Object.entries(handlers)) bus.off(v, h); });
});

app.listen(PORT, () => console.log(`v2 live inspector on http://localhost:${PORT}`));
```

---

## Phase 11 — Live Inspector UI

Two pages: **Runs list** (`/`) and **Run detail** (`/run.html?id=…`). Vanilla JS, no build step. Live updates via EventSource.

### Task 11.1: `v2/ui/index.html` (runs list + new-run form)

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Brand Image Blaster — Runs</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header>
    <h1>Brand Image Blaster <span class="version">v2</span></h1>
    <nav><a href="/" class="active">Runs</a></nav>
  </header>

  <main>
    <section class="new-run">
      <h2>New Run</h2>
      <form id="new-run-form">
        <label>Cartridge <select id="cartridge" name="cartridge"></select></label>
        <label>N per title <input type="number" id="N" name="N" value="10" min="1" max="30"></label>
        <label><input type="checkbox" id="critic" name="critic" checked> Run critic pass</label>
        <label>Model
          <select id="model" name="model">
            <option value="fal-ai/nano-banana-pro">nano-banana-pro (fast, refs)</option>
            <option value="fal-ai/flux-pro/v1.1-ultra">flux-1.1-ultra</option>
            <option value="fal-ai/flux-2-pro">flux-2-pro</option>
            <option value="fal-ai/flux-pro/kontext">flux-kontext (refs)</option>
          </select>
        </label>
        <label>Titles (one per line, format: <code>category|title</code>)
          <textarea id="titles" rows="6" placeholder="general|Does creatine cause hair loss&#10;lifestyle-triggers|Can coffee cause acne"></textarea>
        </label>
        <button type="submit">Start Run</button>
      </form>
    </section>

    <section class="runs">
      <h2>Runs</h2>
      <table id="runs-table">
        <thead><tr><th>ID</th><th>Cartridge</th><th>Status</th><th>Titles</th><th>N</th><th>Hit Rate</th><th>Started</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>
  </main>

  <script src="app.js"></script>
  <script>BrandImageBlaster.initRunsPage();</script>
</body>
</html>
```

### Task 11.2: `v2/ui/run.html` (chain inspector)

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Run — Brand Image Blaster</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header>
    <h1>Run <span id="run-id"></span></h1>
    <nav><a href="/">← Runs</a></nav>
  </header>
  <main id="run-detail">
    <section id="overview"></section>
    <section id="stages"></section>
    <section id="titles"></section>
  </main>
  <script src="app.js"></script>
  <script>BrandImageBlaster.initRunDetailPage();</script>
</body>
</html>
```

### Task 11.3: `v2/ui/app.js` (the heart of the inspector)

```js
(function () {
  const API = '/api';

  async function json(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }

  // ---------- RUNS LIST PAGE ----------
  async function initRunsPage() {
    const cartridges = (await json(`${API}/cartridges`)).cartridges;
    const sel = document.getElementById('cartridge');
    cartridges.forEach(c => { const o = document.createElement('option'); o.value = o.textContent = c; sel.appendChild(o); });

    document.getElementById('new-run-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const titlesRaw = f.titles.value.trim().split('\n').filter(Boolean);
      const titles = titlesRaw.map((line, i) => {
        const [cat, ...rest] = line.split('|');
        const title = rest.join('|').trim() || cat.trim();
        const category = rest.length ? cat.trim() : 'general';
        return { id: `t${Date.now()}-${i}`, title, category };
      });
      await json(`${API}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartridge: f.cartridge.value, titles, N: parseInt(f.N.value), critic: f.critic.checked, model: f.model.value
        })
      });
      renderRuns();
    });

    await renderRuns();

    const es = new EventSource(`${API}/events`);
    es.addEventListener('run.started', renderRuns);
    es.addEventListener('run.finished', renderRuns);
    es.addEventListener('run.failed', renderRuns);
    es.addEventListener('stage.finished', renderRuns);
  }

  async function renderRuns() {
    const runs = await json(`${API}/runs`);
    const tbody = document.querySelector('#runs-table tbody');
    tbody.innerHTML = '';
    for (const r of runs) {
      const tr = document.createElement('tr');
      const hr = r.hitRate?.total ? `${(r.hitRate.rate * 100).toFixed(0)}% (${r.hitRate.usable}/${r.hitRate.total})` : '—';
      tr.innerHTML = `
        <td><a href="/run.html?id=${r.id}">${r.id}</a></td>
        <td>${r.cartridge}</td>
        <td class="status-${r.status}">${r.status}</td>
        <td>${r.titleCount}</td>
        <td>${r.N}</td>
        <td>${hr}</td>
        <td>${new Date(r.startedAt).toLocaleString()}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ---------- RUN DETAIL PAGE ----------
  async function initRunDetailPage() {
    const id = new URLSearchParams(location.search).get('id');
    document.getElementById('run-id').textContent = id;

    let trace = await json(`${API}/runs/${id}`);
    render(trace);

    const es = new EventSource(`${API}/events?run=${id}`);
    const refresh = async () => { trace = await json(`${API}/runs/${id}`); render(trace); };
    ['stage.started', 'stage.updated', 'stage.finished', 'render.item', 'verdict.set', 'run.finished', 'run.failed'].forEach(ev => es.addEventListener(ev, refresh));
  }

  function render(trace) {
    renderOverview(trace);
    renderStages(trace);
    renderTitles(trace);
  }

  function renderOverview(trace) {
    const total = Object.values(trace.verdicts || {}).length;
    const usable = Object.values(trace.verdicts || {}).filter(v => v.verdict === 'usable' || v.verdict === 'winner').length;
    const rate = total ? ((usable / total) * 100).toFixed(0) : '—';
    document.getElementById('overview').innerHTML = `
      <div class="overview">
        <div><strong>Cartridge:</strong> ${trace.cartridge}</div>
        <div><strong>Status:</strong> <span class="status-${trace.status}">${trace.status}</span></div>
        <div><strong>Titles:</strong> ${trace.input.titles.length} × N=${trace.input.N}</div>
        <div><strong>Hit rate:</strong> ${rate}${total ? '% (' + usable + '/' + total + ')' : ''}</div>
        <div><strong>Started:</strong> ${new Date(trace.startedAt).toLocaleString()}</div>
      </div>`;
  }

  function renderStages(trace) {
    const s = trace.stages;
    const row = (name, stage) => {
      const elapsed = stage.elapsedMs ? `${stage.elapsedMs} ms` : '';
      const extra =
        name === 'shotList' ? ` · model=${stage.model || ''} · ${stage.tokensUsed ? `${stage.tokensUsed.total_tokens || 0} tokens` : ''}` :
        name === 'critic'   ? `${stage.enabled === false ? ' (skipped)' : ''}` :
        name === 'resolved' ? '' :
        name === 'renders'  ? (() => {
          const items = Object.values(stage.items || {}).flat();
          const ok = items.filter(i => i.status === 'ok').length;
          return ` · ${ok}/${items.length} rendered`;
        })() : '';
      return `<div class="stage stage-${stage.status}"><span class="name">${name}</span><span class="status">${stage.status}</span><span class="meta">${elapsed}${extra}</span></div>`;
    };
    document.getElementById('stages').innerHTML = `
      <h2>Chain</h2>
      <div class="stages">
        ${row('shotList', s.shotList)}
        ${row('critic', s.critic)}
        ${row('resolved', s.resolved)}
        ${row('renders', s.renders)}
      </div>`;
  }

  function renderTitles(trace) {
    const root = document.getElementById('titles');
    root.innerHTML = '<h2>Titles</h2>';
    for (const title of trace.input.titles) {
      root.appendChild(renderTitle(trace, title));
    }
  }

  function renderTitle(trace, title) {
    const wrap = document.createElement('div');
    wrap.className = 'title-card';
    const variance = trace.stages.shotList?.variance?.[title.id];
    const pVar = trace.stages.resolved?.promptVariance?.[title.id];
    const shots = (trace.stages.critic?.status === 'done' ? trace.stages.critic.revised?.[title.id]?.shots : trace.stages.shotList?.raw?.[title.id]?.shots) || [];
    const resolved = trace.stages.resolved?.prompts?.[title.id] || [];
    const renders = trace.stages.renders?.items?.[title.id] || [];
    const diff = trace.stages.critic?.diff?.[title.id] || [];

    wrap.innerHTML = `
      <header>
        <h3>${escapeHtml(title.title)} <small>[${title.category}]</small></h3>
        <div class="variance">
          ${variance ? `Shot variance: <strong>${variance.score}</strong> · ${variance.distinct?.composition}/${variance.total} compositions · ${variance.distinct?.subject_type} subjects · ${variance.distinct?.theme} themes · ${variance.distinct?.model_spec} models` : ''}
          ${pVar ? ` · Prompt jaccard distance: <strong>${pVar.avgDistance}</strong>` : ''}
        </div>
      </header>

      <details open><summary>Stage 1 · Shot list (raw LLM)</summary>
        ${shotsTable(trace.stages.shotList?.raw?.[title.id]?.shots || [])}
      </details>

      <details ${diff.length ? 'open' : ''}><summary>Stage 2 · Critic diff (${diff.length} changes)</summary>
        ${diffTable(diff)}
      </details>

      <details><summary>Stage 3 · Resolved prompts</summary>
        ${resolvedList(resolved)}
      </details>

      <details open><summary>Stage 4 · Renders</summary>
        ${renderGrid(trace, title, resolved, renders)}
      </details>
    `;

    // Bind verdict buttons
    wrap.querySelectorAll('[data-verdict]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await json(`${API}/runs/${trace.id}/verdict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            titleId: title.id, filename: btn.dataset.filename, verdict: btn.dataset.verdict
          })
        });
      });
    });

    return wrap;
  }

  function shotsTable(shots) {
    if (!shots.length) return '<p class="empty">pending…</p>';
    return `<table class="shots"><thead><tr><th>#</th><th>composition</th><th>subject_type</th><th>topic</th><th>theme</th><th>model_spec</th></tr></thead><tbody>${
      shots.map((s, i) => `<tr><td>${i+1}</td><td>${s.composition||''}</td><td>${s.subject_type||''}</td><td>${s.subject_topic||''}</td><td>${s.theme||''}</td><td>${s.model_spec||''}</td></tr>`).join('')
    }</tbody></table>`;
  }

  function diffTable(diff) {
    if (!diff.length) return '<p class="empty">no changes</p>';
    return `<table class="diff"><thead><tr><th>#</th><th>kind</th><th>changed</th><th>before → after</th></tr></thead><tbody>${
      diff.map(d => {
        if (d.kind === 'changed') {
          const changes = (d.keys || []).map(k => `<code>${k}</code>: ${escapeHtml(String(d.before?.[k] ?? ''))} → ${escapeHtml(String(d.after?.[k] ?? ''))}`).join('<br>');
          return `<tr><td>${d.idx+1}</td><td>changed</td><td>${(d.keys||[]).join(', ')}</td><td>${changes}</td></tr>`;
        }
        return `<tr><td>${d.idx+1}</td><td>${d.kind}</td><td></td><td>${escapeHtml(JSON.stringify(d.before || d.after))}</td></tr>`;
      }).join('')
    }</tbody></table>`;
  }

  function resolvedList(resolved) {
    if (!resolved.length) return '<p class="empty">pending…</p>';
    return `<ol class="resolved">${resolved.map(r => `
      <li>
        <div class="prompt">${highlightSlots(r)}</div>
        <div class="meta">
          <code>${r.composition}</code> · <code>${r.subject_phrase}</code> · <code>${r.theme}</code> · ${r.camera} · ${r.lens}
        </div>
      </li>`).join('')}</ol>`;
  }

  function highlightSlots(r) {
    let p = escapeHtml(r.prompt);
    // Highlight the subject phrase and any slot values
    if (r.subject_phrase) p = p.replace(escapeHtml(r.subject_phrase), `<mark class="subj">${escapeHtml(r.subject_phrase)}</mark>`);
    for (const v of Object.values(r.slots_used || {})) {
      if (!v) continue;
      const esc = escapeHtml(v);
      p = p.replace(esc, `<mark class="slot">${esc}</mark>`);
    }
    return p;
  }

  function renderGrid(trace, title, resolved, renders) {
    if (!renders.length) return '<p class="empty">pending…</p>';
    return `<div class="grid">${renders.map(r => {
      const prompt = resolved[r.promptIdx];
      const vkey = `${title.id}/${r.filename}`;
      const v = trace.verdicts?.[vkey]?.verdict;
      const imgUrl = `${API}/images/${encodeURIComponent(title.slug)}/${encodeURIComponent(r.filename)}`;
      if (r.status !== 'ok') return `<div class="tile failed"><div>${r.filename}</div><div class="error">${escapeHtml(r.error || '')}</div></div>`;
      return `
        <div class="tile verdict-${v || 'none'}">
          <img src="${imgUrl}" alt="${r.filename}" loading="lazy">
          <div class="tile-prompt">${prompt ? escapeHtml(prompt.prompt.slice(0, 140)) + '…' : ''}</div>
          <div class="verdict-buttons">
            <button data-verdict="usable"      data-filename="${r.filename}">✓ usable</button>
            <button data-verdict="not-usable"  data-filename="${r.filename}">✗ reject</button>
            <button data-verdict="winner"      data-filename="${r.filename}">★ winner</button>
          </div>
        </div>`;
    }).join('')}</div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }

  window.BrandImageBlaster = { initRunsPage, initRunDetailPage };
})();
```

### Task 11.4: `v2/ui/styles.css`

```css
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f6f4ef; color: #2b2a27; }
header { padding: 1rem 1.5rem; background: #2b2a27; color: #f6f4ef; display: flex; align-items: center; gap: 2rem; }
header h1 { margin: 0; font-size: 1.1rem; font-weight: 600; }
header .version { opacity: 0.6; font-size: 0.8rem; }
header nav a { color: #d4c5a9; text-decoration: none; margin-right: 1rem; }
header nav a.active { color: #fff; }
main { padding: 1.5rem; max-width: 1400px; margin: 0 auto; }
h2 { font-size: 1rem; margin-top: 2rem; }
form label { display: block; margin-bottom: 0.5rem; font-size: 0.9rem; }
form input, form select, form textarea { padding: 0.4rem; font-family: inherit; }
form textarea { width: 100%; font-family: monospace; font-size: 0.85rem; }
form button { padding: 0.5rem 1rem; background: #2b2a27; color: #fff; border: 0; cursor: pointer; }
.new-run { background: #fff; padding: 1rem; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
table { width: 100%; border-collapse: collapse; background: #fff; margin-top: 0.5rem; }
th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #eee; font-size: 0.9rem; }
.status-running { color: #c4917a; }
.status-done { color: #9aaa91; }
.status-failed { color: #c46b6b; }
.overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; background: #fff; padding: 1rem; border-radius: 6px; }
.stages { display: flex; gap: 0.5rem; margin: 0.5rem 0 1.5rem; }
.stage { flex: 1; padding: 0.75rem; background: #fff; border-left: 4px solid #ddd; font-size: 0.85rem; }
.stage-running { border-left-color: #c4917a; }
.stage-done { border-left-color: #9aaa91; }
.stage-failed { border-left-color: #c46b6b; }
.stage-pending { border-left-color: #ddd; opacity: 0.6; }
.stage .name { font-weight: 600; margin-right: 0.5rem; }
.stage .meta { color: #888; }
.title-card { background: #fff; margin-bottom: 1.5rem; padding: 1rem; border-radius: 6px; }
.title-card header { background: none; color: inherit; padding: 0; display: block; margin-bottom: 0.5rem; }
.title-card h3 { margin: 0; font-size: 1rem; }
.variance { font-size: 0.85rem; color: #555; margin-top: 0.25rem; }
details { margin-top: 0.75rem; }
details summary { cursor: pointer; font-weight: 600; font-size: 0.9rem; }
.shots, .diff { font-size: 0.8rem; margin-top: 0.5rem; }
.shots th, .diff th { background: #f6f4ef; }
.resolved { list-style: decimal; padding-left: 1.5rem; }
.resolved li { margin-bottom: 0.75rem; font-size: 0.85rem; }
.resolved .prompt { line-height: 1.4; }
.resolved .meta { color: #888; font-size: 0.75rem; margin-top: 0.25rem; }
mark.subj { background: #ffe8d6; padding: 0 2px; }
mark.slot { background: #e6f0e1; padding: 0 2px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.75rem; margin-top: 0.5rem; }
.tile { background: #fafafa; border: 2px solid transparent; border-radius: 4px; overflow: hidden; }
.tile img { width: 100%; display: block; aspect-ratio: 16/9; object-fit: cover; }
.tile-prompt { padding: 0.4rem; font-size: 0.75rem; color: #666; min-height: 3em; }
.verdict-buttons { display: flex; padding: 0.25rem; gap: 0.25rem; }
.verdict-buttons button { flex: 1; font-size: 0.75rem; padding: 0.25rem; cursor: pointer; background: #eee; border: 0; }
.tile.verdict-usable { border-color: #9aaa91; }
.tile.verdict-not-usable { border-color: #c46b6b; opacity: 0.5; }
.tile.verdict-winner { border-color: #c4917a; box-shadow: 0 0 0 2px #c4917a33; }
.tile.failed { padding: 0.5rem; color: #c46b6b; font-size: 0.8rem; }
.empty { color: #999; font-style: italic; font-size: 0.85rem; }
code { background: #f0ece2; padding: 1px 4px; border-radius: 2px; font-size: 0.8em; }
```

---

## Phase 12 — Integration test (the 70/100 test)

### Task 12.1: First real batch via UI

- [ ] **Step 1: Start server**

```bash
cd v2 && node src/server.js
```

- [ ] **Step 2: Open `http://localhost:3002`**, submit a batch of 3 titles × N=10:

```
general|Does creatine cause hair loss
lifestyle-triggers|Can coffee cause acne
skincare-basics|Does retinol help with acne
```

- [ ] **Step 3: Click into the run and watch it fill in live.**

- [ ] **Step 4: After renders finish, tag every image `usable`, `not-usable`, or `winner`.** Watch the hit-rate in the overview climb toward (hopefully) 70%.

- [ ] **Step 5: Drop the measured hit rate into `learnings.md`** under `## Update log`, plus which compositions / subjects / themes over-indexed. This closes the feedback loop and informs the next cartridge revision.

- [ ] **Step 6: Commit everything**

```bash
git add v2/
git commit -m "v2: parallel codebase with live chain inspector"
```

---

## Out of scope (deferred)

- **Auto-Judge (VLM scoring)** — once manual hit-rate data says what "usable" means, add a VLM critic that pre-scores so the human only tags edge cases.
- **Perceptual-hash dedup** — cheap to add; skip until we see near-dup pairs in production.
- **Multi-brand onboarding UI** — currently swap `cartridge/` folders by hand.
- **v1 migration** — v1 stays. Port when v2 hit rate beats v1 for 3 consecutive batches.
- **Re-roll single shots from the UI** — quality-of-life; skip until the core loop is proven.

---

## Notes on executing this plan

- Phases 1–2 are prerequisites for everything else. Phases 3–4–5 can be developed against the fake-LLM test before you spend OpenRouter tokens.
- Phase 8 (Trace Store) is the single most important piece of infrastructure. If you skip it, you lose the ability to answer "where in the chain did variance die?" — which is the whole point.
- Phase 11 (UI) can be built incrementally: runs-list first, then run-detail stage bars, then title cards. Each slice is usable on its own.
