const express = require('express');
const db = require('../db');
const realtime = require('../realtime');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Chaves permitidas e validação de cada uma
const KEYS = {
  sla_warn_minutes: (v) => Number.isInteger(v) && v >= 1 && v <= 1440,
  sla_alert_minutes: (v) => Number.isInteger(v) && v >= 1 && v <= 1440,
};

async function getAll() {
  const { rows } = await db.query('SELECT key, value FROM app_settings');
  const out = {};
  for (const r of rows) out[r.key] = Number.isNaN(Number(r.value)) ? r.value : Number(r.value);
  return out;
}

router.get('/', async (req, res, next) => {
  try { res.json({ settings: await getAll() }); } catch (err) { next(err); }
});

router.put('/', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    for (const [key, value] of Object.entries(body)) {
      if (!KEYS[key]) return res.status(400).json({ error: `Configuração desconhecida: ${key}` });
      if (!KEYS[key](value)) return res.status(400).json({ error: `Valor inválido para ${key}` });
      await db.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, String(value)]
      );
    }
    const settings = await getAll();
    realtime.broadcast('settings:updated', settings);
    res.json({ settings });
  } catch (err) { next(err); }
});

module.exports = router;
