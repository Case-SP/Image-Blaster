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

  const halfUp = Math.ceil(N / 2);
  const halfDown = Math.floor(N / 2);
  const minSubjects = Math.min(3, N);
  const minCompositions = Math.min(5, N);
  const minCameras = Math.min(3, N);

  return `You are the shot-list generator for ${cartridge.profile.brand_name}.

# BRAND DNA
${cartridge.profile.brand_dna ? `Visual signature: ${cartridge.profile.brand_dna.visual_signature}
Mandatory: ${cartridge.profile.brand_dna.mandatory_elements}
FORBIDDEN: ${cartridge.profile.brand_dna.forbidden}` : ''}

# STUDIO RULES
${cartridge.studioRules || '(none)'}

# GUARDRAILS
${cartridge.guardrails || '(none)'}

# HOW TO THINK (follow this order — do not skip)

## STEP 1 — Extract physical subjects from the title

Before picking any shots, examine the title and list every noun that refers to a physical object, substance, device, ingredient, product, food, or material. These are things you could photograph on their own. Body parts (hair, skin, face) are NOT physical subjects — they go with person shots.

Examples:
- "Does Creatine Cause Hair Loss?" → PHYSICAL: creatine powder, capsule. (not hair — that's a body part)
- "Does Ozempic Cause Hair Loss?" → PHYSICAL: injection pen (device), pill pack.
- "Does Wearing a Hat Cause Hair Loss?" → PHYSICAL: hat, hair strand.
- "Can Mold Cause Acne?" → PHYSICAL: mold spores (macro), humid surface texture.
- "How to Quit Smoking" → PHYSICAL: cigarette, ashtray, lighter, nicotine patch.
- "Does Humidity Cause Acne?" → PHYSICAL: water droplets, condensation, steam.
- "Does Retinol Help with Acne?" → PHYSICAL: retinol bottle, serum, pipette.
- "What Causes Cold Sores?" → PHYSICAL: (none specific — skin/lips only).
- "Vitamin D Deficiency" → PHYSICAL: vitamin capsule, sunlight.

## STEP 1b — Extract body region from the title

If the title mentions a specific body region, note it. This becomes the subject_topic for skin-close or beauty shots so the image actually shows that body part.

Recognized regions: back, jawline (also "jaw"), forehead, chin, cheek, neck, chest (also "décolletage"), shoulder, temple, hairline, under-eye, hormonal.

Examples:
- "What Causes Back Acne?" → BODY_REGION: back
- "What Causes Jawline Acne?" → BODY_REGION: jawline
- "How to Reduce Forehead Wrinkles" → BODY_REGION: forehead
- "When Does Hormonal Acne Stop?" → BODY_REGION: hormonal (use chin/jawline-style crops)
- "Does Chocolate Cause Acne?" → BODY_REGION: (none — whole face is fine)

When body_region is set AND a shot uses subject_type = "skin-close" (or a beauty composition like portrait-profile), set the shot's subject_topic to that region. This makes the render actually show the correct body part instead of a generic pretty face.

## STEP 2 — Apply HARD distribution rules (these are rules, not goals)

Given N=${N} shots per title:

**If the title has AT LEAST ONE physical subject from Step 1:**
- AT LEAST ${halfUp} shots MUST use NON-PERSON subject_types (powder, liquid, food, device, skincare-bottle, skincare-cream, skincare-tube, supplement-pill).
- Person shots cannot exceed ${halfDown}.
- For the non-person shots, use the physical subject from Step 1 as subject_topic.

**If the title has NO physical subject (pure condition/concept):**
- Person shots are allowed up to N, BUT you must include AT LEAST 1 skin-close shot and AT LEAST 1 macro-ish composition (macro-texture, fragment-crop, macro-pores, texture-dewy).

**In ALL cases:**
- Use AT LEAST ${minSubjects} distinct subject_types across the ${N} shots.
- Use AT LEAST ${minCompositions} distinct compositions.
- Use AT LEAST ${minCameras} distinct cameras (drawn from ECU/CU/MCU/MS/WS/overhead — you don't specify camera directly, but your chosen compositions must span at least this many).
- Person shots: model_spec MUST vary — different ethnicity AND gender combinations across shots.
- Include at least 1 "hybrid" shot when the title suggests skincare/beauty: a person with visible applied product (compositions: apply-product-visible, applying-touch, beauty-product-cheek) where subject_type is person-beauty but subject_topic names the product.

## STEP 3 — Output the shots

Each shot: { composition, subject_type, subject_topic, theme, model_spec (or null) }

- composition: MUST be EXACTLY one of the composition names listed below. Never invent.
- subject_type: MUST be EXACTLY one of these 11 values: powder, liquid, food, device, skincare-bottle, skincare-cream, skincare-tube, supplement-pill, person-beauty, person-lifestyle, skin-close. NEVER output "product" — that's a category label, not a subject_type. NEVER invent a new subject_type.
- subject_topic: the specific keyword from the title ("creatine", "ozempic", etc.) OR "default"
- theme: MUST be one of the theme names below. Vary across shots.
- model_spec: for person shots, "ethnicity gender" string (e.g. "Black woman"). null for non-person.

# COMPOSITIONS
${compList}

# SUBJECTS (topics = phrase-bank keys)
${subjList}

# THEMES
${themes}

# OUTPUT (strict JSON — include subjects_identified and body_region for trace)
{
  "<titleId>": {
    "subjects_identified": ["creatine powder", "capsule"],
    "body_region": "back",
    "shots": [{"composition":"...","subject_type":"...","subject_topic":"...","theme":"...","model_spec":null}, ...]
  }
}

No markdown, no explanation. Just the JSON.`;
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

