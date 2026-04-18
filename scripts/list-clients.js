#!/usr/bin/env node
require('dotenv').config();
const { listClients } = require('../v2/src/db/supabase');

(async () => {
  const rows = await listClients();
  if (!rows.length) { console.log('(no clients)'); return; }
  console.log('id'.padEnd(38), 'name'.padEnd(20), 'cartridge'.padEnd(14), 'n', 'quota', 'active', 'token (truncated)');
  rows.forEach(c => {
    console.log(
      c.id,
      (c.name || '').padEnd(20),
      (c.cartridge || '').padEnd(14),
      String(c.n_per_title).padEnd(2),
      String(c.monthly_image_quota).padEnd(5),
      c.active ? 'yes' : 'no ',
      c.token.slice(0, 8) + '…'
    );
  });
})().catch(e => { console.error(e); process.exit(1); });
