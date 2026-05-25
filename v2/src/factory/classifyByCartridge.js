// classifyByCartridge.js
//
// Cartridge-keyed classifier dispatch. The orchestrator used to import
// classifyObjects directly; that hardcoded the product cartridge's spatial
// schema as the only classification shape. Cartridges now declare their
// classifier in profile.json (`classifier: "object" | "logo"`); this module
// routes to the right module and the rest of the pipeline stays generic.

const { classifyObjects, objectContextPrefix } = require('./objectContext');
const { classifyLogos, logoContextPrefix } = require('./logoContext');

const CLASSIFIERS = {
  object: { classify: classifyObjects, prefix: objectContextPrefix },
  logo:   { classify: classifyLogos,   prefix: logoContextPrefix }
};

function classifyByCartridge(cartridge, titles) {
  const name = cartridge?.profile?.classifier || 'object';
  const c = CLASSIFIERS[name];
  if (!c) {
    console.warn(`[classifyByCartridge] unknown classifier "${name}" — falling back to object`);
    return CLASSIFIERS.object.classify(titles);
  }
  return c.classify(titles);
}

function prefixByCartridge(cartridge, ctx) {
  const name = cartridge?.profile?.classifier || 'object';
  const c = CLASSIFIERS[name] || CLASSIFIERS.object;
  return c.prefix(ctx);
}

module.exports = { classifyByCartridge, prefixByCartridge };
