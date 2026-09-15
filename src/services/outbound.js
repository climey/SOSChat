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
async function sendText(conversationId, user, body, { scheduled = false } = {}) {
  body = String(body || '').trim();
  if (!body) throw new SendError(400, 'Mensagem vazia');
  if (body.length > MESSAGE_MAX) throw new SendError(400, `Mensagem excede ${MESSAGE_MAX} caracteres`);
  const conv = await conversations.getById(conversationId);
  if (!conv) throw new SendError(404, 'Conversa não encontrada');
  const accountId = await resolveAccount(conv);
  if (whatsapp.multiAccount && !accountId) throw new SendError(502, 'Nenhum número de WhatsApp conectado. Escaneie o QR code em Configurações.');

  const { rows } = await db.query(
    `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id)
     VALUES ($1, 'out', 'text', $2, 'pending', $3) RETURNING *`,
    [conversationId, body, user.id]
  );
  let message = rows[0];
  try {
    const waId = await whatsapp.sendText(accountId, conv.wa_id, body);
    message = (await db.query(`UPDATE messages SET wa_message_id = $2, status = 'sent' WHERE id = $1 RETURNING *`, [message.id, waId])).rows[0];
  } catch (err) {
    message = (await db.query(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`, [message.id, String(err.message).slice(0, 500)])).rows[0];
  }

  const updated = await touchAfterSend(conversationId, body, user.id);
  message.sender_name = user.name;
  realtime.broadcast('message:new', { message, conversation: updated });
  realtime.broadcast('conversation:updated', updated);
  if (!scheduled) require('./schedules').cancelFor(conversationId, 'agent').catch(() => {});
  return { message, conversation: updated };
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

module.exports = { sendText, addNote, touchAfterSend, resolveAccount, SendError, MESSAGE_MAX };
