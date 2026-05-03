#!/usr/bin/env node
/** Quick auth-state check for a given email. Usage: node scripts/check-user.js --email x@y.com */
require('dotenv').config();
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
  const email = String(args.email || '').trim().toLowerCase();
  if (!email) { console.error('--email required'); process.exit(1); }

  console.log(`=== access_grants for ${email} ===`);
  const { data: grants } = await sb().from('access_grants').select('*').eq('email', email).order('created_at', { ascending: false });
  if (!grants?.length) console.log('  (none)');
  for (const g of grants || []) {
    const status = g.used_at ? `USED ${g.used_at}` : new Date(g.expires_at) < new Date() ? 'EXPIRED' : 'ACTIVE';
    console.log(`  [${status}] token=${g.token} code=${g.code} expires=${g.expires_at}`);
  }

  console.log(`\n=== clients row ===`);
  const { data: client } = await sb().from('clients').select('id,name,email,active,created_at').eq('email', email).maybeSingle();
  console.log(client ? JSON.stringify(client, null, 2) : '  (none — never provisioned)');

  if (client) {
    console.log(`\n=== sessions ===`);
    const { data: sessions } = await sb().from('sessions').select('id,expires_at,last_seen_at,user_agent').eq('client_id', client.id).order('expires_at', { ascending: false });
    if (!sessions?.length) console.log('  (none)');
    for (const s of sessions || []) {
      const expired = new Date(s.expires_at) < new Date();
      console.log(`  ${expired ? '[EXPIRED]' : '[ACTIVE] '} sid=${s.id.slice(0,10)}…  expires=${s.expires_at}  last_seen=${s.last_seen_at || '—'}`);
      if (s.user_agent) console.log(`             UA: ${s.user_agent.slice(0,80)}`);
    }

    console.log(`\n=== runs ===`);
    const { data: runs } = await sb().from('runs').select('id,status,started_at,ok_count,failed_count').eq('client_id', client.id).order('started_at', { ascending: false });
    console.log(`  count: ${runs?.length || 0}`);
    for (const r of (runs || []).slice(0,5)) {
      console.log(`  ${r.started_at}  ${r.status}  ${r.ok_count}/${r.ok_count + r.failed_count}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
