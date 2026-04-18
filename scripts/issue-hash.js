#!/usr/bin/env node
require('dotenv').config();
const crypto = require('crypto');
const { insertClient } = require('../v2/src/db/supabase');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
  }
  return args;
}

(async () => {
  const { name, cartridge, n = '5', quota = '500' } = parseArgs();
  if (!name || !cartridge) {
    console.error('Usage: node scripts/issue-hash.js --name "Nolla" --cartridge nolla [--n 5] [--quota 500]');
    process.exit(1);
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const client = await insertClient({
    token,
    name,
    cartridge,
    n_per_title: parseInt(n, 10),
    monthly_image_quota: parseInt(quota, 10)
  });
  console.log('\n✓ Client created');
  console.log('  id:        ' + client.id);
  console.log('  name:      ' + client.name);
  console.log('  cartridge: ' + client.cartridge);
  console.log('  n/title:   ' + client.n_per_title);
  console.log('\nClient token (give this to them):\n  ' + token);
  console.log('\nPublic URL: ' + (process.env.PUBLIC_BASE_URL || 'http://localhost:3002') + '/client?token=' + token);
})().catch(e => { console.error(e); process.exit(1); });
