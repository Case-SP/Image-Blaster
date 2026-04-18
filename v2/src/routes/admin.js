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
