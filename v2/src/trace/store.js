const { EventEmitter } = require('events');
const { EVENTS } = require('./schema');
const createStorage = require('../storage');

const storage = createStorage();
const bus = new EventEmitter();
bus.setMaxListeners(200);

// Rolling timing window for /healthz. Each successful render item appends
// { model, stage, elapsedMs }. We keep up to 200 entries (FIFO) so p50/p95
// reflect recent activity without unbounded memory growth.
const RENDER_TIMING_WINDOW = 200;
const renderTimings = [];
function recordRenderTiming(entry) {
  if (!entry || typeof entry.elapsedMs !== 'number') return;
  renderTimings.push({ model: entry.model, stage: entry.stage, ms: entry.elapsedMs, t: Date.now() });
  if (renderTimings.length > RENDER_TIMING_WINDOW) renderTimings.shift();
}
function summarizeRenderTimings() {
  if (!renderTimings.length) return { count: 0 };
  const byModel = {};
  for (const r of renderTimings) {
    const k = r.model || 'unknown';
    (byModel[k] = byModel[k] || []).push(r.ms);
  }
  const pct = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
  };
  const summary = { count: renderTimings.length, byModel: {} };
  for (const [m, arr] of Object.entries(byModel)) {
    summary.byModel[m] = { count: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95) };
  }
  return summary;
}

