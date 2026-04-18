const { EventEmitter } = require('events');
const { EVENTS } = require('./schema');
const createStorage = require('../storage');

const storage = createStorage();
const bus = new EventEmitter();
bus.setMaxListeners(200);

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
      shotList: { status: 'pending' },
      critic:   { status: 'pending' },
      resolved: { status: 'pending' },
      renders:  { status: 'pending', items: {} }
    },
    verdicts: {},
    error: null
  };

  let latest = trace;
  const persist = () => storage.writeTrace(latest, clientId).catch(e => console.error('[trace] persist', e.message));
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

module.exports = { bus, createTrace, readTrace, listTraces, computeHitRate, computeRenderProgress, EVENTS };
