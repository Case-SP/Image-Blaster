const { sb, upsertRun, getRun, listRunsByClient, recordImage, listImagesByRun } = require('../db/supabase');

const BUCKET = 'generations';
const THUMBS_BUCKET = 'generations-thumbs';
const THUMB_WIDTH = 384;

let sharp = null;
try { sharp = require('sharp'); } catch { /* thumbs disabled — UI falls back to ?w= route */ }

// Pre-bake a 384-wide WebP thumb next to the original PNG, in a public bucket.
// The UI loads tile thumbnails directly from the Supabase CDN, never through
// Node. Best-effort: a thumb failure never breaks the original PNG write.
async function writeThumb(runId, slug, filename, buffer) {
  if (!sharp) return;
  try {
    const thumb = await sharp(buffer).resize({ width: THUMB_WIDTH }).webp({ quality: 78 }).toBuffer();
    const path = `${runId}/${slug}/${filename}.webp`;
    const { error } = await sb().storage.from(THUMBS_BUCKET).upload(path, thumb, {
      contentType: 'image/webp', upsert: true
    });
    if (error) console.warn('[thumb] upload failed:', filename, error.message);
  } catch (e) {
    console.warn('[thumb] resize failed:', filename, e.message);
  }
}

async function writeImage(runId, slug, filename, buffer, metadata) {
  const storagePath = `${runId}/${slug}/${filename}`;
  const { error } = await sb().storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: 'image/png', upsert: true
  });
  if (error) throw error;
  await recordImage({ runId, slug, filename, storagePath });
  // Pre-bake the thumb in parallel-but-fire-and-forget. We don't await it for
  // the orchestrator so the render flow stays fast; the next /tiles call
  // picks up the public URL whether or not the thumb has landed yet (UI
  // falls back to the auth-protected ?w=384 route until the thumb exists).
  writeThumb(runId, slug, filename, buffer).catch(() => {});
  if (metadata) {
    const metaPath = `${runId}/${slug}/${filename}.json`;
    await sb().storage.from(BUCKET).upload(metaPath, Buffer.from(JSON.stringify(metadata, null, 2)), {
      contentType: 'application/json', upsert: true
    });
  }
  return storagePath;
}

async function readImage(runId, slug, filename) {
  const storagePath = `${runId}/${slug}/${filename}`;
  const { data, error } = await sb().storage.from(BUCKET).download(storagePath);
  if (error) return null;
  const ab = await data.arrayBuffer();
  return Buffer.from(ab);
}

async function listImages(runId, slug) {
  const rows = await listImagesByRun(runId);
  return rows.filter(r => r.slug === slug).map(r => ({ slug: r.slug, filename: r.filename }));
}

async function writeTrace(trace, clientId) {
  if (!clientId) throw new Error('writeTrace requires clientId in Supabase mode');
  await upsertRun(trace, clientId);
}

async function readTrace(id, clientId) {
  if (!clientId) throw new Error('readTrace requires clientId in Supabase mode');
  const row = await getRun(id, clientId);
  return row?.trace || null;
}

async function listTraces({ clientId }) {
  if (!clientId) return [];
  const rows = await listRunsByClient(clientId);
  return rows.map(r => r.trace);
}

async function listImagesForRun(runId) {
  const rows = await listImagesByRun(runId);
  return rows.map(r => ({ slug: r.slug, filename: r.filename }));
}

module.exports = { writeImage, readImage, listImages, writeTrace, readTrace, listTraces, listImagesForRun };
