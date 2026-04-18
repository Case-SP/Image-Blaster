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
    await renderRuns();
    openSSE();
  }

  $('#signout-btn').addEventListener('click', async () => {
    await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'same-origin' });
    location.reload();
  });

  $('#batch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const titles = $('#titles').value.trim().split('\n').map(x => x.trim()).filter(Boolean);
    if (!titles.length) return;
    $('#generate-btn').disabled = true;
    try {
      await json(`${API}/public/runs`, { method: 'POST', body: JSON.stringify({ titles }) });
      $('#titles').value = '';
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      $('#generate-btn').disabled = false;
    }
    await renderRuns();
  });

  async function renderRuns() {
    const runs = await json(`${API}/public/runs`);
    const tbody = $('#runs-table tbody');
    tbody.innerHTML = '';
    $('#no-runs').hidden = runs.length > 0;

    let anyRunning = false;
    for (const r of runs) {
      const tr = document.createElement('tr');
      const p = r.renderProgress || { ok: 0, failed: 0, total: 0 };
      const done = p.ok + p.failed;
      const isRunning = r.status === 'running';
      if (isRunning) anyRunning = true;
      const progressStr = p.total
        ? `${done}/${p.total}` + (p.failed ? ` · ${p.failed} failed` : '')
        : (isRunning ? 'starting…' : '—');
      const canDownload = r.status === 'done' && p.ok > 0;
      tr.innerHTML = `
        <td>${new Date(r.startedAt).toLocaleString()}</td>
        <td>${r.titleCount}</td>
        <td>${progressStr}</td>
        <td>${canDownload ? `<button data-run="${r.id}" class="dl">Download ZIP</button>`
                          : (r.status === 'failed' ? '<span class="muted">failed</span>' : '')}</td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.dl').forEach(b => b.addEventListener('click', () => downloadZip(b.dataset.run)));

    if (anyRunning) setStatus('running', 'generating…');
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
