const express = require('express');
const archiver = require('archiver');
const { requireClient } = require('../auth/middleware');
const { runBatch } = require('../orchestrator');
const { readTrace, listTraces } = require('../trace/store');
const createStorage = require('../storage');

const storage = createStorage();
const router = express.Router();

router.use(requireClient);

const MAX_TITLES = 200;
const MAX_N = 10;
const MAX_TOTAL_IMAGES = 500;

function err(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

function normalizeTitles(raw) {
  return raw.map((line, i) => {
    const text = typeof line === 'string' ? line : (line.title || '');
    if (!text.trim()) return null;
    const parts = text.split('|');
    const hasCategory = parts.length > 1;
    const title = hasCategory ? parts.slice(1).join('|').trim() : text.trim();
    const category = hasCategory ? parts[0].trim() : 'general';
    return {
      id: `c-${Date.now()}-${i}`,
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50),
      category
    };
  }).filter(Boolean);
}

function traceToRun(t) {
  const renders = t.stages?.renders?.items || {};
  const flat = Object.values(renders).flat();
  const ok = flat.filter(x => x.status === 'ok').length;
  const failed = flat.filter(x => x.status === 'failed').length;
  const total = flat.length;
  return {
    run_id: t.id,
    status: t.status,
    progress: { ok, failed, total },
    titles: t.input?.titles?.length || 0,
    started_at: t.startedAt,
    finished_at: t.finishedAt || null
  };
}

// POST /v1/generate — kick off a batch
router.post('/generate', async (req, res) => {
  try {
    const { titles, n_per_title, cartridge, aspect_ratio, model, critic } = req.body || {};
    if (!Array.isArray(titles) || !titles.length) {
      return err(res, 400, 'titles_required', 'titles must be a non-empty array');
    }
    if (titles.length > MAX_TITLES) {
      return err(res, 400, 'batch_too_large', `max ${MAX_TITLES} titles per batch`, { max: MAX_TITLES });
    }
    const N = Math.max(1, Math.min(MAX_N, parseInt(n_per_title, 10) || req.client.n_per_title || 3));
    const normalized = normalizeTitles(titles);
    if (!normalized.length) return err(res, 400, 'titles_required', 'no valid titles after normalization');

    const total = normalized.length * N;
    if (total > MAX_TOTAL_IMAGES) {
      return err(res, 400, 'batch_too_large',
        `batch would render ${total} images; max ${MAX_TOTAL_IMAGES}`,
        { max: MAX_TOTAL_IMAGES, requested: total });
    }

    // Cartridge override must match client's allowed cartridge for v1 (one per key).
    const cartridgeName = cartridge || req.client.cartridge;
    if (cartridgeName !== req.client.cartridge) {
      return err(res, 403, 'cartridge_not_found',
        `this key is scoped to cartridge '${req.client.cartridge}'`);
    }

    // Capture run_id synchronously via onTraceCreated, then fire-and-forget.
    const runIdPromise = new Promise((resolve) => {
      runBatch({
        cartridgeName,
        titles: normalized,
        N,
        critic: critic !== false,
        model: model || undefined,
        aspectRatio: aspect_ratio || undefined,
        clientId: req.client.id,
        onTraceCreated: (trace) => resolve(trace.id)
      }).catch(e => console.error('[v1 generate]', e));
    });
    const runId = await runIdPromise;

    res.status(202).json({
      run_id: runId,
      status: 'queued',
      titles: normalized.length,
      n_per_title: N,
      total_images: total,
      polling_url: `/v1/runs/${runId}`
    });
  } catch (e) {
    console.error('[v1 generate]', e);
    err(res, 500, 'internal', e.message);
  }
});

// GET /v1/runs — list recent runs for this key
router.get('/runs', async (req, res) => {
  try {
    const runs = await listTraces({ clientId: req.client.id });
    res.json({ runs: runs.slice(0, 50).map(r => ({
      run_id: r.id,
      status: r.status,
      titles: r.titleCount,
      ok: r.renderProgress?.ok || 0,
      failed: r.renderProgress?.failed || 0,
      total: r.renderProgress?.total || 0,
      started_at: r.startedAt,
      finished_at: r.finishedAt || null
    })), has_more: runs.length > 50 });
  } catch (e) {
    err(res, 500, 'internal', e.message);
  }
});

// GET /v1/runs/:id — full status + image list
router.get('/runs/:id', async (req, res) => {
  try {
    const trace = await readTrace(req.params.id, req.client.id);
    if (!trace) return err(res, 404, 'not_found', 'run not found');

    const renders = trace.stages?.renders?.items || {};
    const images = [];
    for (const [titleId, arr] of Object.entries(renders)) {
      const title = trace.input.titles.find(t => t.id === titleId);
      if (!title) continue;
      for (const item of arr) {
        images.push({
          title: title.title,
          category: title.category,
          slug: title.slug,
          filename: item.filename,
          status: item.status,
          prompt: item.prompt || null,
          url: item.status === 'ok'
            ? `${req.protocol}://${req.get('host')}/v1/runs/${trace.id}/images/${title.slug}/${item.filename}`
            : null,
          error: item.error || null
        });
      }
    }

    const base = traceToRun(trace);
    res.json({
      ...base,
      zip_url: trace.status === 'done'
        ? `${req.protocol}://${req.get('host')}/v1/runs/${trace.id}/zip`
        : null,
      images
    });
  } catch (e) {
    err(res, 500, 'internal', e.message);
  }
});

// GET /v1/runs/:id/images/:slug/:filename — single image proxy
router.get('/runs/:id/images/:slug/:filename', async (req, res) => {
  try {
    const trace = await readTrace(req.params.id, req.client.id);
    if (!trace) return err(res, 404, 'not_found', 'run not found');
    const buf = await storage.readImage(trace.id, req.params.slug, req.params.filename);
    if (!buf) return err(res, 404, 'not_found', 'image not found');
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (e) {
    err(res, 500, 'internal', e.message);
  }
});

// GET /v1/runs/:id/zip — streaming ZIP of all ok images
router.get('/runs/:id/zip', async (req, res) => {
  let trace;
  try {
    trace = await readTrace(req.params.id, req.client.id);
    if (!trace) return err(res, 404, 'not_found', 'run not found');
  } catch (e) {
    return err(res, 500, 'internal', e.message);
  }

  const items = trace.stages?.renders?.items || {};
  const plan = [];
  for (const [tid, arr] of Object.entries(items)) {
    const title = trace.input.titles.find(t => t.id === tid);
    if (!title) continue;
    for (const item of arr) {
      if (item.status === 'ok') plan.push({ slug: title.slug, filename: item.filename });
    }
  }
  if (!plan.length) return err(res, 404, 'not_found', 'no images yet — run may still be in progress');

  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${trace.id}.zip"`
  });
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', e => { console.error('[v1 zip]', e); try { res.end(); } catch {} });
  archive.pipe(res);
  try {
    for (const { slug, filename } of plan) {
      const buf = await storage.readImage(trace.id, slug, filename);
      if (buf) archive.append(buf, { name: `${slug}/${filename}` });
    }
    await archive.finalize();
  } catch (e) {
    console.error('[v1 zip stream]', e);
    try { res.end(); } catch {}
  }
});

// GET /v1/me — echo the client behind the key (useful for debugging)
router.get('/me', (req, res) => {
  res.json({
    name: req.client.name,
    cartridge: req.client.cartridge,
    n_per_title: req.client.n_per_title,
    monthly_image_quota: req.client.monthly_image_quota,
    api_key_prefix: req.client.api_key_prefix || null
  });
});

module.exports = router;
