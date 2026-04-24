const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function renderOne(prompt, options = {}) {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY not set');
  const model = options.model || 'fal-ai/nano-banana-pro';
  const aspectRatio = options.aspectRatio || '16:9';
  const references = options.references || [];
  const supportsRefs = ['fal-ai/nano-banana-pro', 'fal-ai/flux-pro/kontext'].includes(model);

  // Per-model payload shaping. gpt-image-2 uses image_size (accepts ratios like
  // "16:9" or "auto") + quality and rejects nano-banana-specific fields
  // (safety_tolerance, resolution). References on gpt-image-2 go through a
  // separate /edit endpoint — not wired yet.
  let payload;
  if (model === 'openai/gpt-image-2') {
    payload = {
      prompt,
      image_size: aspectRatio,
      quality: 'high',
      num_images: 1,
      output_format: 'png'
    };
  } else {
    payload = { prompt, aspect_ratio: aspectRatio, resolution: '1K', num_images: 1, output_format: 'png', safety_tolerance: '6' };
    if (supportsRefs && references.length) payload.image_urls = references.slice(0, 4).map(r => r.url);
  }

  const t0 = Date.now();
  let attempt = 0;
  let lastError = null;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch(`https://fal.run/${model}`, {
        method: 'POST',
        headers: { 'Authorization': `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

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
      // Network errors (fetch threw) — also retry
      if (attempt < MAX_RETRIES && !e.message?.startsWith('fal ')) {
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
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { renderOne, downloadImage };
