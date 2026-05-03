const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;
const RENDER_TIMEOUT_MS = parseInt(process.env.FAL_RENDER_TIMEOUT_MS || '120000', 10); // 120s
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.FAL_DOWNLOAD_TIMEOUT_MS || '60000', 10); // 60s

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// fetch + per-request timeout via AbortController. Without this, a stalled
// fal upstream connection can hang the whole orchestrator forever.
async function fetchWithTimeout(url, opts = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function renderOne(prompt, options = {}) {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY not set');
  const model = options.model || 'fal-ai/nano-banana-pro';
  const aspectRatio = options.aspectRatio || '3:4'; // closest fal-supported aspect to A4 portrait (1:1.414); gpt-2 maps via GPT2_SIZE → portrait_4_3 (1024×1408 ≈ 0.727, vs A4 0.707)
  const quality = options.quality || 'medium'; // gpt-image-2 only — 'low' | 'medium' | 'high'. 'medium' is ~2x faster than 'high' and visually equivalent for contact-sheet usage; UI/API can override per-run.
  const references = options.references || [];
  const supportsRefs = ['fal-ai/nano-banana-pro', 'fal-ai/flux-pro/kontext', 'openai/gpt-image-2/edit'].includes(model);
  // Per-call ref budget. Was hard-coded to 4, which froze the brand to ref-01..04
  // alphabetical and silently ignored every style ref added after the original
  // cartridge load. Bumped to 8 so newly-added style refs actually reach fal.
  // Tunable via REF_BUDGET env (1..16). Each ref costs ~1.5–2x prompt-tokens-
  // equivalent in vision-conditioning, so don't push this past ~10 without
  // re-benchmarking quality vs. latency.
  const REF_BUDGET = Math.max(1, Math.min(16, parseInt(process.env.REF_BUDGET || '8', 10)));

  // Per-model payload shaping. gpt-image-2's image_size only accepts fal's
  // named literals, not raw ratio strings — map our "W:H" aspectRatio to the
  // nearest literal and fall back to 'auto' for anything unknown.
  const GPT2_SIZE = {
    '1:1': 'square_hd',
    '16:9': 'landscape_16_9',
    '9:16': 'portrait_16_9',
    '4:3': 'landscape_4_3',
    '3:4': 'portrait_4_3',  // closest fal literal to A4 portrait (1024x1408 ≈ 0.727; A4 = 0.707)
    '4:5': 'portrait_4_3',
    '5:4': 'landscape_4_3',
    '1:1.414': 'portrait_4_3', // A4 portrait literal — same fal mapping
    '210:297': 'portrait_4_3'  // A4 mm — same fal mapping
  };
  let payload;
  if (model === 'openai/gpt-image-2' || model === 'openai/gpt-image-2/edit') {
    payload = {
      prompt,
      image_size: GPT2_SIZE[aspectRatio] || 'auto',
      quality,
      num_images: 1,
      output_format: 'png'
    };
    // /edit endpoint REQUIRES image_urls (verified live: 422 without it,
    // 200 with). The base /openai/gpt-image-2 endpoint silently accepts
    // image_urls but does NOT vision-condition on them, so we never send
    // refs to the base model.
    if (model === 'openai/gpt-image-2/edit' && supportsRefs && references.length) {
      payload.image_urls = references.slice(0, REF_BUDGET).map(r => r.url);
    }
  } else {
    payload = { prompt, aspect_ratio: aspectRatio, resolution: '1K', num_images: 1, output_format: 'png', safety_tolerance: '6' };
    if (supportsRefs && references.length) {
      // Per-model field names — kontext is an edit model that takes a single
      // `image_url`; nano-banana-pro accepts `image_urls` (plural) for
      // multi-image style conditioning. v1.1-ultra has no image input.
      if (model === 'fal-ai/flux-pro/kontext') {
        payload.image_url = references[0].url;
      } else {
        payload.image_urls = references.slice(0, REF_BUDGET).map(r => r.url);
      }
    }
  }

  const t0 = Date.now();
  let attempt = 0;
  let lastError = null;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetchWithTimeout(`https://fal.run/${model}`, {
        method: 'POST',
        headers: { 'Authorization': `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, RENDER_TIMEOUT_MS);

      // Retry on 429 (rate limit) and 5xx (transient server errors)
      if (response.status === 429 || response.status >= 500) {
        const body = await response.text();
        lastError = new Error(`fal ${response.status}: ${body.slice(0, 200)}`);
        if (attempt < MAX_RETRIES) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
          console.warn(`[fal] ${response.status} on attempt ${attempt + 1}, backing off ${backoff}ms`);
          await sleep(backoff);
          attempt++;
          continue;
        }
        throw lastError;
      }

      if (!response.ok) throw new Error(`fal ${response.status}: ${await response.text()}`);
      const r = await response.json();
      if (!r.images?.length) throw new Error('No image returned');
      return {
        url: r.images[0].url,
        width: r.images[0].width || 1920,
        height: r.images[0].height || 1080,
        model,
        elapsedMs: Date.now() - t0,
        attempts: attempt + 1
      };
    } catch (e) {
      // Network errors and timeouts (AbortError) — retry
      const isTimeout = e?.name === 'AbortError' || /aborted/i.test(e?.message || '');
      if (attempt < MAX_RETRIES && (!e.message?.startsWith('fal ') || isTimeout)) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
        console.warn(`[fal] network error on attempt ${attempt + 1}: ${e.message}, backing off ${backoff}ms`);
        await sleep(backoff);
        attempt++;
        continue;
      }
      throw e;
    }
  }

  throw lastError || new Error('fal render failed after retries');
}

async function downloadImage(url) {
  // fal's signed CDN URLs occasionally return 409/5xx for a few seconds after
  // mint. Retry on any non-2xx and on network errors. Same backoff shape as
  // renderOne (INITIAL_BACKOFF_MS * 2^attempt + jitter), capped at MAX_RETRIES.
  let attempt = 0;
  let lastError = null;
  while (attempt <= MAX_RETRIES) {
    try {
      const r = await fetchWithTimeout(url, {}, DOWNLOAD_TIMEOUT_MS);
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      lastError = new Error(`Download ${r.status}`);
    } catch (e) {
      lastError = e;
    }
    if (attempt < MAX_RETRIES) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
      console.warn(`[fal] download error on attempt ${attempt + 1}: ${lastError.message}, backing off ${backoff}ms`);
      await sleep(backoff);
    }
    attempt++;
  }
  throw lastError || new Error('Download failed after retries');
}

module.exports = { renderOne, downloadImage };
