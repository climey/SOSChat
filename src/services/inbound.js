const db = require('../db');
const realtime = require('../realtime');
const conversations = require('./conversations');
const recurrence = require('./recurrence');

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
    case 'contacts': {
      // guarda nomes e telefones para o atendente poder ver e puxar conversa
      const list = (msg.contacts || []).map((c) => ({
        name: c.name?.formatted_name || [c.name?.first_name, c.name?.last_name].filter(Boolean).join(' ') || 'Contato',
        phones: (c.phones || []).map((p) => ({ phone: String(p.phone || '').trim(), wa_id: String(p.wa_id || p.phone || '').replace(/\D/g, '') || null })).filter((p) => p.phone || p.wa_id),
      }));
      return { type, body: `[Contato] ${list.map((c) => c.name).filter(Boolean).join(', ')}`, meta: { contacts: list } };
    }
    case 'interactive': {
      const i = msg.interactive || {};
      const body = i.button_reply?.title || i.list_reply?.title || '[Interativo]';
      return { type, body };
    }
    case 'button':
      return { type, body: msg.button?.text || '[Botão]' };
    case 'reaction':
      return { type, body: `Reagiu com ${msg.reaction?.emoji || ''}` };
    case 'pending': // chegou cifrada e ainda não pôde ser lida; o conteúdo real substitui esta linha quando o celular reenviar
      return { type: 'unsupported', body: '[Aguardando mensagem]', meta: { pending: true, reason: msg.pending?.reason || null } };
    default:
      return { type, body: '[Mensagem não suportada]' };
  }
}

/** Processa uma mensagem recebida: cria/atualiza contato, conversa e mensagem. Idempotente. */
async function handleInboundMessage(msg, contactInfo = {}, accountId = null) {
  const waId = msg.from;
  if (!waId) return null;
  // Reação não é mensagem: aplica na mensagem alvo e sai
  if (msg.type === 'reaction') return handleReaction(msg.reaction?.message_id, 'contact', msg.reaction?.emoji || null);
  const content = extractContent(msg);
  const quotedMessageId = await resolveQuoted(msg);
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
    let reopened = null;
    if (convRows.length) {
      conversationId = convRows[0].id;
    } else if ((reopened = await conversations.reopenRecent(client, contactId, accountId, sentAt))) {
      conversationId = reopened.id;
    } else {
      const ins = await client.query(
        `INSERT INTO conversations (contact_id, status, last_message_at, account_id, sector_id) VALUES ($1, 'open', $2, $3, $4) RETURNING id`,
        [contactId, sentAt, accountId, await conversations.defaultSectorId(client)]
      );
      conversationId = ins.rows[0].id;
      isNew = true;
      if (accountId) await client.query('INSERT INTO conversation_tags (conversation_id, tag_id) SELECT $1, auto_tag_id FROM wa_accounts WHERE id = $2 AND auto_tag_id IS NOT NULL ON CONFLICT DO NOTHING', [conversationId, accountId]);
    }

    const { rows: msgRows } = await client.query(
      `INSERT INTO messages (conversation_id, direction, wa_message_id, type, body, media_id, media_mime, status, created_at, quoted_message_id, meta)
       VALUES ($1, 'in', $2, $3, $4, $5, $6, 'received', $7, $8, $9)
       ON CONFLICT (wa_message_id) DO UPDATE
         SET type = EXCLUDED.type, body = EXCLUDED.body, media_id = EXCLUDED.media_id, media_mime = EXCLUDED.media_mime,
             quoted_message_id = EXCLUDED.quoted_message_id, meta = EXCLUDED.meta
         WHERE messages.meta->>'pending' = 'true' AND COALESCE(EXCLUDED.meta->>'pending', '') <> 'true'
       RETURNING *, (xmax = 0) AS inserted`,
      [conversationId, msg.id || null, content.type, content.body, content.mediaId || null, content.mediaMime || null, sentAt, quotedMessageId, content.meta ? JSON.stringify(content.meta) : null]
    );
    if (!msgRows.length) return null; // duplicado (Meta reenvia webhooks; o WhatsApp repete o "aguardando" a cada tentativa)
    const { inserted, ...message } = msgRows[0];

    if (inserted) {
      await client.query(
        `UPDATE conversations
            SET unread_count = unread_count + 1,
                last_message_at = GREATEST(last_message_at, $2::timestamptz),
                last_message_preview = $3,
                last_message_direction = 'in'
          WHERE id = $1`,
        [conversationId, sentAt, content.body.slice(0, PREVIEW_MAX)]
      );
    } else {
      // O celular do cliente reenviou o conteúdo de um "aguardando mensagem": a linha já contou como não lida,
      // só a prévia muda (e, se a conversa original já foi finalizada, a mensagem fica nela mesmo)
      if (message.conversation_id !== conversationId) {
        if (isNew) { await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]); isNew = false; }
        conversationId = message.conversation_id;
      }
      await client.query(
        `UPDATE conversations SET last_message_preview = $2
          WHERE id = $1 AND (SELECT id FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1) = $3`,
        [conversationId, content.body.slice(0, PREVIEW_MAX), message.id]
      );
    }
    await client.query('UPDATE contacts SET last_seen_at = GREATEST(COALESCE(last_seen_at, $2::timestamptz), $2::timestamptz) WHERE id = $1', [contactId, sentAt]);
    await recurrence.refreshContact(contactId, client);

    const conversation = await conversations.getById(conversationId, client);
    return { message: await withQuoted(message, client), conversation, isNew, replaced: !inserted, reopenNote: reopened?.note || null };
  });

  if (result) {
    if (result.reopenNote) realtime.broadcast('message:new', { message: result.reopenNote, conversation: result.conversation });
    if (result.replaced) realtime.broadcast('message:updated', result.message);
    else realtime.broadcast('message:new', { message: result.message, conversation: result.conversation });
    realtime.broadcast('conversation:updated', result.conversation);
    require('./schedules').cancelFor(result.conversation.id, 'contact').catch(() => {});
    // distribuição automática: conversa sem dono ganha um; dono offline passa adiante
    const dist = require('./distribution');
    if (result.reopenNote) dist.onReopened(result.conversation);
    else if (!result.conversation.assigned_user_id) dist.onNewConversation(result.conversation);
    else dist.onClientMessage(result.conversation);
    require('./vehicle-lookup').maybeAutoPreview(result.message, result.conversation);
  }
  return result;
}

