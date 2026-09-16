const express = require('express');
const db = require('../db');
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
    if (!id) return res.status(404).json({ error: 'Número não encontrado' });
    const body = req.body || {};
    let account = null;
    if (body.name !== undefined) {
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'Informe o nome do número' });
      account = await whatsapp.renameAccount(id, name);
    }
    if (body.auto_tag_id !== undefined) {
      const tagId = body.auto_tag_id === null || body.auto_tag_id === '' ? null : parseId(body.auto_tag_id);
      if (body.auto_tag_id !== null && body.auto_tag_id !== '' && !tagId) return res.status(400).json({ error: 'Etiqueta inválida' });
      if (tagId) {
        const { rows } = await db.query('SELECT id FROM tags WHERE id = $1', [tagId]);
        if (!rows.length) return res.status(400).json({ error: 'Etiqueta não encontrada' });
      }
      account = await whatsapp.setAutoTag(id, tagId);
    }
    if (!account) return res.status(400).json({ error: 'Nada para atualizar' });
    res.json({ account });
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
// Diagnóstico (admin): últimas mensagens cujo texto contém um termo, com o estado da mídia
router.get('/debug/messages', requireAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q || 'indispon').slice(0, 60);
    const { rows } = await db.query(
      `SELECT m.id, m.conversation_id, m.direction, m.type, m.body, m.media_id, m.media_mime, m.wa_message_id, m.status, m.created_at,
              EXISTS (SELECT 1 FROM media_files f WHERE f.id = m.media_id) AS media_stored,
              ct.wa_id, c.account_id
         FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
        WHERE m.body ILIKE $1 OR (m.type = 'audio' AND m.created_at > NOW() - INTERVAL '2 days')
        ORDER BY m.created_at DESC LIMIT 40`,
      [`%${q}%`]
    );
    res.json({ messages: rows });
  } catch (err) { next(err); }
});

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
