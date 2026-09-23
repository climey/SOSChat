const express = require('express');
const reader = require('../services/image-reader');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
/** Atendente vê só o motivo em linguagem simples; administrador vê também o erro técnico da API. */
function forUser(rd, user) {
  if (!rd) return rd;
  const { usage, ...rest } = rd;
  if (user.role === 'admin') return { ...rest, usage, detail: usage && usage.error ? `${usage.status ? usage.status + ' ' : ''}${usage.error}` : null };
  return rest;
}

/** Leituras de fotos de uma conversa. ?conversation=ID */
router.get('/', async (req, res, next) => {
  try {
    const convId = parseId(req.query.conversation);
    if (!convId) return res.status(400).json({ error: 'Informe a conversa' });
    res.json({ readings: (await reader.listForConversation(convId)).map((r) => forUser(r, req.user)) });
  } catch (err) { next(err); }
});

/** Lê (ou relê) a foto de uma mensagem. */
router.post('/:messageId', async (req, res, next) => {
  try {
    const id = parseId(req.params.messageId);
    if (!id) return res.status(400).json({ error: 'Mensagem inválida' });
    const reading = await reader.read(id, { force: true, requestedBy: req.user.id });
    res.status(201).json({ reading: forUser(reading, req.user) });
  } catch (err) {
    if (err instanceof reader.ReadError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
