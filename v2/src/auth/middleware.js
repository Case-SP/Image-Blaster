const crypto = require('crypto');
const { findClientByToken, sb } = require('../db/supabase');

const COOKIE_NAME = 'sid';

// In-memory cache (5 min TTL) — avoids hitting DB on every request
const tokenCache = new Map();
const sessionCache = new Map();
const apiKeyCache = new Map();
const TTL_MS = 5 * 60 * 1000;

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function resolveClientByApiKey(key) {
  const hash = hashApiKey(key);
  const cached = apiKeyCache.get(hash);
  if (cached && cached.expires > Date.now()) return cached.client;
  const { data: client } = await sb().from('clients').select('*').eq('api_key_hash', hash).eq('active', true).maybeSingle();
  if (client) apiKeyCache.set(hash, { client, expires: Date.now() + TTL_MS });
  return client;
}

// ---- Open mode: AUTH_MODE=open disables auth entirely. Every request
// resolves to a shared "public" client. Reversible by unsetting the env var.
const OPEN_MODE = process.env.AUTH_MODE === 'open';
const PUBLIC_EMAIL = 'public@image-blaster.local';
// Cold-start of the Supabase JS client + first auth+query against a freshly-
// connected pooler can take 2–6s in practice (DNS + TLS + Cloudflare cold +
// Supabase pool warm-up). 3s was just barely enough on a good day; bumped to
// 10s so latent edge-of-window cold-starts don't fire the synthetic fallback
// (which can't persist traces). Env var still overrides per-deploy.
const OPEN_MODE_CLIENT_TIMEOUT_MS = parseInt(process.env.OPEN_MODE_CLIENT_TIMEOUT_MS || '10000', 10);
let openModeClient = null;       // resolved value cache
let openModeClientPromise = null; // in-flight promise (only set while a fetch is mid-flight)

async function ensureOpenModeClient() {
  // Fast path: already resolved.
  if (openModeClient) return openModeClient;
  // In-flight: piggyback on the existing call.
  if (openModeClientPromise) return openModeClientPromise;
  // Cold path: kick off a new fetch with a timeout. On failure we DON'T cache
  // the rejected promise — next request gets a fresh attempt rather than
  // awaiting a dead handle forever.
  openModeClientPromise = (async () => {
    const fetchClient = (async () => {
      const { data: existing } = await sb().from('clients').select('*').eq('email', PUBLIC_EMAIL).maybeSingle();
      if (existing) return existing;
      const { data: inserted, error } = await sb().from('clients').insert([{
        token: crypto.randomBytes(24).toString('base64url'),
        name: 'public',
        cartridge: process.env.OPEN_MODE_CARTRIDGE || 'product',
        n_per_title: parseInt(process.env.OPEN_MODE_N || '3', 10),
        monthly_image_quota: parseInt(process.env.OPEN_MODE_QUOTA || '5000', 10),
        email: PUBLIC_EMAIL,
        active: true
      }]).select().single();
      if (error) throw error;
      return inserted;
    })();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ensureOpenModeClient timeout')), OPEN_MODE_CLIENT_TIMEOUT_MS)
    );
    try {
      const c = await Promise.race([fetchClient, timeoutPromise]);
      openModeClient = c;
      return c;
    } catch (e) {
      // Supabase unreachable / rate-limited / pooler-exhausted. Fall back to
      // a synthetic in-memory client so the UI shell still loads. New runs
      // won't persist, but cartridges/static endpoints work and the user
      // sees the funnel chrome instead of a hung page.
      console.warn('[open-mode] Supabase fetch failed, using synthetic fallback:', e.message);
      const fallback = {
        id: 'open-mode-fallback',
        email: PUBLIC_EMAIL,
        name: 'public-fallback',
        cartridge: process.env.OPEN_MODE_CARTRIDGE || 'product',
        n_per_title: parseInt(process.env.OPEN_MODE_N || '3', 10),
        monthly_image_quota: parseInt(process.env.OPEN_MODE_QUOTA || '5000', 10),
        active: true,
        __synthetic: true
      };
      // Don't cache the fallback; next request retries the real Supabase
      // call in case it's recovered.
      return fallback;
    } finally {
      openModeClientPromise = null;
    }
  })();
  return openModeClientPromise;
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.headers['x-access-token']) return req.headers['x-access-token'];
  if (req.query?.token) return req.query.token;
  return null;
}

async function resolveClientByToken(token) {
  const cached = tokenCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.client;
  const client = await findClientByToken(token);
  if (client) tokenCache.set(token, { client, expires: Date.now() + TTL_MS });
  return client;
}

async function resolveClientBySession(sid) {
  const cached = sessionCache.get(sid);
  if (cached && cached.expires > Date.now()) return cached.client;

  const { data: session } = await sb()
    .from('sessions')
    .select('client_id,expires_at')
    .eq('id', sid)
    .maybeSingle();
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await sb().from('sessions').delete().eq('id', sid);
    return null;
  }
  const { data: client } = await sb()
    .from('clients')
    .select('*')
    .eq('id', session.client_id)
    .eq('active', true)
    .maybeSingle();
  if (!client) return null;
  sessionCache.set(sid, { client, expires: Date.now() + TTL_MS });
  return client;
}

function requireClient(req, res, next) {
  (async () => {
    if (OPEN_MODE) {
      try {
        req.client = await ensureOpenModeClient();
        req.authMethod = 'open';
        return next();
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    // Auth resolution order: API key → session cookie → legacy bearer/query token
    const apiKey = req.headers['x-api-key'];
    const sid = !apiKey ? req.cookies?.[COOKIE_NAME] : null;
    const token = (!apiKey && !sid) ? extractToken(req) : null;

    if (!apiKey && !sid && !token) return res.status(401).json({ error: 'not authenticated' });

    try {
      const client = apiKey
        ? await resolveClientByApiKey(apiKey)
        : sid
          ? await resolveClientBySession(sid)
          : await resolveClientByToken(token);
      if (!client) return res.status(401).json({ error: 'invalid or expired' });
      req.client = client;
      req.authMethod = apiKey ? 'api_key' : sid ? 'session' : 'bearer';
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  })();
}

// Gate specifically to UI callers (session cookie). API-key clients get a
// generic 404 — they must use /v1/* which returns a blind surface.
function requireSession(req, res, next) {
  if (req.authMethod === 'api_key') return res.status(404).end();
  next();
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_MASTER_KEY) return res.status(401).json({ error: 'admin key required' });
  next();
}

module.exports = { requireClient, requireAdmin, extractToken, hashApiKey, requireSession };
