# Deploy-as-API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn v2 into a hosted multi-tenant service on Railway + Supabase: admin issues a client a token ("hash"), client logs in with the token, pastes titles, and downloads a ZIP of generated images to their Downloads folder.

**Architecture:** Keep the existing v2 pipeline untouched. Add (1) a **Storage Adapter** abstraction with filesystem-local and Supabase-Storage implementations, (2) a **Supabase Postgres** layer for clients/runs persistence (replaces JSON-on-disk traces in production), (3) a **client-auth middleware** that maps a token to a client+cartridge, (4) a **stripped public UI** (`/client`) that exposes only title-input + progress + ZIP download, (5) an **admin CLI** to issue tokens, and (6) a **ZIP endpoint** that streams a packed archive of a run's final images. Ship behind a Dockerfile-backed Railway service.

**Tech Stack:** Node 18, Express, Supabase (Postgres + Storage), `@supabase/supabase-js`, `archiver` (ZIP), existing OpenRouter + fal.ai clients, vanilla-JS public UI.

**Non-goals:** Billing, rate-limiting beyond hard quotas, cartridge-editing UI, multi-brand admin surface, webhooks, streaming renders. All deferred.

---

## File Structure

### New files
```
v2/
├── .env.example                      # documented env vars
├── Dockerfile                        # Railway build
├── railway.toml                      # Railway service config
├── package.json                      # add @supabase/supabase-js, archiver
├── supabase/
│   └── schema.sql                    # one-shot schema migration
├── src/
│   ├── db/
│   │   └── supabase.js               # Postgres client + typed helpers
│   ├── storage/
│   │   ├── index.js                  # factory: fs or supabase
│   │   ├── fs.js                     # local filesystem adapter
│   │   └── supabase.js               # Supabase Storage adapter
│   ├── auth/
│   │   └── middleware.js             # Bearer token → req.client
│   ├── zip/
│   │   └── pack.js                   # build a ZIP from image buffers
│   └── routes/
│       ├── public.js                 # /api/public/* — client-facing
│       └── admin.js                  # /api/admin/* — master-key guarded
└── ui-client/
    ├── index.html                    # hash entry + titles form + progress + download
    ├── app.js
    └── styles.css

scripts/                              # admin-side helpers (project root)
├── issue-hash.js                     # create a new client + print token
└── list-clients.js                   # dump clients table
```

### Files modified
- `v2/src/orchestrator.js` — take `clientId` option, persist via storage adapter instead of direct fs writes
- `v2/src/trace/store.js` — delegate read/write to storage adapter, keep in-memory EventEmitter bus
- `v2/src/server.js` — mount public+admin route modules, apply auth middleware, wire storage adapter
- `v2/src/render/fal.js` — unchanged (still returns buffer)

### Files untouched
- `v2/src/factory/*` — pipeline is client-agnostic
- `v2/ui/*` — dogfood UI stays on a separate route (`/admin-ui`)
- `v2/cartridge/*` — ships in Docker image for v0

---

## Environment variables

| Var | Dev | Prod |
|-----|-----|------|
| `OPENROUTER_API_KEY` | required | required |
| `FAL_KEY` | required | required |
| `SUPABASE_URL` | unset → triggers fs storage | required |
| `SUPABASE_SERVICE_KEY` | — | required (service role) |
| `ADMIN_MASTER_KEY` | optional | required (admin endpoints + CLI) |
| `PORT` | 3002 | Railway injects |
| `PUBLIC_BASE_URL` | `http://localhost:3002` | `https://<app>.railway.app` |

The `SUPABASE_URL` presence is the single flag that switches between local and cloud mode. Everything else is just config.

---

## Task 1: Supabase project setup (one-time, manual)

**Files:**
- Create: `v2/supabase/schema.sql`

- [ ] **Step 1: Create Supabase project via dashboard.** Note the Project URL and `service_role` key (NOT anon key).

- [ ] **Step 2: Create a Storage bucket named `generations` (private).** In dashboard: Storage → New bucket → `generations` → Public toggle OFF.

- [ ] **Step 3: Write the schema file `v2/supabase/schema.sql`:**

```sql
-- Clients: one row per tenant. Token is their "hash."
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  token text unique not null,
  name text not null,
  cartridge text not null,
  n_per_title int not null default 5,
  monthly_image_quota int not null default 500,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists clients_token_idx on clients(token) where active = true;

-- Runs: replaces the JSON-on-disk trace files in production.
-- trace column holds the entire trace object as jsonb.
create table if not exists runs (
  id text primary key,
  client_id uuid not null references clients(id) on delete cascade,
  status text not null,
  trace jsonb not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok_count int not null default 0,
  failed_count int not null default 0
);
create index if not exists runs_client_started_idx on runs(client_id, started_at desc);

-- Images: metadata only; actual PNGs live in Storage.
create table if not exists images (
  id uuid primary key default gen_random_uuid(),
  run_id text not null references runs(id) on delete cascade,
  slug text not null,
  filename text not null,
  storage_path text not null,  -- e.g. "<run_id>/<slug>/gen-001.png"
  generated_at timestamptz not null default now(),
  unique (run_id, slug, filename)
);
create index if not exists images_run_idx on images(run_id);
```

- [ ] **Step 4: Run the schema in Supabase SQL editor.** Paste the file contents, Run. Verify 3 tables appear in Table Editor.

