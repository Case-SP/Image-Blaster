require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { loadCartridge } = require('./factory/cartridge');
const { buildShotList, buildRenderPrompts, buildShotListSystemPrompt, sanitizeShotMap } = require('./factory/shotList');
const { critiqueShotList } = require('./factory/critic');
const { promptVariance } = require('./factory/variance');
const { renderOne, downloadImage } = require('./render/fal');
const { createTrace } = require('./trace/store');
const createStorage = require('./storage');
const storage = createStorage();

async function runBatch({ cartridgeName = 'nolla', titles, N = 10, critic = true, model, aspectRatio, debug = true, clientId = null }) {
  const cartridge = loadCartridge(cartridgeName);
  const trace = createTrace({
    cartridge: cartridgeName,
    input: { titles, N, options: { critic, model, aspectRatio } },
    clientId
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

    // STAGE 2b: sanitize — auto-correct invalid LLM names (e.g. "device" as a composition)
    const { sanitized, substitutions } = sanitizeShotMap(cartridge, shotMap);
    shotMap = sanitized;

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

    // STAGE 4: render (parallel with concurrency limit — tunable via env var)
    trace.startStage('renders');
    const CONCURRENCY = Math.max(1, Math.min(20, parseInt(process.env.RENDER_CONCURRENCY || '5', 10)));
    const tasks = [];
    for (const title of titles) {
      const shots = resolved[title.id] || [];
      for (let i = 0; i < shots.length; i++) {
        tasks.push({ title, shot: shots[i], idx: i });
      }
    }

    const runOne = async ({ title, shot, idx }) => {
      const filename = `gen-${String(idx + 1).padStart(3, '0')}.png`;
      if (shot.__error) {
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'failed', error: 'resolve: ' + shot.__error, stage: 'resolve' });
        return;
      }
      try {
        const img = await renderOne(shot.prompt, { model, aspectRatio, references: cartridge.references });
        const buf = await downloadImage(img.url);
        const metadata = { ...shot, model: img.model, generatedAt: new Date().toISOString(), runId: trace.id };
        await storage.writeImage(trace.id, title.slug, filename, buf, metadata);
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'ok', elapsedMs: img.elapsedMs, model: img.model });
      } catch (e) {
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'failed', error: e.message });
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
