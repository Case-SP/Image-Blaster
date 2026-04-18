const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sb } = require('../db/supabase');

const router = express.Router();

// Anon-key client used ONLY for OTP send/verify (Supabase Auth doesn't need service key for these).
// We still use the service key for everything else via `sb()`.
function supabaseAnon() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

const SESSION_TTL_DAYS = 30;
const COOKIE_NAME = 'sid';

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function newSessionId() {
  return crypto.randomBytes(36).toString('base64url');
}

function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/'
  };
}

// POST /api/auth/request-code — send OTP via Supabase Auth (email)
router.post('/request-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'email required' });

    // Gate: only provisioned emails can request a code (prevents drive-by enumeration)
    const { data: client } = await sb().from('clients').select('id').eq('email', email).eq('active', true).maybeSingle();
    if (!client) {
      // Return 200 anyway to avoid email enumeration; log server-side
      console.log('[auth] rejected code request for un-provisioned email:', email);
      return res.json({ sent: true });
    }

    const { error } = await supabaseAnon().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true }
    });
    if (error) throw error;
    res.json({ sent: true });
  } catch (e) {
    console.error('[auth request-code]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/verify-code — verify OTP, issue our own session cookie
router.post('/verify-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (!email || !code) return res.status(400).json({ error: 'email and code required' });

    // Try 'email' first (returning user), fall back to 'signup' (first-time)
    // and 'magiclink' (if Supabase classified it that way).
    let verified = null;
    let lastError = null;
    for (const type of ['email', 'signup', 'magiclink']) {
      const { data, error } = await supabaseAnon().auth.verifyOtp({ email, token: code, type });
      if (!error && data?.user) { verified = data; break; }
      lastError = error;
    }
    if (!verified) {
      console.log('[auth verify-code] OTP rejected for', email, '-', lastError?.message);
      return res.status(401).json({ error: 'invalid or expired code' });
    }

    // Look up our client record by email
    const { data: client } = await sb()
      .from('clients')
      .select('*')
      .eq('email', email)
      .eq('active', true)
      .maybeSingle();
    if (!client) return res.status(403).json({ error: 'not provisioned' });

    // Create our own session row
    const sid = newSessionId();
    const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const { error: sErr } = await sb().from('sessions').insert([{
      id: sid,
      client_id: client.id,
      expires_at: expires.toISOString(),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 500)
    }]);
    if (sErr) throw sErr;

    res.cookie(COOKIE_NAME, sid, cookieOpts());
    res.json({
      ok: true,
      client: { name: client.name, cartridge: client.cartridge, n_per_title: client.n_per_title }
    });
  } catch (e) {
    console.error('[auth verify-code]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/logout — delete session + clear cookie
router.post('/logout', async (req, res) => {
  try {
    const sid = req.cookies?.[COOKIE_NAME];
    if (sid) await sb().from('sessions').delete().eq('id', sid);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/me — return current session's client, or 401
router.get('/me', async (req, res) => {
  try {
    const sid = req.cookies?.[COOKIE_NAME];
    if (!sid) return res.status(401).json({ error: 'not signed in' });
    const { data: session } = await sb()
      .from('sessions')
      .select('client_id,expires_at')
      .eq('id', sid)
      .maybeSingle();
    if (!session) return res.status(401).json({ error: 'session not found' });
    if (new Date(session.expires_at) < new Date()) {
      await sb().from('sessions').delete().eq('id', sid);
      return res.status(401).json({ error: 'session expired' });
    }
    const { data: client } = await sb().from('clients').select('name,cartridge,n_per_title,active').eq('id', session.client_id).maybeSingle();
    if (!client?.active) return res.status(401).json({ error: 'client inactive' });
    await sb().from('sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', sid);
    res.json({ name: client.name, cartridge: client.cartridge, n_per_title: client.n_per_title });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, COOKIE_NAME };
