const express = require('express');
const multer = require('multer');
const db = require('../db');
const realtime = require('../realtime');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MEDIA_MAX_BYTES = 16 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_MAX_BYTES, files: 1 } });

const COLS = `q.id, q.shortcut, q.title, q.body, q.visibility, q.created_by, q.media_id, q.media_mime, q.media_name, q.media_size, q.media_kind,
  q.created_at, q.updated_at, u.name AS created_by_name`;

/** Classifica o arquivo do jeito que o WhatsApp espera (o resto vai como documento). */
function mediaKind(mimetype = '') {
  if (['image/jpeg', 'image/png'].includes(mimetype)) return 'image';
  if (['video/mp4', 'video/3gpp'].includes(mimetype)) return 'video';
  if (['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/amr', 'audio/x-m4a'].includes(mimetype)) return 'audio';
  return 'document';
}

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

function validate(body, { requireText = true } = {}) {
  const shortcut = String(body?.shortcut || '').trim().toLowerCase().replace(/^\//, '').slice(0, 30);
  const title = String(body?.title || '').trim().slice(0, 80);
  const text = String(body?.body || '').trim().slice(0, 4096);
  const visibility = body?.visibility === 'personal' ? 'personal' : 'team';
  if (!/^[a-z0-9_-]+$/.test(shortcut)) return { error: 'Atalho: use só letras, números, - ou _ (ex.: prazo)' };
  if (!title) return { error: 'Informe um título' };
  if (requireText && !text) return { error: 'Escreva o texto da resposta ou anexe uma mídia' };
  return { shortcut, title, body: text || null, visibility };
}

function duplicateError(visibility) {
  return visibility === 'personal'
    ? 'Você já tem uma resposta com esse atalho'
    : 'Já existe uma resposta da equipe com esse atalho';
}

/** Cada atendente vê as respostas da equipe e as próprias; o admin vê as dele e as da equipe também. */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${COLS} FROM quick_replies q LEFT JOIN users u ON u.id = q.created_by
        WHERE q.visibility = 'team' OR q.created_by = $1
        ORDER BY q.visibility, q.shortcut`,
      [req.user.id]
    );
    res.json({ quick_replies: rows });
  } catch (err) { next(err); }
});

async function load(id) {
  const { rows } = await db.query(`SELECT ${COLS} FROM quick_replies q LEFT JOIN users u ON u.id = q.created_by WHERE q.id = $1`, [id]);
  return rows[0] || null;
}

/**
 * Quem pode mexer: o dono sempre; o admin nas da equipe.
 * As pessoais de outro atendente ficam invisíveis para todos, inclusive para o admin.
 */
function canEdit(reply, user) {
  if (!reply) return false;
  if (reply.visibility === 'personal') return reply.created_by === user.id;
  return user.role === 'admin' || reply.created_by === user.id;
}

function notify() { realtime.broadcast('quick-replies:updated', {}); }

router.post('/', async (req, res, next) => {
  try {
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { rows } = await db.query(
      'INSERT INTO quick_replies (shortcut, title, body, visibility, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [v.shortcut, v.title, v.body, v.visibility, req.user.id]
    );
    notify();
    res.status(201).json({ quick_reply: await load(rows[0].id) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: duplicateError(req.body?.visibility) });
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const current = id ? await load(id) : null;
    if (!current) return res.status(404).json({ error: 'Resposta não encontrada' });
    if (!canEdit(current, req.user)) return res.status(403).json({ error: 'Só quem criou (ou um admin) pode editar esta resposta' });
    const v = validate(req.body, { requireText: !current.media_id });
    if (v.error) return res.status(400).json({ error: v.error });
    await db.query(
      'UPDATE quick_replies SET shortcut = $2, title = $3, body = $4, visibility = $5, updated_at = NOW() WHERE id = $1',
      [id, v.shortcut, v.title, v.body, v.visibility]
    );
    notify();
    res.json({ quick_reply: await load(id) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: duplicateError(req.body?.visibility) });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const current = id ? await load(id) : null;
    if (!current) return res.status(404).json({ error: 'Resposta não encontrada' });
    if (!canEdit(current, req.user)) return res.status(403).json({ error: 'Só quem criou (ou um admin) pode excluir esta resposta' });
    await db.query('DELETE FROM quick_replies WHERE id = $1', [id]);
    if (current.media_id) await db.query('DELETE FROM media_files WHERE id = $1', [current.media_id]);
    notify();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- Mídia anexada ----------
router.post('/:id/media', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo acima de 16 MB' : err.message });
  });
}, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const current = id ? await load(id) : null;
    if (!current) return res.status(404).json({ error: 'Resposta não encontrada' });
    if (!canEdit(current, req.user)) return res.status(403).json({ error: 'Só quem criou (ou um admin) pode alterar esta resposta' });
    const file = req.file;
    if (!file || !file.buffer?.length) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const mediaId = `qr-${id}-${Date.now().toString(36)}`;
    const kind = mediaKind(file.mimetype);
    const name = String(file.originalname || 'arquivo').slice(0, 200);
    await db.query('INSERT INTO media_files (id, mime, size, data) VALUES ($1, $2, $3, $4)', [mediaId, file.mimetype || 'application/octet-stream', file.buffer.length, file.buffer]);
    await db.query(
      'UPDATE quick_replies SET media_id = $2, media_mime = $3, media_name = $4, media_size = $5, media_kind = $6, updated_at = NOW() WHERE id = $1',
      [id, mediaId, file.mimetype || null, name, file.buffer.length, kind]
    );
    if (current.media_id) await db.query('DELETE FROM media_files WHERE id = $1', [current.media_id]);
    notify();
    res.status(201).json({ quick_reply: await load(id) });
  } catch (err) { next(err); }
});

router.delete('/:id/media', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const current = id ? await load(id) : null;
    if (!current) return res.status(404).json({ error: 'Resposta não encontrada' });
    if (!canEdit(current, req.user)) return res.status(403).json({ error: 'Só quem criou (ou um admin) pode alterar esta resposta' });
    if (!current.media_id) return res.status(400).json({ error: 'Esta resposta não tem mídia' });
    if (!current.body) return res.status(400).json({ error: 'Escreva um texto antes de remover a mídia' });
    await db.query('UPDATE quick_replies SET media_id = NULL, media_mime = NULL, media_name = NULL, media_size = NULL, media_kind = NULL, updated_at = NOW() WHERE id = $1', [id]);
    await db.query('DELETE FROM media_files WHERE id = $1', [current.media_id]);
    notify();
    res.json({ quick_reply: await load(id) });
  } catch (err) { next(err); }
});

module.exports = router;
