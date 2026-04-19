#!/usr/bin/env node
/**
 * Create an invite link that auto-provisions new clients when someone signs
 * in with it. Send the printed URL to your tester — they visit it, enter
 * their email, get the OTP, and they're in. No admin step after this.
 *
 * Usage:
 *   node scripts/issue-invite.js --cartridge nolla [--n 3] [--uses 1] [--days 30] [--note "for Jane"]
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

(async () => {
  const args = parseArgs();
  const cartridge = args.cartridge || 'nolla';
  const n = parseInt(args.n || '3', 10);
  const uses = parseInt(args.uses || '1', 10);
  const days = parseInt(args.days || '30', 10);
  const note = args.note || null;
  const code = args.code || crypto.randomBytes(6).toString('base64url').toLowerCase();
  const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await sb().from('invites').insert([{
    code, cartridge, n_per_title: n, uses_remaining: uses, expires_at, note
  }]);
  if (error) { console.error(error); process.exit(1); }

  const base = process.env.PUBLIC_BASE_URL || 'http://localhost:3002';
  const url = `${base}/client?invite=${code}`;
  console.log('\n✓ Invite created');
  console.log('  code:      ' + code);
  console.log('  cartridge: ' + cartridge);
  console.log('  n/title:   ' + n);
  console.log('  uses:      ' + uses);
  console.log('  expires:   ' + expires_at);
  if (note) console.log('  note:      ' + note);
  console.log('\nSend this link:\n  ' + url);
})().catch(e => { console.error(e); process.exit(1); });
