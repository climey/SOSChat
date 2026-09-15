const db = require('../db');
const realtime = require('../realtime');
const conversations = require('./conversations');

const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
const PREVIEW_MAX = 120;

/** Extrai texto/legenda e mídia de uma mensagem da Cloud API. */
function extractContent(msg) {
  const type = msg.type || 'unknown';
  switch (type) {
    case 'text':
      return { type, body: msg.text?.body || '' };
    case 'image':
    case 'video':
    case 'audio':
    case 'sticker':
    case 'document': {
      const m = msg[type] || {};
      const label = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', sticker: 'Figurinha', document: 'Documento' }[type];
      const body = m.caption || m.filename || `[${label}]`;
      return { type, body, mediaId: m.id || null, mediaMime: m.mime_type || null };
    }
    case 'location': {
      const l = msg.location || {};
      return { type, body: `[Localização] ${l.name || ''} ${l.latitude},${l.longitude}`.trim() };
    }
    case 'contacts':
      return { type, body: `[Contato] ${(msg.contacts || []).map((c) => c.name?.formatted_name).filter(Boolean).join(', ')}` };
    case 'interactive': {
      const i = msg.interactive || {};
      const body = i.button_reply?.title || i.list_reply?.title || '[Interativo]';
      return { type, body };
    }
    case 'button':
      return { type, body: msg.button?.text || '[Botão]' };
    case 'reaction':
      return { type, body: `Reagiu com ${msg.reaction?.emoji || ''}` };
    default:
      return { type, body: '[Mensagem não suportada]' };
  }
}

