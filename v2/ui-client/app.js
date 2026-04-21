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

  // ---- Email step ----
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

  // ---- Code step ----
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

  // ---- Access-grant code (out-of-band) ----
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

  // ---- App ----
  async function enterApp() {
    show('app');
    try {
      const me = await json(`${API}/auth/me`);
      const defN = Math.min(5, Math.max(1, parseInt(me.n_per_title, 10) || 3));
      setN(defN);
    } catch {
      setN(3);
    }
    updateTotals();
    await renderRuns();
    openSSE();
  }

  // N button rotator (cycles 1 → 2 → 3 → 4 → 5 → 1)
  function currentN() { return parseInt($('#n-btn').textContent, 10) || 3; }
  function setN(n) { $('#n-btn').textContent = String(n); }
  $('#n-btn').addEventListener('click', () => {
    const cur = currentN();
    const idx = N_CYCLE.indexOf(cur);
    const next = N_CYCLE[(idx + 1) % N_CYCLE.length];
    setN(next);
    updateTotals();
  });

  function countTitles() {
    return $('#titles').value.trim().split('\n').map(x => x.trim()).filter(Boolean).length;
  }
  function updateTotals() {
    const t = countTitles();
    const n = currentN();
    if (t === 0) { $('#totals').textContent = ''; return; }
    $('#totals').textContent = `${t} × ${n} = ${t * n} images`;
  }
  $('#titles').addEventListener('input', updateTotals);

  $('#signout-btn').addEventListener('click', async () => {
    await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'same-origin' });
    location.reload();
  });

  $('#generate-btn').addEventListener('click', async () => {
    const titles = $('#titles').value.trim().split('\n').map(x => x.trim()).filter(Boolean);
    if (!titles.length) return;
    const N = currentN();
    const total = titles.length * N;

    if (titles.length > 50 || total > 200) {
      const ok = confirm(
        `${total} images (${titles.length} titles × ${N}).\n\n` +
        `~${Math.ceil(total * 4 / 60)} min. Continue?`
      );
      if (!ok) return;
    }

    $('#generate-btn').disabled = true;
    try {
      await json(`${API}/public/runs`, { method: 'POST', body: JSON.stringify({ titles, N }) });
      $('#titles').value = '';
      updateTotals();
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      $('#generate-btn').disabled = false;
    }
    await renderRuns();
  });

  // ---- Runs rendering: latest pinned, older collapsed ----
  function formatDate(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${yy}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function runTitleText(r) {
    const p = r.renderProgress || { ok: 0, failed: 0, total: 0 };
    const isRunning = r.status === 'running';
    const labelBits = `${r.titleCount} title${r.titleCount === 1 ? '' : 's'} · ${p.total} image${p.total === 1 ? '' : 's'}`;
    if (isRunning) {
      const done = p.ok + p.failed;
      return `<span class="running-dot"></span>${labelBits} · ${done}/${p.total}`;
    }
    if (r.status === 'failed') return `${labelBits} · failed`;
    if (p.failed) return `${labelBits} · ${p.failed} failed`;
    return labelBits;
  }

  function runActionHtml(r) {
    const p = r.renderProgress || { ok: 0, failed: 0, total: 0 };
    const canDownload = r.status === 'done' && p.ok > 0;
    if (canDownload) return `<button class="btn-action" data-run="${r.id}">Download</button>`;
    if (r.status === 'running') return `<div class="run-status running">running</div>`;
    if (r.status === 'failed') return `<div class="run-status failed">failed</div>`;
    return `<div class="run-status">—</div>`;
  }

  function renderLatest(r) {
    const latest = $('#latest-run');
    latest.hidden = !r;
    if (!r) return;
    latest.innerHTML = `
      <div class="run-left">
        <div class="run-date">${formatDate(r.startedAt)}</div>
        <div class="run-title">${runTitleText(r)}</div>
      </div>
      <div class="run-action">${runActionHtml(r)}</div>`;
  }

  function renderOlder(olderRuns) {
    const section = $('#older-runs');
    const list = $('#older-list');
    section.hidden = olderRuns.length === 0;
    $('#older-count').textContent = olderRuns.length ? ` (${olderRuns.length})` : '';
    list.innerHTML = '';
    for (const r of olderRuns) {
      const row = document.createElement('div');
      row.className = 'run-row';
      row.innerHTML = `
        <div class="run-left">
          <div class="run-date">${formatDate(r.startedAt)}</div>
          <div class="run-title">${runTitleText(r)}</div>
        </div>
        <div class="run-action">${runActionHtml(r)}</div>`;
      list.appendChild(row);
    }
  }

  async function renderRuns() {
    const runs = await json(`${API}/public/runs`);
    renderLatest(runs[0] || null);
    renderOlder(runs.slice(1));
    bindDownloadButtons();
  }

  // ---- Download with progress ----
  async function downloadZip(runId, btn) {
    const right = btn?.parentElement;
    if (!right) return;
    const original = right.innerHTML;
    right.innerHTML = `
      <div class="dl-progress">
        <div class="dl-bar"><div class="dl-bar-fill" style="width:0%"></div></div>
        <div class="dl-text">starting…</div>
      </div>`;
    const fillEl = right.querySelector('.dl-bar-fill');
    const textEl = right.querySelector('.dl-text');

    try {
      const r = await fetch(`${API}/public/runs/${runId}/zip`, { credentials: 'same-origin' });
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
        const mb = (received / 1048576).toFixed(1);
        if (total) {
          const pct = Math.min(99, Math.round((received / total) * 100));
          fillEl.style.width = pct + '%';
          textEl.textContent = `${pct}% · ${mb} MB`;
        } else {
          fillEl.style.width = '100%';
          fillEl.classList.add('indeterminate');
          textEl.textContent = `${mb} MB`;
        }
      }
      fillEl.style.width = '100%';
      fillEl.classList.remove('indeterminate');
      textEl.textContent = 'saving…';

      const blob = new Blob(chunks, { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${runId}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      textEl.textContent = `${(blob.size / 1048576).toFixed(1)} MB`;
      setTimeout(() => { right.innerHTML = original; bindDownloadButtons(); }, 1500);
    } catch (err) {
      textEl.textContent = 'failed';
      fillEl.classList.add('failed');
      setTimeout(() => { right.innerHTML = original; bindDownloadButtons(); }, 2000);
      console.error('download failed', err);
    }
  }

  function bindDownloadButtons() {
    document.querySelectorAll('.btn-action').forEach(b => {
      if (b.dataset.bound) return;
      b.dataset.bound = '1';
      b.addEventListener('click', () => downloadZip(b.dataset.run, b));
    });
  }

  function openSSE() {
    const es = new EventSource(`${API}/public/events`);
    ['run.started','run.finished','run.failed','stage.started','stage.finished','render.item']
      .forEach(ev => es.addEventListener(ev, renderRuns));
  }

  (async function () {
    // If URL has ?invite=, show welcome message so tester knows they're invited
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
