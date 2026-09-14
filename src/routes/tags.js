const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validate(body) {
  const name = String(body?.name || '').trim().slice(0, 40);
  const color = String(body?.color || '#E03131').trim();
  if (!name) return { error: 'Nome da tag é obrigatório' };
  if (!COLOR_RE.test(color)) return { error: 'Cor inválida (use #RRGGBB)' };
  return { name, color };
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT t.id, t.name, t.color, COUNT(ct.conversation_id)::int AS usage_count
         FROM tags t LEFT JOIN conversation_tags ct ON ct.tag_id = t.id
        GROUP BY t.id, t.name, t.color ORDER BY t.name`
    );
    res.json({ tags: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { rows } = await db.query(
      'INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING id, name, color',
      [v.name, v.color]
    );
    res.status(201).json({ tag: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma tag com esse nome' });
    next(err);
  }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { rows } = await db.query(
      'UPDATE tags SET name = $2, color = $3 WHERE id = $1 RETURNING id, name, color',
      [id, v.name, v.color]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tag não encontrada' });
    res.json({ tag: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma tag com esse nome' });
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const r = await db.query('DELETE FROM tags WHERE id = $1', [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Tag não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
