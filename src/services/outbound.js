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

/** Mensagem automática do sistema: atualiza a prévia, mas a conversa continua esperando um atendente. */
async function touchAfterAutoSend(id, preview) {
  await db.query('UPDATE conversations SET last_message_at = NOW(), last_message_preview = $2 WHERE id = $1', [id, String(preview).slice(0, 120)]);
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

async function sendText(conversationId, user, body, { scheduled = false, quotedId = null, auto = false } = {}) {
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

  const updated = auto ? await touchAfterAutoSend(conversationId, body) : await touchAfterSend(conversationId, body, user.id);
  message = await require('./inbound').withQuoted(message);
  message.sender_name = user.name;
  message.sender_avatar = user.avatar_media_id || null;
  realtime.broadcast('message:new', { message, conversation: updated });
  realtime.broadcast('conversation:updated', updated);
  if (!scheduled) require('./schedules').cancelFor(conversationId, 'agent').catch(() => {});
  return { message, conversation: updated };
}

const PIX_LABEL = { cpf: 'CPF', cnpj: 'CNPJ', phone: 'Telefone', email: 'E-mail', evp: 'Chave aleatória' };
/** Texto da chave Pix (vai no chat da inbox e, onde não há cartão nativo, para o cliente). */
function pixText(pix) {
  return `Chave Pix (${PIX_LABEL[pix.keyType] || 'Chave'})\n${pix.name}\n${pix.key}`;
}
async function pixSettings() {
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('pix_name', 'pix_key', 'pix_key_type', 'pix_format')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { name: (s.pix_name || '').trim(), key: (s.pix_key || '').trim(), keyType: s.pix_key_type || 'cpf', format: s.pix_format === 'card' ? 'card' : 'text' };
}

/**
 * Envia a chave Pix cadastrada em Configurações como cartão nativo do WhatsApp (botão "Copiar chave Pix").
 * Se o cartão não puder ir (API oficial, erro no envio), a chave vai como texto.
 */
async function sendPix(conversationId, user, { quotedId = null } = {}) {
  const pix = await pixSettings();
  if (!pix.key || !pix.name) throw new SendError(400, 'Cadastre a chave Pix em Configurações (nome e chave)');
  const conv = await conversations.getById(conversationId);
  if (!conv) throw new SendError(404, 'Conversa não encontrada');
  const accountId = await resolveAccount(conv);
  if (whatsapp.multiAccount && !accountId) throw new SendError(502, 'Nenhum número de WhatsApp conectado. Escaneie o QR code em Configurações.');
  const quoted = await loadQuoted(conversationId, quotedId);
  const body = pixText(pix);
  const { rows } = await db.query(
    `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id, quoted_message_id)
     VALUES ($1, 'out', 'pix', $2, 'pending', $3, $4) RETURNING *`,
    [conversationId, body, user.id, quoted?.id || null]
  );
  let message = rows[0];
  try {
    let waId;
    if (pix.format === 'card') {
      // cartão nativo (experimental): o WhatsApp pode descartar sem avisar; por isso só quando ligado em Configurações
      try {
        waId = await whatsapp.sendPix(accountId, conv.wa_id, { ...pix, text: body });
      } catch (err) {
        console.warn('[pix] cartão nativo falhou, enviando como texto:', err.message);
        waId = await whatsapp.sendText(accountId, conv.wa_id, body, { quoted });
      }
    } else {
      waId = await whatsapp.sendText(accountId, conv.wa_id, body, { quoted });
    }
    message = (await db.query(`UPDATE messages SET wa_message_id = $2, status = 'sent' WHERE id = $1 RETURNING *`, [message.id, waId])).rows[0];
  } catch (err) {
    message = (await db.query(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`, [message.id, String(err.message).slice(0, 500)])).rows[0];
  }
  const updated = await touchAfterSend(conversationId, '[Chave Pix]', user.id);
  message = await require('./inbound').withQuoted(message);
  message.sender_name = user.name;
  message.sender_avatar = user.avatar_media_id || null;
  realtime.broadcast('message:new', { message, conversation: updated });
  realtime.broadcast('conversation:updated', updated);
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

/**
 * Transfere a conversa. Destino: { user_id } (atendente), { sector_id } (setor: tira o responsável e vai
 * para a fila do setor) ou { account_id } (número: as próximas respostas saem por ele).
 * Registra nota interna com o motivo e avisa o atendente que recebeu.
 */
async function transfer(conversationId, user, target, note) {
  const conv = await conversations.getById(conversationId);
  if (!conv) throw new SendError(404, 'Conversa não encontrada');
  const reason = note ? `: ${String(note).trim().slice(0, 500)}` : '';
  const from = conv.assigned_user_name || user.name;
  let text;
  let notifyUserId = null;

  if (target.user_id) {
    const { rows } = await db.query('SELECT id, name FROM users WHERE id = $1 AND active = TRUE', [target.user_id]);
    const u = rows[0];
    if (!u) throw new SendError(400, 'Atendente inválido');
    if (u.id === conv.assigned_user_id) throw new SendError(400, 'A conversa já está com esse atendente');
    await db.query('UPDATE conversations SET assigned_user_id = $2, attended = TRUE WHERE id = $1', [conversationId, u.id]);
    text = `Transferida de ${from} para ${u.name}${reason}`;
    notifyUserId = u.id;
  } else if (target.sector_id) {
    const { rows } = await db.query('SELECT id, name FROM sectors WHERE id = $1', [target.sector_id]);
    const s = rows[0];
    if (!s) throw new SendError(400, 'Setor inválido');
    await db.query('UPDATE conversations SET sector_id = $2, assigned_user_id = NULL WHERE id = $1', [conversationId, s.id]);
    text = `Transferida para o setor ${s.name} por ${user.name}${reason}`;
  } else if (target.account_id) {
    const { rows } = await db.query('SELECT id, name FROM wa_accounts WHERE id = $1 AND active = TRUE', [target.account_id]);
    const a = rows[0];
    if (!a) throw new SendError(400, 'Número inválido');
    if (a.id === conv.account_id) throw new SendError(400, 'A conversa já está nesse número');
    await db.query('UPDATE conversations SET account_id = $2 WHERE id = $1', [conversationId, a.id]);
    text = `Transferida para o número ${a.name} por ${user.name}${reason}. As próximas respostas saem por esse número.`;
  } else {
    throw new SendError(400, 'Escolha um atendente, setor ou número');
  }

  const noteRow = await db.query(
    `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id)
     VALUES ($1, 'out', 'note', $2, 'sent', $3) RETURNING *`,
    [conversationId, text, user.id]
  );
  const updated = await conversations.getById(conversationId);
  realtime.broadcast('message:new', { message: { ...noteRow.rows[0], sender_name: user.name }, conversation: updated });
  realtime.broadcast('conversation:updated', updated);
  if (notifyUserId) realtime.toUser(notifyUserId, 'conversation:transferred', { conversation: updated, from: user.name, note: note || '' });
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
  const message = { ...rows[0], sender_name: user.name, sender_avatar: user.avatar_media_id || null };
  realtime.broadcast('message:new', { message, conversation: conv });
  return { message, conversation: conv };
}

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;

async function ownMessage(conversationId, user, messageId) {
  const conv = await conversations.getById(conversationId);
  if (!conv) throw new SendError(404, 'Conversa não encontrada');
  const { rows } = await db.query('SELECT * FROM messages WHERE id = $1 AND conversation_id = $2', [messageId, conversationId]);
  const m = rows[0];
  if (!m) throw new SendError(404, 'Mensagem não encontrada');
  if (m.direction !== 'out') throw new SendError(400, 'Só mensagens enviadas pela equipe podem ser alteradas');
  if (m.deleted_at) throw new SendError(400, 'Esta mensagem já foi apagada');
  if (m.sender_user_id && m.sender_user_id !== user.id && user.role !== 'admin') throw new SendError(403, 'Só quem enviou (ou um admin) pode alterar esta mensagem');
  return { conv, m };
}

/** Edita o texto de uma mensagem enviada; o WhatsApp aceita até 15 minutos depois do envio. */
async function editMessage(conversationId, user, messageId, body) {
  body = String(body || '').trim();
  if (!body) throw new SendError(400, 'Mensagem vazia');
  if (body.length > MESSAGE_MAX) throw new SendError(400, `Mensagem excede ${MESSAGE_MAX} caracteres`);
  const { conv, m } = await ownMessage(conversationId, user, messageId);
  if (m.type === 'note') {
    const { rows } = await db.query('UPDATE messages SET body = $2, edited_at = NOW() WHERE id = $1 RETURNING *', [m.id, body]);
    realtime.broadcast('message:updated', rows[0]);
    return rows[0];
  }
  if (m.type !== 'text') throw new SendError(400, 'Só mensagens de texto podem ser editadas');
  if (!m.wa_message_id || m.status === 'failed' || m.status === 'pending') throw new SendError(400, 'Esta mensagem ainda não foi entregue ao WhatsApp');
  if (Date.now() - new Date(m.created_at).getTime() > EDIT_WINDOW_MS) throw new SendError(400, 'O WhatsApp só permite editar até 15 minutos depois do envio');
  if (body === m.body) return m;
  const accountId = await resolveAccount(conv);
  if (whatsapp.multiAccount && !accountId) throw new SendError(502, 'Nenhum número de WhatsApp conectado.');
  try { await whatsapp.editMessage(accountId, conv.wa_id, m.wa_message_id, body); }
  catch (err) { throw new SendError(502, `Não foi possível editar: ${err.message}`); }
  const updated = await require('./inbound').handleEdit(m.wa_message_id, { type: 'text', text: { body } });
  return updated || m;
}

/** Apaga para todos uma mensagem enviada (ou apaga uma nota interna). */
async function deleteMessage(conversationId, user, messageId) {
  const { conv, m } = await ownMessage(conversationId, user, messageId);
  const inbound = require('./inbound');
  if (m.type === 'note' || !m.wa_message_id || m.status === 'failed') {
    const { rows } = await db.query(
      `UPDATE messages SET deleted_at = NOW(), body = $2, media_id = NULL WHERE id = $1 RETURNING *`,
      [m.id, m.type === 'note' ? '[Nota apagada]' : '[Mensagem apagada]']
    );
    realtime.broadcast('message:updated', rows[0]);
    return rows[0];
  }
  if (Date.now() - new Date(m.created_at).getTime() > DELETE_WINDOW_MS) throw new SendError(400, 'O WhatsApp só permite apagar para todos até 2 dias depois do envio');
  const accountId = await resolveAccount(conv);
  if (whatsapp.multiAccount && !accountId) throw new SendError(502, 'Nenhum número de WhatsApp conectado.');
  try { await whatsapp.deleteMessage(accountId, conv.wa_id, m.wa_message_id); }
  catch (err) { throw new SendError(502, `Não foi possível apagar: ${err.message}`); }
  const updated = await inbound.handleRevoke(m.wa_message_id);
  return updated || m;
}

module.exports = { sendText, sendPix, pixText, addNote, react, transfer, editMessage, deleteMessage, loadQuoted, touchAfterSend, resolveAccount, SendError, MESSAGE_MAX };
