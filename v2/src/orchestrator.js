require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { loadCartridge } = require('./factory/cartridge');
const { buildShotList, buildRenderPrompts, buildShotListSystemPrompt, sanitizeShotMap } = require('./factory/shotList');
const { critiqueShotList } = require('./factory/critic');
const { promptVariance } = require('./factory/variance');
const { rewriteForGpt2 } = require('./factory/gpt2Rewriter');
const { renderOne, downloadImage } = require('./render/fal');
const { createTrace } = require('./trace/store');
const createStorage = require('./storage');
const storage = createStorage();

async function runBatch({ cartridgeName = 'nolla', titles, N = 10, critic = true, model, models, aspectRatio, debug = true, clientId = null, onTraceCreated }) {
  const cartridge = loadCartridge(cartridgeName);
  // Accept either `models: string[]` (new, for 'both' mode) or legacy `model: string`.
  // Dedupe + preserve order. 'both' lets us render the same shot list across
  // multiple models so we can A/B the rewriter (keyword-stack → nano vs
  // prose-rewritten → gpt-2) without the shot list itself varying.
  const modelList = Array.from(new Set(
    (models && models.length ? models : [model]).filter(Boolean)
  ));
  if (!modelList.length) modelList.push(undefined); // fall back to render default
  const needsRewrite = modelList.includes('openai/gpt-image-2');

  const trace = createTrace({
    cartridge: cartridgeName,
    input: { titles, N, options: { critic, model: modelList[0], models: modelList, aspectRatio } },
    clientId
  });
  if (typeof onTraceCreated === 'function') {
    try { onTraceCreated(trace); } catch (e) { console.warn('[orchestrator] onTraceCreated threw:', e.message); }
  }

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

    // STAGE 2b: sanitize — auto-correct invalid LLM names (e.g. "device" as a composition)
    const { sanitized, substitutions } = sanitizeShotMap(cartridge, shotMap);
    shotMap = sanitized;

    // STAGE 2c: theme-lock per title when N <= 5 so each title's shots form a
    // visual series (single palette). Pick the most-common theme the LLM chose
    // for that title; tie-break to the earliest shot.
    if (N <= 5) {
      for (const [tid, sel] of Object.entries(shotMap)) {
        const shots = sel?.shots || [];
        if (shots.length < 2) continue;
        const counts = {};
        shots.forEach(s => { if (s.theme) counts[s.theme] = (counts[s.theme] || 0) + 1; });
        const entries = Object.entries(counts);
        if (!entries.length) continue;
        const maxCount = Math.max(...entries.map(([, c]) => c));
        const tied = entries.filter(([, c]) => c === maxCount).map(([k]) => k);
        const winner = tied.length === 1
          ? tied[0]
          : shots.find(s => tied.includes(s.theme))?.theme;
        if (!winner) continue;
        shots.forEach((s, i) => {
          if (s.theme !== winner) {
            substitutions.push({ titleId: tid, shotIdx: i, field: 'theme', before: s.theme, after: winner, reason: 'theme-lock (N<=5)' });
            s.theme = winner;
          }
        });
      }
    }

    // STAGE 3: resolve prompts
    trace.startStage('resolved');
    const resolved = buildRenderPrompts(cartridge, titles, shotMap, { batchSeed: Date.now() });
    const promptVar = {};
    const resolveErrors = {};
    for (const [tid, arr] of Object.entries(resolved)) {
      const okPrompts = arr.filter(p => !p.__error && p.prompt).map(p => p.prompt);
      promptVar[tid] = promptVariance(okPrompts);
      const errs = arr.filter(p => p.__error).map(p => ({ composition: p.composition, subject_type: p.subject_type, error: p.__error }));
      if (errs.length) resolveErrors[tid] = errs;
    }
    trace.finishStage('resolved', { prompts: resolved, promptVariance: promptVar, resolveErrors, substitutions });

    // STAGE 3.5: model-specific rewrite. gpt-image-2 wants candid-photography
    // prose, not keyword stacks — rewrite each prompt through the 9-move
    // template (engine) + cartridge.gpt2Voice (brand flavor). The rewrite is
    // stored on shot.__gpt2Prompt (NOT mutating shot.prompt) so a single shot
    // list can feed both models in 'both' mode — nano gets shot.prompt,
    // gpt-2 gets shot.__gpt2Prompt, and we can diff them against each other.
    if (needsRewrite) {
      trace.startStage('gpt2Rewrite');
      const REWRITE_CONCURRENCY = Math.max(1, Math.min(10, parseInt(process.env.REWRITE_CONCURRENCY || '5', 10)));
      const rewriteTasks = [];
      for (const [tid, arr] of Object.entries(resolved)) {
        for (let i = 0; i < arr.length; i++) {
          const shot = arr[i];
          if (shot.__error || !shot.prompt) continue;
          rewriteTasks.push({ tid, i, shot });
        }
      }
      const rewriteResults = [];
      const rewriteInflight = new Set();
      const rewriteOne = async ({ tid, i, shot }) => {
        try {
          const { rewritten, meta } = await rewriteForGpt2({
            prompt: shot.prompt,
            brandVoice: cartridge.gpt2Voice || '',
            context: {
              subject_type: shot.subject_type,
              subject_topic: shot.subject_topic,
              composition: shot.composition,
              body_region: shot.body_region,
              theme: shot.theme,
              affliction_detail: shot.affliction_detail
            }
          });
          shot.__gpt2Prompt = rewritten;
          rewriteResults.push({ tid, i, ok: true, chars: rewritten.length, elapsedMs: meta.elapsedMs });
        } catch (e) {
          rewriteResults.push({ tid, i, ok: false, error: e.message });
        }
      };
      for (const task of rewriteTasks) {
        const p = rewriteOne(task).finally(() => rewriteInflight.delete(p));
        rewriteInflight.add(p);
        if (rewriteInflight.size >= REWRITE_CONCURRENCY) await Promise.race(rewriteInflight);
      }
      await Promise.all(rewriteInflight);
      const okCount = rewriteResults.filter(r => r.ok).length;
      trace.finishStage('gpt2Rewrite', {
        totalShots: rewriteTasks.length,
        rewritten: okCount,
        failed: rewriteTasks.length - okCount,
        results: rewriteResults
      });
    }

    // STAGE 4: render — one render per (shot × model). In 'both' mode each
    // shot fans out twice; filenames are model-suffixed so they don't collide
    // on disk. gpt-2 reads shot.__gpt2Prompt when present (falls back to the
    // keyword-stack prompt on rewrite failure); everything else reads shot.prompt.
    trace.startStage('renders');
    const CONCURRENCY = Math.max(1, Math.min(20, parseInt(process.env.RENDER_CONCURRENCY || '5', 10)));
    const modelSuffix = (m) => {
      if (!m) return 'default';
      if (m.includes('gpt-image-2')) return 'gpt2';
      if (m.includes('nano-banana')) return 'nano';
      return m.split('/').pop().replace(/[^a-z0-9]+/gi, '-');
    };
    const tasks = [];
    for (const title of titles) {
      const shots = resolved[title.id] || [];
      for (let i = 0; i < shots.length; i++) {
        for (const m of modelList) {
          tasks.push({ title, shot: shots[i], idx: i, model: m });
        }
      }
    }

    const runOne = async ({ title, shot, idx, model: m }) => {
      const suffix = modelList.length > 1 ? `-${modelSuffix(m)}` : '';
      const filename = `gen-${String(idx + 1).padStart(3, '0')}${suffix}.png`;
      if (shot.__error) {
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'failed', error: 'resolve: ' + shot.__error, stage: 'resolve', model: m });
        return;
      }
      const prompt = (m === 'openai/gpt-image-2' && shot.__gpt2Prompt) ? shot.__gpt2Prompt : shot.prompt;
      try {
        const img = await renderOne(prompt, { model: m, aspectRatio, references: cartridge.references });
        const buf = await downloadImage(img.url);
        const metadata = { ...shot, prompt, model: img.model, generatedAt: new Date().toISOString(), runId: trace.id };
        await storage.writeImage(trace.id, title.slug, filename, buf, metadata);
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'ok', elapsedMs: img.elapsedMs, model: img.model });
      } catch (e) {
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'failed', error: e.message, model: m });
      }
    };

    const inflight = new Set();
    for (const task of tasks) {
      const p = runOne(task).finally(() => inflight.delete(p));
      inflight.add(p);
      if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    trace.finishStage('renders');
    trace.finish();
  } catch (e) {
    trace.fail(e);
    throw e;
  }

  return trace.id;
}

module.exports = { runBatch };
