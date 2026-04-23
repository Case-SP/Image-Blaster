#!/usr/bin/env node
/**
 * Issue an API key (X-API-Key header auth). If a client row exists for the
 * email, attaches the key to it; otherwise creates a new client.
 *
 * The key is shown ONCE. We store only the sha256 hash. Lose it = rotate it.
 *
 * Usage:
 *   node scripts/issue-api-key.js --email sean@nollahealth.com
 *   node scripts/issue-api-key.js --email x@y.com --cartridge nolla --n 3 --quota 2000 --note "acme pilot" --rotate
 */
require('dotenv').config();
const crypto = require('crypto');
const { sb, insertClient } = require('../v2/src/db/supabase');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = process.argv[i + 1];
      if (v === undefined || v.startsWith('--')) args[k] = true;
      else { args[k] = v; i++; }
    }
  }
  return args;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

(async () => {
  const args = parseArgs();
  const email = String(args.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('--email required');
    process.exit(1);
  }
  const cartridge = args.cartridge || 'nolla';
  const n = parseInt(args.n || '3', 10);
  const quota = parseInt(args.quota || '2000', 10);
  const note = args.note || null;
  const rotate = !!args.rotate;

  // Generate key: ibk_live_<22 base64url chars>
  const suffix = crypto.randomBytes(16).toString('base64url'); // 22 chars
  const key = `ibk_live_${suffix}`;
  const prefix = key.slice(0, 14); // "ibk_live_XXXXX" for display
  const hash = sha256(key);

  // Find existing client by email
  const { data: existing } = await sb().from('clients').select('id,name,cartridge,email,api_key_hash,api_key_prefix').eq('email', email).maybeSingle();

  let client;
  if (existing) {
    if (existing.api_key_hash && !rotate) {
      console.error(`client ${email} already has an API key (prefix ${existing.api_key_prefix}).`);
      console.error(`pass --rotate to replace it (existing key will stop working immediately).`);
      process.exit(1);
    }
    const { data: updated, error } = await sb().from('clients').update({
      api_key_hash: hash,
      api_key_prefix: prefix,
      api_key_created_at: new Date().toISOString(),
      cartridge, // allow updating cartridge/quota at the same time
      n_per_title: n,
      monthly_image_quota: quota,
      active: true
    }).eq('id', existing.id).select().single();
    if (error) { console.error(error); process.exit(1); }
    client = updated;
    console.log(`\n✓ API key ${rotate ? 'rotated' : 'attached'} for existing client ${email}`);
  } else {
    const displayName = email.split('@')[0];
    const legacyToken = crypto.randomBytes(24).toString('base64url'); // keep legacy token column non-null
    const { data: inserted, error } = await sb().from('clients').insert([{
      token: legacyToken,
      name: displayName,
      email,
      cartridge,
      n_per_title: n,
      monthly_image_quota: quota,
      active: true,
      api_key_hash: hash,
      api_key_prefix: prefix,
      api_key_created_at: new Date().toISOString()
    }]).select().single();
    if (error) { console.error(error); process.exit(1); }
    client = inserted;
    console.log(`\n✓ API key issued for NEW client ${email}`);
  }

  console.log(`  client_id: ${client.id}`);
  console.log(`  cartridge: ${client.cartridge} · n/title: ${client.n_per_title} · quota: ${client.monthly_image_quota}/mo`);
  if (note) console.log(`  note:      ${note}`);
  console.log('');
  console.log('KEY (shown once — store in your secret manager):');
  console.log('──────────────────────────────────────────────────────');
  console.log(`  ${key}`);
  console.log('──────────────────────────────────────────────────────');
  console.log('');
  console.log('Usage:');
  const base = process.env.PUBLIC_BASE_URL || 'https://image-blaster-production.up.railway.app';
  console.log(`  curl -X POST ${base}/v1/generate \\`);
  console.log(`    -H "X-API-Key: ${key}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"titles":["example title"], "n_per_title": 3}'`);
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
