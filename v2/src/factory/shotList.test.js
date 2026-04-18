const test = require('node:test');
const assert = require('node:assert');
const { buildRenderPrompts } = require('./shotList');
const { loadCartridge } = require('./cartridge');

const cartridge = loadCartridge('nolla');

test('10 shots for one title produce distinct prompts', () => {
  const fakeLLMOutput = {
    "t1": {
      shots: Array(10).fill(null).map((_, i) => ({
        composition: i < 5 ? "overhead-scatter" : "macro-texture",
        subject_type: "powder",
        subject_topic: "creatine",
        theme: ["warm-cream", "cool-white", "sage-green"][i % 3],
        model_spec: null
      }))
    }
  };
  const titles = [{ id: "t1", title: "Does creatine cause hair loss", category: "general" }];
  const prompts = buildRenderPrompts(cartridge, titles, fakeLLMOutput, { batchSeed: 1 });
  const strings = prompts["t1"].map(p => p.prompt);
  const unique = new Set(strings);
  assert.equal(strings.length, 10);
  assert.ok(unique.size >= 5, `expected >=5 distinct prompts, got ${unique.size}. First three: ${strings.slice(0,3).join(' | ')}`);
});