// Body-region topics (extend when cartridge adds more).
const BODY_REGIONS = new Set([
  'back', 'jawline', 'jaw', 'chin', 'forehead', 'cheek', 'neck',
  'chest', 'decolletage', 'shoulder', 'temple', 'hairline', 'under-eye', 'hormonal'
]);

// When subject_topic is a body region, force the composition's area/crop/fragment
// slot to that region. Without this, a composition like `fragment-crop` would
// randomly pick 'lips and chin' even when the title asks for 'back'.
function bodyRegionSlotOverrides(topic) {
  if (!BODY_REGIONS.has(topic)) return null;
  return { area: topic, crop: topic, fragment: topic };
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

  const slotOverrides = bodyRegionSlotOverrides(topic);

  const built = buildPrompt({ composition, subject, seed, suffix: cartridge.suffix, themeSuffix, modelSpec, slotOverrides });
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
      try {
        return resolveShot(cartridge, shot, seed);
      } catch (e) {
        return { __error: e.message, original: shot, composition: shot.composition, subject_type: shot.subject_type, subject_topic: shot.subject_topic, theme: shot.theme };
      }
    });
  }
  return out;
}

// Subject → composition-category mapping used by the sanitizer
const SUBJECT_CATEGORY = {
  'powder': 'product', 'liquid': 'product', 'food': 'product', 'device': 'product',
  'skincare-bottle': 'product', 'skincare-cream': 'product', 'skincare-tube': 'product', 'supplement-pill': 'product',
  'person-beauty': 'beauty', 'person-lifestyle': 'lifestyle', 'skin-close': 'skin'
};
const VALID_SUBJECTS = Object.keys(SUBJECT_CATEGORY);

/**
 * Walk every shot, replace invalid compositions/subjects/themes with valid picks
 * from the appropriate category. Returns { sanitized, substitutions: [{titleId, shotIdx, field, before, after, reason}] }.
 * Never throws — even unrecognizable input becomes a valid shot via defaults.
 */
