const { createClient } = require('@supabase/supabase-js');

function sb() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY required');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });
}

// ---- clients ----
async function findClientByToken(token) {
  const { data, error } = await sb()
    .from('clients')
    .select('*')
    .eq('token', token)
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}
async function insertClient({ token, name, cartridge, n_per_title = 5, monthly_image_quota = 500 }) {
  const { data, error } = await sb()
    .from('clients')
    .insert([{ token, name, cartridge, n_per_title, monthly_image_quota }])
    .select()
    .single();
  if (error) throw error;
  return data;
}
async function listClients() {
  const { data, error } = await sb().from('clients').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ---- runs ----
async function upsertRun(trace, clientId) {
  const ok = Object.values(trace.stages?.renders?.items || {}).flat().filter(i => i.status === 'ok').length;
  const failed = Object.values(trace.stages?.renders?.items || {}).flat().filter(i => i.status === 'failed').length;
  const { error } = await sb().from('runs').upsert([{
    id: trace.id,
    client_id: clientId,
    status: trace.status,
    trace,
    started_at: trace.startedAt,
    finished_at: trace.finishedAt,
    ok_count: ok,
    failed_count: failed
  }]);
  if (error) throw error;
}
async function getRun(id, clientId) {
  const { data, error } = await sb()
    .from('runs').select('*').eq('id', id).eq('client_id', clientId).maybeSingle();
  if (error) throw error;
  return data;
}
async function listRunsByClient(clientId) {
  const { data, error } = await sb()
    .from('runs').select('*').eq('client_id', clientId).order('started_at', { ascending: false }).limit(100);
  if (error) throw error;
  return data;
}

// ---- images (metadata) ----
async function recordImage({ runId, slug, filename, storagePath }) {
  const { error } = await sb().from('images').insert([{
    run_id: runId, slug, filename, storage_path: storagePath
  }]);
  if (error && !String(error.message || '').includes('duplicate')) throw error;
}
async function listImagesByRun(runId) {
  const { data, error } = await sb().from('images').select('*').eq('run_id', runId).order('slug').order('filename');
  if (error) throw error;
  return data;
}

module.exports = { sb, findClientByToken, insertClient, listClients, upsertRun, getRun, listRunsByClient, recordImage, listImagesByRun };
