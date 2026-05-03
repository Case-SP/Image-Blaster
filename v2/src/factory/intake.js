// Intake stage — used by cartridges where profile.input_mode === 'intake'.
//
// Takes one free-text input (sentence, brief, paragraph, list) plus the
// cartridge's intake prompt (cartridge.intakePrompt) and returns six panel
// phrases. Those phrases get spliced into the cartridge's single composition
// as slot_overrides so each shot becomes a fully-described 6-panel grid.
//
// Replaces the shotList stage for intake-mode cartridges. The critic and
// gpt-2 rewriter stages are skipped for intake mode (the cartridge has only
// one composition + theme; there's nothing to critique, and a 9-move candid-
// photo rewrite would mangle the grid prompt).

function fillBrandPlaceholders(template, profile, runtime = {}) {
  const dna = profile.brand_dna || {};
  const recent = (runtime.recentlyUsedAxes && runtime.recentlyUsedAxes.length)
    ? runtime.recentlyUsedAxes.join(', ')
    : '(none yet — this is the first contact sheet of the run)';
  return template
    .replace(/\{\{brand_name\}\}/g, profile.brand_name || '(unnamed)')
    .replace(/\{\{visual_signature\}\}/g, dna.visual_signature || '(none)')
    .replace(/\{\{mandatory_elements\}\}/g, dna.mandatory_elements || '(none)')
    .replace(/\{\{forbidden\}\}/g, dna.forbidden || '(none)')
    .replace(/\{\{recently_used_axes\}\}/g, recent);
}

function cleanJson(raw) {
  let s = String(raw || '').trim();
  const md = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (md) s = md[1];
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s.replace(/,(\s*[}\]])/g, '$1').trim();
}

async function runIntake({ cartridge, input, model = 'anthropic/claude-sonnet-4.5', temperature = 0.85, recentlyUsedAxes = [] } = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  if (!input || typeof input !== 'string') throw new Error('input (string) required');
  if (!cartridge?.intakePrompt) throw new Error(`cartridge "${cartridge?.name}" has no intake.md`);

  const systemPrompt = fillBrandPlaceholders(cartridge.intakePrompt, cartridge.profile || {}, { recentlyUsedAxes });

  const t0 = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3002',
      'X-Title': 'Recast Intake'
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      temperature, // higher than shotList — different intake calls on the same input should diverge
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input }
      ]
    })
  });
  if (!response.ok) throw new Error(`Intake ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const result = await response.json();
  const content = result.choices?.[0]?.message?.content || '';

  let parsed;
  try { parsed = JSON.parse(cleanJson(content)); }
  catch (e) { throw new Error(`Intake JSON parse failed: ${e.message}. Head: ${content.slice(0, 200)}`); }

  const panels = Array.isArray(parsed.panels) ? parsed.panels : null;
  if (!panels || panels.length !== 6 || panels.some(p => typeof p !== 'string' || !p.trim())) {
    throw new Error(`Intake output invalid: expected { panels: string[6] }, got ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  // axes_used is optional but strongly preferred — drives rotation. If the LLM
  // omits it, rotation degrades to "spread axes randomly across runs."
  const axesUsed = Array.isArray(parsed.axes_used)
    ? parsed.axes_used.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim())
    : [];

  return {
    panels: panels.map(p => p.trim()),
    axesUsed,
    meta: {
      model,
      elapsedMs: Date.now() - t0,
      systemPromptChars: systemPrompt.length,
      inputChars: input.length,
      tokensUsed: result.usage
    }
  };
}

module.exports = { runIntake };
