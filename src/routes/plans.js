const express = require('express');
const db = require('../db');
const realtime = require('../realtime');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const COLS = `p.id, p.name, p.credits, p.validity_days, p.price_cents, p.active, p.created_at,
  (SELECT COUNT(*)::int FROM contacts ct WHERE ct.plan_id = p.id AND ct.plan_credits IS NOT NULL) AS contacts_count`;

function parseId(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }

function validate(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = String(body.name || '').trim().slice(0, 80);
    if (!out.name) return { error: 'Informe o nome do plano' };
  }
  if (!partial || body.credits !== undefined) {
    out.credits = Number(body.credits);
    if (!Number.isInteger(out.credits) || out.credits < 0 || out.credits > 10000) return { error: 'Quantidade de consultas inválida' };
  }
  if (body.validity_days !== undefined) {
    out.validity_days = body.validity_days === null || body.validity_days === '' ? null : Number(body.validity_days);
    if (out.validity_days !== null && (!Number.isInteger(out.validity_days) || out.validity_days <= 0)) return { error: 'Validade em dias inválida' };
  }
  if (body.price_cents !== undefined) {
    out.price_cents = body.price_cents === null || body.price_cents === '' ? null : Math.round(Number(body.price_cents));
    if (out.price_cents !== null && (!Number.isFinite(out.price_cents) || out.price_cents < 0)) return { error: 'Preço inválido' };
  }
  if (body.active !== undefined) out.active = Boolean(body.active);
  return { values: out };
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT ${COLS} FROM plans p ORDER BY p.active DESC, p.credits, p.name`);
    res.json({ plans: rows });
  } catch (err) { next(err); }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const v = validate(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const { name, credits, validity_days = null, price_cents = null, active = true } = v.values;
    const { rows } = await db.query(
      `WITH ins AS (INSERT INTO plans (name, credits, validity_days, price_cents, active) VALUES ($1, $2, $3, $4, $5) RETURNING *)
       SELECT ${COLS} FROM ins p`,
      [name, credits, validity_days, price_cents, active]
    );
    realtime.broadcast('plans:updated', {});
    res.status(201).json({ plan: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um plano com esse nome' });
    next(err);
  }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Plano não encontrado' });
    const v = validate(req.body || {}, true);
    if (v.error) return res.status(400).json({ error: v.error });
    const entries = Object.entries(v.values);
    if (!entries.length) return res.status(400).json({ error: 'Nada para atualizar' });
    const params = [id];
    const sets = entries.map(([k, val]) => { params.push(val); return `${k} = $${params.length}`; });
    const { rows } = await db.query(`WITH up AS (UPDATE plans SET ${sets.join(', ')} WHERE id = $1 RETURNING *) SELECT ${COLS} FROM up p`, params);
    if (!rows.length) return res.status(404).json({ error: 'Plano não encontrado' });
    realtime.broadcast('plans:updated', {});
    res.json({ plan: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um plano com esse nome' });
    next(err);
  }
});

// Contatos que já têm o plano continuam com o saldo (snapshot); só o catálogo perde a opção.
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Plano não encontrado' });
    const r = await db.query('DELETE FROM plans WHERE id = $1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Plano não encontrado' });
    realtime.broadcast('plans:updated', {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
