const express = require('express');
const { Readable } = require('stream');
const db = require('../db');
const whatsapp = require('../services/whatsapp');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Proxy de mídia: só serve IDs que existem em mensagens recebidas
router.get('/:mediaId', async (req, res, next) => {
  try {
    const mediaId = String(req.params.mediaId);
    if (!/^[\w.-]+$/.test(mediaId)) return res.status(400).json({ error: 'ID inválido' });
    // Só serve IDs referenciados por uma mensagem ou por uma foto de perfil
    const { rows } = await db.query(
      `SELECT 1 FROM messages WHERE media_id = $1 UNION ALL SELECT 1 FROM contacts WHERE avatar_media_id = $1 LIMIT 1`,
      [mediaId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Mídia não encontrada' });
    const media = await whatsapp.fetchMedia(mediaId);
    res.setHeader('Content-Type', media.mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (media.size) res.setHeader('Content-Length', media.size);
    if (media.buffer) return res.end(media.buffer);
    Readable.fromWeb(media.stream).pipe(res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
