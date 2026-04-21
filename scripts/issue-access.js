#!/usr/bin/env node
/**
 * Issue a one-time access grant for a tester. Creates both a magic link
 * (URL) and a 6-digit code. Either can be redeemed once to create a
 * standard 30-day session. Bypasses Supabase email entirely — you copy
 * the printed message into a manual email.
 *
 * Usage:
 *   node scripts/issue-access.js --email dennis@s-p.studio
 *   node scripts/issue-access.js --email x@y.com --days 2 --n 3 --cartridge nolla --note "beta tester"
 */
require('dotenv').config();
const crypto = require('crypto');
const { sb } = require('../v2/src/db/supabase');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
  }
  return args;
}

function sixDigit() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

(async () => {
  const args = parseArgs();
  const email = String(args.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('--email required');
    process.exit(1);
  }
  const days = parseInt(args.days || '2', 10);
  const cartridge = args.cartridge || 'nolla';
  const n = parseInt(args.n || '3', 10);
  const quota = parseInt(args.quota || '500', 10);
  const note = args.note || null;

  const token = crypto.randomBytes(9).toString('base64url'); // 12 chars
  const code = sixDigit();
  const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await sb().from('access_grants').insert([{
    token, code, email, cartridge, n_per_title: n, monthly_image_quota: quota, expires_at, note
  }]);
  if (error) { console.error(error); process.exit(1); }

  const base = process.env.PUBLIC_BASE_URL || 'https://image-blaster-production.up.railway.app';
  const url = `${base}/a/${token}`;
  const expFmt = new Date(expires_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  console.log(`\n✓ Access issued for ${email} (expires ${expFmt})`);
  console.log(`  cartridge: ${cartridge} · n/title: ${n} · quota: ${quota}${note ? ' · ' + note : ''}`);
  console.log('\nEmail body:');
  console.log('──────────────────────────────────────');
  console.log(`Hey — here's your access to Image Blaster.`);
  console.log('');
  console.log(`Click to sign in:`);
  console.log(`  ${url}`);
  console.log('');
  console.log(`Or enter this code on the sign-in page:`);
  console.log(`  ${code}`);
  console.log('');
  console.log(`Both expire in ${days} day${days === 1 ? '' : 's'}.`);
  console.log('──────────────────────────────────────\n');
})().catch(e => { console.error(e); process.exit(1); });
