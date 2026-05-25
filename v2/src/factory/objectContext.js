// objectContext.js
//
// One Haiku call per BATCH that classifies each input title's object into a
// generalized spatial/contextual schema. The result is cached on the trace
// (`trace.input.objectContext[titleId]`) so:
//   - The in-situ prompt can inject hard facts about mounting / scale /
//     orientation, instead of letting the model hallucinate placement.
//   - Promote (parent → next stage) reads the parent trace and keeps using
//     the cached classification — no re-classify cost.
//
// Schema (intentionally generalized — works for toothbrush → bed → lamp):
//   {
//     object_kind: "lamp",
//     form_factor: "wall-mounted articulated arm",
//     scale: "human",                      // hand | desk | human | room
//     occupies: "wall-vertical",           // free-standing | wall-vertical |
//                                          // ceiling-hung | surface-rest |
//                                          // floor-rest | hand-held |
//                                          // body-worn | embedded
//     use_height: "task",                  // floor | knee | hip | torso |
//                                          // task | eye | overhead
//     orientation: "extends horizontally from a wall plate",
//     activity: "directional task lighting",
//     natural_environments: ["interior corridor", "courtyard", "atelier"]
//   }

const SYSTEM = `You classify physical objects for a product-rendering pipeline.

For each input title, return a single JSON object with these fields:

- object_kind (string): the noun for the object (e.g. "lamp", "toothbrush", "bed").
- form_factor (string, ≤80 chars): one short phrase describing its physical type.
- scale: exactly one of "hand" | "desk" | "human" | "room".
- occupies: exactly one of "free-standing" | "wall-vertical" | "ceiling-hung" | "surface-rest" | "floor-rest" | "hand-held" | "body-worn" | "embedded".
- use_height: exactly one of "floor" | "knee" | "hip" | "torso" | "task" | "eye" | "overhead".
- orientation (string, ≤80 chars): how the object sits in space (e.g. "extends horizontally from wall plate", "rests flat on a horizontal surface", "hangs from a single cable").
- activity (string, ≤60 chars): the primary use ("task lighting", "tooth cleaning", "sleeping").
- natural_environments (array of 3 strings, ≤30 chars each): typical rooms/settings where this object lives.

Rules:
- Pick the most accurate values for the actual object described — be literal, not creative.
- For ambiguous titles, infer the most common form (a "lamp" without qualifiers = floor lamp).
- Wall-mounted / ceiling-hung / hand-held are mutually exclusive — pick the dominant mode.

Output: ONE JSON object per title, in the same order, separated by newlines. No prose, no markdown, no backticks.`;

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
  scale: new Set(['hand', 'desk', 'human', 'room']),
  occupies: new Set(['free-standing', 'wall-vertical', 'ceiling-hung', 'surface-rest', 'floor-rest', 'hand-held', 'body-worn', 'embedded']),
  use_height: new Set(['floor', 'knee', 'hip', 'torso', 'task', 'eye', 'overhead'])
};

function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {
    object_kind: String(obj.object_kind || '').slice(0, 60).trim(),
    form_factor: String(obj.form_factor || '').slice(0, 100).trim(),
    scale: ALLOWED.scale.has(obj.scale) ? obj.scale : 'human',
    occupies: ALLOWED.occupies.has(obj.occupies) ? obj.occupies : 'free-standing',
    use_height: ALLOWED.use_height.has(obj.use_height) ? obj.use_height : 'task',
    orientation: String(obj.orientation || '').slice(0, 100).trim(),
    activity: String(obj.activity || '').slice(0, 80).trim(),
    natural_environments: Array.isArray(obj.natural_environments)
      ? obj.natural_environments.slice(0, 5).map(s => String(s).slice(0, 40).trim()).filter(Boolean)
      : []
  };
  if (!out.object_kind) return null;
  return out;
}

// Inject classification facts into a scene prompt. Used by the in-situ stage
// so the model gets hard facts about object placement before it freestyles
// the scene.
function objectContextPrefix(ctx) {
  if (!ctx) return '';
  const env = ctx.natural_environments?.length ? ctx.natural_environments.slice(0, 3).join(', ') : '';
  // Descriptive facts only — no MUST-NOT prose, no failure-mode-specific
  // patches. Hand the model the structured truth about the object and
  // trust the cartridge's slot vocabulary + user-supplied refs to do the
  // rest. Specific failure modes (e.g. holding pose on wall-mounts) are
  // signals to rebalance the cartridge, not to add prompt branches here.
  const parts = [
    `The object is a ${ctx.object_kind || 'object'} (${ctx.form_factor || 'standard form'}).`,
    `It naturally occupies ${ctx.occupies} space at ${ctx.use_height} height; scale: ${ctx.scale}.`,
    ctx.orientation ? `Orientation: ${ctx.orientation}.` : '',
    env ? `It belongs in environments like: ${env}.` : '',
    `Place it accordingly — preserve its natural mounting and use-height.`
  ].filter(Boolean);
  return parts.join(' ');
}

async function classifyObjects(titles, { model = 'anthropic/claude-haiku-4.5' } = {}) {
  if (!Array.isArray(titles) || !titles.length) return {};
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('[objectContext] OPENROUTER_API_KEY not set — skipping classification');
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
        'X-Title': 'Recast Object Context'
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
    console.warn('[objectContext] fetch failed:', e.message);
    return {};
  }
  if (!response.ok) {
    console.warn('[objectContext] OpenRouter', response.status, await response.text().catch(() => ''));
    return {};
  }
  const result = await response.json().catch(() => null);
  const content = result?.choices?.[0]?.message?.content;
  if (!content) return {};
  const parsed = parseJsonLines(content);
  // Map back to title IDs by position. The LLM returns one JSON per title in
  // the same order we asked. If counts mismatch we still salvage what we can.
  const out = {};
  for (let i = 0; i < titles.length; i++) {
    const ctx = sanitize(parsed[i]);
    if (ctx) out[titles[i].id] = ctx;
  }
  return out;
}

module.exports = { classifyObjects, objectContextPrefix };
