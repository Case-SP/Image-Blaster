const express = require('express');
const { requireClient } = require('../auth/middleware');
const { runBatch } = require('../orchestrator');
const { readTrace, listTraces, bus, EVENTS } = require('../trace/store');
const createStorage = require('../storage');
const { packZip } = require('../zip/pack');

const storage = createStorage();
const router = express.Router();

router.use(requireClient);

// POST /api/public/runs — start a batch for this client
router.post('/runs', async (req, res) => {
  try {
    const { titles = [] } = req.body;
    if (!Array.isArray(titles) || !titles.length) {
      return res.status(400).json({ error: 'titles[] required' });
    }
    const normalized = titles.slice(0, 50).map((line, i) => {
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
      N: req.client.n_per_title,
      critic: true,
      clientId: req.client.id
    }).catch(e => console.error('[runBatch]', e));

    res.json({ status: 'started', titles: normalized.length, N: req.client.n_per_title });
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

// GET /api/public/runs/:id/zip — stream a ZIP of all images
router.get('/runs/:id/zip', async (req, res) => {
  try {
    const trace = await readTrace(req.params.id, req.client.id);
    if (!trace) return res.status(404).json({ error: 'not found' });
    const items = trace.stages?.renders?.items || {};
    const files = [];
    for (const [tid, arr] of Object.entries(items)) {
      const title = trace.input.titles.find(t => t.id === tid);
      if (!title) continue;
      for (const item of arr) {
        if (item.status !== 'ok') continue;
        const buf = await storage.readImage(trace.id, title.slug, item.filename);
        if (buf) files.push({ filename: `${title.slug}/${item.filename}`, buffer: buf });
      }
    }
    if (!files.length) return res.status(404).json({ error: 'no images yet' });
    const zip = await packZip(files);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${req.params.id}.zip"`
    });
    res.send(zip);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/events?run=<id> — SSE scoped to this client's runs
router.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders();
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
  req.on('close', () => { for (const [v, h] of Object.entries(handlers)) bus.off(v, h); });
});

// GET /api/public/me — client metadata
router.get('/me', (req, res) => {
  res.json({
    name: req.client.name,
    cartridge: req.client.cartridge,
    n_per_title: req.client.n_per_title
  });
});

module.exports = router;
