(function () {
  const API = '/api';
  const $ = (s) => document.querySelector(s);

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
    $('#app-section').hidden = which !== 'app';
  }

  function setStatus(kind, text) {
    const pill = $('#status-pill');
    pill.hidden = false;
    pill.className = kind;
    $('#status-text').textContent = text;
  }

  let pendingEmail = null;

  $('#email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim().toLowerCase();
    $('#email-btn').disabled = true;
    $('#email-msg').textContent = '';
    try {
      await json(`${API}/auth/request-code`, { method: 'POST', body: JSON.stringify({ email }) });
      pendingEmail = email;
      $('#code-email').textContent = email;
      show('code');
      $('#code').focus();
    } catch (err) {
      $('#email-msg').textContent = err.message;
    } finally {
      $('#email-btn').disabled = false;
    }
  });

  $('#code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#code').value.trim();
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
  });

  $('#resend-btn').addEventListener('click', async () => {
    if (!pendingEmail) return;
    $('#code-msg').textContent = 'Sending new code…';
    try {
      await json(`${API}/auth/request-code`, { method: 'POST', body: JSON.stringify({ email: pendingEmail }) });
      $('#code-msg').textContent = 'New code sent.';
    } catch (err) {
      $('#code-msg').textContent = err.message;
    }
  });

  async function enterApp() {
    show('app');
    // Initialize N selector from client default
    try {
      const me = await json(`${API}/auth/me`);
      const defN = String(me.n_per_title || 3);
      const sel = $('#n-per-title');
      if (sel.querySelector(`option[value="${defN}"]`)) sel.value = defN;
    } catch {}
    updateTotals();
    await renderRuns();
    openSSE();
  }

  function countTitles() {
    return $('#titles').value.trim().split('\n').map(x => x.trim()).filter(Boolean).length;
  }
  function updateTotals() {
    const t = countTitles();
    const n = parseInt($('#n-per-title').value, 10) || 1;
    $('#totals').textContent = `${t} title${t === 1 ? '' : 's'} · ${t * n} image${t * n === 1 ? '' : 's'} total`;
  }
  $('#titles').addEventListener('input', updateTotals);
  $('#n-per-title').addEventListener('change', updateTotals);

  $('#signout-btn').addEventListener('click', async () => {
    await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'same-origin' });
    location.reload();
  });

  $('#batch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const titles = $('#titles').value.trim().split('\n').map(x => x.trim()).filter(Boolean);
    if (!titles.length) return;
    const N = parseInt($('#n-per-title').value, 10) || 3;
    const total = titles.length * N;

    // Warning at >50 titles OR >200 total images
    if (titles.length > 50 || total > 200) {
      const ok = confirm(
        `You're about to generate ${total} images (${titles.length} titles × ${N} per title).\n\n` +
        `At roughly 4 seconds per image, this will take about ${Math.ceil(total * 4 / 60)} minute${Math.ceil(total * 4 / 60) === 1 ? '' : 's'}.\n\n` +
        `Continue?`
      );
      if (!ok) return;
    }

    $('#generate-btn').disabled = true;
    try {
      await json(`${API}/public/runs`, {
        method: 'POST',
        body: JSON.stringify({ titles, N })
      });
      $('#titles').value = '';
      updateTotals();
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      $('#generate-btn').disabled = false;
    }
    await renderRuns();
  });

  function formatDate(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${yy}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function renderRuns() {
    const runs = await json(`${API}/public/runs`);
    const list = $('#run-list');
    list.innerHTML = '';
    $('#no-runs').hidden = runs.length > 0;

    let anyRunning = false;
    for (const r of runs) {
      const row = document.createElement('div');
      row.className = 'run-row';
      const p = r.renderProgress || { ok: 0, failed: 0, total: 0 };
      const done = p.ok + p.failed;
      const isRunning = r.status === 'running';
      if (isRunning) anyRunning = true;

      const titleBits = `${r.titleCount} title${r.titleCount === 1 ? '' : 's'} · ${p.total} image${p.total === 1 ? '' : 's'}`;
      const canDownload = r.status === 'done' && p.ok > 0;

      let rightHtml = '';
      if (canDownload) {
        rightHtml = `<button class="btn-action" data-run="${r.id}">Download</button>`;
      } else if (isRunning) {
        rightHtml = `<div class="run-status running">${done}/${p.total || '—'}</div>`;
      } else if (r.status === 'failed') {
        rightHtml = `<div class="run-status failed">failed</div>`;
      } else {
        rightHtml = `<div class="run-status">—</div>`;
      }

      row.innerHTML = `
        <div class="run-left">
          <div class="run-date">${formatDate(r.startedAt)}</div>
          <div class="run-title">${titleBits}${p.failed ? ` <span class="run-meta">· ${p.failed} failed</span>` : ''}</div>
        </div>
        <div class="run-right">${rightHtml}</div>`;
      list.appendChild(row);
    }
    list.querySelectorAll('.btn-action').forEach(b =>
      b.addEventListener('click', () => downloadZip(b.dataset.run))
    );

    if (anyRunning) setStatus('running', 'generating');
    else setStatus('idle', 'idle');
  }

  async function downloadZip(runId) {
    const r = await fetch(`${API}/public/runs/${runId}/zip`, { credentials: 'same-origin' });
    if (!r.ok) { alert('Download failed: ' + r.status); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${runId}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openSSE() {
    const es = new EventSource(`${API}/public/events`);
    ['run.started','run.finished','run.failed','stage.started','stage.finished','render.item']
      .forEach(ev => es.addEventListener(ev, renderRuns));
  }

  (async function () {
    try {
      await json(`${API}/auth/me`);
      enterApp();
    } catch {
      show('email');
    }
  })();
})();
