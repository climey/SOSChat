/* Envio de mensagens e notas pelo atendente (usado pela rota e pelo agendador). */
const db = require('../db');
const realtime = require('./realtime-proxy');
const whatsapp = require('./whatsapp');
const conversations = require('./conversations');

const MESSAGE_MAX = 4096; // limite da Cloud API para texto

/** Atualiza a conversa após um envio do atendente e devolve a versão nova. */
async function touchAfterSend(id, preview, userId) {
  await db.query(
    `UPDATE conversations
        SET last_message_at = NOW(),
            last_message_preview = $2,
            last_message_direction = 'out',
            attended = TRUE,
            first_response_at = COALESCE(first_response_at, NOW()),
            assigned_user_id = COALESCE(assigned_user_id, $3),
            status = 'open', resolved_at = NULL, resolved_by_user_id = NULL
      WHERE id = $1`,
    [id, String(preview).slice(0, 120), userId]
  );
  return conversations.getById(id);
}

/** Resolve o número pelo qual a conversa responde (conversas antigas caem no primeiro conectado). */
async function resolveAccount(conv) {
  let accountId = conv.account_id;
  if (whatsapp.multiAccount && !accountId) {
    accountId = whatsapp.pickAccount();
    if (!accountId) return null;
    await db.query('UPDATE conversations SET account_id = $2 WHERE id = $1', [conv.id, accountId]);
  }
  return accountId;
}

class SendError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Envia texto ao cliente. Grava como pendente, envia, atualiza com o ID do WhatsApp.
 * Retorna { message, conversation }; message.status = 'failed' quando o provedor recusou.
 */
/** Busca a mensagem a ser citada, garantindo que pertence à conversa e já existe no WhatsApp. */
async function loadQuoted(conversationId, quotedId) {
  if (!quotedId) return null;
  const { rows } = await db.query(
    `SELECT id, wa_message_id, direction, body, type FROM messages WHERE id = $1 AND conversation_id = $2 AND type <> 'note'`,
    [quotedId, conversationId]
  );
  if (!rows.length) throw new SendError(400, 'Mensagem citada não encontrada nesta conversa');
  const q = rows[0];
  return { id: q.id, wa_message_id: q.wa_message_id, fromMe: q.direction === 'out', body: q.body, type: q.type };
}

