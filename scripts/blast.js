#!/usr/bin/env node
/**
 * blast.js — fire N renders at a cartridge for volume testing.
 *
 * Designed for the demo-cartridge contact-sheet flow: each render produces
 * one 4:5 image with 6 panels, so N renders ≈ 6N conceptual demo images.
 *
 * Local dev (AUTH_MODE=open) only — uses /api/public/runs which auto-resolves
 * to the public client. The cartridge override is honored only in open mode.
 *
 * Usage:
 *   node scripts/blast.js --cartridge demo --count 5
 *   node scripts/blast.js --cartridge demo --count 84 --model fal-ai/nano-banana
 *   node scripts/blast.js --cartridge demo --count 10 --titles-prefix "Variant"
 *
 * Defaults: cartridge=demo, count=5, model=fal-ai/nano-banana, aspect=4:5, N=1
 */

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}

const HOST = args.host || 'http://localhost:3002';
const CARTRIDGE = args.cartridge || 'demo';
const COUNT = parseInt(args.count || '5', 10);
const MODEL = args.model || 'fal-ai/nano-banana';
// Comma-separated multi-model fan-out (one shot list, rendered through each).
// Overrides --model when set. e.g. --models fal-ai/nano-banana,openai/gpt-image-2
const MODELS = args.models ? args.models.split(',').map(s => s.trim()).filter(Boolean) : null;
const ASPECT = args.aspect || '4:5';
const QUALITY = args.quality || undefined; // gpt-image-2 only: low | medium | high (default high)
const N_PER = parseInt(args['n-per'] || '1', 10);
const TITLE_PREFIX = args['titles-prefix'] || 'Variant';
const BATCH_SIZE = parseInt(args.batch || '1', 10); // titles per HTTP request

if (!Number.isFinite(COUNT) || COUNT < 1) {
  console.error('--count must be a positive integer');
  process.exit(1);
}

// Build COUNT titles, sliced into BATCH_SIZE-sized POSTs.
const titles = Array.from({ length: COUNT }, (_, i) =>
  `${TITLE_PREFIX} ${String(i + 1).padStart(3, '0')}`
);
const batches = [];
for (let i = 0; i < titles.length; i += BATCH_SIZE) {
  batches.push(titles.slice(i, i + BATCH_SIZE));
}

(async () => {
  const modelLabel = MODELS ? MODELS.join('+') : MODEL;
  console.log(`[blast] cartridge=${CARTRIDGE} model(s)=${modelLabel} aspect=${ASPECT}${QUALITY ? ` quality=${QUALITY}` : ''} N=${N_PER}`);
  console.log(`[blast] firing ${COUNT} title(s) in ${batches.length} batch(es) of ${BATCH_SIZE}`);
  const t0 = Date.now();
  const runIds = [];
  let ok = 0, fail = 0;
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    try {
      const body = {
        titles: batch,
        N: N_PER,
        aspect_ratio: ASPECT,
        cartridge: CARTRIDGE
      };
      if (MODELS) body.models = MODELS; else body.model = MODEL;
      if (QUALITY) body.quality = QUALITY;
      const r = await fetch(`${HOST}/api/public/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const resp = await r.json().catch(() => ({}));
      if (!r.ok) { fail++; console.warn(`[blast] batch ${bi + 1} HTTP ${r.status}:`, resp.error || resp); continue; }
      ok++;
      console.log(`[blast] batch ${bi + 1}/${batches.length} started — ${batch.length} title(s), ${batch.length * N_PER} render(s)`);
    } catch (e) {
      fail++;
      console.error(`[blast] batch ${bi + 1} threw:`, e.message);
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[blast] queued: ${ok} ok / ${fail} fail in ${elapsed}s`);
  console.log(`[blast] watch progress at ${HOST}/  (or tail trace store: data/traces/*.json)`);
})().catch(e => { console.error(e); process.exit(1); });
