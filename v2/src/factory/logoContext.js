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
//     formality: "casual",
//     // --- aesthetic brief (Register Router) ---
//     registers: ["mid-century","y2k","brutalist-poster"],  // 2-4, ∈ profile.styles, primary = [0]
//     palette_policy: "mono" | "muted-brand-color" | "one-saturated-field",
//     mark_bias: "abstract" | "pictographic" | "letterform" | "system",
//     render_treatment: "flat" | "dimensional" | "material-expressive"
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
- registers (array of 2-4 strings): the brand-appropriate aesthetic registers, MOST-fitting first. Each MUST be one of: "mid-century" | "swiss-modern" | "art-deco" | "bauhaus" | "post-modern" | "contemporary-minimal" | "y2k" | "utilitarian-industrial" | "vernacular-handmade" | "brutalist-poster" | "art-nouveau" | "victorian-engraved". Choose registers that genuinely suit the brand's posture and era — a record label might be ["mid-century","y2k","brutalist-poster"]; a law firm ["swiss-modern","contemporary-minimal","victorian-engraved"]. Pick a REAL spread of distinct worlds, not three near-synonyms.
- palette_policy: exactly one of "mono" (black/white only) | "muted-brand-color" (one restrained brand hue) | "one-saturated-field" (a single bold saturated ground, e.g. institutional). Default to "mono" for austere/scholarly/clinical brands.
- mark_bias: exactly one of "abstract" | "pictographic" | "letterform" | "system".
- render_treatment: exactly one of "flat" | "dimensional" | "material-expressive". Reserve "material-expressive" for luxury/fashion/experimental brands; default "flat".

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

// Register Router: the full 12-key aesthetic register set. Confirmed in the
// Task 0 audit (2026-05-25) to exactly match v2/cartridge/logos/profile.json
// `styles` keys. `era` above only lists 9 of these; `registers` draws from all 12.
const STYLE_KEYS = new Set([
  'mid-century', 'swiss-modern', 'art-deco', 'bauhaus', 'post-modern', 'contemporary-minimal',
  'y2k', 'utilitarian-industrial', 'vernacular-handmade', 'brutalist-poster', 'art-nouveau', 'victorian-engraved'
]);
ALLOWED.palette_policy = new Set(['mono', 'muted-brand-color', 'one-saturated-field']);
ALLOWED.mark_bias = new Set(['abstract', 'pictographic', 'letterform', 'system']);
ALLOWED.render_treatment = new Set(['flat', 'dimensional', 'material-expressive']);

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
  // --- aesthetic brief (Register Router): validate + clamp. Independent of the
  // existing prefix fields above; logoContextPrefix is unchanged. ---
  let registers = Array.isArray(obj.registers) ? obj.registers.filter(r => STYLE_KEYS.has(r)) : [];
  registers = [...new Set(registers)].slice(0, 4);
  if (registers.length < 2) {
    for (const fb of [out.era, 'contemporary-minimal', 'swiss-modern']) {
      if (STYLE_KEYS.has(fb) && !registers.includes(fb)) registers.push(fb);
      if (registers.length >= 2) break;
    }
  }
  out.registers = registers;
  out.palette_policy = ALLOWED.palette_policy.has(obj.palette_policy) ? obj.palette_policy : 'mono';
  out.mark_bias = ALLOWED.mark_bias.has(obj.mark_bias) ? obj.mark_bias : 'abstract';
  out.render_treatment = ALLOWED.render_treatment.has(obj.render_treatment) ? obj.render_treatment : 'flat';
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
        max_tokens: 320 * titles.length + 240,
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
