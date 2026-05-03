require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { runBatch } = require('./orchestrator');
const { loadCartridge } = require('./factory/cartridge');
const { readTrace, listTraces, bus, EVENTS } = require('./trace/store');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const v1Routes = require('./routes/v1');
const { router: authRoutes, redeemGrant, cookieOpts, COOKIE_NAME } = require('./routes/auth');
const createStorage = require('./storage');

const app = express();
app.set('trust proxy', 1); // Railway terminates TLS upstream; honor X-Forwarded-* for req.protocol/req.ip
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
const PORT = parseInt(process.env.PORT || '3002', 10);
const storage = createStorage();

// ---- Auth ----
app.use('/api/auth', authRoutes);

// ---- Public API (UI-facing) ----
app.use('/api/public', publicRoutes);

// ---- v1 API (programmatic, X-API-Key header) ----
app.use('/v1', v1Routes);

// ---- Admin API ----
app.use('/api/admin', adminRoutes);

// ---- Invite shortener: /i/<code> → / with ?invite=<code> ----
app.get('/i/:code', (req, res) => {
  const code = encodeURIComponent(req.params.code);
  res.redirect(302, `/?invite=${code}`);
});

// ---- One-time access grant: /a/<token> → session cookie + redirect home ----
app.get('/a/:token', async (req, res) => {
  try {
    const { sid } = await redeemGrant({
      token: req.params.token,
      userAgent: req.headers['user-agent']
    });
    res.cookie(COOKIE_NAME, sid, cookieOpts());
    res.redirect(302, '/');
  } catch (e) {
    const status = e.status || 500;
    console.error('[access-link]', e.message);
    res.status(status).send(
      `<!doctype html><meta charset="utf-8"><title>Access</title>` +
      `<body style="font-family:system-ui;padding:2rem;max-width:420px">` +
      `<p>${e.message}</p><p><a href="/">Back to sign-in</a></p></body>`
    );
  }
});

// ---- Client UI (primary: served at root; /client kept for backward compat) ----
app.use('/client', express.static(path.join(__dirname, '../ui-client')));
app.use('/', express.static(path.join(__dirname, '../ui-client')));

// ---- Dogfood UI (dev) ----
app.use('/admin-ui', express.static(path.join(__dirname, '../ui')));

// ---- Dev-only local fs endpoints (kept for existing dogfood UI) ----
// Guard: in prod (SUPABASE_URL set), require ADMIN_MASTER_KEY header
app.use('/api', (req, res, next) => {
  if (process.env.SUPABASE_URL && req.headers['x-admin-key'] !== process.env.ADMIN_MASTER_KEY) {
    return res.status(404).end();
  }
  next();
});

app.get('/api/cartridges', (req, res) => {
  const dir = path.join(__dirname, '../cartridge');
  res.json({ cartridges: fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isDirectory()) });
});