/** Processa uma mensagem recebida: cria/atualiza contato, conversa e mensagem. Idempotente. */
async function handleInboundMessage(msg, contactInfo = {}, accountId = null) {
  const waId = msg.from;
  if (!waId) return null;
  const content = extractContent(msg);
  const sentAt = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();
  const profileName = contactInfo.profile?.name || null;

  const result = await db.withTransaction(async (client) => {
    const { rows: contactRows } = await client.query(
      `INSERT INTO contacts (wa_id, profile_name) VALUES ($1, $2)
       ON CONFLICT (wa_id) DO UPDATE SET profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name)
       RETURNING id`,
      [waId, profileName]
    );
    const contactId = contactRows[0].id;

    // Conversa aberta existente deste contato neste número (lock para evitar duplicidade em webhooks concorrentes)
    let { rows: convRows } = await client.query(
      `SELECT id FROM conversations WHERE contact_id = $1 AND status = 'open' AND account_id IS NOT DISTINCT FROM $2
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [contactId, accountId]
    );
    let conversationId;
    let isNew = false;
    if (convRows.length) {
      conversationId = convRows[0].id;
    } else {
      const ins = await client.query(
        `INSERT INTO conversations (contact_id, status, last_message_at, account_id) VALUES ($1, 'open', $2, $3) RETURNING id`,
        [contactId, sentAt, accountId]
      );
      conversationId = ins.rows[0].id;
      isNew = true;
    }

    const { rows: msgRows } = await client.query(
      `INSERT INTO messages (conversation_id, direction, wa_message_id, type, body, media_id, media_mime, status, created_at)
       VALUES ($1, 'in', $2, $3, $4, $5, $6, 'received', $7)
       ON CONFLICT (wa_message_id) DO NOTHING
       RETURNING *`,
      [conversationId, msg.id || null, content.type, content.body, content.mediaId || null, content.mediaMime || null, sentAt]
    );
    if (!msgRows.length) return null; // duplicado (Meta reenvia webhooks)

    await client.query(
      `UPDATE conversations
          SET unread_count = unread_count + 1,
              last_message_at = GREATEST(last_message_at, $2::timestamptz),
              last_message_preview = $3,
              last_message_direction = 'in'
        WHERE id = $1`,
      [conversationId, sentAt, content.body.slice(0, PREVIEW_MAX)]
    );

    const conversation = await conversations.getById(conversationId, client);
    return { message: msgRows[0], conversation, isNew };
  });

  if (result) {
    realtime.broadcast('message:new', { message: result.message, conversation: result.conversation });
    realtime.broadcast('conversation:updated', result.conversation);
  }
  return result;
}

/**
 * Registra uma mensagem enviada pelo próprio número fora do sistema (ex.: pelo celular).
 * Ignorada se já existe (eco de um envio feito pela inbox).
 */
async function handleOutboundEcho(waId, msg, accountId = null) {
  const content = extractContent(msg);
  const sentAt = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();

  const result = await db.withTransaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM messages WHERE wa_message_id = $1', [msg.id]);
    if (exists.rowCount) return null;

    const { rows: contactRows } = await client.query(
      `INSERT INTO contacts (wa_id) VALUES ($1) ON CONFLICT (wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id RETURNING id`,
      [waId]
    );
    const contactId = contactRows[0].id;
    let { rows: convRows } = await client.query(
      `SELECT id FROM conversations WHERE contact_id = $1 AND status = 'open' AND account_id IS NOT DISTINCT FROM $2
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [contactId, accountId]
    );
    let conversationId = convRows[0]?.id;
    if (!conversationId) {
      const ins = await client.query(
        `INSERT INTO conversations (contact_id, status, last_message_at, account_id) VALUES ($1, 'open', $2, $3) RETURNING id`,
        [contactId, sentAt, accountId]
      );
      conversationId = ins.rows[0].id;
    }
    const { rows: msgRows } = await client.query(
      `INSERT INTO messages (conversation_id, direction, wa_message_id, type, body, media_id, media_mime, status, created_at)
       VALUES ($1, 'out', $2, $3, $4, $5, $6, 'sent', $7)
       ON CONFLICT (wa_message_id) DO NOTHING RETURNING *`,
      [conversationId, msg.id, content.type, content.body, content.mediaId || null, content.mediaMime || null, sentAt]
    );
    if (!msgRows.length) return null;
    await client.query(
      `UPDATE conversations
          SET last_message_at = GREATEST(last_message_at, $2::timestamptz),
              last_message_preview = $3,
              last_message_direction = 'out',
              first_response_at = COALESCE(first_response_at, $2::timestamptz)
        WHERE id = $1`,
      [conversationId, sentAt, content.body.slice(0, PREVIEW_MAX)]
    );
    const conversation = await conversations.getById(conversationId, client);
    return { message: { ...msgRows[0], sender_name: 'Celular' }, conversation };
  });

  if (result) {
    realtime.broadcast('message:new', result);
    realtime.broadcast('conversation:updated', result.conversation);
  }
  return result;
}

/** Aplica uma edição feita no WhatsApp ao texto da mensagem. */
async function handleEdit(waMessageId, msg) {
  const content = extractContent(msg);
  const { rows } = await db.query(
    `UPDATE messages SET body = $2, edited_at = NOW() WHERE wa_message_id = $1 AND deleted_at IS NULL RETURNING *`,
    [waMessageId, content.body]
  );
  if (!rows.length) return null;
  await refreshPreview(rows[0]);
  realtime.broadcast('message:updated', rows[0]);
  return rows[0];
}

/** Marca uma mensagem apagada "para todos" no WhatsApp. */
async function handleRevoke(waMessageId) {
  const { rows } = await db.query(
    `UPDATE messages SET deleted_at = NOW(), body = '[Mensagem apagada]', media_id = NULL WHERE wa_message_id = $1 RETURNING *`,
    [waMessageId]
  );
  if (!rows.length) return null;
  await refreshPreview(rows[0]);
  realtime.broadcast('message:updated', rows[0]);
  return rows[0];
}

/** Se a mensagem for a última da conversa, atualiza a prévia na lista. */
async function refreshPreview(message) {
  const { rows } = await db.query(
    `UPDATE conversations SET last_message_preview = $2
      WHERE id = $1 AND (SELECT id FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1) = $3
      RETURNING id`,
    [message.conversation_id, String(message.body || '').slice(0, PREVIEW_MAX), message.id]
  );
  if (rows.length) realtime.broadcast('conversation:updated', await conversations.getById(message.conversation_id));
}

/** Atualiza status de entrega (sent → delivered → read / failed) de mensagens enviadas. */
async function handleStatus(st) {
  if (!st.id || !STATUS_RANK.hasOwnProperty(st.status)) return;
  const error = st.errors?.[0] ? `${st.errors[0].code}: ${st.errors[0].title || st.errors[0].message || ''}` : null;
  const { rows } = await db.query(
    `UPDATE messages SET status = $2, error = COALESCE($3, error)
      WHERE wa_message_id = $1
        AND (CASE status WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END) < $4
      RETURNING id, conversation_id, status, error`,
    [st.id, st.status, error, STATUS_RANK[st.status]]
  );
  if (rows.length) realtime.broadcast('message:status', rows[0]);
}

/** Percorre o payload do webhook da Meta e despacha mensagens e status. */
async function processWebhook(payload) {
  if (payload?.object !== 'whatsapp_business_account') return;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (change.field !== 'messages') continue;
      const contactsById = new Map((value.contacts || []).map((c) => [c.wa_id, c]));
      for (const msg of value.messages || []) {
        try {
          await handleInboundMessage(msg, contactsById.get(msg.from));
        } catch (err) {
          console.error('[inbound] erro ao processar mensagem', msg.id, err);
        }
      }
      for (const st of value.statuses || []) {
        try {
          await handleStatus(st);
        } catch (err) {
          console.error('[inbound] erro ao processar status', st.id, err);
        }
      }
    }
  }
}

module.exports = { processWebhook, handleInboundMessage, handleOutboundEcho, handleEdit, handleRevoke, handleStatus, extractContent };
