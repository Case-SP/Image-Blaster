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
let openModeClientPromise = null;

async function ensureOpenModeClient() {
  if (openModeClientPromise) return openModeClientPromise;
  openModeClientPromise = (async () => {
    const { data: existing } = await sb().from('clients').select('*').eq('email', PUBLIC_EMAIL).maybeSingle();
    if (existing) return existing;
    const { data: inserted, error } = await sb().from('clients').insert([{
      token: crypto.randomBytes(24).toString('base64url'),
      name: 'public',
      cartridge: process.env.OPEN_MODE_CARTRIDGE || 'nolla',
      n_per_title: parseInt(process.env.OPEN_MODE_N || '3', 10),
      monthly_image_quota: parseInt(process.env.OPEN_MODE_QUOTA || '5000', 10),
      email: PUBLIC_EMAIL,
      active: true
    }]).select().single();
    if (error) throw error;
    return inserted;
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

module.exports = { requireClient, requireAdmin, extractToken, hashApiKey };
