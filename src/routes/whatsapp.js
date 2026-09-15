const express = require('express');
const QRCode = require('qrcode');
const whatsapp = require('../services/whatsapp');
const conversations = require('../services/conversations');
const realtime = require('../realtime');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function requireMulti(req, res, next) {
  if (!whatsapp.multiAccount) return res.status(400).json({ error: 'Gestão de números só está disponível com WA_PROVIDER=baileys' });
  next();
}

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Status de todos os números (todos os atendentes podem ver)
router.get('/status', (req, res) => {
  res.json(whatsapp.getStatus());
});

// Cadastra um novo número (a sessão inicia e gera o QR)
router.post('/accounts', requireAdmin, requireMulti, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Informe um nome para o número (ex.: Vendas)' });
    res.status(201).json({ account: await whatsapp.addAccount(name) });
  } catch (err) {
    next(err);
  }
});

router.patch('/accounts/:id', requireAdmin, requireMulti, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!id || !name) return res.status(400).json({ error: 'Dados inválidos' });
    res.json({ account: await whatsapp.renameAccount(id, name) });
  } catch (err) {
    next(err);
  }
});

router.delete('/accounts/:id', requireAdmin, requireMulti, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Número não encontrado' });
    let deleted = 0;
    if (req.query.delete_conversations === '1') deleted = await conversations.deleteByAccount(id);
    await whatsapp.removeAccount(id);
    res.json({ ok: true, deleted_conversations: deleted });
  } catch (err) {
    next(err);
  }
});

// Conversas de números que já foram removidos (ficam sem número associado)
router.get('/orphans', requireAdmin, async (req, res, next) => {
  try {
    res.json({ count: await conversations.countOrphans() });
  } catch (err) {
    next(err);
  }
});

router.delete('/orphans', requireAdmin, async (req, res, next) => {
  try {
    const deleted = await conversations.deleteOrphans();
    realtime.broadcast('conversations:reload', { reason: 'orphans-deleted' });
    res.json({ deleted });
  } catch (err) {
    next(err);
  }
});

// QR code atual como imagem (data URL), só quando aguardando leitura
router.get('/accounts/:id/qr', requireAdmin, requireMulti, async (req, res, next) => {
  try {
    const qr = whatsapp.getQr(parseId(req.params.id));
    if (!qr) return res.status(404).json({ error: 'Nenhum QR code disponível no momento' });
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280, color: { dark: '#000000', light: '#ffffff' } });
    res.json({ qr: dataUrl });
  } catch (err) {
    next(err);
  }
});

router.post('/accounts/:id/logout', requireAdmin, requireMulti, async (req, res, next) => {
  try {
    await whatsapp.logout(parseId(req.params.id));
    res.json(whatsapp.getStatus());
  } catch (err) {
    next(err);
  }
});

router.post('/accounts/:id/reconnect', requireAdmin, requireMulti, async (req, res, next) => {
  try {
    await whatsapp.reconnect(parseId(req.params.id));
    res.json(whatsapp.getStatus());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