- [ ] **Step 5: Copy URL + service_role key into local `.env`:**

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=<service role key>
ADMIN_MASTER_KEY=<generate via: openssl rand -base64 32>
```

---

## Task 2: Install dependencies

**Files:**
- Modify: `package.json` (project root — shared with v1)

- [ ] **Step 1: Install packages**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client
npm install @supabase/supabase-js archiver
```

- [ ] **Step 2: Verify installed**

```bash
node -e "console.log(require('@supabase/supabase-js').createClient ? 'ok' : 'missing')"
node -e "console.log(require('archiver') ? 'ok' : 'missing')"
```
Expected: `ok` twice.

---

## Task 3: `.env.example` and docs

**Files:**
- Create: `v2/.env.example`

- [ ] **Step 1: Write `v2/.env.example`**

```
# LLM + render providers (required)
OPENROUTER_API_KEY=
FAL_KEY=

# Supabase (production mode)
# If unset, v2 falls back to local filesystem storage (dev)
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# Admin (required in production)
# openssl rand -base64 32
ADMIN_MASTER_KEY=

# Public URL used in generated links (clients see this)
PUBLIC_BASE_URL=http://localhost:3002
```

---

## Task 4: Supabase client + DB helpers

**Files:**
- Create: `v2/src/db/supabase.js`

- [ ] **Step 1: Implement the DB module**

```js
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
```

- [ ] **Step 2: Smoke test (requires SUPABASE env vars)**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && node -e "
require('dotenv').config({ path: '../.env' });
const db = require('./src/db/supabase');
db.listClients().then(r => console.log('clients:', r.length)).catch(e => { console.error(e); process.exit(1); });
"
```
Expected: `clients: 0` (empty table is OK).

---

## Task 5: Storage adapter — interface + filesystem impl

**Files:**
- Create: `v2/src/storage/index.js`
- Create: `v2/src/storage/fs.js`

- [ ] **Step 1: Implement `v2/src/storage/index.js` (factory)**

```js
module.exports = function createStorage() {
  if (process.env.SUPABASE_URL) return require('./supabase');
  return require('./fs');
};
```

- [ ] **Step 2: Implement `v2/src/storage/fs.js` (current behavior, extracted)**

```js
const fs = require('fs');
const path = require('path');

const GENS_DIR = path.join(__dirname, '../../output/generations');
const TRACE_DIR = path.join(__dirname, '../../data/traces');
if (!fs.existsSync(GENS_DIR)) fs.mkdirSync(GENS_DIR, { recursive: true });
if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });

async function writeImage(runId, slug, filename, buffer, metadata) {
  const dir = path.join(GENS_DIR, slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), buffer);
  if (metadata) fs.writeFileSync(path.join(dir, `${filename}.json`), JSON.stringify(metadata, null, 2));
  return `${slug}/${filename}`;
}
async function readImage(runId, slug, filename) {
  const p = path.join(GENS_DIR, slug, filename);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}
