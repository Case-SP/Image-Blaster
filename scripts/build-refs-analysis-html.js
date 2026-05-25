#!/usr/bin/env node
//
// Standalone HTML generator: reads 10 user-curated logo refs, embeds each as
// a base64 data URL, writes a self-contained review page to docs/.
// Per card: form type + treatment + construction logic + what cartridge slot
// values would produce it + verdict (fit / partial / anti-pattern).

const fs = require('fs');
const path = require('path');

const REFS_BASE = '/Users/casemiller/Pictures/Refs.library/images';

const cards = [
  {
    n: 1,
    file: `${REFS_BASE}/MOYZW3R333293.info/An image uploaded by Victor Azuara on Nov 07, 2023..jpg`,
    mime: 'image/jpeg',
    title: '6-mark abstract grid (snowflake / bars / loops / dumbbell / beads / circles)',
    form: 'sketch grid · 6 abstract symbols · 3×2',
    treatment: 'Flat solid black on pure white · uniform heavy stroke · crisp vector edges · no shading · no gradient',
    construction: 'Each mark built from primitive shapes (circles, semi-circles, bars) joined into a unique iconic form. No two marks repeat the same geometric solution. The grid shows REAL RANGE — radial, linear, intertwined, dotted, beaded, overlapping — across one consistent vocabulary.',
    slots: {
      grid: 'a 3x2 grid of 6 marks (three columns, two rows) centered with even spacing',
      palette: 'rendered in solid black on a pure white ground',
      mark_type: 'ABSTRACT GEOMETRIC SYMBOLS built from primitive shapes — NO letterforms'
    },
    verdict: 'fit',
    note: 'Platonic ideal. This is exactly what our sketch stage should be producing. If we keep producing this register, the cartridge is dialed in.'
  },
  {
    n: 2,
    file: `${REFS_BASE}/MOWC897ORO1M6.info/logo- 18.webp`,
    mime: 'image/webp',
    title: 'Uniqlo · bilingual SYSTEM (Japanese katakana + English squares)',
    form: 'system · mark + wordmark integrated · bilingual',
    treatment: 'Flat saturated red on white · sans-serif geometric letterforms inside red square containers · grey "LifeWear" tagline below in Helvetica-like type',
    construction: 'Two square containers (Japanese ユニ / クロ left, English UNI / QLO right) sharing the same red, paired tightly. Mark IS the wordmark — no separate symbol.',
    slots: {
      bucket: 'system/',
      stage: 'Stage 2 (Phase 3) — finished mark+wordmark identity reference',
      palette_note: 'Saturated brand red — our current Stage 2 palette is monochrome only. Phase 3 needs a controlled-color palette option.'
    },
    verdict: 'fit',
    note: 'Belongs in the system/ bucket, not sketch/. Bilingual integration is a register we should consider for international brands. Not a sketch reference.'
  },
  {
    n: 3,
    file: `${REFS_BASE}/MOWC3VWBHTYC4.info/logo- 26.webp`,
    mime: 'image/webp',
    title: 'Lamborghini Trattori · chrome script wordmark',
    form: 'wordmark · ornate cursive script · 3D metallic',
    treatment: 'Photographic chrome bevels · soft metallic gradient · highly polished · drop-shadow specular highlights · ornate Spencerian script',
    construction: 'Cursive Spencerian-derived script with elaborate flourishes, rendered as if pressed metal with light reflecting off curved surfaces.',
    slots: {
      bucket: 'ANTI-PATTERN — should never reach output',
      forbidden_by: 'suffix.md negatives: "no 3D bevels, no fake glows, no drop shadows, no gradients"',
      lesson: 'The cartridge correctly forbids this register. Useful as a calibration check that the negatives are working.'
    },
    verdict: 'anti',
    note: 'If our sketch ever produces something like this, the suffix.md negatives are not landing. This is a counter-example, not a target.'
  },
  {
    n: 4,
    file: `${REFS_BASE}/MOWC2MGYKGAIJ.info/logo- 35.webp`,
    mime: 'image/webp',
    title: 'Versace · molten gold organic letterforms',
    form: 'wordmark · organic blob letterforms · 3D metallic gold',
    treatment: 'Heavy metallic gold with sculpted/dripping surface · highly textured · photographic depth · grey ground',
    construction: 'Each letterform as if cast in liquid gold, then frozen mid-drip. Letters are organic blob-shapes that just barely read as VERSACE.',
    slots: {
      bucket: 'ANTI-PATTERN — chrome/gold metallic register',
      forbidden_by: 'suffix.md "no 3D bevels, no fake glows"',
      partial_lesson: 'The MELTED ORGANIC SHAPE construction is interesting (relates to FLOWING ORGANIC register) — but the metallic treatment is forbidden. If the form were FLAT BLACK SILHOUETTE, it would fit our flowing-organic slot.'
    },
    verdict: 'anti',
    note: 'Same anti-pattern as #3. The underlying letterform construction (organic, drippy, asymmetric) is actually interesting in flat form — the disqualifier is the metallic treatment.'
  },
  {
    n: 5,
    file: `${REFS_BASE}/MOWBZJI2J0KWK.info/logo- 43.webp`,
    mime: 'image/webp',
    title: 'Off-White™ · wordmark + intercut hand pictograms',
    form: 'wordmark · serif type with iconographic punctuation',
    treatment: 'Pure black on white · classical serif (Bodoni-like) for the words · flat black-and-white vector hand illustrations between/around the words',
    construction: 'Type-driven, but the "punctuation" between Off and White is replaced with a pictographic black-fingers-pointing-up hand silhouette (twice). The illustrations behave like glyphs in the sequence.',
    slots: {
      bucket: 'system/ (Stage 2 reference)',
      register_note: 'Wordmark + pictographic ornament hybrid. Could feed Stage 2 when palette is monochrome.',
      sketch_relevance: 'The HAND PICTOGRAM is exactly what our ICONIC PICTOGRAPHIC mark_type register would produce — but as standalone marks, not embedded in a wordmark.'
    },
    verdict: 'partial',
    note: 'Wordmark with pictogram glyphs is a hybrid we don\'t currently model. Useful as a Stage 2 reference; the pictogram component validates ICONIC PICTOGRAPHIC as a sketch register.'
  },
  {
    n: 6,
    file: `${REFS_BASE}/MOWBYJTF93JP4.info/logo- 55.webp`,
    mime: 'image/webp',
    title: 'Single 4-lobed organic mark · paramecium gestalt',
    form: 'single mark · abstract organic · 1-up presentation',
    treatment: 'Solid heavy black on soft light-grey ground · flat fill · soft rounded curves',
    construction: 'Four conjoined organic blob/lobe shapes meeting at a center cross-point. Bilateral symmetry on both axes. Reads as creature, plant, gesture all at once.',
    slots: {
      bucket: 'system/ (single hero presentation)',
      sketch_relevance: 'This form is exactly what FLOWING ORGANIC mark_type should produce in a grid context. The 1-up presentation with breathing room is a Stage 2 hero treatment.',
      grid_variant_idea: 'Worth adding a grid variant: "single hero mark, vast breathing room, 1-up presentation" for cases where the user wants ONE direction explored carefully.'
    },
    verdict: 'fit',
    note: 'Form fits FLOWING ORGANIC. Presentation (1-up hero) is missing from our grid slot — currently we always show 4-6 marks. Adding a 1-up variant is a small addition.'
  },
  {
    n: 7,
    file: `${REFS_BASE}/MOWC3E1E338EB.info/logo- 28.webp`,
    mime: 'image/webp',
    title: 'Mid-century mark CATALOG · 3×2 grid with captions + attribution',
    form: 'sketch catalog · 6 finished marks with caption attribution below each',
    treatment: 'Saturated color on white (orange, red, pink) · each mark in its own clean style · small grey/black sans-serif captions below: "Brand name, descriptor, year"',
    construction: 'Each mark its own logic (geometric figure, modular bars, sunburst-letter, angular slab, arrow, type-letterforms). Across the grid: shared mid-century 1968-1993 era language. Captions provide historical context.',
    slots: {
      bucket: 'sketch/ (multi-mark catalog page)',
      grid_variant_idea: 'Add a slot variant: "a 3x2 grid of 6 marks centered, each with a small grey caption below in the form Brand, descriptor, year" — emulates historical reference-book layout',
      palette_note: 'Allows controlled color (mid-century palette: muted orange, red, pink) — but ONLY when the era register implies it'
    },
    verdict: 'fit',
    note: 'Strong sketch register variant. Caption-attribution gives the model a structural anchor that yields more "real" marks (historical reference behavior). Worth adding as a `grid` slot value for sketch.'
  },
  {
    n: 8,
    file: `${REFS_BASE}/MOWC75CX2AMR4.info/logo- 24.webp`,
    mime: 'image/webp',
    title: 'Danchinomirai · institutional bilingual SYSTEM with geometric mark',
    form: 'system · mark + bilingual wordmark + URL',
    treatment: 'Pure black on white · rounded-square geometric mark with + and dot inside · sans-serif Japanese kanji + English serif type · URL in grey',
    construction: 'Mark is a clean geometric primitive composition (square frame + plus + dot — institutional/architectural feel). Wordmark integrates Japanese kanji at scale with English subhead.',
    slots: {
      bucket: 'system/',
      stage: 'Stage 2 (Phase 3) — institutional brand identity',
      palette: 'monochrome black on white — fits our Stage 2 palette'
    },
    verdict: 'fit',
    note: 'Belongs in system/ bucket. Bilingual is recurring — worth supporting for international brands in Phase 3.'
  },
  {
    n: 9,
    file: `${REFS_BASE}/MOWCCOVTZGBJL.info/logo- 14.webp`,
    mime: 'image/webp',
    title: 'Herman Miller · BRAND SPEC PAGE with grid-overlay construction diagram',
    form: 'brand book / spec page · single iconic mark on measured grid + wordmark with dimensional annotations',
    treatment: 'Black on warm cream/yellowed paper · grid overlay in light grey · serif caption text · explicit construction-line documentation',
    construction: 'Top: Herman Miller "M" symbol (the iconic crescent-curve form) drawn on a square measured grid with dimension annotations (A, B). Bottom: wordmark with construction-line measurements showing cap height (A) and width-of-m (B).',
    slots: {
      bucket: 'mockup/ (brand book / spec sheet)',
      grid_variant_match: 'Already in our grid slot: "a 2x2 grid of 4 finished marks above, paired with a matching row of thin-line construction diagrams below" — same family, single-mark version',
      stage: 'Stage 3 (Phase 4) — brand book layout reference'
    },
    verdict: 'fit',
    note: 'Validates the construction-grid pairing pattern in our existing grid slot. As a single-mark spec sheet, also belongs in mockup/ for Phase 4.'
  },
  {
    n: 10,
    file: `${REFS_BASE}/MOWCSO399M4TH.info/logo- 3.webp`,
    mime: 'image/webp',
    title: 'Mountain Research · stepped-pixel pictographic mountain + slab wordmark',
    form: 'system · pictographic mark + heavy slab wordmark',
    treatment: 'Pure black on white · stepped horizontal-line abstraction of a mountain (like topographic contour lines or Lego steps) on a black trapezoid base · heavy slab-serif wordmark below',
    construction: 'Mark: nature pictogram (mountain) abstracted into stepped pixel-bands resembling topo lines or stacked plates, sitting on a black trapezoidal "ground" shape. Wordmark: heavy display slab in two stacked lines.',
    slots: {
      bucket: 'system/',
      sketch_relevance: 'The pictographic mountain matches our ICONIC PICTOGRAPHIC mark_type slot directly ("mountain, wave, sun, star, leaf, flame" — mountain explicit)',
      stage: 'Stage 2 (Phase 3) — finished mark+wordmark system'
    },
    verdict: 'fit',
    note: 'Pictographic mountain validates our ICONIC PICTOGRAPHIC slot. As a finished system, belongs in Stage 2 reference set.'
  }
];

