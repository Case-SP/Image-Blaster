const fs = require('fs');
const path = require('path');

const GENS_DIR = path.join(__dirname, '../../output/generations');
const TRACE_DIR = path.join(__dirname, '../../data/traces');
if (!fs.existsSync(GENS_DIR)) fs.mkdirSync(GENS_DIR, { recursive: true });
if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });

// Paths are keyed on runId to match the Supabase layout — without this,
// two concurrent runs (e.g. 'both' mode firing nano + gpt-2 over the same
// titles) collide on disk because they produce identical slugs and
// filenames, and the second writer silently overwrites the first.
async function writeImage(runId, slug, filename, buffer, metadata) {
  const dir = path.join(GENS_DIR, runId, slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), buffer);
  if (metadata) fs.writeFileSync(path.join(dir, `${filename}.json`), JSON.stringify(metadata, null, 2));
  return `${runId}/${slug}/${filename}`;
}
async function readImage(runId, slug, filename) {
  const p = path.join(GENS_DIR, runId, slug, filename);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}
async function listImages(runId, slug) {
  const dir = path.join(GENS_DIR, runId, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.png')).map(filename => ({ slug, filename }));
}
async function writeTrace(trace, clientId) {
  fs.writeFileSync(path.join(TRACE_DIR, `${trace.id}.json`), JSON.stringify(trace, null, 2));
}
async function readTrace(id, clientId) {
  const p = path.join(TRACE_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
async function listTraces({ clientId } = {}) {
  return fs.readdirSync(TRACE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort().reverse()
    .map(f => JSON.parse(fs.readFileSync(path.join(TRACE_DIR, f), 'utf8')));
}
async function listImagesForRun(runId, slugs) {
  const out = [];
  for (const slug of slugs) {
    const list = await listImages(runId, slug);
    out.push(...list);
  }
  return out;
}

module.exports = { writeImage, readImage, listImages, writeTrace, readTrace, listTraces, listImagesForRun };