/**
 * Registra uma mensagem enviada pelo próprio número fora do sistema (ex.: pelo celular).
 * Ignorada se já existe (eco de um envio feito pela inbox).
 */
async function handleOutboundEcho(waId, msg, accountId = null) {
  if (msg.type === 'reaction') return handleReaction(msg.reaction?.message_id, 'me', msg.reaction?.emoji || null);
  const content = extractContent(msg);
  const sentAt = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();
  const quotedMessageId = await resolveQuoted(msg);

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
    let reopened = null;
    if (!conversationId && (reopened = await conversations.reopenRecent(client, contactId, accountId, sentAt))) conversationId = reopened.id;
    if (!conversationId) {
      const ins = await client.query(
        `INSERT INTO conversations (contact_id, status, last_message_at, account_id, sector_id) VALUES ($1, 'open', $2, $3, $4) RETURNING id`,
        [contactId, sentAt, accountId, await conversations.defaultSectorId(client)]
      );
      conversationId = ins.rows[0].id;
      if (accountId) await client.query('INSERT INTO conversation_tags (conversation_id, tag_id) SELECT $1, auto_tag_id FROM wa_accounts WHERE id = $2 AND auto_tag_id IS NOT NULL ON CONFLICT DO NOTHING', [conversationId, accountId]);
    }
    const { rows: msgRows } = await client.query(
      `INSERT INTO messages (conversation_id, direction, wa_message_id, type, body, media_id, media_mime, status, created_at, quoted_message_id, meta)
       VALUES ($1, 'out', $2, $3, $4, $5, $6, 'sent', $7, $8, $9)
       ON CONFLICT (wa_message_id) DO NOTHING RETURNING *`,
      [conversationId, msg.id, content.type, content.body, content.mediaId || null, content.mediaMime || null, sentAt, quotedMessageId, content.meta ? JSON.stringify(content.meta) : null]
    );
    if (!msgRows.length) return null;
    await client.query(
      `UPDATE conversations
          SET last_message_at = GREATEST(last_message_at, $2::timestamptz),
              last_message_preview = $3,
              last_message_direction = 'out',
              attended = TRUE,
              unread_count = 0,
              first_response_at = COALESCE(first_response_at, $2::timestamptz)
        WHERE id = $1`,
      [conversationId, sentAt, content.body.slice(0, PREVIEW_MAX)]
    );
    const conversation = await conversations.getById(conversationId, client);
    return { message: { ...(await withQuoted(msgRows[0], client)), sender_name: 'Celular' }, conversation, reopenNote: reopened?.note || null };
  });

  if (result) {
    if (result.reopenNote) realtime.broadcast('message:new', { message: result.reopenNote, conversation: result.conversation });
    realtime.broadcast('message:new', result);
    realtime.broadcast('conversation:updated', result.conversation);
  }
  return result;
}

