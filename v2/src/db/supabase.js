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
  // Materialize cartridge + stage as real columns so /tiles can filter via
  // an index instead of extracting from JSON. The DB trigger covers legacy
  // writers; we set them here too so the columns are correct from the
  // start of every new run.
  const cartridge = trace.cartridge || null;
  const stage = trace.stages?.shotList?.stage || trace.input?.stage || null;
  const { error } = await sb().from('runs').upsert([{
    id: trace.id,
    client_id: clientId,
    status: trace.status,
    trace,
    started_at: trace.startedAt,
    finished_at: trace.finishedAt,
    ok_count: ok,
    failed_count: failed,
    cartridge,
    stage
  }]);
  // If the columns don't exist yet (migration not run), retry without them so
  // writes don't fail. PostgREST surfaces this as either:
  //   "column ... does not exist" (raw Postgres)
  //   "Could not find the 'X' column ... in the schema cache" (PostgREST cache)
  // Match both.
  const msg = error?.message || '';
  const isMissingNewCol = /cartridge|stage/i.test(msg) &&
    /(does not exist|schema cache|could not find)/i.test(msg);
  if (isMissingNewCol) {
    const { error: e2 } = await sb().from('runs').upsert([{
      id: trace.id,
      client_id: clientId,
      status: trace.status,
      trace,
      started_at: trace.startedAt,
      finished_at: trace.finishedAt,
      ok_count: ok,
      failed_count: failed
    }]);
    if (e2) throw e2;
    return;
  }
  if (error) throw error;
}
async function getRun(id, clientId) {
  const { data, error } = await sb()
    .from('runs').select('*').eq('id', id).eq('client_id', clientId).maybeSingle();
  if (error) throw error;
  return data;
}
async function listRunsByClient(clientId) {
  // Slim listing: project only scalar fields and a tiny set of JSON paths.
  // Pulling the whole trace->stages tree (which includes renders.items) was
  // causing 5–8 s queries that hit the route's 8 s timeout. Project only
  // each stage's `status` field as a string, plus `cartridge` and the
  // small `input` summary. titleCount is computed server-side from
  // input.titles array length after parsing.
  // SLIM: project scalar fields + only the JSON sub-paths the UI actually
  // reads. `trace->input` (full) used to be projected here — that JSON
  // column is large enough to push the query past the 8s timeout. Instead
  // pull just `titles`, `stage`, `N` and reassemble the slim shape below.
  const { data, error } = await sb()
    .from('runs')
    .select([
      'id', 'client_id', 'status', 'started_at', 'finished_at',
      'ok_count', 'failed_count',
      'cartridge:trace->>cartridge',
      'input_stage:trace->input->>stage',
      'input_n:trace->input->>N',
      'input_titles:trace->input->titles',
      'shot_list_status:trace->stages->shotList->>status',
      'critic_status:trace->stages->critic->>status',
      'resolved_status:trace->stages->resolved->>status',
      'renders_status:trace->stages->renders->>status'
    ].join(','))
    .eq('client_id', clientId)
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data.map(row => ({
    ...row,
    trace: {
      id: row.id,
      cartridge: row.cartridge,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      input: {
        stage: row.input_stage || null,
        N: row.input_n != null ? Number(row.input_n) : null,
        titles: Array.isArray(row.input_titles) ? row.input_titles : []
      },
      stages: {
        shotList: { status: row.shot_list_status },
        critic:   { status: row.critic_status },
        resolved: { status: row.resolved_status },
        renders:  { status: row.renders_status }
      },
      verdicts: {},
      __counts: { ok: row.ok_count || 0, failed: row.failed_count || 0 }
    }
  }));
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
