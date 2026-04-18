function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];

function sampleComposition(composition, { subject, seed = Date.now() }) {
  const rand = rng(seed);
  let prompt = composition.skeleton.replace(/\{subject\}/g, subject || 'subject');

  const slotsUsed = {};
  const slotNames = new Set();
  let m; const re = /\{([a-z_]+)\}/gi;
  while ((m = re.exec(composition.skeleton)) !== null) {
    if (m[1] !== 'subject') slotNames.add(m[1]);
  }
  for (const slot of slotNames) {
    const bank = composition.slots?.[slot];
    if (!bank?.length) continue;
    const value = pick(bank, rand);
    slotsUsed[slot] = value;
    prompt = prompt.replace(new RegExp(`\\{${slot}\\}`, 'g'), value);
  }
  const camera = pick(composition.cameras || ['CU'], rand);
  const lens = pick(composition.lenses || ['50mm'], rand);
  return { prompt, camera, lens, slotsUsed };
}

function buildPrompt({ composition, subject, seed, suffix, themeSuffix, modelSpec }) {
  const s = sampleComposition(composition, { subject, seed });
  const parts = [];
  if (modelSpec) parts.push(modelSpec);
  parts.push(`${s.prompt}, ${s.camera}, ${s.lens}`);
  if (themeSuffix) parts.push(themeSuffix);
  if (suffix?.positives) parts.push(suffix.positives);
  if (suffix?.negatives) parts.push(suffix.negatives);
  return { prompt: parts.join('. '), camera: s.camera, lens: s.lens, slotsUsed: s.slotsUsed };
}

module.exports = { sampleComposition, buildPrompt, rng };