async function listImages(runId, slug) {
  const dir = path.join(GENS_DIR, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.png')).map(filename => ({ slug, filename }));
}
async function writeTrace(trace, clientId) {
  fs.writeFileSync(path.join(TRACE_DIR, `${trace.id}.json`), JSON.stringify(trace, null, 2));
}
async function readTrace(id, clientId) {
  const p = path.join(TRACE_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
async function listTraces({ clientId } = {}) {
  return fs.readdirSync(TRACE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort().reverse()
    .map(f => JSON.parse(fs.readFileSync(path.join(TRACE_DIR, f), 'utf8')));
}
async function listImagesForRun(runId, slugs) {
  // slugs passed in so we don't need to remember per-run slug set
  const out = [];
  for (const slug of slugs) {
    const list = await listImages(runId, slug);
    out.push(...list);
  }
  return out;
}

module.exports = { writeImage, readImage, listImages, writeTrace, readTrace, listTraces, listImagesForRun };
```

- [ ] **Step 3: Smoke test the fs adapter**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && node -e "
const s = require('./src/storage')();
console.log('exports:', Object.keys(s).join(','));
"
```
Expected: `exports: writeImage,readImage,listImages,writeTrace,readTrace,listTraces,listImagesForRun`

---

## Task 6: Storage adapter — Supabase impl

**Files:**
- Create: `v2/src/storage/supabase.js`

- [ ] **Step 1: Implement Supabase adapter**

```js
const { sb, upsertRun, getRun, listRunsByClient, recordImage, listImagesByRun } = require('../db/supabase');

const BUCKET = 'generations';

async function writeImage(runId, slug, filename, buffer, metadata) {
  const storagePath = `${runId}/${slug}/${filename}`;
  const { error } = await sb().storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: 'image/png', upsert: true
  });
  if (error) throw error;
  await recordImage({ runId, slug, filename, storagePath });
  if (metadata) {
    const metaPath = `${runId}/${slug}/${filename}.json`;
    await sb().storage.from(BUCKET).upload(metaPath, Buffer.from(JSON.stringify(metadata, null, 2)), {
      contentType: 'application/json', upsert: true
    });
  }
  return storagePath;
}

async function readImage(runId, slug, filename) {
  const storagePath = `${runId}/${slug}/${filename}`;
  const { data, error } = await sb().storage.from(BUCKET).download(storagePath);
  if (error) return null;
  const ab = await data.arrayBuffer();
  return Buffer.from(ab);
}

async function listImages(runId, slug) {
  const rows = await listImagesByRun(runId);
  return rows.filter(r => r.slug === slug).map(r => ({ slug: r.slug, filename: r.filename }));
}

async function writeTrace(trace, clientId) {
  if (!clientId) throw new Error('writeTrace requires clientId in Supabase mode');
  await upsertRun(trace, clientId);
}

async function readTrace(id, clientId) {
  if (!clientId) throw new Error('readTrace requires clientId in Supabase mode');
  const row = await getRun(id, clientId);
  return row?.trace || null;
}

async function listTraces({ clientId }) {
  if (!clientId) return [];
  const rows = await listRunsByClient(clientId);
  return rows.map(r => r.trace);
}

async function listImagesForRun(runId) {
  const rows = await listImagesByRun(runId);
  return rows.map(r => ({ slug: r.slug, filename: r.filename }));
}

module.exports = { writeImage, readImage, listImages, writeTrace, readTrace, listTraces, listImagesForRun };
```

- [ ] **Step 2: Smoke test (requires SUPABASE env vars + clients table has at least one test row)**

Defer until Task 9 gives us a client row — but verify module loads:

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && node -e "
require('dotenv').config({ path: '../.env' });
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'placeholder';
const s = require('./src/storage/supabase');
console.log('exports:', Object.keys(s).join(','));
"
```
Expected: `exports: writeImage,readImage,listImages,writeTrace,readTrace,listTraces,listImagesForRun`

---

## Task 7: Wire storage adapter into trace store

**Files:**
- Modify: `v2/src/trace/store.js`

- [ ] **Step 1: Replace fs reads/writes with storage adapter calls**

The existing trace store does `fs.writeFileSync(tracePath(trace.id), ...)`. Replace those with `storage.writeTrace(trace, clientId)` and accept a `clientId` on `createTrace()`.

Full updated content:

```js
const { EventEmitter } = require('events');
const { EVENTS } = require('./schema');
const createStorage = require('../storage');

const storage = createStorage();
const bus = new EventEmitter();
bus.setMaxListeners(200);

function newRunId() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rnd}`;
}

function computeHitRate(trace) {
  const verdicts = Object.values(trace.verdicts || {});
  const total = verdicts.length;
  const usable = verdicts.filter(v => v.verdict === 'usable' || v.verdict === 'winner').length;
  return { total, usable, rate: total ? Number((usable / total).toFixed(3)) : null };
}
function computeRenderProgress(trace) {
  const items = Object.values(trace.stages?.renders?.items || {}).flat();
  const ok = items.filter(i => i.status === 'ok').length;
  const failed = items.filter(i => i.status === 'failed').length;
  const total = (trace.input?.titles?.length || 0) * (trace.input?.N || 0);
  return { ok, failed, total };
}

async function readTrace(id, clientId) {
  return storage.readTrace(id, clientId);
}
async function listTraces({ clientId } = {}) {
  const all = await storage.listTraces({ clientId });
  return all.map(t => ({
    id: t.id, cartridge: t.cartridge, status: t.status,
    startedAt: t.startedAt, finishedAt: t.finishedAt,
    titleCount: t.input?.titles?.length || 0,
    N: t.input?.N,
    hitRate: computeHitRate(t),
    renderProgress: computeRenderProgress(t),
    stageStatus: {
      shotList: t.stages?.shotList?.status,
      critic:   t.stages?.critic?.status,
      resolved: t.stages?.resolved?.status,
      renders:  t.stages?.renders?.status
    }
  }));
}

function createTrace({ cartridge, input, clientId = null }) {
  const trace = {
    id: newRunId(),
    cartridge,
    clientId,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    input,
    stages: {
      shotList: { status: 'pending' },
      critic:   { status: 'pending' },
      resolved: { status: 'pending' },
      renders:  { status: 'pending', items: {} }
    },
    verdicts: {},
    error: null
  };

  let latest = trace;
  const persist = () => storage.writeTrace(latest, clientId).catch(e => console.error('[trace] persist', e.message));
  persist();
  bus.emit(EVENTS.RUN_STARTED, { id: trace.id, trace });

  const mutate = (fn) => { fn(latest); persist(); };

  return {
    id: trace.id,
    get: () => latest,
    updateStage(name, patch) {
      mutate(t => { t.stages[name] = { ...t.stages[name], ...patch }; });
      bus.emit(EVENTS.STAGE_UPDATED, { id: trace.id, stage: name, value: latest.stages[name] });
    },
    startStage(name, meta = {}) {
      this.updateStage(name, { status: 'running', startedAt: new Date().toISOString(), ...meta });
      bus.emit(EVENTS.STAGE_STARTED, { id: trace.id, stage: name });
    },
    finishStage(name, patch = {}) {
      this.updateStage(name, { status: 'done', finishedAt: new Date().toISOString(), ...patch });
      bus.emit(EVENTS.STAGE_FINISHED, { id: trace.id, stage: name });
    },
    failStage(name, err) {
      this.updateStage(name, { status: 'failed', finishedAt: new Date().toISOString(), error: err?.message || String(err) });
    },
    recordRenderItem(tid, item) {
      mutate(t => {
        t.stages.renders.items[tid] = t.stages.renders.items[tid] || [];
        t.stages.renders.items[tid].push(item);
      });
      bus.emit(EVENTS.RENDER_ITEM, { id: trace.id, titleId: tid, item });
    },
    setVerdict(tid, filename, verdict, reasons = []) {
      mutate(t => { t.verdicts[`${tid}/${filename}`] = { verdict, reasons, taggedAt: new Date().toISOString() }; });
      bus.emit(EVENTS.VERDICT_SET, { id: trace.id, key: `${tid}/${filename}`, verdict, reasons });
    },
    finish(patch = {}) {
      mutate(t => { Object.assign(t, { status: 'done', finishedAt: new Date().toISOString(), ...patch }); });
      bus.emit(EVENTS.RUN_FINISHED, { id: trace.id });
    },
    fail(err) {
      mutate(t => { Object.assign(t, { status: 'failed', finishedAt: new Date().toISOString(), error: err?.message || String(err) }); });
      bus.emit(EVENTS.RUN_FAILED, { id: trace.id, error: err?.message });
    }
  };
}

module.exports = { bus, createTrace, readTrace, listTraces, computeHitRate, computeRenderProgress, EVENTS };
```

- [ ] **Step 2: Smoke test locally (fs mode, no SUPABASE vars set)**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && node -e "
const { createTrace, listTraces } = require('./src/trace/store');
const h = createTrace({ cartridge: 'nolla', input: { titles: [], N: 1 } });
h.startStage('shotList');
h.finish();
setTimeout(() => listTraces().then(r => { console.log('traces:', r.length); process.exit(0); }), 100);
"
```
Expected: `traces: 1` (or more — previous local runs).

---

## Task 8: Update orchestrator to use storage + clientId

**Files:**
- Modify: `v2/src/orchestrator.js`

- [ ] **Step 1: Accept `clientId` and route image writes through storage**

Replace the `fs.writeFileSync` calls in `runOne` with `storage.writeImage(...)`. The current in-memory `cartridge.references` loader still works fine — no change there.

Diff-style (apply to the existing file):

Replace the `runOne` function (inside `runBatch`) with:

```js
    const runOne = async ({ title, titleDir, shot, idx }) => {
      const filename = `gen-${String(idx + 1).padStart(3, '0')}.png`;
      if (shot.__error) {
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'failed', error: 'resolve: ' + shot.__error, stage: 'resolve' });
        return;
      }
      try {
        const img = await renderOne(shot.prompt, { model, aspectRatio, references: cartridge.references });
        const buf = await downloadImage(img.url);
        const metadata = { ...shot, model: img.model, generatedAt: new Date().toISOString(), runId: trace.id };
        await storage.writeImage(trace.id, title.slug, filename, buf, metadata);
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'ok', elapsedMs: img.elapsedMs, model: img.model });
      } catch (e) {
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'failed', error: e.message });
      }
    };