/** Descobre a mensagem citada (context.id = id no WhatsApp) e devolve o id interno. */
async function resolveQuoted(msg) {
  const waId = msg.context?.id;
  if (!waId) return null;
  const { rows } = await db.query('SELECT id FROM messages WHERE wa_message_id = $1', [waId]);
  return rows[0]?.id || null;
}

/** Anexa os dados da mensagem citada (para a tela renderizar a citação). */
async function withQuoted(message, client = db) {
  if (!message?.quoted_message_id) return message;
  const { rows } = await client.query(
    `SELECT m.id, m.body, m.type, m.direction, m.media_id, u.name AS sender_name
       FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.id = $1`,
    [message.quoted_message_id]
  );
  return { ...message, quoted: rows[0] || null };
}

/** Reação em uma mensagem: who = 'contact' (cliente) ou 'me' (nosso número); emoji null remove. */
async function handleReaction(waMessageId, who, emoji) {
  if (!waMessageId) return null;
  const { rows } = await db.query(
    `UPDATE messages
        SET reactions = CASE WHEN $3::text IS NULL OR $3 = '' THEN reactions - $2::text ELSE reactions || jsonb_build_object($2::text, $3::text) END
      WHERE wa_message_id = $1 RETURNING id, conversation_id, reactions`,
    [waMessageId, who, emoji]
  );
  if (rows.length) realtime.broadcast('message:updated', rows[0]);
  return rows[0] || null;
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

/** Contato criado só pelo LID (`<id>@lid`) ganhou número: unifica no contato do número e avisa as telas. */
async function mergeLidContact(lidJid, waId) {
  const { rows } = await db.query('SELECT id FROM contacts WHERE wa_id = $1', [lidJid]);
  if (!rows.length) return null;
  const out = await require('./contacts').mergeInto(rows[0].id, waId);
  if (out) {
    console.log(`[inbound] contato ${lidJid} unificado no número ${waId}`);
    realtime.broadcast('conversations:reload', { reason: 'lid-merged' });
  }
  return out;
}

/** Percorre o payload do webhook da Meta e despacha mensagens e status. */
async function processWebhook(payload) {
  if (payload?.object !== 'whatsapp_business_account') return;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (change.field !== 'messages') continue;
      // Modo multi-número: o webhook diz por qual número (phone_number_id) a mensagem entrou
      const whatsapp = require('./whatsapp');
      let accountId = null;
      let cloudAccount = null;
      if (whatsapp.multiAccount) {
        cloudAccount = whatsapp.cloudAccountByPhoneNumberId(value.metadata?.phone_number_id);
        if (!cloudAccount) { console.warn('[webhook] número oficial não cadastrado:', value.metadata?.phone_number_id); continue; }
        accountId = cloudAccount.account.id;
      }
      const contactsById = new Map((value.contacts || []).map((c) => [c.wa_id, c]));
      for (const msg of value.messages || []) {
        try {
          if (cloudAccount) await cloudAccount.api.storeInboundMedia(msg);
          await handleInboundMessage(msg, contactsById.get(msg.from), accountId);
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

module.exports = { processWebhook, mergeLidContact, handleInboundMessage, handleOutboundEcho, handleReaction, handleEdit, handleRevoke, handleStatus, extractContent, withQuoted };
