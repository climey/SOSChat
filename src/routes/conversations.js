const express = require('express');
const db = require('../db');
const realtime = require('../realtime');
const whatsapp = require('../services/whatsapp');
const conversations = require('../services/conversations');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MESSAGE_MAX = 4096; // limite da Cloud API para texto

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// GET /api/conversations?status=open|resolved|all&assigned=me|unassigned|all&tag=ID&q=texto
router.get('/', async (req, res, next) => {
  try {
    const rows = await conversations.list({
      status: ['open', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open',
      assigned: ['me', 'unassigned', 'all'].includes(req.query.assigned) ? req.query.assigned : 'all',
      userId: req.user.id,
      tagId: parseId(req.query.tag),
      q: String(req.query.q || '').trim().slice(0, 100) || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ conversations: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const conv = id && (await conversations.getById(id));
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    res.json({ conversation: conv });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/messages', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    const { rows } = await db.query(
      `SELECT m.*, u.name AS sender_name
         FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.conversation_id = $1
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT 500`,
      [id]
    );
    res.json({ messages: rows });
  } catch (err) {
    next(err);
  }
});

// Envia mensagem de texto ao cliente
router.post('/:id/messages', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const body = String(req.body?.body || '').trim();
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    if (!body) return res.status(400).json({ error: 'Mensagem vazia' });
    if (body.length > MESSAGE_MAX) return res.status(400).json({ error: `Mensagem excede ${MESSAGE_MAX} caracteres` });

    const conv = await conversations.getById(id);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

    // Grava como pendente, envia, depois atualiza com o ID do WhatsApp
    const { rows } = await db.query(
      `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id)
       VALUES ($1, 'out', 'text', $2, 'pending', $3) RETURNING *`,
      [id, body, req.user.id]
    );
    let message = rows[0];

    try {
      const waId = await whatsapp.sendText(conv.wa_id, body);
      const upd = await db.query(
        `UPDATE messages SET wa_message_id = $2, status = 'sent' WHERE id = $1 RETURNING *`,
        [message.id, waId]
      );
      message = upd.rows[0];
    } catch (err) {
      const upd = await db.query(
        `UPDATE messages SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`,
        [message.id, String(err.message).slice(0, 500)]
      );
      message = upd.rows[0];
    }

    await db.query(
      `UPDATE conversations
          SET last_message_at = NOW(),
              last_message_preview = $2,
              first_response_at = COALESCE(first_response_at, NOW()),
              assigned_user_id = COALESCE(assigned_user_id, $3),
              status = 'open', resolved_at = NULL, resolved_by_user_id = NULL
        WHERE id = $1`,
      [id, body.slice(0, 120), req.user.id]
    );

    const updated = await conversations.getById(id);
    message.sender_name = req.user.name;
    realtime.broadcast('message:new', { message, conversation: updated });
    realtime.broadcast('conversation:updated', updated);
    res.status(message.status === 'failed' ? 502 : 201).json({ message, conversation: updated });
  } catch (err) {
    next(err);
  }
});

// Zera não lidas e marca a última mensagem recebida como lida no WhatsApp
router.post('/:id/read', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    await db.query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [id]);
    const { rows } = await db.query(
      `SELECT wa_message_id FROM messages WHERE conversation_id = $1 AND direction = 'in'
        ORDER BY created_at DESC LIMIT 1`,
      [id]
    );
    if (rows[0]?.wa_message_id) whatsapp.markAsRead(rows[0].wa_message_id); // fire-and-forget
    const conv = await conversations.getById(id);
    realtime.broadcast('conversation:updated', conv);
    res.json({ conversation: conv });
  } catch (err) {
    next(err);
  }
});

// Atualiza status (open/resolved) e/ou responsável
router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    const { status, assigned_user_id } = req.body || {};
    const sets = [];
    const params = [id];

    if (status !== undefined) {
      if (!['open', 'resolved'].includes(status)) return res.status(400).json({ error: 'Status inválido' });
      params.push(status);
      sets.push(`status = $${params.length}`);
      if (status === 'resolved') {
        params.push(req.user.id);
        sets.push(`resolved_at = NOW(), resolved_by_user_id = $${params.length}`);
      } else {
        sets.push('resolved_at = NULL, resolved_by_user_id = NULL');
      }
    }
    if (assigned_user_id !== undefined) {
      const uid = assigned_user_id === null ? null : parseId(assigned_user_id);
      if (assigned_user_id !== null && !uid) return res.status(400).json({ error: 'Usuário inválido' });
      if (uid) {
        const u = await db.query('SELECT 1 FROM users WHERE id = $1 AND active = TRUE', [uid]);
        if (!u.rowCount) return res.status(400).json({ error: 'Usuário inválido' });
      }
      params.push(uid);
      sets.push(`assigned_user_id = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });

    const r = await db.query(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $1`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Conversa não encontrada' });
    const conv = await conversations.getById(id);
    realtime.broadcast('conversation:updated', conv);
    res.json({ conversation: conv });
  } catch (err) {
    next(err);
  }
});

// Substitui o conjunto de tags da conversa
router.put('/:id/tags', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    const tagIds = Array.isArray(req.body?.tag_ids) ? req.body.tag_ids.map(parseId).filter(Boolean) : [];
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM conversation_tags WHERE conversation_id = $1', [id]);
      if (tagIds.length) {
        await client.query(
          `INSERT INTO conversation_tags (conversation_id, tag_id)
           SELECT $1::int, t.id FROM tags t WHERE t.id = ANY($2::int[])
           ON CONFLICT DO NOTHING`,
          [id, tagIds]
        );
      }
    });
    const conv = await conversations.getById(id);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    realtime.broadcast('conversation:updated', conv);
    res.json({ conversation: conv });
  } catch (err) {
    next(err);
  }
});

// Atualiza nome do contato
router.patch('/:id/contact', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    await db.query(
      `UPDATE contacts SET name = $2 WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`,
      [id, name || null]
    );
    const conv = await conversations.getById(id);
    realtime.broadcast('conversation:updated', conv);
    res.json({ conversation: conv });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
