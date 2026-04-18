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
