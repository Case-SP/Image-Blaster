#!/usr/bin/env node
require('dotenv').config();
const crypto = require('crypto');
const { sb, insertClient } = require('../v2/src/db/supabase');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
  }
  return args;
}

(async () => {
  const { email, cartridge, name, n = '5', quota = '500' } = parseArgs();
  if (!email || !cartridge || !name) {
    console.error('Usage: node scripts/issue-access.js --email <addr> --cartridge <name> --name "<display name>" [--n 5] [--quota 500]');
    process.exit(1);
  }
  const normalizedEmail = email.trim().toLowerCase();

  // Existing by email?
  const { data: existing } = await sb().from('clients').select('id,name,cartridge,email,n_per_title').eq('email', normalizedEmail).maybeSingle();
  if (existing) {
    console.error('Email already provisioned:', existing);
    process.exit(1);
  }

  // Internal API-access token (still useful for headless API calls)
  const token = crypto.randomBytes(24).toString('base64url');
  const client = await insertClient({
    token,
    name,
    cartridge,
    n_per_title: parseInt(n, 10),
    monthly_image_quota: parseInt(quota, 10)
  });

  // Backfill email
  const { error } = await sb().from('clients').update({ email: normalizedEmail }).eq('id', client.id);
  if (error) { console.error('Failed to set email:', error); process.exit(1); }

  const publicBase = process.env.PUBLIC_BASE_URL || 'http://localhost:3002';
  console.log('\n✓ Client provisioned');
  console.log('  id:        ' + client.id);
  console.log('  name:      ' + client.name);
  console.log('  cartridge: ' + client.cartridge);
  console.log('  email:     ' + normalizedEmail);
  console.log('  n/title:   ' + client.n_per_title);
  console.log('\nSign-in URL:  ' + publicBase + '/client');
  console.log('Have the user visit that URL and enter their email.');
  console.log('\n(Internal API token for headless access, optional to share: ' + token + ')');
})().catch(e => { console.error(e); process.exit(1); });
