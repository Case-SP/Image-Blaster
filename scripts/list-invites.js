#!/usr/bin/env node
/**
 * List every invite code, who (if anyone) has signed up with it so far,
 * and how many uses are left.
 *
 * Usage:
 *   node scripts/list-invites.js
 */
require('dotenv').config();
const { sb } = require('../v2/src/db/supabase');

(async () => {
  const { data: invites, error } = await sb()
    .from('invites')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { console.error(error); process.exit(1); }

  if (!invites.length) {
    console.log('(no invites issued yet)');
    console.log('\nCreate one: node scripts/issue-invite.js --cartridge nolla');
    return;
  }

  const base = process.env.PUBLIC_BASE_URL || 'http://localhost:3002';
  const now = new Date();

  console.log('');
  for (const inv of invites) {
    const exp = inv.expires_at ? new Date(inv.expires_at) : null;
    const expired = exp && exp < now;
    const used = inv.uses_remaining <= 0;
    const status = expired ? 'EXPIRED' : used ? 'EXHAUSTED' : 'ACTIVE';
    const emoji = status === 'ACTIVE' ? '●' : '○';

    console.log(`${emoji} ${inv.code.padEnd(12)} ${status.padEnd(10)} cartridge=${inv.cartridge}  n=${inv.n_per_title}  uses-left=${inv.uses_remaining}`);
    if (exp) console.log(`   expires: ${exp.toISOString().slice(0, 16).replace('T', ' ')}`);
    if (inv.note) console.log(`   note:    ${inv.note}`);
    console.log(`   link:    ${base}/i/${inv.code}`);
    console.log('');
  }

  console.log(`Total: ${invites.length} (${invites.filter(i => i.uses_remaining > 0 && (!i.expires_at || new Date(i.expires_at) > now)).length} active)`);
})().catch(e => { console.error(e); process.exit(1); });
