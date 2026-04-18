(function () {
  const API = '/api';

  async function json(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }

  async function initRunsPage() {
    const cartridges = (await json(`${API}/cartridges`)).cartridges;
    const sel = document.getElementById('cartridge');
    cartridges.forEach(c => { const o = document.createElement('option'); o.value = o.textContent = c; sel.appendChild(o); });

    document.getElementById('new-run-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const titlesRaw = f.titles.value.trim().split('\n').filter(Boolean);
      const titles = titlesRaw.map((line, i) => {
        const [cat, ...rest] = line.split('|');
        const title = rest.join('|').trim() || cat.trim();
        const category = rest.length ? cat.trim() : 'general';
        return { id: `t${Date.now()}-${i}`, title, category };
      });
      await json(`${API}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartridge: f.cartridge.value, titles, N: parseInt(f.N.value), critic: f.critic.checked, model: f.model.value
        })
      });
      renderRuns();
    });

    await renderRuns();

    const es = new EventSource(`${API}/events`);
    ['run.started','run.finished','run.failed','stage.started','stage.finished','render.item'].forEach(ev => es.addEventListener(ev, renderRuns));
  }

  async function renderRuns() {
    const runs = await json(`${API}/runs`);
    const tbody = document.querySelector('#runs-table tbody');
    tbody.innerHTML = '';
    for (const r of runs) {
      const tr = document.createElement('tr');
      const hr = r.hitRate?.total ? `${(r.hitRate.rate * 100).toFixed(0)}% (${r.hitRate.usable}/${r.hitRate.total})` : '—';
      const p = r.renderProgress || { ok: 0, failed: 0, total: 0 };
      const done = p.ok + p.failed;
      let progress = '—';
      if (p.total) {
        const pct = Math.round((done / p.total) * 100);
        const stages = r.stageStatus || {};
        const currentStage = stages.renders === 'running' ? 'rendering'
          : stages.resolved === 'running' ? 'resolving'
          : stages.critic === 'running' ? 'critic'
          : stages.shotList === 'running' ? 'shotList'
          : r.status === 'running' ? 'starting' : '';
        progress = r.status === 'done' || r.status === 'failed'
          ? `${done}/${p.total}${p.failed ? ` (${p.failed} failed)` : ''}`
          : `<span class="progressing">${currentStage || 'running'} · ${done}/${p.total} (${pct}%)</span>`;
      }
      tr.innerHTML = `
        <td><a href="/run.html?id=${r.id}">${r.id}</a></td>
        <td>${r.cartridge}</td>
        <td class="status-${r.status}">${r.status}</td>
        <td>${progress}</td>
        <td>${r.titleCount}</td>
        <td>${r.N}</td>
        <td>${hr}</td>
        <td>${new Date(r.startedAt).toLocaleString()}</td>`;
      tbody.appendChild(tr);
    }
  }

  async function initRunDetailPage() {
    const id = new URLSearchParams(location.search).get('id');
    document.getElementById('run-id').textContent = id;

    let trace = await json(`${API}/runs/${id}`);
    render(trace);

    const es = new EventSource(`${API}/events?run=${id}`);
    const refresh = async () => { trace = await json(`${API}/runs/${id}`); render(trace); };
    ['stage.started', 'stage.updated', 'stage.finished', 'render.item', 'verdict.set', 'run.finished', 'run.failed'].forEach(ev => es.addEventListener(ev, refresh));
  }

  function render(trace) {
    renderOverview(trace);
    renderStages(trace);
    renderTitles(trace);
  }

  function renderOverview(trace) {
    const total = Object.values(trace.verdicts || {}).length;
    const usable = Object.values(trace.verdicts || {}).filter(v => v.verdict === 'usable' || v.verdict === 'winner').length;
    const rate = total ? ((usable / total) * 100).toFixed(0) : '—';
    document.getElementById('overview').innerHTML = `
      <div class="overview">
        <div><strong>Cartridge:</strong> ${trace.cartridge}</div>
        <div><strong>Status:</strong> <span class="status-${trace.status}">${trace.status}</span></div>
        <div><strong>Titles:</strong> ${trace.input.titles.length} × N=${trace.input.N}</div>
        <div><strong>Hit rate:</strong> ${rate}${total ? '% (' + usable + '/' + total + ')' : ''}</div>
        <div><strong>Started:</strong> ${new Date(trace.startedAt).toLocaleString()}</div>
      </div>`;
  }

  function renderStages(trace) {
    const s = trace.stages;
    const row = (name, stage) => {
      const elapsed = stage.elapsedMs ? `${stage.elapsedMs} ms` : '';
      const extra =
        name === 'shotList' ? ` · model=${stage.model || ''} · ${stage.tokensUsed ? `${stage.tokensUsed.total_tokens || 0} tokens` : ''}` :
        name === 'critic'   ? `${stage.enabled === false ? ' (skipped)' : ''}` :
        name === 'resolved' ? '' :
        name === 'renders'  ? (() => {
          const items = Object.values(stage.items || {}).flat();
          const ok = items.filter(i => i.status === 'ok').length;
          return ` · ${ok}/${items.length} rendered`;
        })() : '';
      return `<div class="stage stage-${stage.status}"><span class="name">${name}</span><span class="status">${stage.status}</span><span class="meta">${elapsed}${extra}</span></div>`;
    };
    document.getElementById('stages').innerHTML = `
      <h2>Chain</h2>
      <div class="stages">
        ${row('shotList', s.shotList)}
        ${row('critic', s.critic)}
        ${row('resolved', s.resolved)}
        ${row('renders', s.renders)}
      </div>`;
  }

  function renderTitles(trace) {
    const root = document.getElementById('titles');
    root.innerHTML = '<h2>Titles</h2>';
    for (const title of trace.input.titles) {
      root.appendChild(renderTitle(trace, title));
    }
  }

  function renderTitle(trace, title) {
    const wrap = document.createElement('div');
    wrap.className = 'title-card';
    const variance = trace.stages.shotList?.variance?.[title.id];
    const pVar = trace.stages.resolved?.promptVariance?.[title.id];
    const shots = (trace.stages.critic?.status === 'done' ? trace.stages.critic.revised?.[title.id]?.shots : trace.stages.shotList?.raw?.[title.id]?.shots) || [];
    const resolved = trace.stages.resolved?.prompts?.[title.id] || [];
    const renders = trace.stages.renders?.items?.[title.id] || [];
    const diff = trace.stages.critic?.diff?.[title.id] || [];

    wrap.innerHTML = `
      <header>
        <h3>${escapeHtml(title.title)} <small>[${title.category}]</small></h3>
        <div class="variance">
          ${variance ? `Shot variance: <strong>${variance.score}</strong> · ${variance.distinct?.composition}/${variance.total} compositions · ${variance.distinct?.subject_type} subjects · ${variance.distinct?.theme} themes · ${variance.distinct?.model_spec} models` : ''}
          ${pVar ? ` · Prompt jaccard distance: <strong>${pVar.avgDistance}</strong>` : ''}
        </div>
      </header>

      <details open><summary>Stage 1 · Shot list (raw LLM)</summary>
        ${shotsTable(trace.stages.shotList?.raw?.[title.id]?.shots || [])}
      </details>

      <details ${diff.length ? 'open' : ''}><summary>Stage 2 · Critic diff (${diff.length} changes)</summary>
        ${diffTable(diff)}
      </details>

      <details><summary>Stage 3 · Resolved prompts</summary>
        ${resolvedList(resolved)}
      </details>

      <details open><summary>Stage 4 · Renders</summary>
        ${renderGrid(trace, title, resolved, renders)}
      </details>
    `;

    wrap.querySelectorAll('[data-verdict]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await json(`${API}/runs/${trace.id}/verdict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            titleId: title.id, filename: btn.dataset.filename, verdict: btn.dataset.verdict
          })
        });
      });
    });

    return wrap;
  }

  function shotsTable(shots) {
    if (!shots.length) return '<p class="empty">pending…</p>';
    return `<table class="shots"><thead><tr><th>#</th><th>composition</th><th>subject_type</th><th>topic</th><th>theme</th><th>model_spec</th></tr></thead><tbody>${
      shots.map((s, i) => `<tr><td>${i+1}</td><td>${s.composition||''}</td><td>${s.subject_type||''}</td><td>${s.subject_topic||''}</td><td>${s.theme||''}</td><td>${s.model_spec||''}</td></tr>`).join('')
    }</tbody></table>`;
  }

  function diffTable(diff) {
    if (!diff.length) return '<p class="empty">no changes</p>';
    return `<table class="diff"><thead><tr><th>#</th><th>kind</th><th>changed</th><th>before → after</th></tr></thead><tbody>${
      diff.map(d => {
        if (d.kind === 'changed') {
          const changes = (d.keys || []).map(k => `<code>${k}</code>: ${escapeHtml(String(d.before?.[k] ?? ''))} → ${escapeHtml(String(d.after?.[k] ?? ''))}`).join('<br>');
          return `<tr><td>${d.idx+1}</td><td>changed</td><td>${(d.keys||[]).join(', ')}</td><td>${changes}</td></tr>`;
        }
        return `<tr><td>${d.idx+1}</td><td>${d.kind}</td><td></td><td>${escapeHtml(JSON.stringify(d.before || d.after))}</td></tr>`;
      }).join('')
    }</tbody></table>`;
  }

  function resolvedList(resolved) {
    if (!resolved.length) return '<p class="empty">pending…</p>';
    return `<ol class="resolved">${resolved.map(r => `
      <li>
        <div class="prompt">${highlightSlots(r)}</div>
        <div class="meta">
          <code>${r.composition}</code> · <code>${r.subject_phrase}</code> · <code>${r.theme}</code> · ${r.camera} · ${r.lens}
        </div>
      </li>`).join('')}</ol>`;
  }

  function highlightSlots(r) {
    let p = escapeHtml(r.prompt);
    if (r.subject_phrase) p = p.replace(escapeHtml(r.subject_phrase), `<mark class="subj">${escapeHtml(r.subject_phrase)}</mark>`);
    for (const v of Object.values(r.slots_used || {})) {
      if (!v) continue;
      const esc = escapeHtml(v);
      p = p.replace(esc, `<mark class="slot">${esc}</mark>`);
    }
    return p;
  }

  function renderGrid(trace, title, resolved, renders) {
    if (!renders.length) return '<p class="empty">pending…</p>';
    return `<div class="grid">${renders.map(r => {
      const prompt = resolved[r.promptIdx];
      const vkey = `${title.id}/${r.filename}`;
      const v = trace.verdicts?.[vkey]?.verdict;
      const imgUrl = `${API}/images/${encodeURIComponent(title.slug)}/${encodeURIComponent(r.filename)}`;
      if (r.status !== 'ok') return `<div class="tile failed"><div>${r.filename}</div><div class="error">${escapeHtml(r.error || '')}</div></div>`;
      return `
        <div class="tile verdict-${v || 'none'}">
          <img src="${imgUrl}" alt="${r.filename}" loading="lazy">
          <div class="tile-prompt">${prompt ? escapeHtml(prompt.prompt.slice(0, 140)) + '…' : ''}</div>
          <div class="verdict-buttons">
            <button data-verdict="usable"      data-filename="${r.filename}">✓ usable</button>
            <button data-verdict="not-usable"  data-filename="${r.filename}">✗ reject</button>
            <button data-verdict="winner"      data-filename="${r.filename}">★ winner</button>
          </div>
        </div>`;
    }).join('')}</div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }

  window.BrandImageBlaster = { initRunsPage, initRunDetailPage };
})();