async function sendText(conversationId, user, body, { scheduled = false, quotedId = null } = {}) {
  body = String(body || '').trim();
  if (!body) throw new SendError(400, 'Mensagem vazia');
  if (body.length > MESSAGE_MAX) throw new SendError(400, `Mensagem excede ${MESSAGE_MAX} caracteres`);
  const conv = await conversations.getById(conversationId);
  if (!conv) throw new SendError(404, 'Conversa não encontrada');
  const accountId = await resolveAccount(conv);
  if (whatsapp.multiAccount && !accountId) throw new SendError(502, 'Nenhum número de WhatsApp conectado. Escaneie o QR code em Configurações.');
  const quoted = await loadQuoted(conversationId, quotedId);

  const { rows } = await db.query(
    `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id, quoted_message_id)
     VALUES ($1, 'out', 'text', $2, 'pending', $3, $4) RETURNING *`,
    [conversationId, body, user.id, quoted?.id || null]
  );
  let message = rows[0];
  try {
    const waId = await whatsapp.sendText(accountId, conv.wa_id, body, { quoted });
    message = (await db.query(`UPDATE messages SET wa_message_id = $2, status = 'sent' WHERE id = $1 RETURNING *`, [message.id, waId])).rows[0];
  } catch (err) {
    message = (await db.query(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`, [message.id, String(err.message).slice(0, 500)])).rows[0];
  }

  const updated = await touchAfterSend(conversationId, body, user.id);
  message = await require('./inbound').withQuoted(message);
  message.sender_name = user.name;
  realtime.broadcast('message:new', { message, conversation: updated });
  realtime.broadcast('conversation:updated', updated);
  if (!scheduled) require('./schedules').cancelFor(conversationId, 'agent').catch(() => {});
  return { message, conversation: updated };
}

/** Reação do atendente a uma mensagem (emoji vazio remove). Gravada como reação "me". */
async function react(conversationId, user, messageId, emoji) {
  emoji = String(emoji || '').trim().slice(0, 8);
  const conv = await conversations.getById(conversationId);
  if (!conv) throw new SendError(404, 'Conversa não encontrada');
  const { rows } = await db.query(
    `SELECT id, wa_message_id, direction, type FROM messages WHERE id = $1 AND conversation_id = $2`, [messageId, conversationId]
  );
  const m = rows[0];
  if (!m) throw new SendError(404, 'Mensagem não encontrada');
  if (m.type === 'note' || !m.wa_message_id) throw new SendError(400, 'Não dá para reagir a esta mensagem');
  const accountId = await resolveAccount(conv);
  if (whatsapp.multiAccount && !accountId) throw new SendError(502, 'Nenhum número de WhatsApp conectado.');
  try {
    await whatsapp.sendReaction(accountId, conv.wa_id, m.wa_message_id, m.direction === 'out', emoji);
  } catch (err) {
    throw new SendError(502, `Não foi possível reagir: ${err.message}`);
  }
  const upd = await db.query(
    `UPDATE messages
        SET reactions = CASE WHEN $2 = '' THEN reactions - 'me' ELSE reactions || jsonb_build_object('me', $2::text) END
      WHERE id = $1 RETURNING id, conversation_id, reactions`,
    [m.id, emoji]
  );
  realtime.broadcast('message:updated', upd.rows[0]);
  return upd.rows[0];
}

/** Transfere a conversa para outro atendente, com nota interna do motivo e aviso para quem recebe. */
async function transfer(conversationId, user, toUserId, note) {
  const conv = await conversations.getById(conversationId);
  if (!conv) throw new SendError(404, 'Conversa não encontrada');
  const { rows } = await db.query('SELECT id, name FROM users WHERE id = $1 AND active = TRUE', [toUserId]);
  const target = rows[0];
  if (!target) throw new SendError(400, 'Atendente inválido');
  if (target.id === user.id) throw new SendError(400, 'A conversa já é sua');
  await db.query('UPDATE conversations SET assigned_user_id = $2, attended = TRUE WHERE id = $1', [conversationId, target.id]);
  const text = `Transferida de ${conv.assigned_user_name || user.name} para ${target.name}${note ? `: ${String(note).trim().slice(0, 500)}` : ''}`;
  const noteRow = await db.query(
    `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id)
     VALUES ($1, 'out', 'note', $2, 'sent', $3) RETURNING *`,
    [conversationId, text, user.id]
  );
  const updated = await conversations.getById(conversationId);
  realtime.broadcast('message:new', { message: { ...noteRow.rows[0], sender_name: user.name }, conversation: updated });
  realtime.broadcast('conversation:updated', updated);
  realtime.toUser(target.id, 'conversation:transferred', { conversation: updated, from: user.name, note: note || '' });
  return { conversation: updated };
}

/** Nota interna: fica no histórico da conversa, não vai para o WhatsApp. */
async function addNote(conversationId, user, body) {
  body = String(body || '').trim();
  if (!body) throw new SendError(400, 'Nota vazia');
  if (body.length > MESSAGE_MAX) throw new SendError(400, `Nota excede ${MESSAGE_MAX} caracteres`);
  const conv = await conversations.getById(conversationId);
  if (!conv) throw new SendError(404, 'Conversa não encontrada');
  const { rows } = await db.query(
    `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id)
     VALUES ($1, 'out', 'note', $2, 'sent', $3) RETURNING *`,
    [conversationId, body, user.id]
  );
  const message = { ...rows[0], sender_name: user.name };
  realtime.broadcast('message:new', { message, conversation: conv });
  return { message, conversation: conv };
}

module.exports = { sendText, addNote, react, transfer, loadQuoted, touchAfterSend, resolveAccount, SendError, MESSAGE_MAX };
