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
  const gpt2Voice = readTextOr(path.join(dir, 'gpt2_rewriter.md')); // optional brand voice for gpt-image-2 rewriter
  const intakePrompt = readTextOr(path.join(dir, 'intake.md'));     // optional intake-mode system prompt (when profile.input_mode === 'intake')

  const refsDir = path.join(dir, 'references');
  // Cap kept generous (64) so manual add/remove via scripts/refs.js stays
  // flexible without surprise truncation as the brand grows. Only REF_BUDGET
  // (default 8) actually reach fal per render anyway — see render/fal.js.
  // Subfolders are treated as style buckets — e.g. references/product-shot/*.png
  // get tagged with style='product-shot'. The orchestrator can filter by style
  // for cartridges where a composition has dedicated reference imagery.
  const loadRef = (full, filename, style) => {
    const b = fs.readFileSync(full);
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { filename, style: style || null, url: `data:${mime};base64,${b.toString('base64')}` };
  };
  let references = [];
  if (fs.existsSync(refsDir)) {
    for (const entry of fs.readdirSync(refsDir).sort()) {
      const full = path.join(refsDir, entry);
      if (fs.statSync(full).isDirectory()) {
        for (const sub of fs.readdirSync(full).sort()) {
          if (!/\.(jpg|jpeg|png|webp)$/i.test(sub)) continue;
          references.push(loadRef(path.join(full, sub), sub, entry));
        }
      } else if (/\.(jpg|jpeg|png|webp)$/i.test(entry)) {
        references.push(loadRef(full, entry, null));
      }
    }
    references = references.slice(0, 64);
  }

  const catDir = path.join(dir, 'categories');
  const categories = {};
  if (fs.existsSync(catDir)) {
    fs.readdirSync(catDir).filter(f => f.endsWith('.json')).forEach(f => {
      categories[f.replace(/\.json$/, '')] = readJSON(path.join(catDir, f));
    });
  }

  return { name, profile, themes, compositions, subjects, palette, suffix, critic, guardrails, studioRules, gpt2Voice, intakePrompt, references, categories };
}

module.exports = { loadCartridge };
