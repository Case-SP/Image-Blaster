#!/usr/bin/env node
//
// classify-logo-refs.js
//
// One-time ingestion: scans v2/cartridge/logos/all refs/, sends each image
// to OpenRouter Haiku Vision with a constrained classification prompt, moves
// the file to v2/cartridge/logos/references/<bucket>/ under a sortable name.
//
// Buckets:
//   sketch     — hand-drawn working sketches OR pages showing many marks
//                tiled together (catalog/grid pages, exploration sheets,
//                construction-line type studies)
//   logo-only  — a single finished mark/icon as dominant subject, no wordmark
//   wordmark   — a single finished wordmark/logotype as dominant subject
//   system     — finished mark AND wordmark composed together (badges,
//                lockups, integrated emblems)
//   mockup     — brand identity applied to surface (business card, packaging,
//                signage, apparel, web header, brand book spec page)
//
// Idempotent: files already moved (no longer in `all refs/`) aren't reprocessed.
// Concurrency: 5 in-flight. Skips GIFs (cartridge loader rejects them).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'v2', 'cartridge', 'logos');
const SRC = path.join(ROOT, 'all refs');
const REFS = path.join(ROOT, 'references');
const BUCKETS = ['sketch', 'logo-only', 'wordmark', 'system', 'mockup'];
const CONCURRENCY = 5;
const MODEL = 'anthropic/claude-haiku-4.5';

const SYSTEM = `You classify brand-identity reference images into exactly one of five buckets. Output ONLY the bucket name, lowercase, no other text, no punctuation.

Buckets:
- sketch: hand-drawn working sketches OR pages showing MANY marks/logos tiled together (catalog pages, mark grids, exploration sheets, construction-line type studies, vector wireframes with anchor-point handles, multi-variation pages). Anything where the image is showing multiple marks or letterform variations as exploration material counts as sketch.
- logo-only: a SINGLE finished mark/icon as the dominant subject, no wordmark accompanying it. The mark stands alone.
- wordmark: a SINGLE finished wordmark/logotype as the dominant subject, no separate mark accompanying it. Type-only identity.
- system: a finished brand identity where the mark AND the wordmark are composed together as one integrated piece — badges, lockups, emblems, sealed identities. Both elements are present and resolved.
- mockup: the brand identity applied to a surface or shown in printed/manufactured context — business card, packaging, apparel, signage, web header, vehicle, product, brand-book or spec-sheet layouts showing the system in use.

Output exactly one of: sketch, logo-only, wordmark, system, mockup`;

const VALID = new Set(BUCKETS);

function mimeFor(ext) {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function classifyOne(file) {
  const ext = path.extname(file).toLowerCase();
  if (!/\.(jpg|jpeg|png|webp)$/i.test(file)) {
    return { file, bucket: null, reason: `unsupported ext ${ext}` };
  }
  const fullPath = path.join(SRC, file);
  const buf = fs.readFileSync(fullPath);
  const dataUrl = `data:${mimeFor(ext)};base64,${buf.toString('base64')}`;

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3002',
        'X-Title': 'Recast Logo Refs Classifier'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Classify this image.' },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ]
      })
    });
  } catch (e) {
    return { file, bucket: null, reason: `fetch error: ${e.message}` };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { file, bucket: null, reason: `OpenRouter ${response.status}: ${body.slice(0, 100)}` };
  }
  const result = await response.json().catch(() => null);
  const raw = result?.choices?.[0]?.message?.content;
  if (!raw) return { file, bucket: null, reason: 'empty response' };

  const cleaned = String(raw).trim().toLowerCase().replace(/[.\s]+$/, '').split(/\s+/)[0];
  if (!VALID.has(cleaned)) {
    return { file, bucket: null, reason: `invalid label "${raw.slice(0, 40)}"` };
  }
  return { file, bucket: cleaned };
}

function nextNumber(bucket) {
  const dir = path.join(REFS, bucket);
  const existing = fs.readdirSync(dir).filter(f => /^\d{2}-/.test(f));
  if (!existing.length) return 1;
  const nums = existing.map(f => parseInt(f.slice(0, 2), 10)).filter(n => !isNaN(n));
  return Math.max(0, ...nums) + 1;
}

function safeStem(originalName) {
  // Drop extension, lowercase, collapse whitespace + parens to single hyphen,
  // trim multiple hyphens, max length ~40 so the filename stays readable.
  const stem = originalName.replace(/\.[^.]+$/, '');
  const slug = stem
    .toLowerCase()
    .replace(/[\s\(\)]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug || 'ref';
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set');
    process.exit(1);
  }
  if (!fs.existsSync(SRC)) {
    console.error(`Source folder not found: ${SRC}`);
    process.exit(1);
  }
  for (const b of BUCKETS) {
    fs.mkdirSync(path.join(REFS, b), { recursive: true });
  }

  const files = fs.readdirSync(SRC)
    .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
    .sort();

  const skipped = files.filter(f => /\.gif$/i.test(f));
  const work = files.filter(f => !/\.gif$/i.test(f));

  console.log(`Source: ${SRC}`);
  console.log(`Files: ${files.length} (${work.length} eligible, ${skipped.length} GIFs skipped)`);
  console.log(`Buckets: ${BUCKETS.join(', ')}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log('');

  const results = [];
  const inflight = new Set();
  let i = 0;

  const startOne = (file) => {
    const p = (async () => {
      const r = await classifyOne(file);
      results.push(r);
      const idx = results.length;
      if (r.bucket) {
        const n = nextNumber(r.bucket);
        const ext = path.extname(file);
        const stem = safeStem(file);
        const newName = `${String(n).padStart(2, '0')}-${stem}${ext}`;
        const target = path.join(REFS, r.bucket, newName);
        try {
          fs.renameSync(path.join(SRC, file), target);
          console.log(`[${idx}/${work.length}] ${file}  →  ${r.bucket}/${newName}`);
        } catch (e) {
          console.warn(`[${idx}/${work.length}] ${file}  →  ${r.bucket} (move FAILED: ${e.message})`);
        }
      } else {
        console.warn(`[${idx}/${work.length}] ${file}  ✗  ${r.reason}`);
      }
    })().finally(() => inflight.delete(p));
    inflight.add(p);
  };

  for (i = 0; i < work.length; i++) {
    startOne(work[i]);
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
  }
  await Promise.all(inflight);

  console.log('');
  console.log('=== Distribution ===');
  const counts = {};
  for (const b of BUCKETS) counts[b] = 0;
  let unclassified = 0;
  for (const r of results) {
    if (r.bucket) counts[r.bucket]++;
    else unclassified++;
  }
  for (const b of BUCKETS) console.log(`  ${b.padEnd(10)} : ${counts[b]}`);
  if (unclassified) console.log(`  unclassified : ${unclassified} (left in place)`);
  if (skipped.length) console.log(`  gif (skipped): ${skipped.length}`);

  const remaining = fs.readdirSync(SRC).filter(f => !f.startsWith('.'));
  console.log('');
  console.log(`Remaining in "all refs/": ${remaining.length}`);
  if (remaining.length && remaining.length <= 10) {
    for (const f of remaining) console.log(`  - ${f}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
