const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const { requireClient, requireSession } = require('../auth/middleware');
const { runBatch } = require('../orchestrator');
const { readTrace, listTraces, bus, EVENTS } = require('../trace/store');
const createStorage = require('../storage');
const { SESSION_ALLOWED_MODELS } = require('../render/models');

const storage = createStorage();
const router = express.Router();

// Lazily require sharp. If it's not installed (e.g. fresh checkout without
// `npm i`), the thumbnail path silently falls back to the full PNG and the
// app keeps working. Adding sharp is non-breaking.
let sharp = null;
try { sharp = require('sharp'); } catch { /* thumbnails disabled */ }
// In-memory thumbnail LRU. Bounded to ~80 MB total (resized PNGs are tiny —
// a 256-wide PNG is ~12 KB, so this caches roughly the last 6500 thumbnails).
const THUMB_CACHE_MAX = 256;
const thumbCache = new Map(); // key: `${runId}::${slug}::${filename}::${w}`
function thumbCacheGet(k) {
  const v = thumbCache.get(k);
  if (v) { thumbCache.delete(k); thumbCache.set(k, v); } // bump LRU
  return v;
}
function thumbCacheSet(k, v) {
  thumbCache.set(k, v);
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const first = thumbCache.keys().next().value;
    thumbCache.delete(first);
  }
}

router.use(requireClient);
router.use(requireSession); // /api/public/* is the UI surface — API-key clients must use /v1/*

// Request-timing middleware. Logs `[req METHOD /path] ms` for every public-
// route hit so we can diagnose which endpoint is slow without ad-hoc curl.
// Also stamps an `X-Server-Time` header for the UI footer widget to read.
router.use((req, res, next) => {
  const t0 = Date.now();
  const route = req.path.replace(/\/[a-zA-Z0-9-]{16,}/g, '/:id');
  res.on('finish', () => {
    const ms = Date.now() - t0;
    if (ms > 200 || res.statusCode >= 400) {
      console.log(`[req ${req.method} ${route}] ${ms}ms ${res.statusCode}`);
    }
  });
  res.setHeader('X-Request-Started', String(t0));
  next();
});

