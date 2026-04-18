(function () {
  const API = '/api/public';
  let TOKEN = null;

  const $ = (s) => document.querySelector(s);

  async function json(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}), ...(TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {}) }
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    return r.json();
  }

  async function downloadZip(runId) {
    const r = await fetch(`${API}/runs/${runId}/zip`, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    if (!r.ok) { alert('Download failed: ' + r.status); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${runId}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function login(token) {
    TOKEN = token;
    try {
      const me = await json(`${API}/me`);
      localStorage.setItem('token', token);
      $('#client-meta').textContent = `${me.name} — ${me.n_per_title}/title`;
      $('#auth-section').hidden = true;
      $('#app-section').hidden = false;
      await renderRuns();
      openSSE();
    } catch (e) {
      TOKEN = null;
      $('#auth-error').textContent = 'Invalid token';
    }
  }

  $('#auth-form').addEventListener('submit', (e) => { e.preventDefault(); login($('#token').value.trim()); });

  $('#batch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const titles = $('#titles').value.trim().split('\n').map(x => x.trim()).filter(Boolean);
    if (!titles.length) return;
    $('#generate-btn').disabled = true;
    try {
      await json(`${API}/runs`, { method: 'POST', body: JSON.stringify({ titles }) });
      $('#titles').value = '';
    } catch (err) { alert('Failed: ' + err.message); }
    finally { $('#generate-btn').disabled = false; }
    await renderRuns();
  });

  async function renderRuns() {
    const runs = await json(`${API}/runs`);
    const tbody = $('#runs-table tbody');
    tbody.innerHTML = '';
    for (const r of runs) {
      const tr = document.createElement('tr');
      const p = r.renderProgress || { ok: 0, failed: 0, total: 0 };
      const done = p.ok + p.failed;
      const progressStr = p.total ? `${done}/${p.total}` + (p.failed ? ` (${p.failed} failed)` : '') : '—';
      const canDownload = r.status === 'done' && p.ok > 0;
      tr.innerHTML = `
        <td>${r.id}</td>
        <td>${new Date(r.startedAt).toLocaleString()}</td>
        <td>${r.titleCount}</td>
        <td>${r.status}</td>
        <td>${progressStr}</td>
        <td>${canDownload ? `<button data-run="${r.id}" class="dl">Download ZIP</button>` : '—'}</td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.dl').forEach(b => b.addEventListener('click', () => downloadZip(b.dataset.run)));
  }

  function openSSE() {
    const es = new EventSource(`${API}/events?token=${encodeURIComponent(TOKEN)}`);
    ['run.started','run.finished','run.failed','stage.started','stage.finished','render.item'].forEach(ev => es.addEventListener(ev, renderRuns));
  }

  // Auto-login from URL ?token= or localStorage
  const qs = new URLSearchParams(location.search);
  const pre = qs.get('token') || localStorage.getItem('token');
  if (pre) { $('#token').value = pre; login(pre); }
})();
