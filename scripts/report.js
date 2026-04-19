#!/usr/bin/env node
/**
 * Activity report — every client, when they joined, how many runs they've
 * fired, total images generated, and when they were last active.
 *
 * Usage:
 *   node scripts/report.js
 *   node scripts/report.js --email case@s-p.studio       # detail view
 *   node scripts/report.js --since 2026-04-15             # activity since
 */
require('dotenv').config();
const { sb } = require('../v2/src/db/supabase');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
  }
  return args;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
}

async function detailForEmail(email) {
  const { data: client } = await sb().from('clients').select('*').eq('email', email.toLowerCase()).maybeSingle();
  if (!client) { console.log('(no client with that email)'); return; }

  const { data: runs } = await sb()
    .from('runs').select('id, status, started_at, finished_at, ok_count, failed_count, trace')
    .eq('client_id', client.id)
    .order('started_at', { ascending: false });

  console.log(`\n=== ${client.name}  <${client.email}> ===`);
  console.log(`id:        ${client.id}`);
  console.log(`cartridge: ${client.cartridge}`);
  console.log(`n/title:   ${client.n_per_title}`);
  console.log(`quota:     ${client.monthly_image_quota}`);
  console.log(`joined:    ${fmtDate(client.created_at)}`);
  console.log(`active:    ${client.active ? 'yes' : 'no'}`);
  console.log(`\nRuns: ${runs?.length || 0}`);
  if (!runs?.length) return;

  for (const r of runs.slice(0, 20)) {
    const titles = r.trace?.input?.titles || [];
    const N = r.trace?.input?.N || '?';
    const titleSample = titles.slice(0, 2).map(t => t.title.slice(0, 40)).join(', ') + (titles.length > 2 ? '…' : '');
    console.log(`  ${fmtDate(r.started_at)}  ${r.status.padEnd(7)}  ${r.ok_count}/${r.ok_count + r.failed_count}  N=${N}  ${titles.length} titles: ${titleSample}`);
  }
  if (runs.length > 20) console.log(`  … and ${runs.length - 20} older runs`);

  const totalOk = runs.reduce((a, r) => a + (r.ok_count || 0), 0);
  const totalFailed = runs.reduce((a, r) => a + (r.failed_count || 0), 0);
  console.log(`\nLifetime: ${totalOk} images rendered, ${totalFailed} failed`);
}

async function overview(sinceIso) {
  const { data: clients } = await sb()
    .from('clients')
    .select('id, email, name, cartridge, n_per_title, created_at, active');
  if (!clients?.length) { console.log('(no clients yet)'); return; }

  // Fetch runs once (scoped by since if given)
  let runQuery = sb().from('runs').select('client_id, status, started_at, ok_count, failed_count');
  if (sinceIso) runQuery = runQuery.gte('started_at', sinceIso);
  const { data: runs } = await runQuery;

  const byClient = new Map();
  for (const r of runs || []) {
    const cur = byClient.get(r.client_id) || { runs: 0, ok: 0, failed: 0, last: null, done: 0, running: 0, bad: 0 };
    cur.runs++;
    cur.ok += r.ok_count || 0;
    cur.failed += r.failed_count || 0;
    if (!cur.last || r.started_at > cur.last) cur.last = r.started_at;
    if (r.status === 'done') cur.done++;
    else if (r.status === 'running') cur.running++;
    else if (r.status === 'failed') cur.bad++;
    byClient.set(r.client_id, cur);
  }

  console.log('');
  console.log('email'.padEnd(30), 'name'.padEnd(18), 'cartridge'.padEnd(10), 'joined'.padEnd(17), 'runs', 'imgs', 'last-active');
  console.log('─'.repeat(110));

  const rows = clients.map(c => ({ c, stats: byClient.get(c.id) || { runs: 0, ok: 0, failed: 0, last: null } }));
  rows.sort((a, b) => (b.stats.last || '').localeCompare(a.stats.last || ''));

  for (const { c, stats } of rows) {
    console.log(
      (c.email || '(no email)').padEnd(30),
      (c.name || '').slice(0, 17).padEnd(18),
      (c.cartridge || '').slice(0, 9).padEnd(10),
      fmtDate(c.created_at).padEnd(17),
      String(stats.runs).padStart(4),
      String(stats.ok).padStart(4),
      fmtDate(stats.last)
    );
  }

  const totalRuns = rows.reduce((a, r) => a + r.stats.runs, 0);
  const totalImgs = rows.reduce((a, r) => a + r.stats.ok, 0);
  console.log('─'.repeat(110));
  console.log(`${clients.length} client${clients.length === 1 ? '' : 's'} · ${totalRuns} runs · ${totalImgs} images${sinceIso ? ' (since ' + sinceIso + ')' : ''}`);
}

(async () => {
  const args = parseArgs();
  if (args.email) {
    await detailForEmail(args.email);
  } else {
    const sinceIso = args.since ? new Date(args.since).toISOString() : null;
    await overview(sinceIso);
  }
})().catch(e => { console.error(e); process.exit(1); });
