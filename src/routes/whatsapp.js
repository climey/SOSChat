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

// Cadastra um novo número: por QR code (a sessão inicia e gera o QR) ou oficial (provider: 'cloud', com as credenciais da Meta)
router.post('/accounts', requireAdmin, requireMulti, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Informe um nome para o número (ex.: Vendas)' });
    const provider = req.body?.provider === 'cloud' ? 'cloud' : 'baileys';
    res.status(201).json({ account: await whatsapp.addAccount(name, { provider, phone_number_id: req.body?.phone_number_id, access_token: req.body?.access_token, waba_id: req.body?.waba_id }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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
    // credenciais do número oficial (revalidadas na Meta)
    if (body.access_token !== undefined || body.phone_number_id !== undefined || body.waba_id !== undefined) {
      if (whatsapp.providerOf(id) !== 'cloud') return res.status(400).json({ error: 'Credenciais só se aplicam a número oficial (API da Meta)' });
      const patch = {};
      for (const k of ['access_token', 'phone_number_id', 'waba_id']) if (body[k] !== undefined) patch[k] = body[k];
      account = await whatsapp.updateCloudAccount(id, patch);
    }
    if (!account) return res.status(400).json({ error: 'Nada para atualizar' });
    res.json({ account });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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

// Diagnóstico (admin): mensagens que chegaram cifradas e não puderam ser lidas (o celular do cliente precisa reenviar)
router.get('/debug/decrypt', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT m.id, m.conversation_id, m.wa_message_id, m.meta->>'reason' AS reason, m.created_at, ct.wa_id, c.account_id
         FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
        WHERE m.meta->>'pending' = 'true' ORDER BY m.created_at DESC LIMIT 50`
    );
    res.json({ failures: whatsapp.decryptFailures(), pending: rows });
  } catch (err) { next(err); }
});

// Reinicia a sessão criptografada com o contato da conversa (admin). A próxima mensagem enviada a ele recria a sessão.
router.post('/debug/reset-session', requireAdmin, async (req, res, next) => {
  try {
    const convId = parseId(req.body?.conversation_id);
    if (!convId) return res.status(400).json({ error: 'Informe a conversa' });
    const { rows } = await db.query('SELECT c.id, c.account_id, ct.wa_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1', [convId]);
    if (!rows.length) return res.status(404).json({ error: 'Conversa não encontrada' });
    const accountId = rows[0].account_id || whatsapp.pickAccount();
    if (!whatsapp.multiAccount || !accountId || whatsapp.providerOf(accountId) !== 'baileys') return res.status(400).json({ error: 'Só disponível com um número conectado pelo QR code' });
    let result;
    try { result = await whatsapp.resetSession(accountId, rows[0].wa_id); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    const note = await db.query(
      `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id) VALUES ($1, 'out', 'note', $2, 'sent', $3) RETURNING *`,
      [convId, `Sessão criptografada com o contato reiniciada por ${req.user.name}. Envie uma mensagem ao cliente para restabelecer; as respostas dele voltam a chegar normalmente.`, req.user.id]
    );
    const conv = await conversations.getById(convId);
    realtime.broadcast('message:new', { message: { ...note.rows[0], sender_name: req.user.name }, conversation: conv });
    res.json({ ok: true, ...result });
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
    if (err.status) return res.status(err.status).json({ error: err.message });
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
