const test = require('node:test');
const assert = require('node:assert');
const { sampleComposition, buildPrompt } = require('./grammar');

const composition = {
  skeleton: "{subject} on {surface} with {light}",
  slots: { surface: ["marble", "linen", "wood"], light: ["warm side", "cool even"] },
  cameras: ["CU"], lenses: ["50mm"]
};

test('seed determinism', () => {
  const a = sampleComposition(composition, { subject: "x", seed: 42 });
  const b = sampleComposition(composition, { subject: "x", seed: 42 });
  assert.equal(a.prompt, b.prompt);
});

test('different seeds diverge', () => {
  const s = new Set();
  for (let i = 0; i < 20; i++) s.add(sampleComposition(composition, { subject: "x", seed: i }).prompt);
  assert.ok(s.size >= 3);
});

test('buildPrompt composes camera/lens/suffix', () => {
  const out = buildPrompt({
    composition, subject: "x", seed: 1,
    suffix: { positives: "editorial", negatives: "no text" }
  });
  assert.match(out.prompt, /CU/);
  assert.match(out.prompt, /editorial/);
  assert.match(out.prompt, /no text/);
});
