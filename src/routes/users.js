const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const realtime = require('../realtime');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

// Lista de atendentes (todos podem ver, para atribuir conversas), com presença
router.get('/', async (req, res, next) => {
  try {
    const includeInactive = req.user.role === 'admin' && req.query.all === '1';
    const { rows } = await db.query(
      `SELECT id, name, email, role, active, availability, avatar_media_id, created_at FROM users
        ${includeInactive ? '' : 'WHERE active = TRUE'} ORDER BY name`
    );
    res.json({ users: rows.map((u) => ({ ...u, online: realtime.isOnline(u.id) })) });
  } catch (err) {
    next(err);
  }
});

// Foto de perfil (própria; admin pode definir a de qualquer atendente). multipart: file (imagem até 2 MB)
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
async function setAvatar(req, res, next, targetId) {
  try {
    const file = req.file;
    if (!file || !file.buffer?.length) return res.status(400).json({ error: 'Envie uma imagem' });
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return res.status(400).json({ error: 'Use JPG, PNG ou WebP' });
    const mediaId = `uavatar-${targetId}`;
    await db.query(
      `INSERT INTO media_files (id, mime, size, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET mime = EXCLUDED.mime, size = EXCLUDED.size, data = EXCLUDED.data, created_at = NOW()`,
      [mediaId, file.mimetype, file.size, file.buffer]
    );
    // Sufixo de versão para o navegador não usar a foto antiga em cache
    const versioned = `${mediaId}`;
    const { rows } = await db.query('UPDATE users SET avatar_media_id = $2 WHERE id = $1 RETURNING id, name, avatar_media_id', [targetId, versioned]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    realtime.broadcast('user:avatar', { user_id: targetId, avatar_media_id: mediaId, version: Date.now() });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
}
function multerImage(req, res, next) {
  avatarUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Imagem acima de 2 MB' : err.message });
  });
}
router.post('/me/avatar', multerImage, (req, res, next) => setAvatar(req, res, next, req.user.id));
router.post('/:id/avatar', requireAdmin, multerImage, (req, res, next) => setAvatar(req, res, next, Number(req.params.id)));
router.delete('/me/avatar', async (req, res, next) => {
  try {
    await db.query('UPDATE users SET avatar_media_id = NULL WHERE id = $1', [req.user.id]);
    await db.query('DELETE FROM media_files WHERE id = $1', [`uavatar-${req.user.id}`]);
    realtime.broadcast('user:avatar', { user_id: req.user.id, avatar_media_id: null });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Status manual do próprio atendente: available | away
router.patch('/me/availability', async (req, res, next) => {
  try {
    const availability = req.body?.availability === 'away' ? 'away' : 'available';
    await db.query('UPDATE users SET availability = $2 WHERE id = $1', [req.user.id, availability]);
    realtime.broadcast('presence', { user_id: req.user.id, online: realtime.isOnline(req.user.id), availability });
    res.json({ availability });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = req.body?.role === 'admin' ? 'admin' : 'agent';
    if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Nome e e-mail válidos são obrigatórios' });
    if (password.length < 8) return res.status(400).json({ error: 'Senha deve ter no mínimo 8 caracteres' });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, active, created_at`,
      [name, email, hash, role]
    );
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'E-mail já cadastrado' });
    next(err);
  }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const sets = [];
    const params = [id];
    const b = req.body || {};

    if (b.name !== undefined) {
      const name = String(b.name).trim().slice(0, 120);
      if (!name) return res.status(400).json({ error: 'Nome inválido' });
      params.push(name); sets.push(`name = $${params.length}`);
    }
    if (b.role !== undefined) {
      if (!['admin', 'agent'].includes(b.role)) return res.status(400).json({ error: 'Perfil inválido' });
      if (id === req.user.id && b.role !== 'admin') return res.status(400).json({ error: 'Você não pode remover seu próprio acesso de admin' });
      params.push(b.role); sets.push(`role = $${params.length}`);
    }
    if (b.active !== undefined) {
      if (id === req.user.id && !b.active) return res.status(400).json({ error: 'Você não pode desativar a si mesmo' });
      params.push(Boolean(b.active)); sets.push(`active = $${params.length}`);
    }
    if (b.password !== undefined) {
      const pw = String(b.password);
      if (pw.length < 8) return res.status(400).json({ error: 'Senha deve ter no mínimo 8 caracteres' });
      params.push(await bcrypt.hash(pw, 12)); sets.push(`password_hash = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });

    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, email, role, active, created_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