// Compositions that are fundamentally face-centric — their skeleton describes a
// face touch/close-up that cannot render non-face body regions even with slot
// overrides. When a shot pairs one of these with a non-face body region topic,
// the sanitizer swaps the composition for a body-region-friendly alternative.
const FACE_ONLY_COMPOSITIONS = new Set([
  'apply-product-visible',  // "finger pressing on {area}" — area options are all face
  'applying-touch',         // same shape
  'portrait-direct', 'portrait-profile', 'gaze-intense',
  'serene-eyes-closed', 'mirror-reflection', 'natural-candid'
]);
const NON_FACE_REGIONS = new Set(['back', 'shoulder', 'chest', 'decolletage']);
// Compositions that accept any body region (their skeleton wraps the subject phrase
// generically, so the subject phrase + area override land the region correctly).
const REGION_FRIENDLY = ['texture-dewy', 'macro-pores', 'macro-surface', 'fragment-crop'];

function sanitizeShotMap(cartridge, shotMap) {
  const compNames = Object.keys(cartridge.compositions);
  const themeNames = Object.keys(cartridge.themes);
  const byCategory = {};
  for (const [name, def] of Object.entries(cartridge.compositions)) {
    const cat = def.category || 'product';
    (byCategory[cat] = byCategory[cat] || []).push(name);
  }
  const pickByCategory = (cat, seed) => {
    const list = byCategory[cat] || compNames;
    return list[Math.abs(seed) % list.length];
  };
  const pickRegionFriendly = (seed) => {
    const available = REGION_FRIENDLY.filter(n => cartridge.compositions[n]);
    return available[Math.abs(seed) % available.length] || REGION_FRIENDLY[0];
  };

  const substitutions = [];
  const sanitized = {};
  let seedCounter = 0;

  for (const [tid, sel] of Object.entries(shotMap)) {
    const shots = (sel?.shots || []).map((s, idx) => {
      const out = { ...s };

      // subject_type
      if (!VALID_SUBJECTS.includes(out.subject_type)) {
        const before = out.subject_type;
        out.subject_type = 'person-beauty';
        substitutions.push({ titleId: tid, shotIdx: idx, field: 'subject_type', before, after: out.subject_type, reason: 'invalid' });
      }

      // composition (must exist AND match subject category)
      const subjCat = SUBJECT_CATEGORY[out.subject_type];
      const compDef = cartridge.compositions[out.composition];
      if (!compDef) {
        const before = out.composition;
        out.composition = pickByCategory(subjCat, ++seedCounter);
        substitutions.push({ titleId: tid, shotIdx: idx, field: 'composition', before, after: out.composition, reason: 'unknown composition' });
      } else if (compDef.category !== subjCat) {
        const before = out.composition;
        out.composition = pickByCategory(subjCat, ++seedCounter);
        substitutions.push({ titleId: tid, shotIdx: idx, field: 'composition', before, after: out.composition, reason: `category mismatch (${compDef.category} vs ${subjCat})` });
      }

      // theme
      if (out.theme && !themeNames.includes(out.theme)) {
        const before = out.theme;
        out.theme = themeNames[(++seedCounter) % themeNames.length];
        substitutions.push({ titleId: tid, shotIdx: idx, field: 'theme', before, after: out.theme, reason: 'invalid' });
      }

      // subject_topic: fall back to 'default' if phrase bank missing
      const subjDef = cartridge.subjects[out.subject_type];
      if (subjDef && out.subject_topic && !subjDef.phrase_banks?.[out.subject_topic]) {
        // Don't substitute silently — resolveShot already falls back to 'default' bank
      }

      // Body-region incompatibility: swap face-only compositions when the topic
      // targets a non-face region (back, shoulder, chest, decolletage). Without
      // this the shot renders e.g. "cream on under-eye" for a back-acne title.
      if (NON_FACE_REGIONS.has(out.subject_topic) && FACE_ONLY_COMPOSITIONS.has(out.composition)) {
        const before = out.composition;
        out.composition = pickRegionFriendly(++seedCounter);
        substitutions.push({
          titleId: tid, shotIdx: idx, field: 'composition', before, after: out.composition,
          reason: `face-only composition incompatible with body region '${out.subject_topic}'`
        });
      }

      return out;
    });
    sanitized[tid] = { ...sel, shots };
  }

  return { sanitized, substitutions };
}

module.exports = { buildShotList, buildShotListSystemPrompt, buildRenderPrompts, resolveShot, sanitizeShotMap };
