#!/usr/bin/env node
// Rebuild deleted run rows from storage sidecar metadata.
// Default: dry-run (lists what would be written). Pass --execute to commit.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sb } = require('../v2/src/db/supabase');

const EXECUTE = process.argv.includes('--execute');
const ORPHANS_FROM_ARG = process.argv.filter(a => /^\d{8}-\d{6}-/.test(a));

async function findClientId() {
  // Open-mode public client id. The orphans were created in open mode so
  // they all belong to it.
  const supa = sb();
  const { data } = await supa.from('clients').select('id, email').eq('email', 'public@image-blaster.local').maybeSingle();
  return data?.id || null;
}

async function discoverOrphans() {
  const supa = sb();
  const { data: roots } = await supa.storage.from('generations').list('', { limit: 1000, sortBy: { column: 'name' } });
  const storageIds = (roots || []).map(r => r.name).filter(n => /^\d{8}-\d{6}-/.test(n));
  const { data: runs } = await supa.from('runs').select('id').limit(2000);
  const dbIds = new Set((runs || []).map(r => r.id));
  return storageIds.filter(id => !dbIds.has(id));
}

async function readSidecar(runId, slug, filename) {
  const path = `${runId}/${slug}/${filename}.json`;
  const { data, error } = await sb().storage.from('generations').download(path);
  if (error || !data) return null;
  try {
    const txt = await data.text();
    return JSON.parse(txt);
  } catch { return null; }
}

async function rebuildOne(runId, clientId) {
  const supa = sb();
  const { data: slugs } = await supa.storage.from('generations').list(runId);
  if (!slugs?.length) return { runId, skipped: 'no slugs' };

  const titles = [];
  const itemsByTitle = {};
  let cartridge = 'product'; // default; sidecar will override
  let earliest = null, latest = null;
  let runStage = null;
  let recoveredCount = 0;
  let runParentsFromSidecar = null;

  for (const sObj of slugs) {
    if (!sObj.name) continue;
    const slug = sObj.name;
    const { data: files } = await supa.storage.from('generations').list(`${runId}/${slug}`);
    const pngs = (files || []).filter(f => f.name && /\.png$/.test(f.name));
    if (!pngs.length) continue;

    const titleId = `t-${runId}-${slug.slice(0, 24)}`;
    const titleText = slug.replace(/-/g, ' ');
    titles.push({ id: titleId, title: titleText, slug, category: 'general' });
    itemsByTitle[titleId] = [];

    for (let i = 0; i < pngs.length; i++) {
      const png = pngs[i];
      const meta = await readSidecar(runId, slug, png.name);
      const ts = meta?.generatedAt || null;
      if (ts) {
        const tms = new Date(ts).getTime();
        if (!earliest || tms < earliest) earliest = tms;
        if (!latest || tms > latest) latest = tms;
      }
      runStage = runStage || meta?.stage || meta?.composition || null;
      if (meta?.parent && !runParentsFromSidecar) runParentsFromSidecar = [meta.parent];
      itemsByTitle[titleId].push({
        promptIdx: meta?.__styleIndex ?? i,
        filename: png.name,
        status: 'ok',
        model: meta?.model || 'fal-ai/nano-banana-pro',
        elapsedMs: meta?.elapsedMs || null,
        refsAttached: meta?.refsAttached || 0,
        refsAvailable: meta?.refsAvailable || 0,
        stage: meta?.stage || meta?.composition || null,
        parent: meta?.parent || null
      });
      recoveredCount++;
    }
  }

  // Synthesize a minimal trace
  const startedAt = earliest ? new Date(earliest).toISOString() : runIdToTimestamp(runId);
  const finishedAt = latest ? new Date(latest).toISOString() : startedAt;
  const trace = {
    id: runId,
    cartridge,
    clientId,
    status: 'done',
    startedAt,
    finishedAt,
    input: {
      titles,
      N: Math.max(1, ...Object.values(itemsByTitle).map(a => a.length)),
      stage: runStage,
      parents: runParentsFromSidecar,
      options: {}
    },
    stages: {
      shotList:    { status: 'done', mode: 'recovered' },
      critic:      { status: 'skipped' },
      resolved:    { status: 'done' },
      gpt2Rewrite: { status: 'skipped' },
      renders:     { status: 'done', items: itemsByTitle }
    },
    verdicts: {},
    error: null,
    __recovered: true,
    __recoveredAt: new Date().toISOString()
  };
  const okCount = recoveredCount;

  if (!EXECUTE) {
    return { runId, slugs: titles.length, recovered: okCount, status: 'dry-run' };
  }

  // Write run row
  const { error: runErr } = await supa.from('runs').upsert([{
    id: runId,
    client_id: clientId,
    status: 'done',
    trace,
    started_at: startedAt,
    finished_at: finishedAt,
    ok_count: okCount,
    failed_count: 0
  }]);
  if (runErr) return { runId, error: 'run upsert: ' + runErr.message };

  // Write images table rows
  const imgRows = [];
  for (const t of titles) {
    for (const it of itemsByTitle[t.id]) {
      imgRows.push({
        run_id: runId,
        slug: t.slug,
        filename: it.filename,
        storage_path: `${runId}/${t.slug}/${it.filename}`
      });
    }
  }
  if (imgRows.length) {
    const { error: imgErr } = await supa.from('images').insert(imgRows);
    if (imgErr && !String(imgErr.message || '').includes('duplicate')) {
      return { runId, error: 'images insert: ' + imgErr.message };
    }
  }
  return { runId, slugs: titles.length, recovered: okCount, imageRowsInserted: imgRows.length, status: 'rebuilt' };
}

function runIdToTimestamp(runId) {
  const m = runId.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return new Date().toISOString();
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

(async () => {
  const clientId = await findClientId();
  if (!clientId) { console.error('public client id not found'); process.exit(1); }
  const orphans = ORPHANS_FROM_ARG.length ? ORPHANS_FROM_ARG : await discoverOrphans();
  console.log(`mode: ${EXECUTE ? 'EXECUTE (writing)' : 'DRY RUN (no writes)'}`);
  console.log(`clientId: ${clientId}`);
  console.log(`orphans to process: ${orphans.length}`);
  console.log('');
  for (const id of orphans) {
    const r = await rebuildOne(id, clientId);
    console.log(JSON.stringify(r));
  }
})();