```

Add `const storage = require('./storage')();` near the top. Remove the `titleDir` arg from the task constructor — storage handles the path.

Change `runBatch({ ... })` signature to include `clientId`:
```js
async function runBatch({ cartridgeName = 'nolla', titles, N = 10, critic = true, model, aspectRatio, debug = true, clientId = null }) {
```

And change `createTrace({ cartridge, input: {...} })` to `createTrace({ cartridge, input: {...}, clientId })`.

- [ ] **Step 2: Smoke — local fs mode (don't actually fire a batch, just require)**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && node -e "
const o = require('./src/orchestrator');
console.log('exports:', Object.keys(o).join(','));
"
```
Expected: `exports: runBatch`

---

## Task 9: Admin CLI — issue hash

**Files:**
- Create: `scripts/issue-hash.js`
- Create: `scripts/list-clients.js`

- [ ] **Step 1: Write `scripts/issue-hash.js`**

```js
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
```

- [ ] **Step 2: Write `scripts/list-clients.js`**

```js
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
```

- [ ] **Step 3: Issue a test client (requires SUPABASE env)**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client && node scripts/issue-hash.js --name "Test Client" --cartridge nolla --n 3
```
Expected: prints token + public URL. **Save this token for Task 13.**

- [ ] **Step 4: Verify via list**

```bash
node scripts/list-clients.js
```
Expected: 1 row.

---

## Task 10: Auth middleware

**Files:**
- Create: `v2/src/auth/middleware.js`

- [ ] **Step 1: Implement**

```js
const { findClientByToken } = require('../db/supabase');

// In-memory cache (5 min TTL) — avoids hitting DB on every request
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.headers['x-access-token']) return req.headers['x-access-token'];
  if (req.query?.token) return req.query.token;
  return null;
}

async function resolveClient(token) {
  const cached = cache.get(token);
  if (cached && cached.expires > Date.now()) return cached.client;
  const client = await findClientByToken(token);
  if (client) cache.set(token, { client, expires: Date.now() + TTL_MS });
  return client;
}

function requireClient(req, res, next) {
  (async () => {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'token required' });
    try {
      const client = await resolveClient(token);
      if (!client) return res.status(401).json({ error: 'invalid token' });
      req.client = client;
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  })();
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_MASTER_KEY) return res.status(401).json({ error: 'admin key required' });
  next();
}

module.exports = { requireClient, requireAdmin, extractToken };
```

- [ ] **Step 2: Smoke**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && node -e "
const m = require('./src/auth/middleware');
console.log('exports:', Object.keys(m).join(','));
"
```
Expected: `exports: requireClient,requireAdmin,extractToken`

---

## Task 11: ZIP packer

**Files:**
- Create: `v2/src/zip/pack.js`

- [ ] **Step 1: Implement**

```js
const archiver = require('archiver');

/**
 * Build an in-memory ZIP of images.
 * `files` is an array of { filename, buffer }.
 * Returns a Promise<Buffer>.
 */
function packZip(files, { zipName = 'images' } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('data', c => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('warning', err => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);
    for (const { filename, buffer } of files) {
      if (buffer) archive.append(buffer, { name: filename });
    }
    archive.finalize();
  });
}

module.exports = { packZip };
```

