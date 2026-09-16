const express = require('express');
const multer = require('multer');
const db = require('../db');
const realtime = require('../realtime');
const whatsapp = require('../services/whatsapp');
const conversations = require('../services/conversations');
const contactsService = require('../services/contacts');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const outbound = require('../services/outbound');
const schedules = require('../services/schedules');
const audio = require('../services/audio');

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
      sectorId: parseId(req.query.sector),
      plan: ['with', 'without', 'empty', 'expired'].includes(req.query.plan) ? req.query.plan : null,
      recurrence: ['new', 'occasional', 'recurrent', 'loyal', 'inactive'].includes(req.query.recurrence) ? req.query.recurrence : null,
      hidden: ['only', 'all'].includes(req.query.hidden) ? req.query.hidden : 'none',
      q: String(req.query.q || '').trim().slice(0, 100) || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ conversations: rows });
  } catch (err) {
    next(err);
  }
});

// Contadores das abas com os filtros atuais
router.get('/counts', async (req, res, next) => {
  try {
    res.json(await conversations.counts({
      assigned: ['me', 'unassigned', 'all'].includes(req.query.assigned) ? req.query.assigned : 'all',
      userId: req.user.id,
      tagId: parseId(req.query.tag),
      accountId: parseId(req.query.account),
      sectorId: parseId(req.query.sector),
      plan: ['with', 'without', 'empty', 'expired'].includes(req.query.plan) ? req.query.plan : null,
      recurrence: ['new', 'occasional', 'recurrent', 'loyal', 'inactive'].includes(req.query.recurrence) ? req.query.recurrence : null,
      hidden: ['only', 'all'].includes(req.query.hidden) ? req.query.hidden : 'none',
      q: String(req.query.q || '').trim().slice(0, 100) || null,
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const conv = id && (await conversations.getById(id, db, req.user.id));
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
      `SELECT m.*, u.name AS sender_name, u.avatar_media_id AS sender_avatar, mf.size AS media_size,
              CASE WHEN q.id IS NULL THEN NULL ELSE json_build_object(
                'id', q.id, 'body', q.body, 'type', q.type, 'direction', q.direction, 'media_id', q.media_id, 'sender_name', qu.name
              ) END AS quoted
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_user_id
         LEFT JOIN media_files mf ON mf.id = m.media_id
         LEFT JOIN messages q ON q.id = m.quoted_message_id
         LEFT JOIN users qu ON qu.id = q.sender_user_id
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
    const result = await outbound.sendText(id, req.user, req.body?.body, { quotedId: parseId(req.body?.quoted_message_id) });
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
    message.sender_avatar = req.user.avatar_media_id || null;
    realtime.broadcast('message:new', { message, conversation: updated });
    realtime.broadcast('conversation:updated', updated);
    schedules.cancelFor(id, 'agent').catch(() => {});
    res.status(message.status === 'failed' ? 502 : 201).json({ message, conversation: updated });
  } catch (err) {
    next(err);
  }
});

// Mensagem de voz gravada no navegador: converte para OGG/Opus e envia como áudio de voz
router.post('/:id/audio', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Áudio acima de 25 MB' : err.message });
  });
}, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const file = req.file;
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    if (!file || !file.buffer?.length) return res.status(400).json({ error: 'Nenhum áudio enviado' });
    if (!audio.isAvailable()) return res.status(501).json({ error: 'Conversor de áudio indisponível no servidor' });

    const conv = await conversations.getById(id);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    const accountId = await resolveAccount(conv);
    if (whatsapp.multiAccount && !accountId) return res.status(502).json({ error: 'Nenhum número de WhatsApp conectado.' });

    const ext = (file.mimetype || '').includes('mp4') || (file.mimetype || '').includes('aac') ? 'mp4' : (file.mimetype || '').includes('ogg') ? 'ogg' : 'webm';
    let voice;
    try {
      voice = await audio.toVoiceNote(file.buffer, ext);
    } catch (err) {
      return res.status(500).json({ error: `Falha ao converter o áudio: ${err.message.slice(0, 200)}` });
    }
    const quoted = await outbound.loadQuoted(id, parseId(req.body?.quoted_message_id));

    const { rows } = await db.query(
      `INSERT INTO messages (conversation_id, direction, type, body, media_mime, status, sender_user_id, quoted_message_id)
       VALUES ($1, 'out', 'audio', '[Áudio]', $2, 'pending', $3, $4) RETURNING *`,
      [id, voice.mimetype, req.user.id, quoted?.id || null]
    );
    let message = rows[0];
    const mediaId = `out-${message.id}`;
    await db.query(`INSERT INTO media_files (id, mime, size, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [mediaId, voice.mimetype, voice.buffer.length, voice.buffer]);
    try {
      const waId = await whatsapp.sendMedia(accountId, conv.wa_id, { buffer: voice.buffer, mimetype: voice.mimetype, kind: 'audio', ptt: true, seconds: voice.seconds, waveform: voice.waveform, quoted });
      message = (await db.query(`UPDATE messages SET wa_message_id = $2, media_id = $3, status = 'sent' WHERE id = $1 RETURNING *`, [message.id, waId, mediaId])).rows[0];
    } catch (err) {
      message = (await db.query(`UPDATE messages SET media_id = $3, status = 'failed', error = $2 WHERE id = $1 RETURNING *`, [message.id, String(err.message).slice(0, 500), mediaId])).rows[0];
    }
    const updated = await touchConversationAfterSend(id, '[Áudio]', req.user.id);
    message.sender_name = req.user.name;
    message.sender_avatar = req.user.avatar_media_id || null;
    message.media_size = voice.buffer.length;
    realtime.broadcast('message:new', { message, conversation: updated });
    realtime.broadcast('conversation:updated', updated);
    schedules.cancelFor(id, 'agent').catch(() => {});
    res.status(message.status === 'failed' ? 502 : 201).json({ message, conversation: updated });
  } catch (err) {
    next(err);
  }
});

// Reação do atendente a uma mensagem ({ emoji }; vazio remove)
router.post('/:id/messages/:mid/react', async (req, res, next) => {
  try {
    const id = parseId(req.params.id), mid = parseId(req.params.mid);
    if (!id || !mid) return res.status(404).json({ error: 'Mensagem não encontrada' });
    res.json({ message: await outbound.react(id, req.user, mid, req.body?.emoji) });
  } catch (err) {
    if (err instanceof outbound.SendError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Editar o texto de uma mensagem enviada ({ body }) e apagar para todos
router.patch('/:id/messages/:mid', async (req, res, next) => {
  try {
    const id = parseId(req.params.id), mid = parseId(req.params.mid);
    if (!id || !mid) return res.status(404).json({ error: 'Mensagem não encontrada' });
    res.json({ message: await outbound.editMessage(id, req.user, mid, req.body?.body) });
  } catch (err) {
    if (err instanceof outbound.SendError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
router.delete('/:id/messages/:mid', async (req, res, next) => {
  try {
    const id = parseId(req.params.id), mid = parseId(req.params.mid);
    if (!id || !mid) return res.status(404).json({ error: 'Mensagem não encontrada' });
    res.json({ message: await outbound.deleteMessage(id, req.user, mid) });
  } catch (err) {
    if (err instanceof outbound.SendError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Transferir para outro atendente ({ user_id, note })
router.post('/:id/transfer', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    const b = req.body || {};
    res.json(await outbound.transfer(id, req.user, { user_id: parseId(b.user_id), sector_id: parseId(b.sector_id), account_id: parseId(b.account_id) }, b.note));
  } catch (err) {
    if (err instanceof outbound.SendError) return res.status(err.status).json({ error: err.message });
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
    const { status, assigned_user_id, pinned, muted, hidden, unread, waiting, sector_id } = req.body || {};
    const sets = [];
    const params = [id];

    if (sector_id !== undefined) {
      const sid = parseId(sector_id);
      const s = sid && (await db.query('SELECT 1 FROM sectors WHERE id = $1', [sid]));
      if (!s?.rowCount) return res.status(400).json({ error: 'Setor inválido' });
      params.push(sid); sets.push(`sector_id = $${params.length}`);
    }

    // Preferências pessoais: só afetam a tela de quem marcou
    if (pinned !== undefined || muted !== undefined || hidden !== undefined) {
      const exists = await db.query('SELECT 1 FROM conversations WHERE id = $1', [id]);
      if (!exists.rowCount) return res.status(404).json({ error: 'Conversa não encontrada' });
      await conversations.setPrefs(id, req.user.id, { pinned, muted, hidden });
    }
    // "Marcar como não lida": garante ao menos 1 não lida; "marcar como lida": zera
    if (unread === true) sets.push('unread_count = GREATEST(unread_count, 1)');
    if (unread === false) sets.push('unread_count = 0');
    // "Marcar como esperando resposta" / "Marcar como respondida"
    if (waiting === true) sets.push(`last_message_direction = 'in'`);
    if (waiting === false) sets.push(`last_message_direction = 'out'`);

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
      if (uid) sets.push('attended = TRUE');
    }
    const prefsOnly = !sets.length && (pinned !== undefined || muted !== undefined || hidden !== undefined);
    if (!sets.length && !prefsOnly) return res.status(400).json({ error: 'Nada para atualizar' });

    if (sets.length) {
      const r = await db.query(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $1`, params);
      if (!r.rowCount) return res.status(404).json({ error: 'Conversa não encontrada' });
      if (status === 'resolved') schedules.cancelFor(id, 'resolve').catch(() => {});
      realtime.broadcast('conversation:updated', await conversations.getById(id));
    }
    // Resposta com as preferências de quem pediu (a transmissão acima vai sem elas; cada tela aplica as suas)
    res.json({ conversation: await conversations.getById(id, db, req.user.id) });
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

// Atualiza nome do contato e/ou bloqueio
router.patch('/:id/contact', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    const before = await conversations.getById(id);
    if (!before) return res.status(404).json({ error: 'Conversa não encontrada' });

    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim().slice(0, 120);
      await db.query('UPDATE contacts SET name = $2 WHERE id = $1', [before.contact_id, name || null]);
      await contactsService.logEvent(before.contact_id, req.user.id, 'field', `${req.user.name} renomeou o contato para ${name || '(sem nome)'}`);
    }
    if (req.body?.blocked !== undefined) {
      const blocked = Boolean(req.body.blocked);
      const accountId = before.account_id || whatsapp.pickAccount();
      try {
        await whatsapp.setBlocked(accountId, before.wa_id, blocked);
      } catch (err) {
        return res.status(502).json({ error: `Não foi possível ${blocked ? 'bloquear' : 'desbloquear'} no WhatsApp: ${err.message}` });
      }
      await contactsService.setBlocked(before.contact_id, req.user, blocked);
    }
    const conv = await conversations.getById(id);
    realtime.broadcast('conversation:updated', conv);
    res.json({ conversation: conv });
  } catch (err) {
    next(err);
  }
});

// Exclui a conversa e todo o histórico dela (só admin). Mídias órfãs são limpas junto.
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Conversa não encontrada' });
    const r = await db.query('DELETE FROM conversations WHERE id = $1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Conversa não encontrada' });
    await conversations.purgeOrphanMedia();
    realtime.broadcast('conversation:deleted', { id });
    res.json({ ok: true });
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
