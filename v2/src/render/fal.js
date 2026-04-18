async function renderOne(prompt, options = {}) {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY not set');
  const model = options.model || 'fal-ai/nano-banana-pro';
  const aspectRatio = options.aspectRatio || '16:9';
  const references = options.references || [];
  const supportsRefs = ['fal-ai/nano-banana-pro', 'fal-ai/flux-pro/kontext'].includes(model);

  const payload = { prompt, aspect_ratio: aspectRatio, resolution: '1K', num_images: 1, output_format: 'png', safety_tolerance: '6' };
  if (supportsRefs && references.length) payload.image_urls = references.slice(0, 4).map(r => r.url);

  const t0 = Date.now();
  const response = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`fal ${response.status}: ${await response.text()}`);
  const r = await response.json();
  if (!r.images?.length) throw new Error('No image returned');
  return { url: r.images[0].url, width: r.images[0].width || 1920, height: r.images[0].height || 1080, model, elapsedMs: Date.now() - t0 };
}

async function downloadImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { renderOne, downloadImage };
