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
    if (!from || !text) return res.status(400).json({ error: 'Informe from e text' });
    const msg = {
      id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: text },
    };
    const accountId = Number(req.body?.account_id) || whatsapp.pickAccount() || null;
    const result = await inbound.handleInboundMessage(msg, name ? { profile: { name } } : {}, accountId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