- [ ] **Step 2: Unit smoke**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && node -e "
const { packZip } = require('./src/zip/pack');
packZip([{ filename: 'a.txt', buffer: Buffer.from('hello') }]).then(b => {
  console.log('zip bytes:', b.length, 'starts with PK:', b.slice(0,2).toString() === 'PK');
});
"
```
Expected: `zip bytes: <nonzero> starts with PK: true`

---

## Task 12: Public + admin route modules

**Files:**
- Create: `v2/src/routes/public.js`
- Create: `v2/src/routes/admin.js`
- Modify: `v2/src/server.js`

- [ ] **Step 1: Create `v2/src/routes/public.js`**

```js
const express = require('express');
const { requireClient } = require('../auth/middleware');
const { runBatch } = require('../orchestrator');
const { readTrace, listTraces, bus, EVENTS } = require('../trace/store');
const createStorage = require('../storage');
const { packZip } = require('../zip/pack');

const storage = createStorage();
const router = express.Router();

router.use(requireClient);

// POST /api/public/runs — start a batch for this client
router.post('/runs', async (req, res) => {
  try {
    const { titles = [] } = req.body;
    if (!Array.isArray(titles) || !titles.length) {
      return res.status(400).json({ error: 'titles[] required' });
    }
    const normalized = titles.slice(0, 50).map((line, i) => {
      const raw = typeof line === 'string' ? line : (line.title || '');
      if (!raw.trim()) return null;
      const parts = raw.split('|');
      const hasCategory = parts.length > 1;
      const title = hasCategory ? parts.slice(1).join('|').trim() : raw.trim();
      const category = hasCategory ? parts[0].trim() : 'general';
      return {
        id: `c-${Date.now()}-${i}`,
        title,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50),
        category
      };
    }).filter(Boolean);
    if (!normalized.length) return res.status(400).json({ error: 'no valid titles' });

    // Fire-and-forget; client watches via SSE
    runBatch({
      cartridgeName: req.client.cartridge,
      titles: normalized,
      N: req.client.n_per_title,
      critic: true,
      clientId: req.client.id
    }).catch(e => console.error('[runBatch]', e));

    res.json({ status: 'started', titles: normalized.length, N: req.client.n_per_title });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/runs — list this client's runs
router.get('/runs', async (req, res) => {
  try {
    const runs = await listTraces({ clientId: req.client.id });
    res.json(runs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/runs/:id — get one trace (scoped to this client)
router.get('/runs/:id', async (req, res) => {
  try {
    const trace = await readTrace(req.params.id, req.client.id);
    if (!trace) return res.status(404).json({ error: 'not found' });
    res.json(trace);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/runs/:id/zip — stream a ZIP of all images
router.get('/runs/:id/zip', async (req, res) => {
  try {
    const trace = await readTrace(req.params.id, req.client.id);
    if (!trace) return res.status(404).json({ error: 'not found' });
    const items = trace.stages?.renders?.items || {};
    const files = [];
    for (const [tid, arr] of Object.entries(items)) {
      const title = trace.input.titles.find(t => t.id === tid);
      if (!title) continue;
      for (const item of arr) {
        if (item.status !== 'ok') continue;
        const buf = await storage.readImage(trace.id, title.slug, item.filename);
        if (buf) files.push({ filename: `${title.slug}/${item.filename}`, buffer: buf });
      }
    }
    if (!files.length) return res.status(404).json({ error: 'no images yet' });
    const zip = await packZip(files);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${req.params.id}.zip"`
    });
    res.send(zip);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/events?run=<id> — SSE scoped to this client's runs
router.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders();
  const runFilter = req.query.run || null;
  const clientTraceIds = new Set(); // populated lazily — we don't pre-load, we filter by run id only

  const send = async (event, data) => {
    if (runFilter && data.id && data.id !== runFilter) return;
    // Even without runFilter, only forward events whose trace belongs to this client.
    if (data.id && !clientTraceIds.has(data.id)) {
      const t = await readTrace(data.id, req.client.id).catch(() => null);
      if (!t) return;
      clientTraceIds.add(data.id);
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const handlers = {};
  for (const [, v] of Object.entries(EVENTS)) {
    handlers[v] = (data) => send(v, data).catch(() => {});
    bus.on(v, handlers[v]);
  }
  req.on('close', () => { for (const [v, h] of Object.entries(handlers)) bus.off(v, h); });
});

// GET /api/public/me — client metadata (used by UI)
router.get('/me', (req, res) => {
  res.json({
    name: req.client.name,
    cartridge: req.client.cartridge,
    n_per_title: req.client.n_per_title
  });
});

module.exports = router;
```

- [ ] **Step 2: Create `v2/src/routes/admin.js`**

```js
const express = require('express');
const { requireAdmin } = require('../auth/middleware');
const { listClients } = require('../db/supabase');

const router = express.Router();
router.use(requireAdmin);

router.get('/clients', async (req, res) => {
  try { res.json(await listClients()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
```

- [ ] **Step 3: Rewrite `v2/src/server.js` to mount these + protect the dogfood UI**

Add at the top: `const publicRoutes = require('./routes/public'); const adminRoutes = require('./routes/admin');`

Mount: `app.use('/api/public', publicRoutes); app.use('/api/admin', adminRoutes);`

Also serve `ui-client` as a separate static path: `app.use('/client', express.static(path.join(__dirname, '../ui-client')));`

Keep the existing `/api/*` dogfood routes (they read from local fs — useful for dev, not exposed in prod unless ADMIN_MASTER_KEY query param matches).

Full new `v2/src/server.js`:

```js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');
const { runBatch } = require('./orchestrator');
const { loadCartridge } = require('./factory/cartridge');
const { readTrace, listTraces, bus, EVENTS } = require('./trace/store');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const createStorage = require('./storage');

const app = express();
app.use(express.json({ limit: '10mb' }));
const PORT = parseInt(process.env.PORT || '3002', 10);
const storage = createStorage();

// ---- Public API ----
app.use('/api/public', publicRoutes);

// ---- Admin API ----
app.use('/api/admin', adminRoutes);

// ---- Client UI ----
app.use('/client', express.static(path.join(__dirname, '../ui-client')));

// ---- Dogfood UI (dev) ----
app.use('/admin-ui', express.static(path.join(__dirname, '../ui')));

// ---- Dev-only local fs endpoints (kept for existing dogfood UI) ----
// Guard: require ADMIN_MASTER_KEY header in prod (i.e. when SUPABASE_URL is set)
app.use('/api', (req, res, next) => {
  if (process.env.SUPABASE_URL && req.headers['x-admin-key'] !== process.env.ADMIN_MASTER_KEY) {
    return res.status(404).end();
  }
  next();
});

app.get('/api/cartridges', (req, res) => {
  const dir = path.join(__dirname, '../cartridge');
  res.json({ cartridges: fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isDirectory()) });
});

app.get('/api/runs', async (req, res) => { try { res.json(await listTraces()); } catch (e) { res.status(500).json({error:e.message}); } });
app.get('/api/runs/:id', async (req, res) => {
  try {
    const t = await readTrace(req.params.id, null);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/runs', async (req, res) => {
  try {
    const { cartridge = 'nolla', titles = [], N = 10, critic = true, model, aspectRatio } = req.body;
    if (!titles.length) return res.status(400).json({ error: 'titles[] required' });
    const titlesNormalized = titles.map((t, i) => ({
      id: t.id || `run-${i}`,
      title: t.title,
      slug: t.slug || t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50),
      category: t.category || 'general'
    }));
    runBatch({ cartridgeName: cartridge, titles: titlesNormalized, N, critic, model, aspectRatio }).catch(e => console.error('[runBatch]', e));
    res.json({ status: 'started' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/runs/:id/verdict', async (req, res) => {
  try {
    const t = await readTrace(req.params.id, null);
    if (!t) return res.status(404).json({ error: 'not found' });
    const { titleId, filename, verdict, reasons = [] } = req.body;
    t.verdicts[`${titleId}/${filename}`] = { verdict, reasons, taggedAt: new Date().toISOString() };
    await storage.writeTrace(t, t.clientId || null);
    bus.emit(EVENTS.VERDICT_SET, { id: t.id, key: `${titleId}/${filename}`, verdict, reasons });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/images/:slug/:filename', async (req, res) => {
  // Dev-only fallback: read from local fs directly
  const p = path.join(__dirname, '../output/generations', req.params.slug, req.params.filename);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders();
  const runFilter = req.query.run || null;
  const send = (event, data) => {
    if (runFilter && data.id && data.id !== runFilter) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const handlers = {};
  for (const [, v] of Object.entries(EVENTS)) {
    handlers[v] = (data) => send(v, data);
    bus.on(v, handlers[v]);
  }
  req.on('close', () => { for (const [v, h] of Object.entries(handlers)) bus.off(v, h); });
});

// ---- Root redirect ----
app.get('/', (req, res) => res.redirect('/client'));

app.listen(PORT, () => console.log(`v2 live at http://localhost:${PORT}  (client UI: /client, admin UI: /admin-ui)`));
```

- [ ] **Step 4: Smoke — server starts**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && lsof -iTCP:3002 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | xargs -r kill; sleep 0.5; node src/server.js &
sleep 2
curl -s http://localhost:3002/ -L -o /dev/null -w "HTTP %{http_code}\n"
curl -s http://localhost:3002/api/public/runs -w "\nHTTP %{http_code}\n"
kill %1 2>/dev/null
```
Expected: redirects to `/client` (404 if static files not yet there — OK for now), `/api/public/runs` returns `{"error":"token required"}` HTTP 401.

---

## Task 13: Client UI

**Files:**
- Create: `v2/ui-client/index.html`
- Create: `v2/ui-client/app.js`
- Create: `v2/ui-client/styles.css`

- [ ] **Step 1: Write `v2/ui-client/index.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Image Generator</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header>
    <h1>Image Generator</h1>
    <div id="client-meta"></div>
  </header>

  <main>
    <section id="auth-section">
      <h2>Log in</h2>
      <p>Paste your access token:</p>
      <form id="auth-form">
        <input type="text" id="token" placeholder="token" required>
        <button type="submit">Continue</button>
      </form>
      <p class="hint" id="auth-error"></p>
    </section>

    <section id="app-section" hidden>
      <form id="batch-form">
        <label>Titles (one per line)
          <textarea id="titles" rows="10" placeholder="Does Creatine Cause Hair Loss?&#10;How to Quit Smoking&#10;..."></textarea>
        </label>
        <button type="submit" id="generate-btn">Generate</button>
      </form>

      <section id="current-run" hidden>
        <h2>Running <span id="run-id"></span></h2>
        <div id="progress"></div>
        <div id="stage-line"></div>
      </section>

      <section id="past-runs">
        <h2>Your runs</h2>
        <table id="runs-table">
          <thead><tr><th>ID</th><th>Started</th><th>Titles</th><th>Status</th><th>Progress</th><th>Download</th></tr></thead>
          <tbody></tbody>
        </table>
      </section>
    </section>
  </main>

  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `v2/ui-client/app.js`**

```js
(function () {
  const API = '/api/public';
  let TOKEN = null;

  const $ = (s) => document.querySelector(s);

  async function json(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}), ...(TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {}) }
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    return r.json();
  }

  async function downloadZip(runId) {
    const r = await fetch(`${API}/runs/${runId}/zip`, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    if (!r.ok) { alert('Download failed: ' + r.status); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${runId}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function login(token) {
    TOKEN = token;
    try {
      const me = await json(`${API}/me`);
      localStorage.setItem('token', token);
      $('#client-meta').textContent = `${me.name} — ${me.n_per_title}/title`;
      $('#auth-section').hidden = true;
      $('#app-section').hidden = false;
      await renderRuns();
      openSSE();
    } catch (e) {
      TOKEN = null;
      $('#auth-error').textContent = 'Invalid token';
    }
  }

  $('#auth-form').addEventListener('submit', (e) => { e.preventDefault(); login($('#token').value.trim()); });

  $('#batch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const titles = $('#titles').value.trim().split('\n').map(x => x.trim()).filter(Boolean);
    if (!titles.length) return;
    $('#generate-btn').disabled = true;
    try {
      await json(`${API}/runs`, { method: 'POST', body: JSON.stringify({ titles }) });
      $('#titles').value = '';
    } catch (err) { alert('Failed: ' + err.message); }
    finally { $('#generate-btn').disabled = false; }
    await renderRuns();
  });

  async function renderRuns() {
    const runs = await json(`${API}/runs`);
    const tbody = $('#runs-table tbody');
    tbody.innerHTML = '';
    for (const r of runs) {
      const tr = document.createElement('tr');
      const p = r.renderProgress || { ok: 0, failed: 0, total: 0 };
      const done = p.ok + p.failed;
      const progressStr = p.total ? `${done}/${p.total}` + (p.failed ? ` (${p.failed} failed)` : '') : '—';
      const canDownload = r.status === 'done' && p.ok > 0;
      tr.innerHTML = `
        <td>${r.id}</td>
        <td>${new Date(r.startedAt).toLocaleString()}</td>
        <td>${r.titleCount}</td>
        <td>${r.status}</td>
        <td>${progressStr}</td>
        <td>${canDownload ? `<button data-run="${r.id}" class="dl">Download ZIP</button>` : '—'}</td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.dl').forEach(b => b.addEventListener('click', () => downloadZip(b.dataset.run)));
  }

  function openSSE() {
    const es = new EventSource(`${API}/events?token=${encodeURIComponent(TOKEN)}`);
    ['run.started','run.finished','run.failed','stage.started','stage.finished','render.item'].forEach(ev => es.addEventListener(ev, renderRuns));
  }

  // Auto-login from URL ?token= or localStorage
  const qs = new URLSearchParams(location.search);
  const pre = qs.get('token') || localStorage.getItem('token');
  if (pre) { $('#token').value = pre; login(pre); }
})();
```

- [ ] **Step 3: Write `v2/ui-client/styles.css`**

```css
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f6f4ef; color: #2b2a27; }
header { padding: 1rem 1.5rem; background: #2b2a27; color: #f6f4ef; display: flex; justify-content: space-between; align-items: center; }
header h1 { margin: 0; font-size: 1.1rem; }
#client-meta { font-size: 0.9rem; opacity: 0.7; }
main { padding: 1.5rem; max-width: 1000px; margin: 0 auto; }
h2 { font-size: 1rem; margin-top: 2rem; }
input, textarea, button { padding: 0.6rem; font-family: inherit; font-size: 1rem; }
textarea { width: 100%; font-family: monospace; font-size: 0.9rem; }
button { background: #2b2a27; color: white; border: 0; cursor: pointer; padding: 0.6rem 1.2rem; }
button:disabled { opacity: 0.5; cursor: wait; }
label { display: block; margin-bottom: 0.5rem; }
#auth-section, #current-run, #past-runs, #batch-form { background: #fff; padding: 1rem 1.25rem; border-radius: 6px; margin-bottom: 1rem; }
.hint { color: #c46b6b; font-size: 0.85rem; min-height: 1em; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #eee; font-size: 0.9rem; }
.dl { padding: 0.3rem 0.7rem; font-size: 0.85rem; }
```

- [ ] **Step 4: Smoke — load UI + log in with test client's token**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && lsof -iTCP:3002 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | xargs -r kill; sleep 0.5; node src/server.js &
sleep 2
curl -s "http://localhost:3002/client" -o /dev/null -w "HTTP %{http_code}\n"
curl -s "http://localhost:3002/api/public/me" -H "Authorization: Bearer <PASTE_TOKEN_FROM_TASK_9>" -w "\nHTTP %{http_code}\n"
kill %1 2>/dev/null
```
Expected: `/client` → HTTP 200, `/api/public/me` → `{"name":"Test Client","cartridge":"nolla","n_per_title":3}` HTTP 200.

---

## Task 14: End-to-end local test (fs mode)

**Files:** (none created — this is a verification task)

- [ ] **Step 1: Start server in fs mode (unset Supabase env)**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && (unset SUPABASE_URL SUPABASE_SERVICE_KEY; node src/server.js) &
sleep 2
```

- [ ] **Step 2: Verify /admin-ui still works (dogfood)**

Browser: `http://localhost:3002/admin-ui` — the old dogfood UI should appear. Submit a test batch via the "New Run" form. Confirm renders happen.

- [ ] **Step 3: Kill server**

```bash
kill %1 2>/dev/null
```

Note: `/client` will NOT work without Supabase because it depends on `findClientByToken`. That's expected — in dev, use `/admin-ui`.

---

## Task 15: End-to-end Supabase test

Requires a test client issued in Task 9.

- [ ] **Step 1: Start with Supabase env**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client/v2 && node src/server.js &
sleep 2
```

- [ ] **Step 2: Hit `/api/public/me` with token**

```bash
curl -s http://localhost:3002/api/public/me -H "Authorization: Bearer <TOKEN>"
```
Expected: JSON with name, cartridge, n_per_title.

- [ ] **Step 3: Fire a 1-title batch**

```bash
curl -s -X POST http://localhost:3002/api/public/runs \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"titles":["Does Creatine Cause Hair Loss?"]}'
```
Expected: `{"status":"started","titles":1,"N":3}`

- [ ] **Step 4: Wait for completion (poll)**

```bash
for i in {1..20}; do
  curl -s http://localhost:3002/api/public/runs -H "Authorization: Bearer <TOKEN>" | node -e "
const rs = JSON.parse(require('fs').readFileSync(0,'utf8'));
const r = rs[0];
console.log(r.id, r.status, JSON.stringify(r.renderProgress));
" ; sleep 10
done
```
Expected: eventually `status: done, {"ok":3,"failed":0,"total":3}`.

- [ ] **Step 5: Download ZIP**

```bash
curl -s -o /tmp/test-run.zip -H "Authorization: Bearer <TOKEN>" "http://localhost:3002/api/public/runs/<RUN_ID>/zip"
unzip -l /tmp/test-run.zip
```
Expected: ZIP contains 3 PNGs in `does-creatine-cause-hair-loss/`.

- [ ] **Step 6: Kill server**

```bash
kill %1 2>/dev/null
```

---

## Task 16: Railway config

**Files:**
- Create: `Dockerfile` (project root)
- Create: `railway.toml` (project root)
- Modify: `package.json` (project root) — add `start` script if missing

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3002
CMD ["node", "v2/src/server.js"]
```

- [ ] **Step 2: Write `railway.toml`**

```toml
[build]
builder = "dockerfile"

[deploy]
healthcheckPath = "/"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

- [ ] **Step 3: Verify root `package.json` has start script**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client && cat package.json | grep -A1 scripts
```
If `"start"` is missing, add it: `"start": "node v2/src/server.js"`.

- [ ] **Step 4: Test Docker build locally (optional, requires Docker)**

```bash
cd /Users/casemiller/Desktop/Nolla-Image-Client && docker build -t nolla-api .
docker run --rm -p 3002:3002 --env-file .env nolla-api &
sleep 5
curl -s http://localhost:3002/ -L -o /dev/null -w "HTTP %{http_code}\n"
docker stop $(docker ps -q -f ancestor=nolla-api)
```
Expected: HTTP 200.

---

## Task 17: Deploy to Railway

- [ ] **Step 1: Create Railway project**

At railway.app → New Project → Deploy from GitHub (or `railway link` from CLI).

- [ ] **Step 2: Set environment variables in Railway dashboard**

```
OPENROUTER_API_KEY=<value>
FAL_KEY=<value>
SUPABASE_URL=<value>
SUPABASE_SERVICE_KEY=<value>
ADMIN_MASTER_KEY=<generate>
PUBLIC_BASE_URL=https://<app-name>.railway.app
NODE_ENV=production
```

- [ ] **Step 3: Deploy**

Railway auto-builds from Dockerfile and deploys.

- [ ] **Step 4: Smoke — hit the deployed URL**

```bash
URL=https://<app-name>.railway.app
curl -s $URL/ -L -o /dev/null -w "HTTP %{http_code}\n"
curl -s $URL/api/public/runs -w "\nHTTP %{http_code}\n"
```
Expected: HTTP 200 on root, HTTP 401 on /api/public/runs without token.

- [ ] **Step 5: End-to-end smoke from the deployed URL**

Same as Task 15, but with the Railway URL. Verify ZIP download works.

---

## Out of scope (explicitly deferred)

- Billing / quota enforcement (column exists, enforcement not wired)
- Admin UI for cartridge editing
- Per-client reference image uploads
- Webhook notifications on run completion
- Signed download URLs (ZIP is served through the app — fine for low volume)
- Rate limiting beyond the per-client quota field
- Observability (OpenTelemetry, structured logs)

---

## Self-review checklist (filled in during writing)

- ✅ Spec coverage: client auth (Task 10) · title input (Task 13) · image generation (existing, reused) · ZIP download (Tasks 11, 12 route) · Railway deploy (Tasks 16, 17) · Supabase (Tasks 1, 4, 5, 6, 7)
- ✅ No placeholders: every code step contains complete code. Smoke tests have exact commands + expected output.
- ✅ Type consistency: `clientId` threaded through `createTrace({ clientId })` → `storage.writeTrace(trace, clientId)` → `readTrace(id, clientId)` consistently. Storage adapter interface identical across `fs.js` and `supabase.js`. `findClientByToken` / `insertClient` / `listClients` names match between db module and scripts.
- ✅ Gaps noted: Task 14 explicitly calls out that `/client` requires Supabase — fs-mode dev uses `/admin-ui` instead. This is intentional.
