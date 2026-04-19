#!/usr/bin/env node
/**
 * Stress-test the live batch pipeline.
 *
 * Usage:
 *   node scripts/stress-test.js --titles 10 --n 5 [--url https://...] [--token <token>]
 */
require('dotenv').config();

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
  }
  return args;
}

const TITLES_POOL = [
  'Does Creatine Cause Hair Loss?',
  'Can Coffee Cause Acne?',
  'Does Retinol Help With Acne?',
  'How to Quit Smoking',
  'Does Dairy Cause Acne?',
  'What Causes Cold Sores?',
  'Does Chocolate Cause Acne?',
  'Does Stress Cause Acne?',
  'Does Sugar Cause Acne?',
  'Can Mold Cause Acne?',
  'Does Whey Protein Cause Acne?',
  'Does Humidity Cause Acne?',
  'Does Testosterone Cause Hair Loss?',
  'Does Ozempic Cause Hair Loss?',
  'Which Vitamin Deficiency Causes Hair Loss?',
  'Does Alcohol Cause Acne?',
  'Does Vaping Cause Acne?',
  'Does Biotin Cause Acne?',
  'Can Ashwagandha Cause Acne?',
  'Does Peanut Butter Cause Acne?'
];

function pickTitles(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(TITLES_POOL[i % TITLES_POOL.length]);
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs();
  const url = (args.url || 'http://localhost:3002').replace(/\/$/, '');
  const token = args.token || process.env.STRESS_TEST_TOKEN;
  const titleCount = parseInt(args.titles || '5', 10);
  const N = parseInt(args.n || '3', 10);

  if (!token) {
    console.error('No token. Pass --token <token> or set STRESS_TEST_TOKEN in .env');
    process.exit(1);
  }

  const titles = pickTitles(titleCount);
  const totalImages = titleCount * N;

  console.log(`\n=== Stress Test ===`);
  console.log(`URL:     ${url}`);
  console.log(`Titles:  ${titleCount}`);
  console.log(`N/title: ${N}`);
  console.log(`Target:  ${totalImages} images\n`);

  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  const tStart = Date.now();

  const fire = await fetch(`${url}/api/public/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ titles, N })
  });
  if (!fire.ok) {
    console.error('POST /api/public/runs failed:', fire.status, await fire.text());
    process.exit(1);
  }
  console.log('Run fired.');

  let runId = null;
  let last = null;
  while (true) {
    const r = await fetch(`${url}/api/public/runs`, { headers });
    const runs = await r.json();
    const run = runs[0];
    if (!run) { await sleep(1000); continue; }
    runId = run.id;
    const p = run.renderProgress || { ok: 0, failed: 0, total: 0 };
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
    const rate = p.ok > 0 ? (p.ok / ((Date.now() - tStart) / 60000)).toFixed(1) : '—';
    const line = `[${elapsed}s] ${run.status} ${p.ok}/${p.total} (${p.failed} failed) · ${rate} img/min`;
    if (line !== last) { console.log(line); last = line; }
    if (run.status === 'done' || run.status === 'failed') break;
    await sleep(5000);
  }

  const t = await fetch(`${url}/api/public/runs/${runId}`, { headers });
  const trace = await t.json();
  const totalSec = (Date.now() - tStart) / 1000;
  const items = Object.values(trace.stages?.renders?.items || {}).flat();
  const ok = items.filter(i => i.status === 'ok').length;
  const failed = items.filter(i => i.status === 'failed').length;
  const renderMs = items.filter(i => i.elapsedMs).map(i => i.elapsedMs);
  const avgMs = renderMs.length ? Math.round(renderMs.reduce((a, b) => a + b, 0) / renderMs.length) : 0;
  const sorted = [...renderMs].sort((a, b) => a - b);
  const p95Ms = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;

  console.log('\n=== Results ===');
  console.log(`Run ID:       ${runId}`);
  console.log(`Status:       ${trace.status}`);
  console.log(`Wall time:    ${totalSec.toFixed(1)}s`);
  console.log(`Rendered:     ${ok}/${totalImages} (${failed} failed)`);
  console.log(`Hit rate:     ${((ok / totalImages) * 100).toFixed(0)}%`);
  console.log(`Throughput:   ${((ok / totalSec) * 60).toFixed(1)} images/min`);
  console.log(`Avg render:   ${avgMs}ms`);
  console.log(`p95 render:   ${p95Ms}ms`);
  console.log(`Stage timing:`);
  for (const [k, v] of Object.entries(trace.stages || {})) {
    console.log(`  ${k.padEnd(10)} ${v.status.padEnd(8)} ${v.elapsedMs || '?'}ms`);
  }
  const retried = items.filter(i => i.attempts && i.attempts > 1).length;
  if (retried) console.log(`Renders with retries: ${retried}/${ok}`);
}

main().catch(e => { console.error(e); process.exit(1); });
