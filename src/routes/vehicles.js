const express = require('express');
const vehicles = require('../services/vehicle-lookup');
const outbound = require('../services/outbound');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** Dados básicos do veículo pela placa (cache de 30 dias). ?conversation=ID informa se a confirmação já foi enviada. */
router.get('/:plate', async (req, res, next) => {
  try {
    const result = await vehicles.lookup(req.params.plate, { force: req.query.force === '1' });
    if (result.status === 'invalid') return res.status(400).json({ error: result.error });
    const { template, mode } = await vehicles.settings();
    const convId = parseId(req.query.conversation);
    res.json({
      ...result,
      mode,
      message: result.status === 'found' ? vehicles.renderMessage(template, result.plate, result.data) : null,
      sent_at: convId ? await vehicles.previewSentAt(convId, result.plate) : null,
    });
  } catch (err) { next(err); }
});

/** Envia ao cliente a mensagem de confirmação do veículo. body: { conversation_id } */
router.post('/:plate/send', async (req, res, next) => {
  try {
    const convId = parseId(req.body?.conversation_id);
    if (!convId) return res.status(400).json({ error: 'Informe a conversa' });
    const out = await vehicles.sendPreview(convId, req.params.plate, req.user);
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof outbound.SendError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
