require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const v1Routes = require('./routes/v1');
const { router: authRoutes, redeemGrant, cookieOpts, COOKIE_NAME } = require('./routes/auth');

const app = express();
app.set('trust proxy', 1); // Railway terminates TLS upstream; honor X-Forwarded-* for req.protocol/req.ip
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
const PORT = parseInt(process.env.PORT || '3002', 10);

// ---- Auth ----
app.use('/api/auth', authRoutes);

// ---- Public API (UI-facing) ----
app.use('/api/public', publicRoutes);

// ---- v1 API (programmatic, X-API-Key header) ----
app.use('/v1', v1Routes);

// ---- Admin API ----
app.use('/api/admin', adminRoutes);

// ---- Invite shortener: /i/<code> → / with ?invite=<code> ----
app.get('/i/:code', (req, res) => {
  const code = encodeURIComponent(req.params.code);
  res.redirect(302, `/?invite=${code}`);
});

// ---- One-time access grant: /a/<token> → session cookie + redirect home ----
app.get('/a/:token', async (req, res) => {
  try {
    const { sid } = await redeemGrant({
      token: req.params.token,
      userAgent: req.headers['user-agent']
    });
    res.cookie(COOKIE_NAME, sid, cookieOpts());
    res.redirect(302, '/');
  } catch (e) {
    const status = e.status || 500;
    console.error('[access-link]', e.message);
    res.status(status).send(
      `<!doctype html><meta charset="utf-8"><title>Access</title>` +
      `<body style="font-family:system-ui;padding:2rem;max-width:420px">` +
      `<p>${e.message}</p><p><a href="/">Back to sign-in</a></p></body>`
    );
  }
});

// ---- Client UI (primary: served at root; /client kept for backward compat) ----
app.use('/client', express.static(path.join(__dirname, '../ui-client')));
app.use('/', express.static(path.join(__dirname, '../ui-client')));

// Silence browser favicon requests
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Root is served by the static middleware above (ui-client/index.html)

app.listen(PORT, () => console.log(`Recast live at http://localhost:${PORT}`));