function newRunId() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rnd}`;
}

function computeHitRate(trace) {
  const verdicts = Object.values(trace.verdicts || {});
  const total = verdicts.length;
  const usable = verdicts.filter(v => v.verdict === 'usable' || v.verdict === 'winner').length;
  return { total, usable, rate: total ? Number((usable / total).toFixed(3)) : null };
}
function computeRenderProgress(trace) {
  // Prefer the counter-column path when the trace was loaded as a slim
  // listing (no items[] in stages.renders, just __counts). Fall back to
  // counting items when the full trace is present.
  if (trace.__counts) {
    const total = (trace.input?.titles?.length || 0) * (trace.input?.N || 0);
    return { ok: trace.__counts.ok || 0, failed: trace.__counts.failed || 0, total };
  }
  const items = Object.values(trace.stages?.renders?.items || {}).flat();
  const ok = items.filter(i => i.status === 'ok').length;
  const failed = items.filter(i => i.status === 'failed').length;
  const total = (trace.input?.titles?.length || 0) * (trace.input?.N || 0);
  return { ok, failed, total };
}

async function readTrace(id, clientId) {
  return storage.readTrace(id, clientId);
}
async function listTraces({ clientId } = {}) {
  const all = await storage.listTraces({ clientId });
  return all.map(t => ({
    id: t.id, cartridge: t.cartridge, status: t.status,
    startedAt: t.startedAt, finishedAt: t.finishedAt,
    titleCount: t.input?.titles?.length || 0,
    N: t.input?.N,
    // Slim summary of input so the UI can do skeleton math + slug lookups
    // without us projecting the entire `trace->input` JSON (which is large
    // and made the listing query exceed the 8s timeout).
    input: t.input ? {
      stage: t.input.stage || null,
      N: t.input.N,
      titles: Array.isArray(t.input.titles)
        ? t.input.titles.map(x => ({ id: x.id, slug: x.slug, title: x.title }))
        : []
    } : null,
    hitRate: computeHitRate(t),
    renderProgress: computeRenderProgress(t),
    stageStatus: {
      shotList: t.stages?.shotList?.status,
      critic:   t.stages?.critic?.status,
      resolved: t.stages?.resolved?.status,
      renders:  t.stages?.renders?.status
    }
  }));
}

function createTrace({ cartridge, input, clientId = null }) {
  const trace = {
    id: newRunId(),
    cartridge,
    clientId,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    input,
    stages: {
      shotList:     { status: 'pending' },
      critic:       { status: 'pending' },
      resolved:     { status: 'pending' },
      gpt2Rewrite:  { status: 'pending' },  // only runs when model is openai/gpt-image-2
      renders:      { status: 'pending', items: {} }
    },
    verdicts: {},
    error: null
  };

  let latest = trace;
  // Coalesce persists: keep only the latest snapshot pending while a write
  // is in flight. Render-heavy stages call mutate dozens of times per
  // second; without coalescing, every one of those triggers a separate full-
  // trace upsert and the chain backs up until Supabase times out the
  // statement. Now: write once, queue at most one more (the latest), drop
  // every intermediate snapshot in between.
  let pendingSnapshot = null;
  let writing = false;
  // Wall-clock timeout per persist write. A single hung Supabase upsert can
  // otherwise block the persist chain forever and the orchestrator never
  // reaches trace.finish(), leaving runs stuck in 'running' until the orphan
  // sweep catches them 15 minutes later.
  const PERSIST_TIMEOUT_MS = parseInt(process.env.PERSIST_TIMEOUT_MS || '10000', 10);
  async function writeWithTimeout(snap) {
    return Promise.race([
      storage.writeTrace(snap, clientId),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`persist timeout ${PERSIST_TIMEOUT_MS}ms`)), PERSIST_TIMEOUT_MS))
    ]);
  }
  async function flushLoop() {
    if (writing) return;
    writing = true;
    try {
      while (pendingSnapshot) {
        const snap = pendingSnapshot;
        pendingSnapshot = null;
        try { await writeWithTimeout(snap); }
        catch (e) { console.error('[trace] persist', e.message); }
      }
    } finally {
      writing = false;
    }
  }
  const persist = () => {
    pendingSnapshot = JSON.parse(JSON.stringify(latest));
    flushLoop();
  };
  persist();
  bus.emit(EVENTS.RUN_STARTED, { id: trace.id, trace });

  const mutate = (fn) => { fn(latest); persist(); };

  return {
    id: trace.id,
    get: () => latest,
    updateStage(name, patch) {
      mutate(t => { t.stages[name] = { ...t.stages[name], ...patch }; });
      bus.emit(EVENTS.STAGE_UPDATED, { id: trace.id, stage: name, value: latest.stages[name] });
    },
    startStage(name, meta = {}) {
      this.updateStage(name, { status: 'running', startedAt: new Date().toISOString(), ...meta });
      bus.emit(EVENTS.STAGE_STARTED, { id: trace.id, stage: name });
    },
    finishStage(name, patch = {}) {
      this.updateStage(name, { status: 'done', finishedAt: new Date().toISOString(), ...patch });
      bus.emit(EVENTS.STAGE_FINISHED, { id: trace.id, stage: name });
    },
    failStage(name, err) {
      this.updateStage(name, { status: 'failed', finishedAt: new Date().toISOString(), error: err?.message || String(err) });
    },
    recordRenderItem(tid, item) {
      mutate(t => {
        t.stages.renders.items[tid] = t.stages.renders.items[tid] || [];
        t.stages.renders.items[tid].push(item);
      });
      // Feed the rolling /healthz window. Only ok renders count toward
      // p50/p95 since failed retries skew the distribution.
      if (item.status === 'ok') recordRenderTiming(item);
      bus.emit(EVENTS.RENDER_ITEM, { id: trace.id, titleId: tid, item });
    },
    setVerdict(tid, filename, verdict, reasons = []) {
      mutate(t => { t.verdicts[`${tid}/${filename}`] = { verdict, reasons, taggedAt: new Date().toISOString() }; });
      bus.emit(EVENTS.VERDICT_SET, { id: trace.id, key: `${tid}/${filename}`, verdict, reasons });
    },
    finish(patch = {}) {
      mutate(t => { Object.assign(t, { status: 'done', finishedAt: new Date().toISOString(), ...patch }); });
      bus.emit(EVENTS.RUN_FINISHED, { id: trace.id });
    },
    fail(err) {
      mutate(t => { Object.assign(t, { status: 'failed', finishedAt: new Date().toISOString(), error: err?.message || String(err) }); });
      bus.emit(EVENTS.RUN_FAILED, { id: trace.id, error: err?.message });
    }
  };
}

module.exports = { bus, createTrace, readTrace, listTraces, computeHitRate, computeRenderProgress, EVENTS, summarizeRenderTimings };
