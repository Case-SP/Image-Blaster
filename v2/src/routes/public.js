const express = require('express');
const archiver = require('archiver');
const { requireClient, requireSession } = require('../auth/middleware');
const { runBatch } = require('../orchestrator');
const { readTrace, listTraces, bus, EVENTS } = require('../trace/store');
const createStorage = require('../storage');
const { SESSION_ALLOWED_MODELS } = require('../render/models');

const storage = createStorage();
const router = express.Router();

router.use(requireClient);
router.use(requireSession); // /api/public/* is the UI surface — API-key clients must use /v1/*

// POST /api/public/runs — start a batch for this client
const MAX_TITLES = 200;
const MAX_N = 10;
const MAX_TOTAL_IMAGES = 500;

// Experimental models are default-deny per client. Only emails in
// EXPERIMENTAL_MODEL_EMAILS (comma-sep) or open-mode (local dev) can
// select gpt-image-2 and the 'both' fan-out. Everyone else is nano-only.
// Keyed on email so we don't need a schema change; revisit if this grows.
const EXPERIMENTAL_MODELS = new Set(['openai/gpt-image-2']);
const EXPERIMENTAL_EMAILS = new Set(
  (process.env.EXPERIMENTAL_MODEL_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
function hasExperimentalAccess(req) {
  if (req.authMethod === 'open') return true; // local dev (AUTH_MODE=open)
  const email = (req.client?.email || '').toLowerCase();
  return EXPERIMENTAL_EMAILS.has(email);
}

router.post('/runs', async (req, res) => {
  try {
    const { titles = [], N: requestedN, model, models } = req.body;
    if (!Array.isArray(titles) || !titles.length) {
      return res.status(400).json({ error: 'titles[] required' });
    }
    if (titles.length > MAX_TITLES) {
      return res.status(400).json({ error: `too many titles (${titles.length}); max ${MAX_TITLES} per run` });
    }

    // Accept `models: []` (multi-model A/B) or legacy `model`. Allowlist-check
    // each. 'both' mode sends models=[nano, gpt-2] so the shot list is shared.
    const modelList = Array.isArray(models) && models.length ? models : (model ? [model] : []);
    for (const m of modelList) {
      if (!SESSION_ALLOWED_MODELS.has(m)) {
        return res.status(400).json({ error: `model '${m}' not in allowlist` });
      }
      if (EXPERIMENTAL_MODELS.has(m) && !hasExperimentalAccess(req)) {
        return res.status(403).json({ error: `model '${m}' not available on this account` });
      }
    }

    const N = Math.max(1, Math.min(MAX_N, parseInt(requestedN, 10) || req.client.n_per_title || 3));
    const fanOut = Math.max(1, modelList.length);
    const total = titles.length * N * fanOut;
    if (total > MAX_TOTAL_IMAGES) {
      return res.status(400).json({ error: `batch too large: ${total} images (max ${MAX_TOTAL_IMAGES}). Reduce titles, N, or models.` });
    }

    const normalized = titles.map((line, i) => {
      const raw = typeof line === 'string' ? line : (line.title || '');
      if (!raw.trim()) return null;
      const parts = raw.split('|');
      const hasCategory = parts.length > 1;
      const title = hasCategory ? parts.slice(1).join('|').trim() : raw.trim();
      const category = hasCategory ? parts[0].trim() : 'general';
      return {
        id: `c-${Date.now()}-${i}`,
        title,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50),
        category
      };
    }).filter(Boolean);
    if (!normalized.length) return res.status(400).json({ error: 'no valid titles' });

    // Fire-and-forget; client watches via SSE
    runBatch({
      cartridgeName: req.client.cartridge,
      titles: normalized,
      N,
      critic: true,
      models: modelList.length ? modelList : undefined,
      clientId: req.client.id
    }).catch(e => console.error('[runBatch]', e));

    res.json({ status: 'started', titles: normalized.length, N, total: normalized.length * N * fanOut });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/runs — list this client's runs
router.get('/runs', async (req, res) => {
  try {
    const runs = await listTraces({ clientId: req.client.id });
    res.json(runs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/runs/:id — get one trace (scoped to this client)
router.get('/runs/:id', async (req, res) => {
  try {
    const trace = await readTrace(req.params.id, req.client.id);
    if (!trace) return res.status(404).json({ error: 'not found' });
    res.json(trace);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/runs/:id/images/:slug/:filename — single image, session-scoped.
router.get('/runs/:id/images/:slug/:filename', async (req, res) => {
  try {
    const trace = await readTrace(req.params.id, req.client.id);
    if (!trace) return res.status(404).json({ error: 'not found' });
    const buf = await storage.readImage(trace.id, req.params.slug, req.params.filename);
    if (!buf) return res.status(404).json({ error: 'image not found' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/runs/:id/zip — streams the ZIP (first byte arrives immediately;
// images are read from storage lazily, one at a time, so memory stays bounded).
router.get('/runs/:id/zip', async (req, res) => {
  let trace;
  try {
    trace = await readTrace(req.params.id, req.client.id);
    if (!trace) return res.status(404).json({ error: 'not found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const items = trace.stages?.renders?.items || {};
  // Flatten into a list of (slug, filename) to append
  const plan = [];
  let approxTotalBytes = 0;
  for (const [tid, arr] of Object.entries(items)) {
    const title = trace.input.titles.find(t => t.id === tid);
    if (!title) continue;
    for (const item of arr) {
      if (item.status !== 'ok') continue;
      plan.push({ slug: title.slug, filename: item.filename });
      approxTotalBytes += 1_500_000; // ~1.5 MB per 1K image, rough for client progress hint
    }
  }
  if (!plan.length) return res.status(404).json({ error: 'no images yet' });

  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${req.params.id}.zip"`,
    // Hint for the client progress bar. Actual zipped size will be close but not
    // exact (PNGs are already compressed). Better than no signal at all.
    'X-Approx-Content-Length': String(approxTotalBytes)
  });

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', err => { if (err.code !== 'ENOENT') console.error('[zip] warn:', err); });
  archive.on('error', err => { console.error('[zip] error:', err); try { res.end(); } catch {} });
  archive.pipe(res);

  try {
    for (const { slug, filename } of plan) {
      const buf = await storage.readImage(trace.id, slug, filename);
      if (buf) archive.append(buf, { name: `${slug}/${filename}` });
    }
    await archive.finalize();
  } catch (e) {
    console.error('[zip] stream failed:', e);
    try { res.end(); } catch {}
  }
});

// GET /api/public/events?run=<id> — SSE scoped to this client's runs
router.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  const runFilter = req.query.run || null;
  const clientTraceIds = new Set();

  const send = async (event, data) => {
    if (runFilter && data.id && data.id !== runFilter) return;
    if (data.id && !clientTraceIds.has(data.id)) {
      const t = await readTrace(data.id, req.client.id).catch(() => null);
      if (!t) return;
      clientTraceIds.add(data.id);
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const handlers = {};
  for (const [, v] of Object.entries(EVENTS)) {
    handlers[v] = (data) => send(v, data).catch(() => {});
    bus.on(v, handlers[v]);
  }
  // 10s heartbeat as a real event (not a comment) — some HTTP/2 edges strip
  // comment-only frames, which looks like an idle stream and gets GOAWAY'd.
  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: ${Date.now()}\n\n`); } catch {}
  }, 10000);
  req.on('close', () => {
    clearInterval(ping);
    for (const [v, h] of Object.entries(handlers)) bus.off(v, h);
  });
});

// GET /api/public/me — client metadata. `experimental` toggles gpt-2/both
// visibility in the UI; server still enforces on POST /runs regardless.
router.get('/me', (req, res) => {
  res.json({
    name: req.client.name,
    cartridge: req.client.cartridge,
    n_per_title: req.client.n_per_title,
    experimental: hasExperimentalAccess(req)
  });
});

module.exports = router;