// GET /api/public/cartridges — list cartridge folder names. In open auth mode
// the client can override the active cartridge per request; in session mode
// the server still pins to req.client.cartridge, so this list is informational.
router.get('/cartridges', (req, res) => {
  try {
    const dir = path.join(__dirname, '../../cartridge');
    const names = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isDirectory());
    // Surface a slim slice of each cartridge's profile so the UI can build
    // cartridge-aware menus (allowed_models, materials, colors, backgrounds,
    // angles, lenses) without fetching every JSON in the cartridge.
    const profiles = {};
    for (const name of names) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, name, 'profile.json'), 'utf8'));
        profiles[name] = {
          input_mode: p.input_mode || 'title',
          default_aspect_ratio: p.default_aspect_ratio || null,
          style_order: p.style_order || null,
          allowed_models: p.allowed_models || null,
          materials: p.materials || null,
          colors: p.colors || null,
          backgrounds: p.backgrounds || null,
          angles: p.angles || null,
          lenses: p.lenses || null
        };
      } catch { profiles[name] = {}; }
    }
    res.json({
      cartridges: names,
      active: req.client.cartridge,
      override: req.authMethod === 'open',
      profiles
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    const { titles = [], N: requestedN, model, models, aspect_ratio, quality, cartridge, stage = null, parents = null, use_parent_as_subject = false, reference_overrides = null, steer_note = null } = req.body;
    // Validate reference_overrides shape: { stage: [{ filename, dataUrl }] }
    // Cap each stage at 16 refs and 5MB per ref to keep memory bounded.
    const MAX_OVERRIDE_REFS = 16;
    const MAX_OVERRIDE_BYTES = 5 * 1024 * 1024;
    let cleanOverrides = null;
    if (reference_overrides && typeof reference_overrides === 'object') {
      cleanOverrides = {};
      for (const [stg, arr] of Object.entries(reference_overrides)) {
        if (!Array.isArray(arr) || !arr.length) continue;
        const trimmed = arr.slice(0, MAX_OVERRIDE_REFS).filter(r => {
          if (!r?.dataUrl || typeof r.dataUrl !== 'string') return false;
          const m = r.dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
          if (!m) return false;
          return m[1].length * 0.75 <= MAX_OVERRIDE_BYTES;
        });
        if (trimmed.length) cleanOverrides[stg] = trimmed;
      }
      if (!Object.keys(cleanOverrides).length) cleanOverrides = null;
    }
    const hasParents = Array.isArray(parents) && parents.length > 0;
    if (!hasParents) {
      if (!Array.isArray(titles) || !titles.length) {
        return res.status(400).json({ error: 'titles[] or parents[] required' });
      }
      if (titles.length > MAX_TITLES) {
        return res.status(400).json({ error: `too many titles (${titles.length}); max ${MAX_TITLES} per run` });
      }
    } else if (parents.length > MAX_TITLES) {
      return res.status(400).json({ error: `too many parents (${parents.length}); max ${MAX_TITLES} per run` });
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
    const titleCount = hasParents ? parents.length : titles.length;
    const total = titleCount * N * fanOut;
    if (total > MAX_TOTAL_IMAGES) {
      return res.status(400).json({ error: `batch too large: ${total} images (max ${MAX_TOTAL_IMAGES}). Reduce titles, N, or models.` });
    }

    let normalized = [];
    if (!hasParents) {
      normalized = titles.map((line, i) => {
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
    }

    // Cartridge override: open-mode only (local dev). Session/api-key callers
    // are pinned to req.client.cartridge for security — we don't want a
    // production user to pivot to another brand's prompt graph mid-request.
    const cartridgeName = (cartridge && req.authMethod === 'open')
      ? cartridge
      : req.client.cartridge;

    // Fire-and-forget; client watches via SSE
    // Invalidate the runs listing cache so the new run shows up immediately.
    runsCache.delete(req.client.id);

    runBatch({
      cartridgeName,
      titles: normalized,
      N,
      critic: true,
      models: modelList.length ? modelList : undefined,
      aspectRatio: aspect_ratio || undefined,
      quality: quality || undefined,
      clientId: req.client.id,
      stage: stage || null,
      parents: hasParents ? parents : null,
      useParentAsSubject: !!use_parent_as_subject,
      referenceOverrides: cleanOverrides,
      steerNote: (typeof steer_note === 'string' && steer_note.trim()) ? steer_note.trim().slice(0, 400) : null
    }).catch(e => console.error('[runBatch]', e));

    res.json({
      status: 'started',
      titles: titleCount,
      N,
      total,
      stage: stage || null,
      parents: hasParents ? parents.length : 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/runs — list this client's runs. Implicit orphan-sweep:
// any trace stuck in 'running' for more than ORPHAN_MAX_MS is auto-marked
// 'failed' (orphaned from a previous server crash or an upstream timeout).
//
// Per-client TTL cache: the underlying Supabase query needs an index on
// runs(client_id, started_at desc) — without it, the listing takes 5–7s.
// Until the index is added, this cache makes back-to-back reloads and
// SSE-triggered refetches feel instant. Set RUNS_CACHE_TTL_MS=0 to disable.
// 90s — a render that's been "running" for longer than this is dead.
// (Nano-banana p50 is ~25s, p95 ~60s; gpt-image-2/edit similar.) Aggressive
// auto-cleanup is the rule, not the exception.
const ORPHAN_MAX_MS = parseInt(process.env.ORPHAN_MAX_MS || '90000', 10);
const RUNS_CACHE_TTL_MS = parseInt(process.env.RUNS_CACHE_TTL_MS || '3000', 10); // 3s
const runsCache = new Map(); // clientId → { t, data }
const RUNS_DB_TIMEOUT_MS = parseInt(process.env.RUNS_DB_TIMEOUT_MS || '8000', 10);
const sweepThrottle = new Map(); // clientId → last-sweep ms
// Long-lived "best response" cache that never expires. Used only when the
// DB is hung AND the short TTL cache has rolled over. Lets the UI keep
// showing the most recent successful snapshot during Supabase outages
// instead of flashing to empty.
const runsLongCache = new Map(); // clientId → { t, data }
router.get('/runs', async (req, res) => {
  try {
    const cacheKey = req.client.id;
    const cached = RUNS_CACHE_TTL_MS > 0 ? runsCache.get(cacheKey) : null;
    if (cached && (Date.now() - cached.t) < RUNS_CACHE_TTL_MS) {
      return res.json(cached.data);
    }
    let runs;
    try {
      runs = await Promise.race([
        listTraces({ clientId: req.client.id }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('listTraces timeout')), RUNS_DB_TIMEOUT_MS))
      ]);
      runsCache.set(cacheKey, { t: Date.now(), data: runs });
      runsLongCache.set(cacheKey, { t: Date.now(), data: runs });
    } catch (err) {
      console.warn('[runs] DB slow/failed:', err.message);
      const long = runsLongCache.get(cacheKey);
      if (cached) {
        res.set('X-Stale-Cache', 'short');
        return res.json(cached.data);
      }
      if (long) {
        res.set('X-Stale-Cache', 'long');
        return res.json(long.data);
      }
      res.set('X-Stale-Cache', 'empty');
      return res.json([]);
    }
    // Sweep orphans in the background — don't block the response.
    const cutoff = Date.now() - ORPHAN_MAX_MS;
    const sweepIds = runs
      .filter(r => r.status === 'running' && new Date(r.startedAt).getTime() < cutoff)
      .map(r => r.id);
    // Throttle: orphan sweep at most once per 60s per client. Without this,
    // every page load re-scans the same set of stuck runs and writes orphan
    // updates that compete with renders for the connection pool.
    const lastSweep = sweepThrottle.get(cacheKey) || 0;
    if (sweepIds.length && (Date.now() - lastSweep) > 60000) {
      sweepThrottle.set(cacheKey, Date.now());
      Promise.all(sweepIds.map(async id => {
        try {
          const t = await readTrace(id, req.client.id);
          if (!t || t.status !== 'running') return;
          if (new Date(t.startedAt).getTime() >= cutoff) return;
          t.status = 'failed';
          t.finishedAt = new Date().toISOString();
          t.error = t.error || 'orphaned: exceeded max running time';
          await storage.writeTrace(t, req.client.id);
        } catch (e) {
          console.warn('[orphan-sweep] failed for', id, e.message);
        }
      })).catch(() => {});
    }
    res.json(runs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/tiles?cartridge=X&limit=N&offset=M
// Flat tiles view: builds the funnel grid directly from the images table
// + light run metadata. No per-run trace JSON fetched. Designed to scale —
// 2k+ images render with one query.
//
// Stage classification:
//   - If the run was kicked off with input.stage set (promote/amplify),
//     every image in that run inherits that stage.
//   - Else (object-mode rotation, fresh sketch input), shot-index is
//     extracted from "gen-NNN-…" filename and mapped through style_order.
const STYLE_ORDER_DEFAULT = ['product-shot', 'in-situ', 'sketch'];
const tilesCache = new Map();      // short TTL cache for fresh hits
const tilesCacheLong = new Map();  // last-known-good — never expires
const TILES_CACHE_TTL_MS = parseInt(process.env.TILES_CACHE_TTL_MS || '15000', 10);
router.get('/tiles', async (req, res) => {
  try {
    const cartridge = req.query.cartridge || req.client.cartridge;
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit || '500', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const cacheKey = `${req.client.id}::${cartridge}::${limit}::${offset}`;
    const cached = tilesCache.get(cacheKey);
    if (cached && Date.now() - cached.t < TILES_CACHE_TTL_MS) return res.json(cached.data);

    const supa = require('../db/supabase').sb();
    const isOpenMode = req.authMethod === 'open';

    // FAST PATH: requires the migration `20260503_runs_cartridge_stage_columns.sql`
    // to have run (adds `cartridge` + `stage` columns + composite index). With
    // the index, this is a single query, ~50ms regardless of total run count.
    // If the columns don't exist (migration not run yet), we throw and fall
    // through to the legacy multi-query path.
    let cartRuns = null;
    try {
      let q = supa.from('runs')
        .select('id, started_at, status, client_id, cartridge, stage')
        .eq('cartridge', cartridge)
        .order('started_at', { ascending: false })
        .limit(600);  // hard cap; 600 runs × ~3 images = 1800 tiles
      if (!isOpenMode) q = q.eq('client_id', req.client.id);
      const r = await Promise.race([
        q,
        new Promise((_, rej) => setTimeout(() => rej(new Error('runs fast-path timeout')), 5000))
      ]);
      if (r.error) throw r.error;  // schema may not have the column yet
      cartRuns = (r.data || []).map(row => ({
        id: row.id,
        started_at: row.started_at,
        status: row.status,
        client_id: row.client_id,
        cartridge: row.cartridge,
        stage: row.stage
      }));
    } catch (err) {
      console.warn('[tiles] fast-path failed, falling back:', err.message);
      cartRuns = null;
    }

    // SLOW PATH (only used when fast-path fails — i.e. before migration):
    // paginate runs, classify cartridge via JSON in parallel batches.
    if (cartRuns === null) {
      const PAGE = 50;
      const MAX_PAGES = 12;
      let runs = [];
      let lastStarted = null;
      let pageErr = null;
      for (let p = 0; p < MAX_PAGES; p++) {
        let q = supa.from('runs').select('id, started_at, status, client_id')
          .order('started_at', { ascending: false })
          .limit(PAGE);
        if (!isOpenMode) q = q.eq('client_id', req.client.id);
        if (lastStarted) q = q.lt('started_at', lastStarted);
        let data;
        try {
          const r = await Promise.race([
            q,
            new Promise((_, rej) => setTimeout(() => rej(new Error('page timeout')), 8000))
          ]);
          if (r.error) { pageErr = r.error; break; }
          data = r.data;
        } catch (e) { pageErr = e; break; }
        if (!data || !data.length) break;
        const filtered = isOpenMode ? data.filter(r => r.client_id === req.client.id) : data;
        runs.push(...filtered);
        lastStarted = data[data.length - 1].started_at;
        if (data.length < PAGE) break;
      }
      const cartByRun = new Map();
      const stageByRun = new Map();
      const batchPromises = [];
      for (let i = 0; i < runs.length; i += 20) {
        const batch = runs.slice(i, i + 20).map(r => r.id);
        batchPromises.push(
          Promise.race([
            supa.from('runs').select([
              'id',
              'cartridge:trace->>cartridge',
              'shot_list_stage:trace->stages->shotList->>stage'
            ].join(',')).in('id', batch),
            new Promise((_, rej) => setTimeout(() => rej(new Error('cart-batch timeout')), 6000))
          ]).catch(() => ({ data: [] }))
        );
      }
      const batchResults = await Promise.all(batchPromises);
      for (const { data } of batchResults) {
        for (const r of (data || [])) {
          if (r.cartridge) cartByRun.set(r.id, r.cartridge);
          if (r.shot_list_stage) stageByRun.set(r.id, r.shot_list_stage);
        }
      }
      for (const r of runs) {
        r.cartridge = cartByRun.get(r.id) || null;
        r.stage = stageByRun.get(r.id) || null;
      }
      if (pageErr && !runs.length) {
        const long = tilesCacheLong.get(cacheKey);
        if (long) { res.set('X-Stale-Cache', 'long'); return res.json(long.data); }
        console.warn('[tiles] runs page err, no cache:', pageErr.message);
        return res.json([]);
      }
      cartRuns = runs.filter(r => r.cartridge === cartridge);
    }

    if (!cartRuns.length) {
      tilesCache.set(cacheKey, { t: Date.now(), data: [] });
      return res.json([]);
    }
    const runMeta = new Map(cartRuns.map(r => [r.id, r]));
    const runIds = cartRuns.map(r => r.id);

    // Step 2: images table — paginate-safe and parallel.
    const imageBatchPromises = [];
    for (let i = 0; i < runIds.length; i += 100) {
      const batch = runIds.slice(i, i + 100);
      imageBatchPromises.push(
        supa.from('images').select('run_id, slug, filename').in('run_id', batch)
          .then(r => r.data || [])
          .catch(() => [])
      );
    }
    const imageBatches = await Promise.all(imageBatchPromises);
    let allImages = [];
    for (const b of imageBatches) allImages = allImages.concat(b);

    // Build the Supabase public-bucket URL prefix once. This points at the
    // CDN — when set, the UI fetches tile thumbnails directly without
    // round-tripping through Node.
    const supaUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const thumbPrefix = supaUrl
      ? `${supaUrl}/storage/v1/object/public/generations-thumbs`
      : null;

    // Step 3: classify + shape into tiles, sorted newest-run first.
    const tiles = allImages.map(i => {
      const meta = runMeta.get(i.run_id);
      let stage = meta?.stage || null;
      if (!stage) {
        const m = i.filename.match(/^gen-(\d+)/);
        const idx = m ? parseInt(m[1], 10) - 1 : 0;
        stage = STYLE_ORDER_DEFAULT[idx % STYLE_ORDER_DEFAULT.length];
      }
      const modelGuess = /-(nano|gpt2e|gpt2|flux)\.png$/.exec(i.filename);
      const model = modelGuess ? ({ nano: 'fal-ai/nano-banana-pro', gpt2e: 'openai/gpt-image-2/edit', gpt2: 'openai/gpt-image-2', flux: 'fal-ai/flux-pro/v1.1-ultra' }[modelGuess[1]]) : null;
      const slugEnc = encodeURIComponent(i.slug);
      const fileEnc = encodeURIComponent(i.filename);
      return {
        runId: i.run_id,
        slug: i.slug,
        filename: i.filename,
        stage,
        model,
        title: i.slug.replace(/-/g, ' '),
        runStartedAt: meta?.started_at,
        url: `/api/public/runs/${i.run_id}/images/${slugEnc}/${fileEnc}`,
        thumbUrl: thumbPrefix ? `${thumbPrefix}/${i.run_id}/${slugEnc}/${fileEnc}.webp` : null
      };
    });
    tiles.sort((a, b) => (b.runStartedAt || '').localeCompare(a.runStartedAt || ''));
    const sliced = tiles.slice(offset, offset + limit);
    tilesCache.set(cacheKey, { t: Date.now(), data: sliced });
    tilesCacheLong.set(cacheKey, { t: Date.now(), data: sliced });
    res.json(sliced);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/public/runs/clear — DESTRUCTIVE. Disabled by default because it
// deletes failed run rows (and any images linked via cascading FKs). The UI
// uses a non-destructive dismiss instead. Re-enable by setting
// ALLOW_DESTRUCTIVE_CLEAR=1 in the env if you really want this behavior.
router.post('/runs/clear', async (req, res) => {
  if (process.env.ALLOW_DESTRUCTIVE_CLEAR !== '1') {
    return res.status(403).json({
      error: 'destructive clear is disabled. Use the UI dismiss instead, or set ALLOW_DESTRUCTIVE_CLEAR=1 to opt in.'
    });
  }
  try {
    const clientId = req.client.id;
    const all = await listTraces({ clientId });
    const stuck = all.filter(r => r.status === 'running');
    let stuckSwept = 0;
    for (const r of stuck) {
      try {
        const t = await readTrace(r.id, clientId);
        if (!t || t.status !== 'running') continue;
        t.status = 'failed';
        t.finishedAt = new Date().toISOString();
        t.error = t.error || 'cleared by user';
        await storage.writeTrace(t, clientId);
        stuckSwept++;
      } catch (e) {
        console.warn('[clear] sweep', r.id, e.message);
      }
    }
    const { sb } = require('../db/supabase');
    const { error, count } = await sb()
      .from('runs')
      .delete({ count: 'exact' })
      .eq('client_id', clientId)
      .eq('status', 'failed');
    if (error) throw error;
    runsCache.delete(clientId);
    res.json({ status: 'cleared', stuckSwept, failedDeleted: count || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/public/runs/:id — get one trace (scoped to this client)
router.get('/runs/:id', async (req, res) => {
  try {
    const trace = await readTrace(req.params.id, req.client.id);
    if (!trace) return res.status(404).json({ error: 'not found' });
    res.json(trace);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lightweight per-process cache: runId → ownerClientId. Replaces the old
// per-image-request `readTrace` round-trip that was timing out under load.
// 5 min TTL is fine — runs don't change ownership.
const runOwnerCache = new Map(); // runId → { clientId, t }
const RUN_OWNER_TTL_MS = 5 * 60 * 1000;
async function ownerOfRun(runId) {
  const hit = runOwnerCache.get(runId);
  if (hit && Date.now() - hit.t < RUN_OWNER_TTL_MS) return hit.clientId;
  const { sb } = require('../db/supabase');
  const { data } = await sb().from('runs').select('client_id').eq('id', runId).maybeSingle();
  const clientId = data?.client_id || null;
  if (clientId) runOwnerCache.set(runId, { clientId, t: Date.now() });
  return clientId;
}

// GET /api/public/runs/:id/images/:slug/:filename — single image, session-scoped.
// Optional `?w=N` query param triggers an on-demand resize (when sharp is
// available). Resized output is cached in-memory across requests.
router.get('/runs/:id/images/:slug/:filename', async (req, res) => {
  try {
    // Cheap ownership check (5-min cached). Replaces the heavy readTrace
    // call that was timing out per request under load.
    const owner = await ownerOfRun(req.params.id);
    if (!owner) return res.status(404).json({ error: 'not found' });
    if (owner !== req.client.id) return res.status(403).json({ error: 'forbidden' });
    // Parse ?w=N. Clamp to a small set of allowed widths so the cache key
    // space is bounded and clients can't spam unique sizes.
    const ALLOWED_W = [128, 256, 384, 512];
    let w = null;
    const wRaw = parseInt(req.query.w, 10);
    if (Number.isFinite(wRaw) && wRaw > 0) {
      w = ALLOWED_W.find(x => x >= wRaw) || null;
    }

    if (w && sharp) {
      const cacheKey = `${req.params.id}::${req.params.slug}::${req.params.filename}::${w}`;
      const cached = thumbCacheGet(cacheKey);
      if (cached) {
        res.set('Content-Type', 'image/webp');
        res.set('Cache-Control', 'private, max-age=86400');
        res.set('X-Thumb-Cache', 'hit');
        return res.send(cached);
      }
      try {
        const src = await storage.readImage(req.params.id, req.params.slug, req.params.filename);
        if (!src) return res.status(404).json({ error: 'image not found' });
        const out = await sharp(src).resize({ width: w }).webp({ quality: 80 }).toBuffer();
        thumbCacheSet(cacheKey, out);
        res.set('Content-Type', 'image/webp');
        res.set('Cache-Control', 'private, max-age=86400');
        res.set('X-Thumb-Cache', 'miss');
        return res.send(out);
      } catch (e) {
        // Thumbnail path failed (storage read flaky, sharp choked on a
        // weird PNG, etc.). Don't 500 — fall through to the raw image
        // path below so the tile still appears. Log so we can debug.
        console.warn('[thumb] resize failed, serving raw:', req.params.filename, '—', e.message);
      }
    }

    // Full-resolution fallback path (also taken when sharp isn't installed
    // OR when the thumbnail path errored above).
    const buf = await storage.readImage(req.params.id, req.params.slug, req.params.filename);
    if (!buf) return res.status(404).json({ error: 'image not found' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (e) {
    console.error('[image] route failed:', req.params.filename, '—', e.message);
    res.status(500).json({ error: e.message });
  }
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

// POST /api/public/zip-selection — bundles a hand-picked set of images
// (possibly across multiple runs) into a single streamed zip.
// Body: { items: [{ runId, slug, filename }, ...] }
router.post('/zip-selection', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'no items' });
  if (items.length > 1000) return res.status(400).json({ error: 'too many items' });

  // Validate every item belongs to this client and the file is real.
  // Cache traces per runId so we don't reload N times.
  const traceCache = new Map();
  const plan = [];
  for (const raw of items) {
    const runId = String(raw?.runId || '');
    const slug = String(raw?.slug || '');
    const filename = String(raw?.filename || '');
    if (!runId || !slug || !filename) continue;
    let trace = traceCache.get(runId);
    if (trace === undefined) {
      trace = await readTrace(runId, req.client.id).catch(() => null);
      traceCache.set(runId, trace);
    }
    if (!trace) continue;
    const renders = trace.stages?.renders?.items || {};
    const titles = trace.input?.titles || [];
    const title = titles.find(t => t.slug === slug);
    if (!title) continue;
    const arr = renders[title.id] || [];
    const hit = arr.find(it => it.filename === filename && it.status === 'ok');
    if (!hit) continue;
    plan.push({ runId, slug, filename });
  }
  if (!plan.length) return res.status(404).json({ error: 'no valid items' });

  const stamp = new Date().toISOString().slice(0, 10);
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="recast-selection-${stamp}.zip"`,
    'X-Approx-Content-Length': String(plan.length * 1_500_000)
  });

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', err => { if (err.code !== 'ENOENT') console.error('[zip] warn:', err); });
  archive.on('error', err => { console.error('[zip] error:', err); try { res.end(); } catch {} });
  archive.pipe(res);

  // Avoid intra-zip name collisions when the same {slug,filename} appears in
  // different runs by prefixing with a short run tag when needed.
  const seen = new Map();
  try {
    for (const { runId, slug, filename } of plan) {
      const buf = await storage.readImage(runId, slug, filename);
      if (!buf) continue;
      const baseName = `${slug}/${filename}`;
      const tag = runId.slice(0, 6);
      const dupKey = baseName;
      const useTag = seen.has(dupKey);
      seen.set(dupKey, true);
      const name = useTag ? `${slug}__${tag}/${filename}` : baseName;
      archive.append(buf, { name });
    }
    await archive.finalize();
  } catch (e) {
    console.error('[zip] selection stream failed:', e);
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
  // Per-connection cache: runId → ownerClientId. Populated cheaply when
  // `run.started` arrives (its payload carries trace.clientId, no DB hit).
  // Subsequent events use the cache; we only fall back to a one-time
  // ownerOfRun lookup if some other event arrives first (rare ordering edge).
  const ownerByRun = new Map();

  const send = (event, data) => {
    try {
      if (runFilter && data.id && data.id !== runFilter) return;
      if (!data.id) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return;
      }
      let owner = ownerByRun.get(data.id);
      // run.started carries the full trace inline — extract clientId from it
      // so we never have to hit the DB to authorize this run's events.
      if (!owner && event === 'run.started' && data.trace?.clientId) {
        owner = data.trace.clientId;
        ownerByRun.set(data.id, owner);
      }
      if (!owner) {
        // First-event-isn't-run.started edge case (or run from before this
        // connection opened). Fire one async lookup; cache the result. The
        // event is dropped if the run isn't ours, but later events for the
        // same run get authorized via the cache.
        ownerOfRun(data.id).then(o => { if (o) ownerByRun.set(data.id, o); }).catch(() => {});
        return;
      }
      if (owner !== req.client.id) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* connection probably closed */ }
  };
  const handlers = {};
  for (const [, v] of Object.entries(EVENTS)) {
    handlers[v] = (data) => send(v, data);
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
