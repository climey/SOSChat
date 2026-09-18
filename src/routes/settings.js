const express = require('express');
const db = require('../db');
const realtime = require('../realtime');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const DEFAULT_KINDS = ['Placa', 'Chassi', 'Motor', 'CRLV', 'CPF', 'CNPJ', 'Telefone', 'Nome completo'];

/** Normaliza a lista de tipos de consulta: texto limpo, sem duplicados (ignorando maiúsculas). */
function normalizeKinds(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const raw of v) {
    if (typeof raw !== 'string') return null;
    const k = raw.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!k) continue;
    if (!out.some((x) => x.toLowerCase() === k.toLowerCase())) out.push(k);
  }
  return out.length >= 1 && out.length <= 20 ? out : null;
}

// Chaves permitidas: validação/normalização de cada uma (devolve null quando inválida)
const KEYS = {
  sla_warn_minutes: (v) => (Number.isInteger(v) && v >= 1 && v <= 1440 ? v : null),
  sla_alert_minutes: (v) => (Number.isInteger(v) && v >= 1 && v <= 1440 ? v : null),
  consultation_kinds: normalizeKinds,
  vehicle_lookup_mode: (v) => (['off', 'suggest', 'auto'].includes(v) ? v : null),
  vehicle_preview_template: (v) => (typeof v === 'string' && v.trim().length >= 10 && v.length <= 1500 ? v.trim() : null),
  vehicle_fix_template: (v) => (typeof v === 'string' && v.trim().length >= 10 && v.length <= 1500 ? v.trim() : null),
  recurrence_occasional_credits: (v) => (Number.isInteger(v) && v >= 1 && v <= 1000 ? v : null),
  recurrence_recurrent_credits: (v) => (Number.isInteger(v) && v >= 1 && v <= 100000 ? v : null),
  recurrence_recurrent_purchases: (v) => (Number.isInteger(v) && v >= 1 && v <= 1000 ? v : null),
  recurrence_recurrent_span_days: (v) => (Number.isInteger(v) && v >= 0 && v <= 3650 ? v : null),
  recurrence_loyal_credits: (v) => (Number.isInteger(v) && v >= 1 && v <= 100000 ? v : null),
  recurrence_loyal_purchases: (v) => (Number.isInteger(v) && v >= 1 && v <= 1000 ? v : null),
  recurrence_loyal_months: (v) => (Number.isInteger(v) && v >= 0 && v <= 120 ? v : null),
  recurrence_inactive_days: (v) => (Number.isInteger(v) && v >= 7 && v <= 3650 ? v : null),
};

function parseValue(key, value) {
  if (key === 'consultation_kinds') {
    try { return normalizeKinds(JSON.parse(value)) || DEFAULT_KINDS; } catch { return DEFAULT_KINDS; }
  }
  return Number.isNaN(Number(value)) ? value : Number(value);
}

async function getAll() {
  const { rows } = await db.query('SELECT key, value FROM app_settings');
  const out = { consultation_kinds: DEFAULT_KINDS, vehicle_lookup_mode: 'suggest', vehicle_preview_template: require('../services/vehicle-lookup').DEFAULT_TEMPLATE, vehicle_fix_template: require('../services/vehicle-lookup').DEFAULT_FIX_TEMPLATE, ...Object.fromEntries(Object.entries(require('../services/recurrence').DEFAULTS).map(([k, v]) => [`recurrence_${k}`, v])) };
  for (const r of rows) out[r.key] = parseValue(r.key, r.value);
  out.vehicle_preview_template_default = require('../services/vehicle-lookup').DEFAULT_TEMPLATE;
  out.vehicle_fix_template_default = require('../services/vehicle-lookup').DEFAULT_FIX_TEMPLATE;
  out.vehicle_sources = require('../services/vehicle-lookup').sourcesStatus();
  return out;
}

/** Lista atual de tipos de consulta (usada pelo serviço de contatos). */
async function consultationKinds(client = db) {
  const { rows } = await client.query(`SELECT value FROM app_settings WHERE key = 'consultation_kinds'`);
  return rows.length ? parseValue('consultation_kinds', rows[0].value) : DEFAULT_KINDS;
}

router.get('/', async (req, res, next) => {
  try { res.json({ settings: await getAll() }); } catch (err) { next(err); }
});

router.put('/', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = [];
    for (const [key, value] of Object.entries(body)) {
      if (!KEYS[key]) return res.status(400).json({ error: `Configuração desconhecida: ${key}` });
      const clean = KEYS[key](value);
      if (clean === null) return res.status(400).json({ error: `Valor inválido para ${key}` });
      updates.push([key, typeof clean === 'object' ? JSON.stringify(clean) : String(clean)]);
    }
    for (const [key, value] of updates) {
      await db.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
      );
    }
    require('../services/recurrence').invalidate();
    const settings = await getAll();
    realtime.broadcast('settings:updated', settings);
    res.json({ settings });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.consultationKinds = consultationKinds;
module.exports.DEFAULT_KINDS = DEFAULT_KINDS;