app.get('/api/runs', async (req, res) => {
  try { res.json(await listTraces()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/runs/:id', async (req, res) => {
  try {
    const t = await readTrace(req.params.id, null);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/runs', async (req, res) => {
  try {
    const { cartridge = 'nolla', titles = [], N = 10, critic = true, model, aspectRatio } = req.body;
    if (!titles.length) return res.status(400).json({ error: 'titles[] required' });
    const titlesNormalized = titles.map((t, i) => ({
      id: t.id || `run-${i}`,
      title: t.title,
      slug: t.slug || t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50),
      category: t.category || 'general'
    }));
    runBatch({ cartridgeName: cartridge, titles: titlesNormalized, N, critic, model, aspectRatio })
      .catch(e => console.error('[runBatch]', e));
    res.json({ status: 'started' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/runs/:id/verdict', async (req, res) => {
  try {
    const t = await readTrace(req.params.id, null);
    if (!t) return res.status(404).json({ error: 'not found' });
    const { titleId, filename, verdict, reasons = [] } = req.body;
    t.verdicts[`${titleId}/${filename}`] = { verdict, reasons, taggedAt: new Date().toISOString() };
    await storage.writeTrace(t, t.clientId || null);
    bus.emit(EVENTS.VERDICT_SET, { id: t.id, key: `${titleId}/${filename}`, verdict, reasons });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/images/:runId/:slug/:filename', async (req, res) => {
  // Dev-only fallback: read from local fs directly.
  const p = path.join(__dirname, '../output/generations', req.params.runId, req.params.slug, req.params.filename);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  const runFilter = req.query.run || null;
  const send = (event, data) => {
    if (runFilter && data.id && data.id !== runFilter) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const handlers = {};
  for (const [, v] of Object.entries(EVENTS)) {
    handlers[v] = (data) => send(v, data);
    bus.on(v, handlers[v]);
  }
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    for (const [v, h] of Object.entries(handlers)) bus.off(v, h);
  });
});

// ---- Brand Studio (local-only admin layer for editing cartridge DNA) ----
// Lives under /api so it inherits the prod-guard above (404s when SUPABASE_URL is set
// without ADMIN_MASTER_KEY). Writes directly to v2/cartridge/<name>/.
const CARTRIDGE_ROOT = path.join(__dirname, '../cartridge');
const REF_EXT_RE = /\.(jpe?g|png|webp)$/i;
const sanitizeSlug = s => String(s || 'ref').toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ref';

app.get('/api/brand/:cartridge', (req, res) => {
  try {
    const dir = path.join(CARTRIDGE_ROOT, req.params.cartridge);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'cartridge not found' });
    const profile = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'));
    const refsDir = path.join(dir, 'references');
    const refs = fs.existsSync(refsDir) ? fs.readdirSync(refsDir).filter(f => REF_EXT_RE.test(f)).sort() : [];
    res.json({ cartridge: req.params.cartridge, profile, refs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/brand/:cartridge/profile', (req, res) => {
  try {
    const dir = path.join(CARTRIDGE_ROOT, req.params.cartridge);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'cartridge not found' });
    const next = req.body && req.body.profile;
    if (!next || typeof next !== 'object') return res.status(400).json({ error: 'profile object required' });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(next, null, 2) + '\n');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/brand/:cartridge/refs/:filename', (req, res) => {
  const p = path.join(CARTRIDGE_ROOT, req.params.cartridge, 'references', req.params.filename);
  if (!REF_EXT_RE.test(req.params.filename) || !fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

app.post('/api/brand/:cartridge/refs', (req, res) => {
  try {
    const dir = path.join(CARTRIDGE_ROOT, req.params.cartridge, 'references');
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'references dir not found' });
    const { filename, dataUrl } = req.body || {};
    if (!filename || !dataUrl) return res.status(400).json({ error: 'filename + dataUrl required' });
    if (!REF_EXT_RE.test(filename)) return res.status(400).json({ error: 'unsupported ext (jpg/png/webp only)' });
    const m = String(dataUrl).match(/^data:[^;]+;base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'dataUrl must be base64' });
    const existing = fs.readdirSync(dir).filter(f => REF_EXT_RE.test(f));
    let max = 0;
    for (const f of existing) { const mm = f.match(/^ref-(\d{2,})-/); if (mm) max = Math.max(max, parseInt(mm[1], 10)); }
    const seq = String(max + 1).padStart(2, '0');
    const ext = path.extname(filename).toLowerCase();
    const slug = sanitizeSlug(filename);
    const target = path.join(dir, `ref-${seq}-${slug}${ext}`);
    fs.writeFileSync(target, Buffer.from(m[1], 'base64'));
    res.json({ ok: true, filename: path.basename(target) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/brand/:cartridge/refs/:filename', (req, res) => {
  try {
    const p = path.join(CARTRIDGE_ROOT, req.params.cartridge, 'references', req.params.filename);
    if (!REF_EXT_RE.test(req.params.filename) || !fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
    fs.unlinkSync(p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Silence browser favicon requests
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Root is served by the static middleware above (ui-client/index.html)

app.listen(PORT, () => console.log(`Recast live at http://localhost:${PORT}  (client UI: /client, admin UI: /admin-ui)`));
