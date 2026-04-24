#!/usr/bin/env node
/** Look at the most recent failed run across all clients (dev-only debugging). */
require('dotenv').config();
const { sb } = require('../v2/src/db/supabase');

(async () => {
  const { data: runs } = await sb()
    .from('runs')
    .select('id, status, client_id, started_at, finished_at, trace')
    .eq('status', 'failed')
    .order('started_at', { ascending: false })
    .limit(3);
  if (!runs?.length) { console.log('(no failed runs)'); return; }

  for (const r of runs) {
    console.log(`\n=== ${r.id} ===`);
    console.log(`client_id: ${r.client_id}  started: ${r.started_at}  finished: ${r.finished_at}`);
    console.log(`top-level error: ${r.trace?.error || '(none)'}`);
    // Stage-level errors
    for (const [name, stage] of Object.entries(r.trace?.stages || {})) {
      if (stage.status === 'failed') {
        console.log(`  stage ${name} FAILED: ${stage.error || stage.message || '(no message)'}`);
      }
    }
    // Render-item errors
    const renders = r.trace?.stages?.renders?.items || {};
    for (const [tid, arr] of Object.entries(renders)) {
      const title = r.trace?.input?.titles?.find(t => t.id === tid)?.title || tid;
      for (const item of arr) {
        if (item.status === 'failed') {
          console.log(`  render "${title.slice(0, 50)}" ${item.filename || '?'}: ${item.error || '(no msg)'}`);
          if (item.prompt) console.log(`    prompt head: ${String(item.prompt).slice(0, 200)}`);
        }
      }
    }
    // Input options (what model was requested)
    console.log(`  options: ${JSON.stringify(r.trace?.input?.options || {})}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
