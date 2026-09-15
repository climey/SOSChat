const express = require('express');
const multer = require('multer');
const db = require('../db');
const realtime = require('../realtime');
const whatsapp = require('../services/whatsapp');
const conversations = require('../services/conversations');
const { requireAuth } = require('../middleware/auth');
const outbound = require('../services/outbound');
const schedules = require('../services/schedules');

const router = express.Router();
router.use(requireAuth);

const MESSAGE_MAX = 4096; // limite da Cloud API para texto
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_MAX_BYTES, files: 1 } });

/** Classifica o arquivo do jeito que o WhatsApp espera. O que não é suportado nativamente vai como documento. */
function mediaKind(mimetype = '') {
  if (['image/jpeg', 'image/png'].includes(mimetype)) return 'image';
  if (['video/mp4', 'video/3gpp'].includes(mimetype)) return 'video';
  if (['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/amr', 'audio/x-m4a'].includes(mimetype)) return 'audio';
  return 'document';
}

const touchConversationAfterSend = outbound.touchAfterSend;
const resolveAccount = outbound.resolveAccount;

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// GET /api/conversations?status=open|resolved|all&assigned=me|unassigned|all&tag=ID&q=texto
router.get('/', async (req, res, next) => {
  try {
    const rows = await conversations.list({
      status: ['open', 'inbox', 'waiting', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open',
      assigned: ['me', 'unassigned', 'all'].includes(req.query.assigned) ? req.query.assigned : 'all',
      userId: req.user.id,
      tagId: parseId(req.query.tag),
      accountId: parseId(req.query.account),
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
    whatsapp.refreshAvatar(conv.account_id, conv.wa_id).catch(() => {}); // atualiza a foto do contato em segundo plano
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
      `SELECT m.*, u.name AS sender_name, mf.size AS media_size
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_user_id
         LEFT JOIN media_files mf ON mf.id = m.media_id
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
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    const result = await outbound.sendText(id, req.user, req.body?.body);
    res.status(result.message.status === 'failed' ? 502 : 201).json(result);
  } catch (err) {
    if (err instanceof outbound.SendError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Envia arquivo (imagem, vídeo, áudio ou documento) com legenda opcional. multipart: file + caption
router.post('/:id/media', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo acima de 25 MB' : err.message });
  });
}, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const file = req.file;
    const caption = String(req.body?.caption || '').trim().slice(0, 1024);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    if (!file || !file.buffer?.length) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const conv = await conversations.getById(id);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    const accountId = await resolveAccount(conv);
    if (whatsapp.multiAccount && !accountId) return res.status(502).json({ error: 'Nenhum número de WhatsApp conectado. Escaneie o QR code em Configurações.' });

    const kind = mediaKind(file.mimetype);
    const filename = String(file.originalname || 'arquivo').slice(0, 200);
    const label = { image: '[Imagem]', video: '[Vídeo]', audio: '[Áudio]' }[kind];
    const body = kind === 'document' ? filename : (caption || label);

    const { rows } = await db.query(
      `INSERT INTO messages (conversation_id, direction, type, body, media_mime, status, sender_user_id)
       VALUES ($1, 'out', $2, $3, $4, 'pending', $5) RETURNING *`,
      [id, kind, body, file.mimetype, req.user.id]
    );
    let message = rows[0];
    const mediaId = `out-${message.id}`;
    await db.query(
      `INSERT INTO media_files (id, mime, size, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [mediaId, file.mimetype, file.size, file.buffer]
    );

    try {
      const waId = await whatsapp.sendMedia(accountId, conv.wa_id, { buffer: file.buffer, mimetype: file.mimetype, filename, caption, kind });
      const upd = await db.query(
        `UPDATE messages SET wa_message_id = $2, media_id = $3, status = 'sent' WHERE id = $1 RETURNING *`,
        [message.id, waId, mediaId]
      );
      message = upd.rows[0];
    } catch (err) {
      const upd = await db.query(
        `UPDATE messages SET media_id = $3, status = 'failed', error = $2 WHERE id = $1 RETURNING *`,
        [message.id, String(err.message).slice(0, 500), mediaId]
      );
      message = upd.rows[0];
    }

    const updated = await touchConversationAfterSend(id, kind === 'document' ? `[Arquivo] ${filename}` : (caption ? `${label} ${caption}` : label), req.user.id);
    message.sender_name = req.user.name;
    realtime.broadcast('message:new', { message, conversation: updated });
    realtime.broadcast('conversation:updated', updated);
    schedules.cancelFor(id, 'agent').catch(() => {});
    res.status(message.status === 'failed' ? 502 : 201).json({ message, conversation: updated });
  } catch (err) {
    next(err);
  }
});

// Nota interna: fica no histórico da conversa, não vai para o WhatsApp
router.post('/:id/notes', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    res.status(201).json(await outbound.addNote(id, req.user, req.body?.body));
  } catch (err) {
    if (err instanceof outbound.SendError) return res.status(err.status).json({ error: err.message });
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
    const conv = await conversations.getById(id);
    if (rows[0]?.wa_message_id && conv) whatsapp.markAsRead(conv.account_id, rows[0].wa_message_id, conv.wa_id).catch(() => {}); // fire-and-forget
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
    if (status === 'resolved') schedules.cancelFor(id, 'resolve').catch(() => {});
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

// ---------- Agendamentos ----------
function scheduleError(res, err) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  throw err;
}

router.get('/:id/schedules', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    res.json({ schedules: await schedules.list(id) });
  } catch (err) { next(err); }
});

router.post('/:id/schedules', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    const conv = await conversations.getById(id);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    res.status(201).json({ schedule: await schedules.create(id, req.user, req.body || {}) });
  } catch (err) { try { scheduleError(res, err); } catch (e) { next(e); } }
});

router.patch('/:id/schedules/:sid', async (req, res, next) => {
  try {
    const id = parseId(req.params.id), sid = parseId(req.params.sid);
    if (!id || !sid) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json({ schedule: await schedules.update(sid, id, req.body || {}) });
  } catch (err) { try { scheduleError(res, err); } catch (e) { next(e); } }
});

router.post('/:id/schedules/:sid/send-now', async (req, res, next) => {
  try {
    const id = parseId(req.params.id), sid = parseId(req.params.sid);
    if (!id || !sid) return res.status(404).json({ error: 'Agendamento não encontrado' });
    const s = await schedules.dispatch(sid);
    if (!s || s.conversation_id !== id) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json({ schedule: s });
  } catch (err) { next(err); }
});

router.delete('/:id/schedules/:sid', async (req, res, next) => {
  try {
    const id = parseId(req.params.id), sid = parseId(req.params.sid);
    if (!id || !sid) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json({ schedule: await schedules.cancel(sid, id, `Cancelado por ${req.user.name}`) });
  } catch (err) { try { scheduleError(res, err); } catch (e) { next(e); } }
});

module.exports = router;
