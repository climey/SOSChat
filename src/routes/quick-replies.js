const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function validate(body) {
  const shortcut = String(body?.shortcut || '').trim().toLowerCase().replace(/^\//, '').slice(0, 30);
  const title = String(body?.title || '').trim().slice(0, 80);
  const text = String(body?.body || '').trim().slice(0, 4096);
  if (!/^[a-z0-9_-]+$/.test(shortcut)) return { error: 'Atalho: use só letras, números, - ou _ (ex.: prazo)' };
  if (!title) return { error: 'Informe um título' };
  if (!text) return { error: 'Escreva o texto da resposta' };
  return { shortcut, title, body: text };
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT q.id, q.shortcut, q.title, q.body, q.created_by, u.name AS created_by_name
         FROM quick_replies q LEFT JOIN users u ON u.id = q.created_by ORDER BY q.shortcut`
    );
    res.json({ quick_replies: rows });
  } catch (err) { next(err); }
});

/** Qualquer atendente cria; edita e exclui só quem criou (ou admin). */
async function canEdit(req, id) {
  if (req.user.role === 'admin') return true;
  const { rows } = await db.query('SELECT created_by FROM quick_replies WHERE id = $1', [id]);
  return rows.length > 0 && rows[0].created_by === req.user.id;
}

router.post('/', async (req, res, next) => {
  try {
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { rows } = await db.query(
      'INSERT INTO quick_replies (shortcut, title, body, created_by) VALUES ($1, $2, $3, $4) RETURNING id, shortcut, title, body',
      [v.shortcut, v.title, v.body, req.user.id]
    );
    res.status(201).json({ quick_reply: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma resposta com esse atalho' });
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    if (!(await canEdit(req, Number(req.params.id)))) return res.status(403).json({ error: 'Só quem criou (ou um admin) pode editar esta resposta' });
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { rows } = await db.query(
      'UPDATE quick_replies SET shortcut = $2, title = $3, body = $4 WHERE id = $1 RETURNING id, shortcut, title, body',
      [Number(req.params.id), v.shortcut, v.title, v.body]
    );
    if (!rows.length) return res.status(404).json({ error: 'Resposta não encontrada' });
    res.json({ quick_reply: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma resposta com esse atalho' });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!(await canEdit(req, Number(req.params.id)))) return res.status(403).json({ error: 'Só quem criou (ou um admin) pode excluir esta resposta' });
    const r = await db.query('DELETE FROM quick_replies WHERE id = $1', [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Resposta não encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
