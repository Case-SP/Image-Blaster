const fs = require('fs');
const path = require('path');

const CARTRIDGE_ROOT = path.join(__dirname, '../../cartridge');

const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const readTextOr = (p, fb = '') => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fb;

function parseSuffix(md) {
  const grab = label => (md.match(new RegExp(`## ${label}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i')) || [])[1]?.trim() || '';
  return { positives: grab('Positives'), negatives: grab('Negatives') };
}

function loadCartridge(name) {
  const dir = path.join(CARTRIDGE_ROOT, name);
  if (!fs.existsSync(dir)) throw new Error(`Cartridge not found: ${name}`);

  const profile = readJSON(path.join(dir, 'profile.json'));
  const themes = readJSON(path.join(dir, 'themes.json')).themes || {};
  const compositionsPath = path.join(dir, 'compositions.json');
  const compositions = fs.existsSync(compositionsPath) ? (readJSON(compositionsPath).compositions || {}) : {};
  const subjects = readJSON(path.join(dir, 'subjects.json')).subjects || {};
  const palette = fs.existsSync(path.join(dir, 'palette.json')) ? readJSON(path.join(dir, 'palette.json')) : null;
  const suffix = parseSuffix(readTextOr(path.join(dir, 'suffix.md')));
  const critic = readTextOr(path.join(dir, 'critic.md'));
  const guardrails = readTextOr(path.join(dir, 'guardrails.md'));
  const studioRules = readTextOr(path.join(dir, 'studio-rules.md'));

  const refsDir = path.join(dir, 'references');
  const references = fs.existsSync(refsDir) ? fs.readdirSync(refsDir)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .slice(0, 8)
    .map(f => {
      const b = fs.readFileSync(path.join(refsDir, f));
      const ext = path.extname(f).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return { filename: f, url: `data:${mime};base64,${b.toString('base64')}` };
    }) : [];

  const catDir = path.join(dir, 'categories');
  const categories = {};
  if (fs.existsSync(catDir)) {
    fs.readdirSync(catDir).filter(f => f.endsWith('.json')).forEach(f => {
      categories[f.replace(/\.json$/, '')] = readJSON(path.join(catDir, f));
    });
  }

  return { name, profile, themes, compositions, subjects, palette, suffix, critic, guardrails, studioRules, references, categories };
}

module.exports = { loadCartridge };
