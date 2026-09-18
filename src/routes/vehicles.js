const express = require('express');
const vehicles = require('../services/vehicle-lookup');
const outbound = require('../services/outbound');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const parseKind = (v) => (v === 'chassi' || v === 'placa' ? v : null);

/**
 * Dados básicos do veículo pela placa ou pelo chassi (cache de 30 dias). O tipo é deduzido pelo
 * tamanho (7 = placa, 17 = chassi) ou informado em ?kind=. ?conversation=ID diz se a confirmação já foi enviada.
 */
router.get('/:ref', async (req, res, next) => {
  try {
    const result = await vehicles.lookup(req.params.ref, { force: req.query.force === '1', kind: parseKind(req.query.kind) });
    if (result.status === 'invalid') return res.status(400).json({ error: result.error });
    const { template, mode } = await vehicles.settings();
    const convId = parseId(req.query.conversation);
    res.json({
      ...result,
      mode,
      message: result.status === 'found' ? vehicles.renderMessage(template, result.ref, result.data, result.kind) : null,
      sent_at: convId ? await vehicles.previewSentAt(convId, result.ref, result.kind) : null,
    });
  } catch (err) { next(err); }
});

/**
 * Conferência + pré-consulta: valida o dado, busca no site e, se não existir, testa as correções prováveis.
 * Cada resultado encontrado vem com a mensagem pronta e se já foi enviada nesta conversa.
 */
router.get('/:ref/resolve', async (req, res, next) => {
  try {
    const result = await vehicles.resolve(req.params.ref, { force: req.query.force === '1', kind: parseKind(req.query.kind) });
    const { template, fixTemplate, mode } = await vehicles.settings();
    const convId = parseId(req.query.conversation);
    const decorate = async (lk, original) => ({
      ...lk,
      message: lk.status === 'found' ? vehicles.renderMessage(original ? fixTemplate : template, lk.ref, lk.data, result.kind, { original }) : null,
      sent_at: convId ? await vehicles.previewSentAt(convId, lk.ref, result.kind) : null,
    });
    res.json({
      ...result,
      mode,
      lookup: result.lookup ? await decorate(result.lookup, null) : null,
      alternatives: await Promise.all(result.alternatives.map((a) => decorate(a, result.ref))),
    });
  } catch (err) { next(err); }
});

/** Envia ao cliente a mensagem de confirmação do veículo. body: { conversation_id, kind?, original? } */
router.post('/:ref/send', async (req, res, next) => {
  try {
    const convId = parseId(req.body?.conversation_id);
    if (!convId) return res.status(400).json({ error: 'Informe a conversa' });
    const original = typeof req.body?.original === 'string' ? req.body.original.slice(0, 30) : null;
    const out = await vehicles.sendPreview(convId, req.params.ref, req.user, { kind: parseKind(req.body?.kind), original });
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof outbound.SendError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
