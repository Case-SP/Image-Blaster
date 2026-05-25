const test = require('node:test');
const assert = require('node:assert');
const { loadCartridge } = require('./cartridge');

test('loads nolla cartridge', () => {
  const c = loadCartridge('nolla');
  assert.equal(c.name, 'nolla');
  assert.ok(c.profile.brand_name);
  assert.ok(Object.keys(c.themes).length);
  assert.ok(Object.keys(c.subjects).length);
  assert.ok(typeof c.suffix.positives === 'string');
  assert.ok(typeof c.critic === 'string');
});

test('throws on missing', () => {
  assert.throws(() => loadCartridge('nope'));
});
