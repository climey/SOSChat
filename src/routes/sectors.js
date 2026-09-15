const express = require('express');
const db = require('../db');
const realtime = require('../realtime');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function validate(body) {
  const name = String(body?.name || '').trim().slice(0, 40);
  const color = String(body?.color || '#868e96').trim();
  if (!name) return { error: 'Nome do setor é obrigatório' };
  if (!COLOR_RE.test(color)) return { error: 'Cor inválida (use #RRGGBB)' };
  return { name, color };
}
const SELECT = `SELECT s.id, s.name, s.color, s.is_default,
                       (SELECT COUNT(*)::int FROM conversations c WHERE c.sector_id = s.id AND c.status = 'open') AS open_count
                  FROM sectors s ORDER BY s.is_default DESC, s.name`;

router.get('/', async (req, res, next) => {
  try { res.json({ sectors: (await db.query(SELECT)).rows }); } catch (err) { next(err); }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { rows } = await db.query('INSERT INTO sectors (name, color) VALUES ($1, $2) RETURNING id, name, color, is_default', [v.name, v.color]);
    realtime.broadcast('sectors:updated', {});
    res.status(201).json({ sector: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um setor com esse nome' });
    next(err);
  }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const sets = [];
    const params = [id];
    if (req.body?.name !== undefined || req.body?.color !== undefined) {
      const cur = (await db.query('SELECT name, color FROM sectors WHERE id = $1', [id])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Setor não encontrado' });
      const v = validate({ name: req.body.name ?? cur.name, color: req.body.color ?? cur.color });
      if (v.error) return res.status(400).json({ error: v.error });
      params.push(v.name, v.color);
      sets.push(`name = $${params.length - 1}`, `color = $${params.length}`);
    }
    if (req.body?.is_default === true) {
      await db.query('UPDATE sectors SET is_default = FALSE');
      sets.push('is_default = TRUE');
    }
    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
    const { rows } = await db.query(`UPDATE sectors SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, color, is_default`, params);
    if (!rows.length) return res.status(404).json({ error: 'Setor não encontrado' });
    realtime.broadcast('sectors:updated', {});
    res.json({ sector: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um setor com esse nome' });
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query('SELECT is_default FROM sectors WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Setor não encontrado' });
    if (rows[0].is_default) return res.status(400).json({ error: 'O setor padrão não pode ser excluído. Defina outro como padrão antes.' });
    // Conversas do setor excluído voltam para o padrão
    await db.query('UPDATE conversations SET sector_id = (SELECT id FROM sectors WHERE is_default LIMIT 1) WHERE sector_id = $1', [id]);
    await db.query('DELETE FROM sectors WHERE id = $1', [id]);
    realtime.broadcast('sectors:updated', {});
    realtime.broadcast('conversations:reload', { reason: 'sector-deleted' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
