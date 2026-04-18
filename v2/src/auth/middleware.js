const { findClientByToken, sb } = require('../db/supabase');

const COOKIE_NAME = 'sid';

// In-memory cache (5 min TTL) — avoids hitting DB on every request
const tokenCache = new Map();
const sessionCache = new Map();
const TTL_MS = 5 * 60 * 1000;

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
    // Prefer session cookie (browser) → fallback to Bearer token (API)
    const sid = req.cookies?.[COOKIE_NAME];
    const token = !sid ? extractToken(req) : null;

    if (!sid && !token) return res.status(401).json({ error: 'not authenticated' });

    try {
      const client = sid ? await resolveClientBySession(sid) : await resolveClientByToken(token);
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

module.exports = { requireClient, requireAdmin, extractToken };
