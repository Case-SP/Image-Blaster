#!/usr/bin/env node
// Backfill 384-wide WebP thumbnails for every existing PNG in the
// `generations` bucket into the public `generations-thumbs` bucket.
//
// Idempotent: skips entries whose thumb already exists (HEAD check).
// Safe to run repeatedly (e.g. after partial network failure).
//
// Usage:
//   node scripts/backfill-thumbnails.js              # all clients
//   node scripts/backfill-thumbnails.js --client=ID  # one client only
//   node scripts/backfill-thumbnails.js --concurrency=8

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { sb } = require('../v2/src/db/supabase');
const sharp = require('sharp');

const BUCKET = 'generations';
const THUMBS_BUCKET = 'generations-thumbs';
const THUMB_WIDTH = 384;

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const CLIENT = args.client || null;
const CONCURRENCY = Math.max(1, parseInt(args.concurrency || '6', 10));

async function thumbExists(path) {
  // HEAD via list — Supabase doesn't expose a direct HEAD on objects, so
  // we list the parent prefix with a search filter (cheap, indexed).
  const supa = sb();
  const dir = path.substring(0, path.lastIndexOf('/'));
  const name = path.substring(path.lastIndexOf('/') + 1);
  const { data, error } = await supa.storage.from(THUMBS_BUCKET).list(dir, {
    limit: 1, search: name
  });
  if (error) return false;
  return Array.isArray(data) && data.some(d => d.name === name);
}

async function processOne(row) {
  const supa = sb();
  const srcPath = `${row.run_id}/${row.slug}/${row.filename}`;
  const thumbPath = `${srcPath}.webp`;
  if (await thumbExists(thumbPath)) {
    return { ok: true, skipped: true, path: thumbPath };
  }
  const { data: blob, error: dlErr } = await supa.storage.from(BUCKET).download(srcPath);
  if (dlErr) return { ok: false, path: srcPath, error: `download: ${dlErr.message}` };
  const ab = await blob.arrayBuffer();
  let thumb;
  try {
    thumb = await sharp(Buffer.from(ab)).resize({ width: THUMB_WIDTH }).webp({ quality: 78 }).toBuffer();
  } catch (e) {
    return { ok: false, path: srcPath, error: `resize: ${e.message}` };
  }
  const { error: upErr } = await supa.storage.from(THUMBS_BUCKET).upload(thumbPath, thumb, {
    contentType: 'image/webp', upsert: true
  });
  if (upErr) return { ok: false, path: thumbPath, error: `upload: ${upErr.message}` };
  return { ok: true, skipped: false, path: thumbPath, bytes: thumb.length };
}

(async () => {
  console.log(`[backfill] starting (concurrency=${CONCURRENCY}${CLIENT ? `, client=${CLIENT}` : ''})`);
  const supa = sb();

  // Pull every (run_id, slug, filename) we know about. PostgREST caps page
  // size (~1000 rows by default) so we paginate by primary key.
  let runIds = null;
  if (CLIENT) {
    const { data: runs } = await supa.from('runs').select('id').eq('client_id', CLIENT).limit(10000);
    if (!runs?.length) { console.log('[backfill] no runs for client'); return; }
    runIds = runs.map(r => r.id);
  }
  const PAGE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    let q = supa.from('images').select('run_id, slug, filename').range(from, from + PAGE - 1);
    if (runIds) q = q.in('run_id', runIds);
    const { data, error } = await q;
    if (error) { console.error('[backfill] fetch images failed:', error.message); process.exit(1); }
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`[backfill] ${rows.length} images to consider`);

  let done = 0, skipped = 0, ok = 0, failed = 0;
  const t0 = Date.now();
  const inflight = new Set();
  const tick = () => {
    if (done % 50 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[backfill] ${done}/${rows.length} (ok=${ok} skipped=${skipped} failed=${failed}) ${elapsed}s`);
    }
  };
  for (const row of rows) {
    if (!/\.png$/i.test(row.filename)) continue;
    const p = processOne(row).then(r => {
      done++;
      if (r.skipped) skipped++;
      else if (r.ok) ok++;
      else { failed++; console.warn(`  FAIL ${r.path}: ${r.error}`); }
      tick();
    }).finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
  }
  await Promise.all(inflight);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[backfill] done — ok=${ok} skipped=${skipped} failed=${failed} in ${elapsed}s`);
})().catch(e => { console.error('[backfill] fatal:', e); process.exit(1); });