const verdictColor = {
  fit: '#2a7d3a',
  partial: '#a36c00',
  anti: '#b53b3b'
};
const verdictLabel = {
  fit: 'FIT',
  partial: 'PARTIAL',
  anti: 'ANTI-PATTERN'
};

function dataUrl(filePath, mime) {
  const buf = fs.readFileSync(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slotBlock(slots) {
  return Object.entries(slots).map(([k, v]) =>
    `<div class="slot-row"><span class="slot-key">${escapeHtml(k)}</span><span class="slot-val">${escapeHtml(v)}</span></div>`
  ).join('');
}

const cardsHtml = cards.map(c => {
  const url = dataUrl(c.file, c.mime);
  return `
  <article class="card" data-verdict="${c.verdict}">
    <div class="card-img-wrap">
      <img src="${url}" alt="Image ${c.n}">
      <div class="verdict" style="background:${verdictColor[c.verdict]}">${verdictLabel[c.verdict]}</div>
    </div>
    <div class="card-body">
      <div class="card-num">Image ${c.n}</div>
      <h2 class="card-title">${escapeHtml(c.title)}</h2>
      <div class="meta">
        <div class="meta-row"><span class="meta-key">Form</span><span class="meta-val">${escapeHtml(c.form)}</span></div>
        <div class="meta-row"><span class="meta-key">Treatment</span><span class="meta-val">${escapeHtml(c.treatment)}</span></div>
        <div class="meta-row"><span class="meta-key">Construction</span><span class="meta-val">${escapeHtml(c.construction)}</span></div>
      </div>
      <h3 class="section-h">Cartridge mapping</h3>
      <div class="slots">${slotBlock(c.slots)}</div>
      <h3 class="section-h">Note</h3>
      <p class="note">${escapeHtml(c.note)}</p>
    </div>
  </article>`;
}).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Logo refs — prompt-perspective analysis</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --bg: #fafaf8;
      --surface: #ffffff;
      --border: #e5e5e2;
      --text: #1a1a1a;
      --text-muted: #6b6b68;
      --text-dim: #a8a8a3;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
      font-size: 14px;
      padding: 2rem 1.5rem 4rem;
    }
    header {
      max-width: 1400px;
      margin: 0 auto 2rem;
    }
    h1 {
      font-size: 1.5rem;
      margin: 0 0 0.4rem;
      letter-spacing: -0.01em;
    }
    .subtitle {
      color: var(--text-muted);
      font-size: 0.95rem;
      margin: 0;
      max-width: 720px;
    }
    .legend {
      display: flex;
      gap: 1.25rem;
      margin: 1rem 0 0;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }
    .legend i {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .legend .fit i { background: ${verdictColor.fit}; }
    .legend .partial i { background: ${verdictColor.partial}; }
    .legend .anti i { background: ${verdictColor.anti}; }

    .grid {
      max-width: 1400px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 1.5rem;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .card-img-wrap {
      position: relative;
      background: #f0f0ec;
      aspect-ratio: 4/3;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .card-img-wrap img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .verdict {
      position: absolute;
      top: 0.6rem;
      right: 0.6rem;
      color: white;
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      padding: 0.25rem 0.55rem;
      border-radius: 3px;
    }
    .card-body {
      padding: 1.1rem 1.2rem 1.3rem;
    }
    .card-num {
      font-size: 0.7rem;
      color: var(--text-dim);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 0.3rem;
    }
    .card-title {
      font-size: 1rem;
      margin: 0 0 0.85rem;
      letter-spacing: -0.005em;
    }
    .meta { margin-bottom: 0.75rem; }
    .meta-row {
      display: grid;
      grid-template-columns: 100px 1fr;
      gap: 0.6rem;
      padding: 0.32rem 0;
      border-bottom: 1px solid var(--border);
      font-size: 0.82rem;
    }
    .meta-row:last-child { border-bottom: 0; }
    .meta-key {
      color: var(--text-muted);
      font-weight: 500;
    }
    .section-h {
      margin: 1rem 0 0.45rem;
      font-size: 0.7rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
      font-weight: 600;
    }
    .slots {
      background: #f7f7f4;
      border-radius: 4px;
      padding: 0.55rem 0.75rem;
      font-size: 0.78rem;
    }
    .slot-row {
      display: grid;
      grid-template-columns: 110px 1fr;
      gap: 0.5rem;
      padding: 0.22rem 0;
    }
    .slot-key {
      font-family: ui-monospace, monospace;
      color: var(--text-muted);
      font-size: 0.72rem;
    }
    .slot-val {
      color: var(--text);
    }
    .note {
      font-size: 0.84rem;
      color: var(--text);
      margin: 0;
      line-height: 1.55;
    }

    .summary {
      max-width: 1400px;
      margin: 2.5rem auto 0;
      padding: 1.5rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .summary h2 {
      margin: 0 0 0.75rem;
      font-size: 1.05rem;
    }
    .summary ul { margin: 0; padding-left: 1.2rem; }
    .summary li { margin-bottom: 0.45rem; font-size: 0.88rem; }
  </style>
</head>
<body>
  <header>
    <h1>Logo refs — prompt-perspective analysis</h1>
    <p class="subtitle">Each ref read as a prompt: form type, visual treatment, construction logic, and what cartridge slot values would produce it. Verdict per card: does this fit our sketch grid, belong in another bucket, or is it an anti-pattern.</p>
    <div class="legend">
      <span class="fit"><i></i> FIT — what we want our cartridge to produce</span>
      <span class="partial"><i></i> PARTIAL — useful but not a 1-to-1 sketch target</span>
      <span class="anti"><i></i> ANTI-PATTERN — what we forbid</span>
    </div>
  </header>

  <main class="grid">
    ${cardsHtml}
  </main>

  <section class="summary">
    <h2>Takeaways for the cartridge</h2>
    <ul>
      <li><strong>Most refs are FINISHED systems (mark + wordmark together), not sketch grids.</strong> Of 10: 2 are sketch-grid candidates (#1, #7), 5 are Stage 2 systems (#2, #5, #6, #8, #10), 1 is a brand-book spec page (#9), 2 are anti-patterns (#3, #4). The user's curation is biased toward Stage 2/3 — most useful for Phase 3+ work, not Phase 2 sketch.</li>
      <li><strong>Add a grid-with-captions variant to the sketch <code>grid</code> slot</strong> (Image #7). Format: "a 3x2 grid of 6 marks, each with a small grey caption below in the form Brand, descriptor, year." Emulating reference-book layout gives the model a structural anchor that yields more "real-feeling" marks.</li>
      <li><strong>Add a 1-up hero variant to the sketch <code>grid</code> slot</strong> (Image #6). Format: "a single hero mark centered with vast breathing room." For when the user wants ONE direction explored carefully rather than 4-6 in a grid.</li>
      <li><strong>Stage 2 (Phase 3) needs a controlled-color palette option</strong> (Image #2 Uniqlo red, Image #7 mid-century palette). Current palette slot is monochrome only. When the era register implies color (mid-century corporate), allow saturated brand color.</li>
      <li><strong>Bilingual / multi-script integration</strong> (Image #2, #8) is recurring in international brand work. Worth a slot value or post-classifier signal in Phase 3.</li>
      <li><strong>Anti-patterns confirmed</strong> (Image #3 Lamborghini chrome, #4 Versace gold). Our suffix.md negatives correctly forbid these. Worth keeping a quick "anti-pattern check" reference in the learnings doc so we know if the negatives ever leak.</li>
      <li><strong>Pictographic mountain (Image #10) and organic blob (Image #6)</strong> validate our existing <code>mark_type</code> registers (ICONIC PICTOGRAPHIC, FLOWING ORGANIC). Both already in slot vocab.</li>
      <li><strong>Construction-grid pairing (Image #9)</strong> validates our existing 6th grid value ("a 2x2 grid of 4 finished marks above, paired with a matching row of thin-line construction diagrams below").</li>
    </ul>
  </section>
</body>
</html>`;

const outDir = path.join(__dirname, '..', 'docs');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'logo-refs-analysis.html');
fs.writeFileSync(outPath, html);
console.log('Wrote', outPath);
console.log('Size:', (fs.statSync(outPath).size / 1024).toFixed(1), 'KB');
console.log('');
console.log('Open with:');
console.log('  open ' + outPath);
