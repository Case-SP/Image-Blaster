const { shotListDiff } = require('./variance');

async function critiqueShotList(cartridge, titles, shotMap, { model = 'anthropic/claude-3-haiku', N = 10 } = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');

  const halfUp = Math.ceil(N / 2);
  const halfDown = Math.floor(N / 2);
  const system = `You are the critic for ${cartridge.profile.brand_name} shot lists. Enforce HARD rules on the batch.

REJECT AND FIX any of these violations:

1. **Person/product balance.** If the title mentions any physical object/substance/device/food (creatine, ozempic, retinol, hat, cigarette, coffee, etc.), AT LEAST ${halfUp} of the ${N} shots MUST use a NON-person subject_type (powder, liquid, food, device, skincare-bottle, skincare-cream, skincare-tube, supplement-pill). Person shots must not exceed ${halfDown}. If violated, convert person shots to non-person using the relevant product/substance.

2. **Composition diversity.** Each title must use at least ${Math.min(5, N)} distinct compositions. No composition more than twice. Prefer variety: mix beauty/product/skin/lifestyle categories.

3. **Subject type diversity.** Each title must use at least ${Math.min(3, N)} distinct subject_types.

4. **Model diversity.** Person shots in a title must have varying model_spec (different ethnicity AND gender across shots). If all person shots share one look, fix it.

5. **Subject topic specificity.** For non-person shots, subject_topic should match the actual product/substance from the title (e.g. "creatine", "ozempic", "retinol") — not "default" when a specific option exists.

6. **FORBIDDEN:** ${cartridge.profile.brand_dna?.forbidden || '(none)'}

7. **Valid names only.** subject_type MUST be exactly one of: powder, liquid, food, device, skincare-bottle, skincare-cream, skincare-tube, supplement-pill, person-beauty, person-lifestyle, skin-close. "product" is NOT valid (it's a category label, not a subject_type). composition and theme names must match the libraries exactly.

Return the REVISED shot list JSON, same shape as input. No markdown, no explanation.

Valid options:
COMPOSITIONS: ${Object.keys(cartridge.compositions).join(', ')}
SUBJECTS (use these EXACT names): ${Object.keys(cartridge.subjects).join(', ')}
THEMES: ${Object.keys(cartridge.themes).join(', ')}`;

  const t0 = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3002',
      'X-Title': 'Brand Image Blaster v2 Critic'
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
