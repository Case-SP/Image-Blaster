const { sb, upsertRun, getRun, listRunsByClient, recordImage, listImagesByRun } = require('../db/supabase');

const BUCKET = 'generations';

async function writeImage(runId, slug, filename, buffer, metadata) {
  const storagePath = `${runId}/${slug}/${filename}`;
  const { error } = await sb().storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: 'image/png', upsert: true
  });
  if (error) throw error;
  await recordImage({ runId, slug, filename, storagePath });
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
