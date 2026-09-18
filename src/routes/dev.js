const express = require('express');
const inbound = require('../services/inbound');
const whatsapp = require('../services/whatsapp');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/**
 * Simula uma mensagem recebida do WhatsApp (apenas fora de produção).
 * POST /api/dev/simulate-inbound { from: "5511999999999", name: "Cliente", text: "Olá" }
 */
router.post('/simulate-inbound', async (req, res, next) => {
  try {
    const from = String(req.body?.from || '').replace(/\D/g, '');
    const text = String(req.body?.text || '').trim();
    const name = String(req.body?.name || '').trim() || undefined;
    const image = typeof req.body?.image_base64 === 'string' ? req.body.image_base64 : null;
    if (!from || (!text && !image)) return res.status(400).json({ error: 'Informe from e text (ou image_base64)' });
    const id = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let msg = { id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } };
    if (image) {
      // foto simulada: guarda o arquivo como as mídias recebidas pelo Baileys
      const mime = String(req.body?.mime || 'image/jpeg');
      const buf = Buffer.from(image, 'base64');
      const mediaId = `sim-img-${Date.now()}`;
      await require('../db').query('INSERT INTO media_files (id, mime, size, data) VALUES ($1, $2, $3, $4)', [mediaId, mime, buf.length, buf]);
      msg = { id, from, timestamp: msg.timestamp, type: 'image', image: { id: mediaId, mime_type: mime, caption: text || undefined } };
    }
    const accountId = Number(req.body?.account_id) || whatsapp.pickAccount() || null;
    const result = await inbound.handleInboundMessage(msg, name ? { profile: { name } } : {}, accountId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
