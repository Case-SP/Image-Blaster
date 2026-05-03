(function () {
  const API = '/api';
  const $ = (s) => document.querySelector(s);
  const N_CYCLE = [1, 2, 3, 4, 5];
  const INVITE = new URLSearchParams(location.search).get('invite');

  async function json(url, opts = {}) {
    const r = await fetch(url, {
      credentials: 'same-origin',
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || r.status);
    return body;
  }

  function show(which) {
    $('#email-section').hidden = which !== 'email';
    $('#code-section').hidden = which !== 'code';
    $('#access-section').hidden = which !== 'access';
    $('#app-section').hidden = which !== 'app';
  }

  // ---------- Auth (unchanged) ----------
  let pendingEmail = null;

  $('#email-btn').addEventListener('click', sendCode);
  $('#email').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCode(); });

  async function sendCode() {
    const email = $('#email').value.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      $('#email-msg').textContent = 'Please enter a valid email.';
      return;
    }
    $('#email-btn').disabled = true;
    $('#email-msg').textContent = '';
    try {
      const endpoint = INVITE ? `${API}/auth/signup` : `${API}/auth/request-code`;
      const body = INVITE ? { email, invite: INVITE } : { email };
      await json(endpoint, { method: 'POST', body: JSON.stringify(body) });
      pendingEmail = email;
      $('#code-email').textContent = email;
      show('code');
      $('#code').focus();
    } catch (err) {
      $('#email-msg').textContent = err.message;
    } finally {
      $('#email-btn').disabled = false;
    }
  }

  $('#code-btn').addEventListener('click', verifyCode);
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });

  async function verifyCode() {
    const code = $('#code').value.trim();
    if (!code) return;
    $('#code-btn').disabled = true;
    $('#code-msg').textContent = '';
    try {
      await json(`${API}/auth/verify-code`, {
        method: 'POST',
        body: JSON.stringify({ email: pendingEmail, code })
      });
      enterApp();
    } catch (err) {
      $('#code-msg').textContent = err.message;
    } finally {
      $('#code-btn').disabled = false;
    }
  }

  $('#resend-btn').addEventListener('click', async () => {
    if (!pendingEmail) return;
    $('#code-msg').textContent = 'Sending…';
    try {
      await json(`${API}/auth/request-code`, { method: 'POST', body: JSON.stringify({ email: pendingEmail }) });
      $('#code-msg').textContent = 'New code sent.';
    } catch (err) {
      $('#code-msg').textContent = err.message;
    }
  });

  $('#have-code-btn').addEventListener('click', () => { show('access'); $('#access-code').focus(); });
  $('#back-to-email-btn').addEventListener('click', () => { show('email'); $('#email').focus(); });
  $('#access-btn').addEventListener('click', redeemAccess);
  $('#access-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') redeemAccess(); });

  async function redeemAccess() {
    const code = $('#access-code').value.trim();
    if (!/^\d{6}$/.test(code)) {
      $('#access-msg').textContent = 'Enter the 6-digit code.';
      return;
    }
    $('#access-btn').disabled = true;
    $('#access-msg').textContent = '';
    try {
      await json(`${API}/auth/redeem-code`, { method: 'POST', body: JSON.stringify({ code }) });
      enterApp();
    } catch (err) {
      $('#access-msg').textContent = err.message;
    } finally {
      $('#access-btn').disabled = false;
    }
  }

  // ---------- App state ----------
  const tracesById = new Map();   // runId -> trace (with renders)
  const runsList = [];            // ordered: newest first
  const selected = new Set();     // imageKey -> selected
  const tilesByKey = new Map();   // imageKey -> { tile, item }

  // Image key uniquely identifies one tile across runs.
  const keyOf = (runId, slug, filename) => `${runId}::${slug}::${filename}`;

  // ---------- Pill input + bubbles ----------
  const ALL_MODELS = [
    { label: 'nano',  ids: ['fal-ai/nano-banana-pro'], experimental: false },
    { label: 'flux',  ids: ['fal-ai/flux-pro/v1.1-ultra'], experimental: false },
    { label: 'gpt-2', ids: ['openai/gpt-image-2'],     experimental: true  },
    { label: 'both',  ids: ['fal-ai/nano-banana-pro', 'openai/gpt-image-2'], experimental: true },
    { label: 'all',   ids: ['fal-ai/nano-banana-pro', 'fal-ai/flux-pro/v1.1-ultra', 'openai/gpt-image-2'], experimental: true }
  ];
  let MODEL_CYCLE = ALL_MODELS.filter(m => !m.experimental);

  let CARTRIDGE_LIST = ['nolla'];
  let CARTRIDGE_PROFILES = {};   // name → profile slice from /api/public/cartridges
  let IS_EXPERIMENTAL = false;
  function currentCartridge() { return $('#cart-btn').textContent; }
  function currentProfile() { return CARTRIDGE_PROFILES[currentCartridge()] || {}; }
  function setCartridge(name) {
    $('#cart-btn').textContent = name;
    try { localStorage.setItem('cartridge', name); } catch {}
  }

  // Per-cartridge model menu. Cartridge declares allowed_models in profile;
  // we filter ALL_MODELS so a cycle option only stays in if every one of its
  // ids is allowed. Experimental gate applies after.
  function filteredModelCycle() {
    const allowed = currentProfile().allowed_models;
    let cycle = ALL_MODELS;
    if (Array.isArray(allowed) && allowed.length) {
      cycle = cycle.filter(m => m.ids.every(id => allowed.includes(id)));
    }
    if (!IS_EXPERIMENTAL) cycle = cycle.filter(m => !m.experimental);
    return cycle.length ? cycle : [ALL_MODELS[0]];
  }
  function refreshModelCycle() {
    MODEL_CYCLE = filteredModelCycle();
    // Product cartridge is locked to `both` (nano + gpt-2 simultaneously).
    // Bubble is disabled so the user can't cycle off it.
    if (currentCartridge() === 'product') {
      const both = MODEL_CYCLE.find(m => m.label === 'both');
      if (both) {
        $('#model-btn').textContent = 'both';
        $('#model-btn').dataset.model = both.ids[0];
        $('#model-btn').disabled = true;
        $('#model-btn').title = 'Product runs always use both nano + gpt-2';
        updateTotals();
        return;
      }
    }
    $('#model-btn').disabled = false;
    $('#model-btn').title = 'Model (click to cycle)';
    const curLabel = $('#model-btn').textContent;
    if (!MODEL_CYCLE.find(m => m.label === curLabel)) {
      $('#model-btn').textContent = MODEL_CYCLE[0].label;
      $('#model-btn').dataset.model = MODEL_CYCLE[0].ids[0];
    }
    updateTotals();
  }

  $('#cart-btn').addEventListener('click', () => {
    if (!CARTRIDGE_LIST.length) return;
    const cur = currentCartridge();
    const idx = CARTRIDGE_LIST.indexOf(cur);
    setCartridge(CARTRIDGE_LIST[(idx + 1) % CARTRIDGE_LIST.length]);
    refreshModelCycle();
    // Re-scope grid + selection to the new cartridge.
    selected.clear();
    renderStatus();
    renderGrid();
    updateDownloadBubble();
  });

  function currentN() { return parseInt($('#n-btn').textContent, 10) || 3; }
  function setN(n) { $('#n-btn').textContent = String(n); }
  function currentModelIds() {
    const label = $('#model-btn').textContent;
    return (MODEL_CYCLE.find(m => m.label === label) || MODEL_CYCLE[0]).ids;
  }

  $('#n-btn').addEventListener('click', () => {
    const cur = currentN();
    const idx = N_CYCLE.indexOf(cur);
    setN(N_CYCLE[(idx + 1) % N_CYCLE.length]);
    updateTotals();
  });

  $('#model-btn').addEventListener('click', () => {
    const label = $('#model-btn').textContent;
    const idx = MODEL_CYCLE.findIndex(m => m.label === label);
    const next = MODEL_CYCLE[(idx + 1) % MODEL_CYCLE.length];
    $('#model-btn').textContent = next.label;
    $('#model-btn').dataset.model = next.ids[0];
    updateTotals();
  });

  function countTitles() {
    return $('#titles').value.trim().split('\n').map(x => x.trim()).filter(Boolean).length;
  }
  function updateTotals() {
    const t = countTitles();
    const n = currentN();
    const ids = currentModelIds();
    const m = Math.max(1, ids.length);
    if (t === 0) { $('#totals').textContent = ''; return; }
    const base = `${t} × ${n}`;
    $('#totals').textContent = m > 1
      ? `${base} × ${m} models = ${t * n * m} images`
      : `${base} = ${t * n} images`;
  }

  // Auto-grow textarea
  const ta = $('#titles');
  function autosize() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(200, ta.scrollHeight) + 'px';
  }
  ta.addEventListener('input', () => { autosize(); updateTotals(); });

  // Enter submits, Shift+Enter inserts newline
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      submitGenerate();
    }
  });

  $('#signout-btn').addEventListener('click', async () => {
    await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'same-origin' });
    location.reload();
  });

  async function submitGenerate() {
    const titles = ta.value.trim().split('\n').map(x => x.trim()).filter(Boolean);
    if (!titles.length) return;
    const N = currentN();
    const total = titles.length * N;

    if (titles.length > 50 || total > 200) {
      const ok = confirm(`${total} images (${titles.length} titles × ${N}).\n\n~${Math.ceil(total * 4 / 60)} min. Continue?`);
      if (!ok) return;
    }

    try {
      const modelIds = currentModelIds();
      const cartridge = currentCartridge();
      const base = modelIds.length > 1
        ? { titles, N, models: modelIds }
        : { titles, N, model: modelIds[0] };
      let body = cartridge ? { ...base, cartridge } : base;
      // Product cartridge starts every fresh input at the sketch stage. Later
      // stages happen via promotion; the orchestrator restricts the cycle to
      // the requested stage.
      if (cartridge === 'product') body = { ...body, stage: 'sketch' };
      await json(`${API}/public/runs`, { method: 'POST', body: JSON.stringify(body) });
      ta.value = '';
      autosize();
      updateTotals();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
    await refreshRuns();
  }

  // ---------- App boot ----------
  async function enterApp() {
    show('app');
    try {
      const me = await json(`${API}/public/me`);
      const defN = Math.min(5, Math.max(1, parseInt(me.n_per_title, 10) || 3));
      setN(defN);
      IS_EXPERIMENTAL = !!me.experimental;
    } catch {
      setN(3);
    }
    try {
      const r = await json(`${API}/public/cartridges`);
      if (Array.isArray(r.cartridges) && r.cartridges.length) {
        CARTRIDGE_LIST = r.cartridges;
        CARTRIDGE_PROFILES = r.profiles || {};
        const stored = (() => { try { return localStorage.getItem('cartridge'); } catch { return null; } })();
        const initial = stored && CARTRIDGE_LIST.includes(stored)
          ? stored
          : (r.active && CARTRIDGE_LIST.includes(r.active) ? r.active : CARTRIDGE_LIST[0]);
        setCartridge(initial);
        if (!r.override) {
          $('#cart-btn').disabled = true;
          $('#cart-btn').title = 'Cartridge pinned by server';
        }
      }
    } catch {}
    refreshModelCycle();
    updateTotals();
    autosize();
    await refreshRuns(true);
    openSSE();
  }

  // ---------- Runs → flat grid ----------
  // Flat tile cache for the funnel — populated from /api/public/tiles. One
  // small query gets every image at once; no per-run trace fetching.
  let flatTiles = [];

  // ---------- Tile-cache persistence ----------
  // The /tiles endpoint takes 5-10s on cold cache because Supabase has no
  // cartridge index — we work around it by serving the last-known tile set
  // from localStorage on cold load (instant) and refreshing in the background.
  // Capped at ~2 MB (well under the 5 MB localStorage quota): each entry is
  // ~250 bytes × 2000 entries ≈ 500 KB, so we have plenty of headroom.
  const TILE_CACHE_KEY = 'flatTiles.v1';
  const TILE_CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour — old cache is fine to show briefly
  function loadCachedTiles() {
    try {
      const raw = localStorage.getItem(TILE_CACHE_KEY);
      if (!raw) return null;
      const { t, cartridge, data } = JSON.parse(raw);
      if (!Array.isArray(data) || (Date.now() - t) > TILE_CACHE_TTL_MS) return null;
      return { cartridge, data };
    } catch { return null; }
  }
  function saveCachedTiles(cartridge, data) {
    try {
      localStorage.setItem(TILE_CACHE_KEY, JSON.stringify({ t: Date.now(), cartridge, data }));
    } catch { /* quota — ignore, cache is best-effort */ }
  }

  // ---------- Status footer (live health widget) ----------
  // Declared early (before renderStatus) so renderStatus can safely call
  // statusFoot.paint() during boot without hitting the const TDZ.
  const statusFoot = {
    sseState: 'connecting',
    dbMs: null,
    warning: null,
    renderSummary: null,
    set(key, v) { this[key] = v; this.paint(); },
    paint() {
      const root = document.getElementById('status-foot');
      if (!root) return;
      root.hidden = false;
      const dot = root.querySelector('[data-key="sse"]');
      if (dot) {
        dot.classList.remove('ok', 'warn', 'err');
        dot.classList.add(this.sseState === 'open' ? 'ok' : (this.sseState === 'connecting' ? 'warn' : 'err'));
        dot.title = `SSE: ${this.sseState}`;
      }
      const dbEl = root.querySelector('[data-key="db"]');
      if (dbEl) {
        dbEl.textContent = this.dbMs == null ? 'DB —' : `DB ${this.dbMs}ms`;
        dbEl.classList.toggle('slow', this.dbMs != null && this.dbMs > 1000);
      }
      const tilesEl = root.querySelector('[data-key="tiles"]');
      if (tilesEl) tilesEl.textContent = `${flatTiles.length} tiles`;
      const inflight = runsList.filter(r => r.status === 'running').length;
      const ifEl = root.querySelector('[data-key="inflight"]');
      if (ifEl) {
        ifEl.textContent = `${inflight} in-flight`;
        ifEl.classList.toggle('active', inflight > 0);
      }
      const rEl = root.querySelector('[data-key="renders"]');
      if (rEl && this.renderSummary && this.renderSummary.count) {
        const models = Object.entries(this.renderSummary.byModel || {});
        const top = models.sort((a,b) => b[1].count - a[1].count)[0];
        if (top) {
          rEl.hidden = false;
          rEl.textContent = `${top[0].split('/').pop()} p50 ${(top[1].p50/1000).toFixed(1)}s`;
        }
      }
      const warnEl = root.querySelector('[data-key="warn"]');
      if (warnEl) {
        if (this.warning) { warnEl.hidden = false; warnEl.textContent = this.warning; }
        else { warnEl.hidden = true; warnEl.textContent = ''; }
      }
    }
  };
  async function pollHealthz() {
    try {
      const t0 = performance.now();
      const r = await fetch(`${API}/public/healthz`, { credentials: 'include' });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      const rtt = Math.round(performance.now() - t0);
      // Server returns -1 as a sentinel for probe failure; treat that as
      // unknown and fall back to the round-trip wall time so the chip stays
      // informative rather than misleading.
      const serverDb = (typeof data.db_ms === 'number' && data.db_ms >= 0) ? data.db_ms : null;
      statusFoot.dbMs = serverDb ?? rtt;
      statusFoot.warning = (data.warnings && data.warnings[0]) || (data.db_err ? `db: ${data.db_err}` : null);
      statusFoot.renderSummary = data.renders || null;
    } catch {
      statusFoot.dbMs = null;
      statusFoot.warning = 'healthz offline';
    }
    statusFoot.paint();
  }
  setInterval(pollHealthz, 30000);
  setInterval(() => statusFoot.paint(), 2000);

  async function refreshRuns(initial = false) {
    let runs;
    try { runs = await json(`${API}/public/runs`); }
    catch { runs = null; }
    if (Array.isArray(runs) && (runs.length > 0 || runsList.length === 0)) {
      const merged = new Map(runsList.map(r => [r.id, r]));
      for (const r of runs) merged.set(r.id, r);
      runsList.length = 0;
      for (const r of merged.values()) runsList.push(r);
      runsList.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    }

    // For the product cartridge, seed the funnel instantly from
    // localStorage (last-known tile set), then kick off /tiles refresh in
    // the background. The user starts working on cached data within
    // milliseconds; the network refresh merges in when it lands. SSE keeps
    // newly-arriving tiles live regardless.
    if (currentCartridge() === 'product') {
      if (initial) {
        const cached = loadCachedTiles();
        if (cached && cached.cartridge === 'product' && cached.data.length) {
          flatTiles = cached.data;
        }
      }
      // Background refresh — don't block this function.
      (async () => {
        try {
          const tiles = await json(`${API}/public/tiles?cartridge=product&limit=2000`);
          if (Array.isArray(tiles)) {
            // Merge: prefer the server set as authoritative for slugs/urls,
            // but keep any SSE-added tiles whose key isn't in the server set
            // (they may be newer than the cached query window).
            const serverKeys = new Set(tiles.map(t => `${t.runId}::${t.slug}::${t.filename}`));
            const sseExtras = flatTiles.filter(t => !serverKeys.has(`${t.runId}::${t.slug}::${t.filename}`));
            flatTiles = [...sseExtras, ...tiles];
            saveCachedTiles('product', flatTiles);
            renderStatus();
            renderGrid();
          }
        } catch { /* leave cached tiles in place */ }
      })();
    }

    renderStatus();
    renderGrid();
  }

  function runsForCurrentCartridge() {
    const cart = currentCartridge();
    if (!cart) return runsList;
    return runsList.filter(r => (r.cartridge || null) === cart);
  }

  function renderStatus() {
    statusFoot.paint();
    const strip = $('#status-strip');
    // Show all in-flight runs, plus failures within the last 30 min so swept
    // orphans don't sit at the top of the UI permanently. Older failures are
    // filtered out — they live in the run list but not in the status strip.
    const FAILED_DISMISS_MS = 30 * 60 * 1000;
    const cutoff = Date.now() - FAILED_DISMISS_MS;
    const active = runsForCurrentCartridge().filter(r => {
      if (r.status === 'running') return true;
      if (r.status === 'failed') {
        const finishedAt = r.finishedAt || r.startedAt;
        return finishedAt && new Date(finishedAt).getTime() > cutoff;
      }
      return false;
    });
    // Also offer a clear button when there are running/failed across ALL
    // cartridges, not just the active one — bulk cleanup is a global action.
    const allActive = runsList.filter(r => {
      if (r.status === 'running') return true;
      if (r.status === 'failed') {
        const finishedAt = r.finishedAt || r.startedAt;
        return finishedAt && new Date(finishedAt).getTime() > cutoff;
      }
      return false;
    });
    if (!active.length && !allActive.length) { strip.hidden = true; strip.innerHTML = ''; return; }
    strip.hidden = false;
    const STRIP_MAX = 4;
    const visibleChips = active.slice(0, STRIP_MAX);
    const hiddenCount = active.length - visibleChips.length;
    const chipsHtml = visibleChips.map(r => {
      const p = r.renderProgress || { ok: 0, failed: 0, total: 0 };
      const done = p.ok + p.failed;
      const cls = r.status === 'failed' ? 'failed' : '';
      const txt = r.status === 'failed'
        ? `failed · ${p.ok}/${p.total}`
        : `generating · ${done}/${p.total}`;
      return `<div class="status-chip ${cls}"><span class="dot"></span>${txt}</div>`;
    }).join('') + (hiddenCount > 0
      ? `<div class="status-chip"><span class="dot"></span>+${hiddenCount} more in flight</div>`
      : '');
    // Visible chip count after applying the local dismiss filter.
    const visibleActive = active.filter(r => !DISMISSED_RUN_IDS.has(r.id));
    const dismissBtn = visibleActive.length
      ? `<button type="button" class="status-clear" data-action="dismiss-chips" title="Hide these chips. Data stays in the database.">Dismiss</button>`
      : '';
    strip.innerHTML = visibleActive.map(r => {
      const p = r.renderProgress || { ok: 0, failed: 0, total: 0 };
      const done = p.ok + p.failed;
      const cls = r.status === 'failed' ? 'failed' : '';
      const txt = r.status === 'failed'
        ? `failed · ${p.ok}/${p.total}`
        : `generating · ${done}/${p.total}`;
      return `<div class="status-chip ${cls}"><span class="dot"></span>${txt}</div>`;
    }).join('') + dismissBtn;
    if (!visibleActive.length) { strip.hidden = true; strip.innerHTML = ''; }
  }

  // Session-only dismiss. Chips auto-clear when run.finished/run.failed
  // events patch the run's status — dismiss is just a force-clear override
  // for chips that are stuck because the SSE event was missed (e.g.
  // disconnected and the run completed during the gap). NOT persisted to
  // localStorage; cleared on reload so we never end up with stale dismiss
  // records hiding live work.
  const DISMISSED_RUN_IDS = new Set();
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="dismiss-chips"]')) return;
    for (const r of runsList) {
      if (r.status === 'failed' || r.status === 'running') DISMISSED_RUN_IDS.add(r.id);
    }
    renderStatus();
  });

  // For the product cartridge, prefer the flat tiles list (one DB query, no
  // per-run trace JSON). For other cartridges or when the flat list isn't
  // populated yet, fall back to iterating loaded traces.
  function flattenItems() {
    const cart = currentCartridge();
    if (cart === 'product' && flatTiles.length) {
      // Start from the server-rendered flat list, overlay any SSE-streamed
      // in-flight items that aren't yet in the flat list.
      const seen = new Set();
      const out = flatTiles.map(t => {
        const k = `${t.runId}::${t.slug}::${t.filename}`;
        seen.add(k);
        return { ...t, prompt: '' };  // prompt loads lazily on lightbox open
      });
      // Overlay live items from tracesById that aren't yet in flatTiles
      for (const trace of tracesById.values()) {
        if (trace.cartridge !== cart) continue;
        const titles = trace.input?.titles || [];
        const titlesById = new Map(titles.map(t => [t.id, t]));
        const items = trace.stages?.renders?.items || {};
        for (const [titleId, arr] of Object.entries(items)) {
          const t = titlesById.get(titleId);
          if (!t) continue;
          for (const it of arr) {
            if (it.status !== 'ok') continue;
            const k = `${trace.id}::${t.slug}::${it.filename}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({
              runId: trace.id,
              runStartedAt: trace.startedAt,
              titleId, title: t.title, slug: t.slug,
              filename: it.filename,
              model: it.model,
              promptIdx: it.promptIdx,
              prompt: pickPromptText((trace.stages?.resolved?.prompts?.[titleId] || [])[it.promptIdx] || {}, it),
              composition: it.stage || '',
              theme: '',
              stage: it.stage || '',
              parent: it.parent || null,
              url: `${API}/public/runs/${trace.id}/images/${encodeURIComponent(t.slug)}/${encodeURIComponent(it.filename)}`,
            });
          }
        }
      }
      out.sort((a, b) => (b.runStartedAt || '').localeCompare(a.runStartedAt || ''));
      return out;
    }
    // Non-product cartridges: legacy trace iteration.
    const out = [];
    const sortedTraces = [...tracesById.values()].sort((a, b) =>
      (b.startedAt || '').localeCompare(a.startedAt || ''));
    for (const trace of sortedTraces) {
      if (cart && trace.cartridge !== cart) continue;
      const r = { id: trace.id, startedAt: trace.startedAt };
      const titles = trace.input?.titles || [];
      const titlesById = new Map(titles.map(t => [t.id, t]));
      const items = trace.stages?.renders?.items || {};
      const resolved = trace.stages?.resolved?.prompts || {};
      for (const [titleId, arr] of Object.entries(items)) {
        const t = titlesById.get(titleId);
        if (!t) continue;
        const shots = resolved[titleId] || [];
        for (const it of arr) {
          if (it.status !== 'ok') continue;  // skip failed/pending in grid
          const shot = shots[it.promptIdx] || {};
          const promptText = pickPromptText(shot, it);
          out.push({
            runId: r.id,
            runStartedAt: r.startedAt,
            titleId, title: t.title, slug: t.slug,
            filename: it.filename,
            model: it.model,
            promptIdx: it.promptIdx,
            prompt: promptText,
            composition: shot.composition || '',
            theme: shot.theme || '',
            stage: it.stage || shot.composition || '',
            parent: it.parent || shot.parent || null,
            url: `${API}/public/runs/${r.id}/images/${encodeURIComponent(t.slug)}/${encodeURIComponent(it.filename)}`,
          });
        }
      }
    }
    return out;
  }

  function pickPromptText(shot, item) {
    if (!shot) return '';
    if (item.model && item.model.includes('gpt-image-2') && shot.__gpt2Prompt) return shot.__gpt2Prompt;
    return shot.prompt || '';
  }

  function modelLabel(modelId) {
    if (!modelId) return '—';
    if (modelId === 'openai/gpt-image-2/edit') return 'gpt-2-e';
    if (modelId.includes('gpt-image-2')) return 'gpt-2';
    if (modelId.includes('nano-banana')) return 'nano';
    if (modelId.includes('flux-pro')) return 'flux';
    return modelId.split('/').pop();
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const PRODUCT_STAGES = ['sketch', 'product-shot', 'in-situ'];
  const STAGE_LABEL = { 'sketch': 'Sketch', 'product-shot': 'Product', 'in-situ': 'In-situ' };
  const NEXT_STAGE = { 'sketch': 'product-shot', 'product-shot': 'in-situ', 'in-situ': null };
  const COLUMN_DEFAULT_LIMIT = 12;
  const showAllByCol = new Set(); // stages where the column is expanded to show older items
  const STAGE_NOTE_PLACEHOLDER = {
    'product-shot': 'material + color note (e.g. "walnut, matte")',
    'in-situ': 'in-situ scene note (e.g. "tatami room, shoji light")'
  };
  const isProductCartridge = () => currentCartridge() === 'product';

  function renderGrid() {
    const grid = $('#grid');
    const empty = $('#grid-empty');
    const funnel = $('#funnel');
    const items = flattenItems();

    // Hide/show grid vs funnel by cartridge
    if (isProductCartridge()) {
      grid.hidden = true;
      empty.hidden = true;
      funnel.hidden = false;
      renderFunnel(items);
      return;
    }
    grid.hidden = false;
    funnel.hidden = true;

    if (!items.length) {
      grid.innerHTML = '';
      const cart = currentCartridge();
      empty.textContent = cart
        ? `No generations yet for ${cart} — paste objects above and press ⏎.`
        : 'No generations yet — paste titles above and press ⏎.';
      empty.hidden = false;
      tilesByKey.clear();
      pruneSelection(new Set());
      return;
    }
    empty.hidden = true;

    const presentKeys = new Set();
    const frag = document.createDocumentFragment();

    for (const it of items) {
      const key = keyOf(it.runId, it.slug, it.filename);
      presentKeys.add(key);
      let entry = tilesByKey.get(key);
      if (!entry) {
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.dataset.key = key;
        tile.innerHTML = `
          <button type="button" class="tile-select" aria-label="Select" data-action="select">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </button>
          <img loading="lazy" alt="${escHtml(it.title)}" src="${it.url}?w=384" onerror="this.closest('.tile')?.classList.add('img-broken'); this.removeAttribute('src');">
          <div class="tile-model">${escHtml(modelLabel(it.model))}</div>`;
        entry = { tile, item: it };
        tilesByKey.set(key, entry);
      } else {
        entry.item = it;
      }
      if (selected.has(key)) entry.tile.classList.add('selected');
      else entry.tile.classList.remove('selected');
      frag.appendChild(entry.tile);
    }

    // Replace grid contents in display order without losing tile identity.
    grid.innerHTML = '';
    grid.appendChild(frag);

    // Don't aggressively prune tilesByKey/selection on every render. Items
    // briefly disappear during transient empty fetches; pruning would wipe
    // selections and cause tile flicker. GC happens on cartridge switch only.
    updateDownloadBubble();
  }

  function pruneSelection(presentKeys) {
    for (const k of [...selected]) if (!presentKeys.has(k)) selected.delete(k);
  }

  // ---------- Product-cartridge staged funnel ----------
  // Per-stage skeleton DOM cache. Skeletons represent expected-but-not-yet-
  // arrived renders for any in-flight run targeting that stage. They live
  // at the top of the column body and are replaced by real tiles as
  // render.item events arrive (i.e. flatTiles grows, skel count drops).
  const skelByStage = new Map();
  function makeSkeleton() {
    const el = document.createElement('div');
    el.className = 'tile skeleton';
    el.innerHTML = '<div class="skel-shimmer"></div>';
    return el;
  }
  function expectedSkelCountForStage(stage) {
    let n = 0;
    for (const r of runsList) {
      if (r.status !== 'running') continue;
      if (r.cartridge !== 'product') continue;
      const target = r.input?.stage || 'sketch';
      if (target !== stage) continue;
      const titles = r.input?.titles?.length || 0;
      const N = r.input?.N || 1;
      const total = titles * N;
      const done = (r.renderProgress?.ok || 0) + (r.renderProgress?.failed || 0);
      n += Math.max(0, total - done);
    }
    return n;
  }
  function syncSkeletonsAt(stage, body, count) {
    let arr = skelByStage.get(stage) || [];
    while (arr.length < count) arr.push(makeSkeleton());
    while (arr.length > count) {
      const removed = arr.pop();
      if (removed.parentNode) removed.remove();
    }
    skelByStage.set(stage, arr);
    // Insert at top, preserving order.
    for (let i = arr.length - 1; i >= 0; i--) {
      if (body.firstChild !== arr[i]) body.insertBefore(arr[i], body.firstChild);
    }
  }

  function renderFunnel(items) {
    const funnel = $('#funnel');
    const presentKeys = new Set();

    // Group by stage. Items with unknown/missing stage land under 'sketch' so
    // legacy renders stay visible somewhere.
    const byStage = { 'sketch': [], 'product-shot': [], 'in-situ': [] };
    for (const it of items) {
      const s = PRODUCT_STAGES.includes(it.stage) ? it.stage : 'sketch';
      byStage[s].push(it);
    }

    // Build a children-count map: parentKey → number of child renders. Used to
    // mark tiles that have already been promoted to the next stage.
    const childrenCount = new Map();
    for (const it of items) {
      const p = it.parent;
      if (!p || !p.runId || !p.slug || !p.filename) continue;
      const k = keyOf(p.runId, p.slug, p.filename);
      childrenCount.set(k, (childrenCount.get(k) || 0) + 1);
    }

    for (const stage of PRODUCT_STAGES) {
      const col = funnel.querySelector(`.funnel-col[data-stage="${stage}"]`);
      const body = col.querySelector('[data-body]');
      const count = col.querySelector('[data-count]');
      // Sort by run-start descending and slice to the recent window. Older
      // items live in the cache; the "Show N older" button at the column
      // foot expands the view in place.
      const allStageItems = [...byStage[stage]].sort((a, b) =>
        (b.runStartedAt || '').localeCompare(a.runStartedAt || ''));
      const expanded = showAllByCol.has(stage);
      const stageItems = expanded ? allStageItems : allStageItems.slice(0, COLUMN_DEFAULT_LIMIT);
      const olderCount = allStageItems.length - stageItems.length;
      const totalCount = allStageItems.length;
      const skelCount = expectedSkelCountForStage(stage);
      count.textContent = totalCount ? (expanded || olderCount === 0 ? `${totalCount}` : `${stageItems.length}/${totalCount}`) : (skelCount ? `${skelCount}…` : '');

      if (!totalCount && !skelCount) {
        body.innerHTML = `<div class="funnel-empty">${stage === 'sketch' ? 'Type an object above and press ⏎.' : 'Promote selections from the previous stage.'}</div>`;
      } else if (!totalCount) {
        // No real tiles yet — body is empty (or holds the previous empty
        // placeholder). Wipe just the placeholder, then drop the skeletons in.
        const placeholder = body.querySelector(':scope > .funnel-empty');
        if (placeholder) placeholder.remove();
        // Detach old skeletons so syncSkeletonsAt rebuilds cleanly.
        const oldSkels = [...body.querySelectorAll(':scope > .skeleton')];
        oldSkels.forEach(s => s.remove());
        // Restore cache pointers (oldSkels still in the array but detached)
        // — easier to just rebuild the array via syncSkeletonsAt(0) then sync
        // up to skelCount.
        skelByStage.set(stage, []);
        syncSkeletonsAt(stage, body, skelCount);
      } else {
        // INCREMENTAL RECONCILE — never `innerHTML = ''`. Walk the desired
        // visible set in order and either insertBefore an existing tile (if
        // it's already in the DOM elsewhere in body) or create+insert a new
        // one. Then remove tiles whose keys aren't in the desired set. This
        // preserves scroll position, hover state, image-decoding work, and
        // selection ring without flicker.
        const desiredKeys = [];
        for (const it of stageItems) {
          const key = keyOf(it.runId, it.slug, it.filename);
          desiredKeys.push(key);
          presentKeys.add(key);
          let entry = tilesByKey.get(key);
          if (!entry) {
            const next = NEXT_STAGE[stage];
            const circleTip = next ? `Promote to ${STAGE_LABEL[next]}` : 'Select for download';
            const tile = document.createElement('div');
            tile.className = 'tile';
            tile.dataset.key = key;
            tile.innerHTML = `
              <button type="button" class="tile-select" aria-label="${escHtml(circleTip)}" title="${escHtml(circleTip)}" data-action="select">
                ${next ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`}
              </button>
              <button type="button" class="tile-dl-select" aria-label="Select for download" title="Select for download" data-action="download-select">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 4v12"></path>
                  <path d="M6 12l6 6 6-6"></path>
                  <path d="M5 20h14"></path>
                </svg>
              </button>
              <button type="button" class="tile-amplify" aria-label="Amplify" data-action="amplify" title="More like this">+</button>
              <img loading="lazy" alt="${escHtml(it.title)}" src="${it.url}?w=384" onerror="this.closest('.tile')?.classList.add('img-broken'); this.removeAttribute('src');">
              <div class="tile-model">${escHtml(modelLabel(it.model))}</div>`;
            entry = { tile, item: it };
            tilesByKey.set(key, entry);
          } else {
            entry.item = it;
          }
          if (selected.has(key)) entry.tile.classList.add('selected');
          else entry.tile.classList.remove('selected');

          const childCount = childrenCount.get(key) || 0;
          const existingPromoted = entry.tile.querySelector('.tile-promoted');
          if (childCount > 0) {
            entry.tile.classList.add('promoted');
            const text = `→ ${childCount}`;
            if (existingPromoted) {
              existingPromoted.textContent = text;
            } else {
              const badge = document.createElement('div');
              badge.className = 'tile-promoted';
              badge.textContent = text;
              badge.title = `${childCount} child render${childCount === 1 ? '' : 's'} in next stage`;
              entry.tile.appendChild(badge);
            }
          } else {
            entry.tile.classList.remove('promoted');
            if (existingPromoted) existingPromoted.remove();
          }
        }
        // Reconcile DOM in-place against the desired ordered list.
        const desiredSet = new Set(desiredKeys);
        // Detach existing skeletons so the index walk doesn't trip over
        // them; we'll re-attach at the top after the real tiles are placed.
        const detachedSkels = [...body.querySelectorAll(':scope > .skeleton')];
        detachedSkels.forEach(s => s.remove());
        // 1. Remove tiles that are no longer desired (e.g. column collapse).
        for (const child of [...body.children]) {
          const k = child.dataset?.key;
          if (!k || !desiredSet.has(k) || !child.classList.contains('tile')) child.remove();
        }
        // 2. Walk desired order; ensure each tile is at the correct index.
        for (let i = 0; i < desiredKeys.length; i++) {
          const want = desiredKeys[i];
          const want_node = tilesByKey.get(want)?.tile;
          if (!want_node) continue;
          const cur = body.children[i];
          if (cur !== want_node) body.insertBefore(want_node, cur || null);
        }
        // 3. Re-attach skeletons at the top, sized to the current expected.
        skelByStage.set(stage, []);
        syncSkeletonsAt(stage, body, skelCount);
      }

      renderColumnFoot(col, stage, { totalCount, visibleCount: stageItems.length, olderCount });
      renderColumnAction(col, stage);
    }
    // No pruning of tilesByKey/selection — see note in renderGrid above.
    updateDownloadBubble();
  }

  function selectedInStage(stage) {
    const out = [];
    for (const k of selected) {
      const entry = tilesByKey.get(k);
      if (!entry) continue;
      const s = PRODUCT_STAGES.includes(entry.item.stage) ? entry.item.stage : 'sketch';
      if (s === stage) out.push(entry);
    }
    return out;
  }

  function renderColumnFoot(col, stage, info = {}) {
    const foot = col.querySelector('[data-foot]');
    const expanded = showAllByCol.has(stage);
    const olderCount = info.olderCount || 0;
    const totalCount = info.totalCount || 0;
    if (expanded && totalCount > COLUMN_DEFAULT_LIMIT) {
      foot.innerHTML = `<div class="row"><button type="button" data-action="show-recent" data-stage="${stage}">Show recent only</button></div>`;
    } else if (olderCount > 0) {
      foot.innerHTML = `<div class="row"><button type="button" data-action="show-older" data-stage="${stage}">Show ${olderCount} older</button></div>`;
    } else {
      foot.innerHTML = '';
    }
  }

  // Action bar is empty by default — promote is one-click on the tile circle
  // now (no multi-select staging step). Kept in DOM in case we surface a
  // future hint or batch-action.
  function renderColumnAction(col, _stage) {
    const action = col.querySelector('[data-action]');
    action.innerHTML = '';
  }

  // Promote is on rails — single click fires immediately, no form. Variety
  // comes from per-tile amplify (`+`) and per-column `+ more like these`.
  // Cartridge slot pickers handle material / background / angle / lens
  // automatically. Onboarding-level palette + reference upload is queued.

  async function sendPromote(col, stage) {
    const next = NEXT_STAGE[stage];
    if (!next) return;
    const sel = selectedInStage(stage);
    if (!sel.length) return;
    const parents = sel.map(s => ({
      runId: s.item.runId,
      slug: s.item.slug,
      filename: s.item.filename,
      title: s.item.title,
      stage: stage,
      note: null
    }));
    const useParentAsSubject = true;
    const isInSitu = next === 'in-situ';
    const N = isInSitu ? 2 : currentN();
    const modelIds = promoteModelIds(next);
    const body = {
      cartridge: currentCartridge(),
      stage: next,
      parents,
      use_parent_as_subject: useParentAsSubject,
      N,
      ...(modelIds.length > 1 ? { models: modelIds } : { model: modelIds[0] })
    };
    const pill = col.querySelector('.promote-pill');
    if (pill) { pill.disabled = true; pill.textContent = 'Sending…'; }
    try {
      await json(`${API}/public/runs`, { method: 'POST', body: JSON.stringify(body) });
      for (const p of parents) selected.delete(keyOf(p.runId, p.slug, p.filename));
      renderColumnAction(col, stage);
      renderColumnFoot(col, stage, []);
      updateDownloadBubble();
      await refreshRuns();
    } catch (err) {
      if (pill) { pill.disabled = false; pill.textContent = 'Failed — retry'; }
      console.error('promote failed', err);
    }
  }

  async function moreLikeThese(stage) {
    // "+ more" iterates on the current selection in this stage — passes each
    // selected image as a visual reference to the model with an "iterate on
    // this" prompt. If nothing's selected, falls back to the 3 most recent
    // items in the stage.
    let sel = selectedInStage(stage);
    if (!sel.length) {
      const items = flattenItems().filter(it => (it.stage || 'sketch') === stage).slice(0, 3);
      sel = items.map(it => ({ item: it }));
    }
    if (!sel.length) return;
    const isInSitu = stage === 'in-situ';
    const N = isInSitu ? 2 : currentN();
    // Same per-stage model routing as promote (kontext locked for in-situ,
    // user-models + kontext for product, user-models for sketch).
    const modelIds = promoteModelIds(stage);
    const parents = sel.map(s => ({
      runId: s.item.runId,
      slug: s.item.slug,
      filename: s.item.filename,
      title: s.item.title,
      stage: stage,
      note: null
    }));
    const body = {
      cartridge: currentCartridge(),
      stage,
      parents,
      use_parent_as_subject: true,
      N,
      ...(modelIds.length > 1 ? { models: modelIds } : { model: modelIds[0] })
    };
    try {
      await json(`${API}/public/runs`, { method: 'POST', body: JSON.stringify(body) });
      await refreshRuns();
    } catch (err) {
      console.error('amplify failed', err);
    }
  }

  // For promote/amplify on the product cartridge:
  //   in-situ      → gpt-2-edit only (purpose-built image-edit; honors the
  //                  parent product shot reliably). flux-pro/kontext was
  //                  dropped — output quality too soft for product imagery.
  //   product-shot → user-selected models. Server auto-routes gpt-2 →
  //                  gpt-2-edit when parent is attached.
  //   sketch (amplify only) → user models (no parent on sketches).
  function promoteModelIds(nextStage) {
    const GPT2E = 'openai/gpt-image-2/edit';
    if (nextStage === 'in-situ') return [GPT2E];
    return currentModelIds();
  }

  async function promoteOne(key) {
    const entry = tilesByKey.get(key);
    if (!entry) return;
    const stage = PRODUCT_STAGES.includes(entry.item.stage) ? entry.item.stage : 'sketch';
    const next = NEXT_STAGE[stage];
    if (!next) return;
    const isInSitu = next === 'in-situ';
    const N = isInSitu ? 2 : currentN();
    const modelIds = promoteModelIds(next);
    const body = {
      cartridge: currentCartridge(),
      stage: next,
      parents: [{
        runId: entry.item.runId,
        slug: entry.item.slug,
        filename: entry.item.filename,
        title: entry.item.title,
        stage: stage,
        note: null
      }],
      use_parent_as_subject: true,
      N,
      ...(modelIds.length > 1 ? { models: modelIds } : { model: modelIds[0] })
    };
    entry.tile.classList.add('promoting');
    try {
      await json(`${API}/public/runs`, { method: 'POST', body: JSON.stringify(body) });
      await refreshRuns();
    } catch (err) {
      console.error('promote-one failed', err);
    } finally {
      entry.tile.classList.remove('promoting');
    }
  }

  async function amplifyOne(key) {
    // Per-tile "+" — iterate on this exact image. Passes the tile as a
    // visual reference with the same parent-as-subject pipeline used by
    // promote, but with a same-stage parent so the orchestrator's prefix
    // becomes "iterate, stay close to the reference" instead of "place
    // this object in a new scene."
    const entry = tilesByKey.get(key);
    if (!entry) return;
    const stage = PRODUCT_STAGES.includes(entry.item.stage) ? entry.item.stage : 'sketch';
    const isInSitu = stage === 'in-situ';
    const N = isInSitu ? 2 : currentN();
    const modelIds = promoteModelIds(stage);
    const body = {
      cartridge: currentCartridge(),
      stage,
      parents: [{
        runId: entry.item.runId,
        slug: entry.item.slug,
        filename: entry.item.filename,
        title: entry.item.title,
        stage: stage,
        note: null
      }],
      use_parent_as_subject: true,
      N,
      ...(modelIds.length > 1 ? { models: modelIds } : { model: modelIds[0] })
    };
    const btn = entry.tile.querySelector('[data-action="amplify"]');
    if (btn) btn.disabled = true;
    try {
      await json(`${API}/public/runs`, { method: 'POST', body: JSON.stringify(body) });
      await refreshRuns();
    } catch (err) {
      console.error('amplify-one failed', err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Funnel-level click delegation (separate from grid handler so amplify
  // doesn't open the lightbox).
  $('#funnel').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'amplify') {
      e.stopPropagation();
      const tile = e.target.closest('.tile');
      if (tile) amplifyOne(tile.dataset.key);
      return;
    }
    if (action === 'show-older') {
      const stage = e.target.closest('[data-action="show-older"]').dataset.stage;
      showAllByCol.add(stage);
      renderGrid();
      return;
    }
    if (action === 'show-recent') {
      const stage = e.target.closest('[data-action="show-recent"]').dataset.stage;
      showAllByCol.delete(stage);
      renderGrid();
      return;
    }
    if (action === 'promote') {
      const stage = e.target.closest('[data-action="promote"]').dataset.stage;
      const col = e.target.closest('.funnel-col');
      sendPromote(col, stage);
      return;
    }
    // Tile click → existing select / lightbox behavior
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const key = tile.dataset.key;
    const entry = tilesByKey.get(key);
    if (!entry) return;
    // Modifier key → always "select for download", never promote.
    if (e.metaKey || e.shiftKey) {
      e.stopPropagation();
      toggleSelect(key);
      return;
    }
    // Dedicated download-select circle → toggle selection (works on all stages).
    if (e.target.closest('[data-action="download-select"]')) {
      e.stopPropagation();
      toggleSelect(key);
      return;
    }
    const onToggle = e.target.closest('[data-action="select"]');
    if (onToggle) {
      e.stopPropagation();
      const stage = PRODUCT_STAGES.includes(entry.item.stage) ? entry.item.stage : 'sketch';
      // sketch + product → instant promote on circle click. in-situ has no
      // next stage, so the circle reverts to download-multi-select.
      if (NEXT_STAGE[stage]) {
        promoteOne(key);
      } else {
        toggleSelect(key);
      }
      return;
    }
    openLightbox(entry.item);
  });

  // ---------- Tile interactions ----------
  $('#grid').addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const key = tile.dataset.key;
    const entry = tilesByKey.get(key);
    if (!entry) return;

    // Click on the select toggle (or anywhere with cmd/shift): toggle selection.
    const onToggle = e.target.closest('[data-action="select"]');
    if (onToggle || e.metaKey || e.shiftKey) {
      e.stopPropagation();
      toggleSelect(key);
      return;
    }
    openLightbox(entry.item);
  });

  function toggleSelect(key) {
    const entry = tilesByKey.get(key);
    if (!entry) return;
    if (selected.has(key)) { selected.delete(key); entry.tile.classList.remove('selected'); }
    else { selected.add(key); entry.tile.classList.add('selected'); }
    updateDownloadBubble();
  }

  function updateDownloadBubble() {
    const dl = $('#dl-btn');
    const c = $('#dl-count');
    const n = selected.size;
    dl.disabled = n === 0;
    c.hidden = n === 0;
    c.textContent = String(n);
  }

  $('#dl-btn').addEventListener('click', downloadSelected);

  async function downloadSelected() {
    if (!selected.size) return;
    const dl = $('#dl-btn');
    const items = [...selected].map(k => tilesByKey.get(k)?.item).filter(Boolean)
      .map(it => ({ runId: it.runId, slug: it.slug, filename: it.filename }));
    if (!items.length) return;

    dl.disabled = true;
    dl.classList.add('busy');
    const c = $('#dl-count');
    const originalText = c.textContent;

    try {
      const r = await fetch(`${API}/public/zip-selection`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);

      const total = parseInt(r.headers.get('Content-Length') || r.headers.get('x-approx-content-length') || '0', 10);
      const reader = r.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) {
          const pct = Math.min(99, Math.round((received / total) * 100));
          c.textContent = pct + '%';
        }
      }

      const blob = new Blob(chunks, { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recast-selection-${stamp}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      // Clear selection after a successful save.
      for (const k of [...selected]) {
        selected.delete(k);
        tilesByKey.get(k)?.tile.classList.remove('selected');
      }
      c.textContent = '✓';
      setTimeout(() => updateDownloadBubble(), 900);
    } catch (err) {
      console.error('zip-selection failed', err);
      c.textContent = '!';
      setTimeout(() => { c.textContent = originalText; updateDownloadBubble(); }, 1500);
    } finally {
      dl.classList.remove('busy');
    }
  }

  // ---------- Lightbox ----------
  const lb = $('#lightbox');
  const lbImg = $('#lb-img');
  const lbPrompt = $('#lb-prompt');
  const lbMeta = $('#lb-meta');
  const lbDownload = $('#lb-download');
  let lbCurrent = null;

  function openLightbox(it) {
    lbCurrent = it;
    lbImg.src = it.url;
    lbImg.alt = it.title;
    lbPrompt.textContent = it.prompt || '(no prompt recorded)';
    const metaParts = [modelLabel(it.model), it.composition, it.theme].filter(Boolean);
    lbMeta.textContent = metaParts.join(' · ');
    lb.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  if (lbDownload) {
    lbDownload.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!lbCurrent) return;
      const it = lbCurrent;
      lbDownload.disabled = true;
      const original = lbDownload.querySelector('span').textContent;
      try {
        const r = await fetch(it.url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${it.slug || 'image'}__${it.filename || 'render.png'}`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        lbDownload.querySelector('span').textContent = 'Saved';
        setTimeout(() => { lbDownload.querySelector('span').textContent = original; }, 1500);
      } catch (err) {
        console.error('lightbox download failed', err);
        lbDownload.querySelector('span').textContent = 'Failed';
        setTimeout(() => { lbDownload.querySelector('span').textContent = original; }, 1500);
      } finally {
        lbDownload.disabled = false;
      }
    });
  }
  function closeLightbox() {
    lb.hidden = true;
    lbImg.src = '';
    document.body.style.overflow = '';
  }
  lb.addEventListener('click', (e) => {
    // Close when clicking outside the stage. Stage has cursor:default; clicks inside
    // are still ok except for the image, where we want to keep open.
    if (!e.target.closest('.lb-stage')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (!lb.hidden && e.key === 'Escape') closeLightbox();
  });

  // ---------- SSE ----------
  // SSE-first state model: render.item events build tile entries directly
  // into flatTiles. run.started / run.finished / run.failed patch the local
  // run record. No SSE event triggers a /runs or /tiles fetch — those are
  // backup-only, fired on demand (cartridge switch, manual reload).
  function applyRenderItemToFlat(id, titleId, item, runMeta) {
    if (!item || item.status !== 'ok' || !item.filename) return;
    // Resolve slug + title from the run's input.titles. We must NOT
    // synthesize a slug from titleId — that produced URLs like
    // /images/c-1777828306749-0/... which 404 because the storage path
    // uses the real slug derived from the title text. If we don't have
    // input.titles yet (race with run.started), defer the tile — the
    // background /tiles refresh will pick it up with the right slug.
    const runRow = runsList.find(r => r.id === id);
    const t = runRow?.input?.titles?.find?.(t => t.id === titleId);
    if (!t || !t.slug) return;
    const slug = t.slug;
    const title = t.title || slug.replace(/-/g, ' ');
    const key = `${id}::${slug}::${item.filename}`;
    if (flatTiles.some(x => `${x.runId}::${x.slug}::${x.filename}` === key)) return;
    flatTiles.unshift({
      runId: id,
      slug,
      filename: item.filename,
      stage: item.stage || null,
      model: item.model || null,
      title,
      runStartedAt: runMeta?.startedAt || (runRow?.startedAt) || new Date().toISOString(),
      url: `${API}/public/runs/${id}/images/${encodeURIComponent(slug)}/${encodeURIComponent(item.filename)}`,
      parent: item.parent || null
    });
  }

  function openSSE() {
    const es = new EventSource(`${API}/public/events`);
    statusFoot.set('sseState', 'connecting');
    es.addEventListener('open', () => { statusFoot.set('sseState', 'open'); pollHealthz(); });
    es.addEventListener('error', () => { statusFoot.set('sseState', es.readyState === 2 ? 'closed' : 'connecting'); });

    // Debounce: at most one /runs+/tiles refresh per IDLE_REFRESH_MS, used as
    // a background safety net for SSE drops. Live UX no longer depends on it.
    const IDLE_REFRESH_MS = 30000;
    let lastBackgroundRefresh = 0;
    function scheduleBackgroundRefresh() {
      const now = Date.now();
      if (now - lastBackgroundRefresh < IDLE_REFRESH_MS) return;
      lastBackgroundRefresh = now;
      setTimeout(() => refreshRuns().catch(() => {}), 4000);
    }
    es.addEventListener('run.started', (e) => {
      try {
        const data = JSON.parse(e.data || '{}');
        if (!data.id) return;
        const existing = runsList.find(r => r.id === data.id);
        if (!existing && data.trace) {
          runsList.unshift({
            id: data.id,
            cartridge: data.trace.cartridge,
            status: 'running',
            startedAt: data.trace.startedAt,
            renderProgress: { ok: 0, failed: 0, total: 0 },
            input: data.trace.input || {}
          });
        }
        renderStatus();
        // Re-render the funnel so skeleton tiles appear immediately for the
        // run's target stage. Without this, skeletons wait until the first
        // render.item arrives (which can be 20–60s on nano).
        renderGrid();
        scheduleBackgroundRefresh();
      } catch {}
    });

    function patchRunStatus(id, status, errMsg) {
      const r = runsList.find(x => x.id === id);
      if (r) {
        r.status = status;
        r.finishedAt = new Date().toISOString();
        if (errMsg) r.error = errMsg;
      }
      renderStatus();
      renderGrid();
    }
    es.addEventListener('run.finished', (e) => {
      try { const d = JSON.parse(e.data || '{}'); if (d.id) patchRunStatus(d.id, 'done'); } catch {}
    });
    es.addEventListener('run.failed', (e) => {
      try { const d = JSON.parse(e.data || '{}'); if (d.id) patchRunStatus(d.id, 'failed', d.error); } catch {}
    });

    // Render-item: the event payload IS the new render. Merge into flatTiles
    // and tracesById; re-render the funnel column. Zero DB round-trips.
    es.addEventListener('render.item', (e) => {
      try {
        const data = JSON.parse(e.data || '{}');
        const { id, titleId, item } = data;
        if (!id || !titleId || !item) return;
        // Bump the run's renderProgress optimistically so the chip ticks up.
        const r = runsList.find(x => x.id === id);
        if (r) {
          r.renderProgress = r.renderProgress || { ok: 0, failed: 0, total: r.renderProgress?.total || 0 };
          if (item.status === 'ok') r.renderProgress.ok = (r.renderProgress.ok || 0) + 1;
          if (item.status === 'failed') r.renderProgress.failed = (r.renderProgress.failed || 0) + 1;
        }
        // Append to flatTiles directly so the product funnel sees it instantly.
        applyRenderItemToFlat(id, titleId, item, r || null);
        // Also feed tracesById for non-product flat-grid path.
        const trace = tracesById.get(id);
        if (trace) {
          trace.stages = trace.stages || {};
          trace.stages.renders = trace.stages.renders || { items: {} };
          const arr = trace.stages.renders.items[titleId] = trace.stages.renders.items[titleId] || [];
          if (!arr.some(x => x.filename === item.filename && x.model === item.model)) arr.push(item);
        }
        renderStatus();
        renderGrid();
      } catch {}
    });

    es.addEventListener('stage.started', (e) => {
      try {
        const data = JSON.parse(e.data || '{}');
        const trace = tracesById.get(data.id);
        if (trace?.stages?.[data.stage]) trace.stages[data.stage].status = 'running';
        renderStatus();
      } catch {}
    });
    es.addEventListener('stage.finished', (e) => {
      try {
        const data = JSON.parse(e.data || '{}');
        const trace = tracesById.get(data.id);
        if (trace?.stages?.[data.stage]) trace.stages[data.stage].status = 'done';
        renderStatus();
      } catch {}
    });
  }

  // ---------- Boot ----------
  (async function () {
    if (INVITE) {
      const w = $('#welcome-msg');
      w.hidden = false;
      w.textContent = "You're invited. Enter your email to get started.";
    }
    try {
      await json(`${API}/auth/me`);
      enterApp();
    } catch {
      show('email');
    }
  })();
})();
