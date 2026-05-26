(function () {
  const API = '/api';
  const $ = (s) => document.querySelector(s);
  const N_CYCLE = [1, 2, 3, 4, 5];
  const INVITE = new URLSearchParams(location.search).get('invite');

  // ---------- Theme toggle (sun/moon) ----------
  // Stored as 'theme' in localStorage; falls back to system preference, then
  // light. Applied via data-theme on <html> so CSS variables flip in one place.
  (function initTheme() {
    let stored = null;
    try { stored = localStorage.getItem('theme'); } catch {}
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initial = stored || (systemDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', initial);
    const btn = $('#theme-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'light';
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch {}
      });
    }
  })();

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

  let CARTRIDGE_LIST = ['product'];
  let CARTRIDGE_PROFILES = {};   // name → profile slice from /api/public/cartridges
  let IS_EXPERIMENTAL = false;
  function currentCartridge() { return $('#cart-btn').textContent; }
  function currentProfile() { return CARTRIDGE_PROFILES[currentCartridge()] || {}; }
  function setCartridge(name) {
    $('#cart-btn').textContent = name;
    try { localStorage.setItem('cartridge', name); } catch {}
  }

  // Per-cartridge funnel flow. The MECHANISM (column rendering, promote chain,
  // SSE, refs) is shared; the FLOW DEFINITION is per-cartridge — you can't
  // generalize a design process, only simplify it. Stage names == composition
  // names (the orchestrator keys stage/ceiling/promote-prefix on them).
  //   next:      stage -> next stage (null = terminal, circle becomes download)
  //   refStages: which stages expose a cartridge-ref override tab
  //   freshStage: where a fresh (non-promote) input lands
  //   aspect:    per-stage aspect_ratio sent on the run (run-level; orch :141)
  //   edit:      stages that promote parent-as-subject; optional model lock +
  //              N override (e.g. product in-situ locks gpt-2-edit, N=2)
  const FLOWS = {
    product: {
      stages: ['sketch', 'product-shot', 'in-situ'],
      labels: { 'sketch': 'Sketch', 'product-shot': 'Product', 'in-situ': 'In-situ' },
      next: { 'sketch': 'product-shot', 'product-shot': 'in-situ', 'in-situ': null },
      refStages: ['sketch', 'in-situ'],
      freshStage: 'sketch',
      aspect: {},
      edit: { 'in-situ': { models: ['openai/gpt-image-2/edit'], n: 2 } }
    },
    logos: {
      stages: ['sketch', 'system-split-4x5'],
      labels: { 'sketch': 'Sketch', 'system-split-4x5': 'Render' },
      next: { 'sketch': 'system-split-4x5', 'system-split-4x5': null },
      refStages: ['sketch'],
      freshStage: 'sketch',
      aspect: { 'sketch': '1:1', 'system-split-4x5': '4:5' },
      // Render is parent-as-subject; gpt-image-2 auto-routes to /edit and
      // flux is filtered SERVER-side, so keep the user's model choice.
      edit: {}
    }
  };
  // Per-stage prompt-steer sets — keyed by stage id, surfaced in the ref modal
  // as dropdown triggers. Picks are joined and appended to the run prompt.
  const STEER_SETS = {
    sketch: [
      { id: 'spread',     label: 'Spread',     options: ['More variety across the grid', 'More consistent'] },
      { id: 'form',       label: 'Form',        options: ['More geometric', 'More organic', 'Sharper', 'Rounder'] },
      { id: 'complexity', label: 'Complexity',  options: ['Simpler', 'More minimal', 'More detailed'] },
    ],
    'system-split-4x5': [
      { id: 'color',  label: 'Color',  options: ['Add brand color', 'Go mono', 'More saturated', 'Warmer'] },
      { id: 'weight', label: 'Weight', options: ['Bolder', 'Quieter', 'More dynamic', 'Calmer'] },
    ],
    'in-situ': [
      { id: 'color',  label: 'Color',  options: ['Add brand color', 'Go mono', 'More saturated', 'Warmer'] },
      { id: 'weight', label: 'Weight', options: ['Bolder', 'Quieter', 'More dynamic', 'Calmer'] },
    ],
    'product-shot': [
      { id: 'form',       label: 'Form',       options: ['More geometric', 'More organic', 'Sharper', 'Rounder'] },
      { id: 'complexity', label: 'Complexity', options: ['Simpler', 'More minimal', 'More detailed'] },
    ],
  };
  // Secondary "More" dropdown shown for every stage — era/register + custom steer.
  const MORE_STEER = { id: 'more', label: 'More ▾', options: ['More retro', 'More modern', 'Different era'] };
  function flow() { return FLOWS[currentCartridge()] || FLOWS.product; }
  function hasFunnelFlow() { return !!FLOWS[currentCartridge()]; }

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
    // Re-scope grid + selection to the new cartridge. Three caches must reset
    // together or tiles bleed/duplicate across cartridges:
    //   1. flatTiles — holds the previous cartridge's tiles; flattenItems()
    //      can't scope them out (tiles carry no `cartridge` field). Drop it and
    //      refetch /tiles for the new cartridge, else the old cartridge's tiles
    //      render (e.g. logos tiles in the product funnel).
    //   2. tilesByKey — the tile-element cache (the intended GC-on-switch).
    //   3. the funnel column DOM — the funnel only *hides* on switch, it keeps
    //      its tile elements. They must be dropped in lockstep with tilesByKey;
    //      otherwise the key-based reconcile re-creates elements while the stale
    //      hidden ones survive, duplicating the funnel on each switch back.
    // refreshRuns() then refetches + re-renders from a clean slate.
    selected.clear();
    flatTiles = [];
    tilesByKey.clear();
    document.querySelectorAll('#funnel .funnel-col [data-body]').forEach(b => { b.innerHTML = ''; });
    // Reset the active ref tab to the new flow's first ref stage (logos has no
    // in-situ tab, so a stale currentRefStage would point at a hidden tab).
    if (!refStages().includes(currentRefStage)) currentRefStage = refStages()[0] || 'sketch';
    renderRefTray();
    renderStatus();
    refreshRuns();
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
    const h = Math.min(200, ta.scrollHeight);
    ta.style.height = h + 'px';
    // Pill stays at 56px (matching the bubble buttons) for single-line input;
    // expands only when the textarea wraps to multi-line.
    const pill = ta.closest('.pill');
    if (pill) pill.classList.toggle('expanded', h > 28);
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

  // ---------- Reference override tray ----------
  // sessionRefs: per-stage list of dropped images. Persisted in IndexedDB so
  // refresh doesn't wipe them (data URLs can exceed the 5 MB localStorage
  // quota at 16 refs × 5 MB). Wired into POST /runs as `reference_overrides`.
  // Union of ref stages across all flows — used for IndexedDB persistence so
  // switching cartridge never drops the other flow's refs. DISPLAY is scoped
  // to the current flow via refStages().
  const ALL_REF_STAGES = ['sketch', 'in-situ'];
  const sessionRefs = { sketch: [], 'in-situ': [] };
  // Per-stage steer picks. Keys: dropdown id → selected option; '__more_era'
  // for the More dropdown; '__custom' for custom free-text steer.
  const sessionSteers = {};
  function stageSteerState(stage) {
    if (!sessionSteers[stage]) sessionSteers[stage] = {};
    return sessionSteers[stage];
  }
  function refStages() { return flow().refStages; }
  let currentRefStage = 'sketch';
  const REF_MAX_BYTES = 5 * 1024 * 1024;
  const REF_MAX_PER_STAGE = 16;

  // Tiny IndexedDB helper. Single store keyed by stage; value is the array.
  const IDB_NAME = 'recast-refs';
  const IDB_STORE = 'refs';
  let idbPromise = null;
  function openIdb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return idbPromise;
  }
  async function idbGetStage(stage) {
    try {
      const db = await openIdb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const r = tx.objectStore(IDB_STORE).get(stage);
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
    } catch { return []; }
  }
  async function idbPutStage(stage, value) {
    try {
      const db = await openIdb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, stage);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { console.warn('idb put failed', e); }
  }
  async function persistRefs() {
    for (const s of ALL_REF_STAGES) await idbPutStage(s, sessionRefs[s]);
  }
  async function hydrateRefs() {
    for (const s of ALL_REF_STAGES) {
      const arr = await idbGetStage(s);
      if (Array.isArray(arr) && arr.length) {
        sessionRefs[s].length = 0;
        sessionRefs[s].push(...arr);
      }
    }
    renderRefTray();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  async function addRefFiles(files) {
    const list = sessionRefs[currentRefStage];
    for (const f of files) {
      if (list.length >= REF_MAX_PER_STAGE) break;
      if (!f.type.startsWith('image/')) continue;
      if (f.size > REF_MAX_BYTES) { console.warn('skip oversize ref', f.name, f.size); continue; }
      try {
        const dataUrl = await readFileAsDataUrl(f);
        list.push({ filename: f.name, dataUrl });
      } catch (e) { console.warn('ref read failed', f.name, e); }
    }
    renderRefTray();
    persistRefs();
  }
  function removeRef(idx) {
    sessionRefs[currentRefStage].splice(idx, 1);
    renderRefTray();
    persistRefs();
  }
  function clearRefs() {
    sessionRefs[currentRefStage].length = 0;
    // Clear stage steers alongside refs ("Clear this stage" covers both).
    sessionSteers[currentRefStage] = {};
    renderRefTray();
    renderSteerDropdowns(currentRefStage);
    persistRefs();
  }
  // Carry user-dropped refs through to the matching target stage. Sketch refs
  // ride into product/sketch/in-situ runs targeting the sketch stage, and
  // in-situ refs ride into product→in-situ promote runs. The orchestrator
  // keys reference_overrides by TARGET stage. We send whichever stage(s)
  // have refs; the orchestrator only consumes the one matching this run.
  function buildRefOverrides(targetStage) {
    if (!targetStage) return null;
    // Direct match first: refs explicitly for this target stage.
    if (sessionRefs[targetStage]?.length) {
      return { [targetStage]: sessionRefs[targetStage] };
    }
    // Sketch refs are the design-direction refs — they ride through to
    // ALL stages until cleared. (Was the prior behavior; we keep it.)
    if (targetStage !== 'sketch' && sessionRefs.sketch?.length) {
      return { [targetStage]: sessionRefs.sketch };
    }
    return null;
  }
  function thumbHtml(r, i) {
    return `<div class="ref-thumb" data-idx="${i}" title="${escHtml(r.filename)}">
      <img src="${r.dataUrl}" alt="">
      <button type="button" class="ref-thumb-x" data-action="ref-remove" data-idx="${i}" aria-label="Remove">×</button>
    </div>`;
  }
  function renderRefTray() {
    // Mini bar (above the funnel). Summarizes both stages compactly.
    const tray = $('#ref-tray');
    const stageEl = $('#ref-tray-stage');
    const clearBtn = $('#ref-tray-clear');
    const miniThumbs = $('#ref-tray-thumbs-mini');
    if (!tray) return;
    const totals = refStages().map(s => ({ stage: s, n: (sessionRefs[s] || []).length }));
    const totalN = totals.reduce((a, b) => a + b.n, 0);
    const labelParts = totals.filter(t => t.n).map(t => `${t.n} ${(flow().labels[t.stage] || t.stage).toLowerCase()}`);
    stageEl.textContent = totalN ? `${labelParts.join(', ')} loaded · overriding cartridge` : 'override off';
    tray.classList.toggle('active', totalN > 0);
    clearBtn.hidden = totalN === 0;
    if (miniThumbs) {
      // Show a few thumbs from each non-empty stage, marked subtly.
      const samples = refStages().flatMap(s => (sessionRefs[s] || []).slice(0, 4).map((r, i) => ({ ...r, _stage: s, _idx: i })));
      miniThumbs.innerHTML = samples.slice(0, 8).map(r => thumbHtml(r, r._idx)).join('');
    }
    // Modal: tabs, drop zone, and grid all reflect the active tab.
    if (!$('#ref-modal').hidden) {
      renderRefTabs();
      // Dropzone + thumbs only apply to stages with image-ref support.
      const isRefStage = refStages().includes(currentRefStage);
      const dropEl = $('#ref-modal-drop');
      if (dropEl) dropEl.hidden = !isRefStage;
      const list = isRefStage ? (sessionRefs[currentRefStage] || []) : [];
      const modalThumbs = $('#ref-modal-thumbs');
      if (modalThumbs) {
        modalThumbs.innerHTML = isRefStage
          ? (list.length
              ? list.map(thumbHtml).join('')
              : `<div class="ref-modal-empty">No ${currentRefStage} refs loaded yet — drop some above.</div>`)
          : '';
      }
    }
  }
  // ---------- Steer dropdowns ----------
  function steerTabStages() {
    const f = flow();
    const steerKeys = Object.keys(STEER_SETS);
    return f.stages.filter(s => f.refStages.includes(s) || steerKeys.includes(s));
  }

  function renderRefTabs() {
    const container = $('#ref-modal-tabs');
    if (!container) return;
    const f = flow();
    const tabs = steerTabStages();
    if (tabs.length && !tabs.includes(currentRefStage)) currentRefStage = tabs[0];
    container.innerHTML = tabs.map(s => {
      const label = f.labels?.[s] || s;
      const n = (sessionRefs[s] || []).length;
      const countHtml = `<span class="ref-tab-count" data-tab-count="${s}">${n ? `· ${n}` : ''}</span>`;
      return `<button type="button" class="ref-modal-tab${s === currentRefStage ? ' active' : ''}" data-stage="${escHtml(s)}" role="tab">${escHtml(label)} ${countHtml}</button>`;
    }).join('');
  }

  function renderSteerDropdowns(stage) {
    const section = $('#steer-section');
    const container = $('#steer-dropdowns');
    if (!section || !container) return;
    const sets = STEER_SETS[stage] || [];
    if (!sets.length) { section.hidden = true; return; }
    section.hidden = false;
    const state = stageSteerState(stage);
    const allSets = [...sets, MORE_STEER];
    container.innerHTML = allSets.map(set => {
      const isMore = set.id === 'more';
      const pick = isMore ? (state.__more_era || null) : (state[set.id] || null);
      const customPick = state.__custom || null;
      const isActive = !!pick || (isMore && !!customPick);
      const opts = set.options.map(o => {
        const isSel = isMore ? o === state.__more_era : o === state[set.id];
        return `<button class="steer-opt${isSel ? ' steer-opt--active' : ''}" data-value="${escHtml(o)}">${escHtml(o)}</button>`;
      }).join('');
      const customRow = isMore
        ? `<button class="steer-opt steer-opt--custom" data-value="__custom__">+ Custom steer…</button>${customPick ? `<div class="steer-custom-tag">"${escHtml(customPick)}" <button class="steer-custom-clear">\xd7</button></div>` : ''}`
        : '';
      const pickSpan = pick ? `<span class="steer-trigger-pick">: ${escHtml(pick)}</span>` : (isMore && customPick ? `<span class="steer-trigger-pick">: custom</span>` : '');
      return `<div class="steer-dd" data-steer-id="${escHtml(set.id)}"><button class="steer-trigger${isActive ? ' steer-trigger--active' : ''}" data-steer-id="${escHtml(set.id)}"><span class="steer-trigger-label">${escHtml(set.label)}</span>${pickSpan}</button><div class="steer-menu glass-surface" hidden>${opts}${customRow}</div></div>`;
    }).join('');
  }

  function closeAllSteerMenus() {
    document.querySelectorAll('.steer-menu').forEach(m => { m.hidden = true; });
  }

  function pickSteer(setId, value, stage) {
    const state = stageSteerState(stage);
    if (setId === 'more') {
      if (state.__more_era === value) { delete state.__more_era; } else { state.__more_era = value; }
    } else {
      if (state[setId] === value) { delete state[setId]; } else { state[setId] = value; }
    }
    closeAllSteerMenus();
    renderSteerDropdowns(stage);
  }

  function handleCustomSteer(stage) {
    const state = stageSteerState(stage);
    const current = state.__custom || '';
    const input = window.prompt('Enter a custom steer phrase (blank to clear):', current);
    if (input === null) return;
    const trimmed = input.trim().slice(0, 200);
    if (trimmed) { state.__custom = trimmed; } else { delete state.__custom; }
    closeAllSteerMenus();
    renderSteerDropdowns(stage);
  }

  function initSteerListeners() {
    const section = $('#steer-section');
    if (!section) return;
    section.addEventListener('click', (e) => {
      const trigger = e.target.closest('.steer-trigger');
      if (trigger) {
        e.stopPropagation();
        const dd = trigger.closest('.steer-dd');
        const menu = dd?.querySelector('.steer-menu');
        if (!menu) return;
        const wasOpen = !menu.hidden;
        closeAllSteerMenus();
        if (!wasOpen) menu.hidden = false;
        return;
      }
      const opt = e.target.closest('.steer-opt');
      if (opt) {
        e.stopPropagation();
        const value = opt.dataset.value;
        const setId = opt.closest('.steer-dd')?.dataset.steerId;
        if (!setId) return;
        if (value === '__custom__') {
          handleCustomSteer(currentRefStage);
        } else {
          pickSteer(setId, value, currentRefStage);
        }
        return;
      }
      const clearCustomBtn = e.target.closest('.steer-custom-clear');
      if (clearCustomBtn) {
        e.stopPropagation();
        delete stageSteerState(currentRefStage).__custom;
        renderSteerDropdowns(currentRefStage);
      }
    });
    document.addEventListener('click', closeAllSteerMenus);
  }

  function openRefModal() {
    const modal = $('#ref-modal');
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    renderRefTabs();
    renderRefTray();
    renderSteerDropdowns(currentRefStage);
  }
  function closeRefModal() {
    const modal = $('#ref-modal');
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
  }
  function initRefTray() {
    const tray = $('#ref-tray');
    const openBtn = $('#ref-tray-open');
    const clearBtn = $('#ref-tray-clear');
    const modal = $('#ref-modal');
    const modalDrop = $('#ref-modal-drop');
    const modalInput = $('#ref-modal-input');
    const modalDone = $('#ref-modal-done');
    const modalClear = $('#ref-modal-clear');

    openBtn?.addEventListener('click', openRefModal);
    clearBtn?.addEventListener('click', (e) => { e.stopPropagation(); clearRefs(); });
    // Clicks on the mini-bar thumbs also open the modal so you can manage them.
    tray?.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="ref-remove"]')) {
        const idx = parseInt(e.target.closest('[data-action="ref-remove"]').dataset.idx, 10);
        removeRef(idx);
        return;
      }
      if (e.target.closest('.ref-tray-thumbs')) openRefModal();
    });

    modalDone?.addEventListener('click', closeRefModal);
    modalClear?.addEventListener('click', clearRefs);

    // Tab switch — delegated on the dynamically rendered tab container so
    // newly rendered tab buttons are handled without re-binding.
    $('#ref-modal-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('.ref-modal-tab');
      if (!tab) return;
      const s = tab.dataset.stage;
      if (!s) return;
      currentRefStage = s;
      renderRefTabs();
      renderRefTray();
      renderSteerDropdowns(s);
    });
    initSteerListeners();
    modal?.addEventListener('click', (e) => {
      // Click outside the stage closes
      if (!e.target.closest('.ref-modal-stage')) closeRefModal();
      // Click on a thumb's × removes it
      const x = e.target.closest('[data-action="ref-remove"]');
      if (x) removeRef(parseInt(x.dataset.idx, 10));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.hidden) closeRefModal();
    });

    // Click drop zone → file picker.
    modalDrop?.addEventListener('click', () => modalInput?.click());
    modalInput?.addEventListener('change', (e) => {
      addRefFiles(Array.from(e.target.files || []));
      modalInput.value = '';
    });

    // Drag-and-drop scoped to the modal drop zone (instead of whole window).
    modalDrop?.addEventListener('dragenter', (e) => {
      e.preventDefault();
      modalDrop.classList.add('dragging');
    });
    modalDrop?.addEventListener('dragleave', (e) => {
      // Only un-style when leaving the drop zone itself, not its children.
      if (e.target === modalDrop) modalDrop.classList.remove('dragging');
    });
    modalDrop?.addEventListener('dragover', (e) => { e.preventDefault(); });
    modalDrop?.addEventListener('drop', (e) => {
      e.preventDefault();
      modalDrop.classList.remove('dragging');
      addRefFiles(Array.from(e.dataTransfer?.files || []));
    });
    // Also accept drops anywhere on the modal backdrop while it's open.
    modal?.addEventListener('dragover', (e) => { e.preventDefault(); });
    modal?.addEventListener('drop', (e) => {
      if (e.target.closest('.ref-modal-drop')) return; // already handled
      e.preventDefault();
      addRefFiles(Array.from(e.dataTransfer?.files || []));
    });
  }

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
      // Funnel cartridges start every fresh input at the flow's fresh stage
      // (sketch). Later stages happen via promotion; the orchestrator restricts
      // the cycle to the requested stage. Aspect is sent per-flow (sketch 1:1).
      if (hasFunnelFlow()) {
        const fresh = flow().freshStage;
        body = { ...body, stage: fresh };
        const asp = flow().aspect?.[fresh];
        if (asp) body = { ...body, aspect_ratio: asp };
      }
      const ov = buildRefOverrides(body.stage || flow().freshStage);
      if (ov) body = { ...body, reference_overrides: ov };
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
    initRefTray();
    hydrateRefs();  // restore dropped refs from IndexedDB after a refresh
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

  async function refreshRuns() {
    let runs;
    try { runs = await json(`${API}/public/runs`); }
    catch { runs = null; }
    if (Array.isArray(runs) && (runs.length > 0 || runsList.length === 0)) {
      const merged = new Map(runsList.map(r => [r.id, r]));
      for (const r of runs) {
        const existing = merged.get(r.id);
        // Preserve richer fields from SSE/local state when the /runs listing
        // doesn't carry them. The listing dropped `input.titles` for speed —
        // SSE provides them on `run.started`, and we need them so render.item
        // can resolve titleId → slug for new tiles. Without this preservation,
        // a refreshRuns() call after SSE loses the titles and subsequent
        // render.item events silently drop their tiles.
        if (existing?.input?.titles?.length && !r.input?.titles?.length) {
          merged.set(r.id, { ...r, input: { ...r.input, titles: existing.input.titles } });
        } else {
          merged.set(r.id, r);
        }
      }
      runsList.length = 0;
      for (const r of merged.values()) runsList.push(r);
      runsList.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    }
    // Flat tile fetch — works for any cartridge that has a /tiles index.
    // Was hardcoded to 'product' which silently dropped logos and any future
    // cartridge from the grid; the endpoint already takes a cartridge param.
    const cart = currentCartridge();
    if (cart) {
      try {
        const tiles = await json(`${API}/public/tiles?cartridge=${encodeURIComponent(cart)}&limit=2000`);
        if (Array.isArray(tiles)) {
          // SSE may have added tiles newer than the server cursor; preserve them.
          const serverKeys = new Set(tiles.map(t => `${t.runId}::${t.slug}::${t.filename}`));
          const sseExtras = flatTiles.filter(t => !serverKeys.has(`${t.runId}::${t.slug}::${t.filename}`));
          flatTiles = [...sseExtras, ...tiles];
        }
      } catch { /* keep current flatTiles */ }
    }
    renderStatus();
    renderGrid();
  }

  function runsForCurrentCartridge() {
    const cart = currentCartridge();
    if (!cart) return runsList;
    return runsList.filter(r => (r.cartridge || null) === cart);
  }

  // One rule: chip exists ⟺ run is running, OR failed within the last 60 s
  // (brief grace so you see "it failed" feedback). No dismiss button — chips
  // are 100% server-state-driven. SSE flips them; nothing else.
  const FAILED_GRACE_MS = 60 * 1000;
  function renderStatus() {
    const strip = $('#status-strip');
    const cutoff = Date.now() - FAILED_GRACE_MS;
    const active = runsForCurrentCartridge().filter(r => {
      if (r.status === 'running') return true;
      if (r.status === 'failed') {
        const at = r.finishedAt || r.startedAt;
        return at && new Date(at).getTime() > cutoff;
      }
      return false;
    });
    if (!active.length) { strip.hidden = true; strip.innerHTML = ''; return; }
    strip.hidden = false;
    strip.innerHTML = active.map(r => {
      const p = r.renderProgress || { ok: 0, failed: 0, total: 0 };
      const done = p.ok + p.failed;
      const cls = r.status === 'failed' ? 'failed' : '';
      // Chip says WHAT (title) and WHERE (target stage), not just a count.
      // First title is enough for the typical case (single-title submit).
      const titles = r.input?.titles || [];
      const titleStr = titles.length === 0 ? '' :
        (titles.length === 1 ? titles[0].title : `${titles[0].title} +${titles.length - 1}`);
      const stage = r.input?.stage || 'sketch';
      const stageLabel = (FLOWS[r.cartridge]?.labels?.[stage]) || stage;
      const where = titleStr ? `${titleStr} → ${stageLabel}` : stageLabel;
      const txt = r.status === 'failed'
        ? `${where} · failed ${p.ok}/${p.total}`
        : `${where} · ${done}/${p.total}`;
      return `<div class="status-chip ${cls}" title="${escHtml(where)}"><span class="dot"></span>${escHtml(txt)}</div>`;
    }).join('');
  }
  // Repaint every 10s so the failed-grace cutoff naturally drops chips.
  setInterval(() => renderStatus(), 10000);

  // Prefer the flat tiles list (one DB query, no per-run trace JSON) whenever
  // it has rows for the current cartridge. Falls back to iterating loaded
  // traces when the list isn't populated yet (cold load, brand-new cartridge).
  function flattenItems() {
    const cart = currentCartridge();
    const flatForCart = flatTiles.filter(t => !cart || (t.cartridge ? t.cartridge === cart : true));
    if (flatForCart.length) {
      // Start from the server-rendered flat list (filtered to current
      // cartridge), overlay any SSE-streamed in-flight items that aren't
      // yet in the flat list.
      const seen = new Set();
      const out = flatForCart.map(t => {
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

  // Stage constants are now per-cartridge (see FLOWS / flow()). Funnel columns
  // are generated from flow().stages so adding a stage to a flow is a data
  // change, not a DOM edit.
  function ensureFunnelColumns() {
    const funnel = $('#funnel');
    const stages = flow().stages;
    const existing = [...funnel.querySelectorAll('.funnel-col')].map(c => c.dataset.stage);
    if (existing.length === stages.length && existing.every((s, i) => s === stages[i])) return;
    funnel.innerHTML = stages.map(s => `
      <div class="funnel-col" data-stage="${escHtml(s)}">
        <div class="funnel-head"><span class="funnel-name">${escHtml(flow().labels[s] || s)}</span><span class="funnel-count" data-count></span></div>
        <div class="funnel-action" data-action></div>
        <div class="funnel-body" data-body></div>
        <div class="funnel-foot" data-foot></div>
      </div>`).join('');
  }

  function renderGrid() {
    const grid = $('#grid');
    const empty = $('#grid-empty');
    const funnel = $('#funnel');
    const items = flattenItems();

    // Hide/show grid vs funnel by cartridge — funnel cartridges have a FLOWS def
    if (hasFunnelFlow()) {
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
          <img loading="lazy" alt="${escHtml(it.title)}" src="${it.thumbUrl || (it.url + '?w=384')}" onerror="if (this.src.endsWith('.webp')) { this.src = '${it.url}?w=384'; } else { this.closest('.tile')?.classList.add('img-broken'); this.removeAttribute('src'); }">
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

  function renderFunnel(items) {
    const funnel = $('#funnel');
    ensureFunnelColumns();
    const presentKeys = new Set();
    const stages = flow().stages;
    const fresh = flow().freshStage;

    // Group by stage. Items with unknown/missing stage land under the fresh
    // stage so legacy renders stay visible somewhere.
    const byStage = {};
    for (const s of stages) byStage[s] = [];
    for (const it of items) {
      const s = stages.includes(it.stage) ? it.stage : fresh;
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

    for (const stage of stages) {
      const col = funnel.querySelector(`.funnel-col[data-stage="${stage}"]`);
      const body = col.querySelector('[data-body]');
      const count = col.querySelector('[data-count]');
      // Sort by run-start descending and slice to the recent window. Older
      // items live in the cache; the "Show N older" button at the column
      // foot expands the view in place.
      const allStageItems = [...byStage[stage]].sort((a, b) =>
        (b.runStartedAt || '').localeCompare(a.runStartedAt || ''));
      const stageItems = allStageItems;
      const totalCount = allStageItems.length;
      // In-flight count for THIS stage: sum of (expected - done) across
      // running runs whose target stage is this column. Tells the user
      // "look here for the new images" without any animated DOM.
      let inflight = 0;
      for (const r of runsList) {
        if (r.status !== 'running') continue;
        if (r.cartridge !== currentCartridge()) continue;
        if ((r.input?.stage || fresh) !== stage) continue;
        const titles = r.input?.titles?.length || 0;
        const N = r.input?.N || 1;
        const done = (r.renderProgress?.ok || 0) + (r.renderProgress?.failed || 0);
        inflight += Math.max(0, titles * N - done);
      }
      count.textContent = totalCount
        ? (inflight ? `${totalCount} · +${inflight}…` : `${totalCount}`)
        : (inflight ? `+${inflight}…` : '');

      if (!totalCount && !inflight) {
        body.innerHTML = `<div class="funnel-empty">${stage === 'sketch' ? 'Type an object above and press ⏎.' : 'Promote selections from the previous stage.'}</div>`;
      } else if (!totalCount) {
        body.innerHTML = `<div class="funnel-empty">Generating ${inflight} image${inflight === 1 ? '' : 's'}…</div>`;
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
            const next = flow().next[stage];
            const circleTip = next ? `Promote to ${flow().labels[next] || next}` : 'Select for download';
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
              <img loading="lazy" alt="${escHtml(it.title)}" src="${it.thumbUrl || (it.url + '?w=384')}" onerror="if (this.src.endsWith('.webp')) { this.src = '${it.url}?w=384'; } else { this.closest('.tile')?.classList.add('img-broken'); this.removeAttribute('src'); }">
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
        for (const child of [...body.children]) {
          const k = child.dataset?.key;
          if (!k || !desiredSet.has(k) || !child.classList.contains('tile')) child.remove();
        }
        for (let i = 0; i < desiredKeys.length; i++) {
          const want_node = tilesByKey.get(desiredKeys[i])?.tile;
          if (!want_node) continue;
          const cur = body.children[i];
          if (cur !== want_node) body.insertBefore(want_node, cur || null);
        }
      }

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
      const s = flow().stages.includes(entry.item.stage) ? entry.item.stage : flow().freshStage;
      if (s === stage) out.push(entry);
    }
    return out;
  }

  function renderColumnAction(col) {
    const action = col.querySelector('[data-action]');
    if (action) action.innerHTML = '';
  }

  // Promote is on rails — single click fires immediately, no form. Variety
  // comes from per-tile amplify (`+`) and per-column `+ more like these`.
  // Cartridge slot pickers handle material / background / angle / lens
  // automatically. Onboarding-level palette + reference upload is queued.

  async function sendPromote(col, stage) {
    const next = flow().next[stage];
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
    const N = flow().edit?.[next]?.n || currentN();
    const modelIds = promoteModelIds(next);
    const body = {
      cartridge: currentCartridge(),
      stage: next,
      parents,
      use_parent_as_subject: useParentAsSubject,
      N,
      ...(modelIds.length > 1 ? { models: modelIds } : { model: modelIds[0] })
    };
    if (flow().aspect?.[next]) body.aspect_ratio = flow().aspect[next];
    const ov = buildRefOverrides(next);
    if (ov) body.reference_overrides = ov;
    const pill = col.querySelector('.promote-pill');
    if (pill) { pill.disabled = true; pill.textContent = 'Sending…'; }
    try {
      await json(`${API}/public/runs`, { method: 'POST', body: JSON.stringify(body) });
      for (const p of parents) selected.delete(keyOf(p.runId, p.slug, p.filename));
      renderColumnAction(col);
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
    const N = flow().edit?.[stage]?.n || currentN();
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
    if (flow().aspect?.[stage]) body.aspect_ratio = flow().aspect[stage];
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
    // Flow may lock specific models for a stage (product in-situ → gpt-2-edit
    // only). Otherwise use the user's models — the server auto-routes gpt-2 →
    // gpt-2-edit and filters no-image models when a parent is attached.
    const lock = flow().edit?.[nextStage]?.models;
    return (lock && lock.length) ? lock : currentModelIds();
  }

  async function promoteOne(key) {
    const entry = tilesByKey.get(key);
    if (!entry) return;
    const stage = flow().stages.includes(entry.item.stage) ? entry.item.stage : flow().freshStage;
    const next = flow().next[stage];
    if (!next) return;
    const N = flow().edit?.[next]?.n || currentN();
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
    if (flow().aspect?.[next]) body.aspect_ratio = flow().aspect[next];
    const ov = buildRefOverrides(next);
    if (ov) body.reference_overrides = ov;
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
    const stage = flow().stages.includes(entry.item.stage) ? entry.item.stage : flow().freshStage;
    // Optional steering note — "more like this, but ___". Empty string or
    // cancel = vanilla amplify (no extra direction).
    const noteRaw = window.prompt('Amplify direction (optional):\n"more like this, but ___"\nLeave blank for a plain variant.');
    if (noteRaw === null) return;  // user cancelled
    const note = noteRaw.trim().slice(0, 240) || null;
    const N = flow().edit?.[stage]?.n || currentN();
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
        note
      }],
      use_parent_as_subject: true,
      N,
      ...(modelIds.length > 1 ? { models: modelIds } : { model: modelIds[0] })
    };
    if (flow().aspect?.[stage]) body.aspect_ratio = flow().aspect[stage];
    const ov = buildRefOverrides(stage);
    if (ov) body.reference_overrides = ov;
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
      const stage = flow().stages.includes(entry.item.stage) ? entry.item.stage : flow().freshStage;
      // Non-terminal stages → instant promote on circle click. The terminal
      // stage has no next, so the circle reverts to download-multi-select.
      if (flow().next[stage]) {
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
        renderGrid();
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
