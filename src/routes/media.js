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
    const { rows } = await db.query('SELECT media_mime FROM messages WHERE media_id = $1 LIMIT 1', [mediaId]);
    if (!rows.length) return res.status(404).json({ error: 'Mídia não encontrada' });
    const { stream, mimeType, size } = await whatsapp.fetchMedia(mediaId);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (size) res.setHeader('Content-Length', size);
    Readable.fromWeb(stream).pipe(res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
