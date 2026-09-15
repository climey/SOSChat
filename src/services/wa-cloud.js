/* Provedor oficial: WhatsApp Business Cloud API (Meta) */
const crypto = require('crypto');
const config = require('../config');

const wa = config.whatsapp;
const GRAPH = 'https://graph.facebook.com';

function isConfigured() {
  return Boolean(wa.phoneNumberId && wa.accessToken);
}

async function graphRequest(path, options = {}) {
  const url = `${GRAPH}/${wa.apiVersion}/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${wa.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(`WhatsApp API: ${msg}`);
    err.code = data?.error?.code;
    err.details = data?.error;
    throw err;
  }
  return data;
}

/** Envia mensagem de texto. Retorna o ID da mensagem no WhatsApp. */
async function sendText(to, body, opts = {}) {
  if (!isConfigured()) {
    console.log(`[whatsapp:mock] -> ${to}: ${body}${opts.quoted ? ` (citando ${opts.quoted.wa_message_id})` : ''}`);
    return `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body },
  };
  if (opts.quoted?.wa_message_id) payload.context = { message_id: opts.quoted.wa_message_id };
  const data = await graphRequest(`${wa.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify(payload) });
  return data?.messages?.[0]?.id || null;
}

/** Reação a uma mensagem (emoji vazio remove). */
async function sendReaction(to, waMessageId, _fromMe, emoji) {
  if (!isConfigured()) { console.log(`[whatsapp:mock] reação ${emoji || '(remover)'} em ${waMessageId}`); return; }
  await graphRequest(`${wa.phoneNumberId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'reaction', reaction: { message_id: waMessageId, emoji: emoji || '' } }),
  });
}

/** Envia mídia: faz upload para a Meta e depois envia a mensagem referenciando o ID. */
async function sendMedia(to, file) {
  if (!isConfigured()) {
    console.log(`[whatsapp:mock] -> ${to}: [${file.kind}] ${file.filename || ''} ${file.caption || ''}`);
    return `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', file.mimetype);
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.filename || 'arquivo');
  const up = await fetch(`${GRAPH}/${wa.apiVersion}/${wa.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${wa.accessToken}` },
    body: form,
  });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok || !upData.id) throw new Error(`WhatsApp API (upload): ${upData?.error?.message || `HTTP ${up.status}`}`);

  const kind = file.kind === 'audio' ? 'audio' : file.kind;
  const media = { id: upData.id };
  if (kind !== 'audio' && file.caption) media.caption = file.caption;
  if (kind === 'document' && file.filename) media.filename = file.filename;
  const data = await graphRequest(`${wa.phoneNumberId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: kind, [kind]: media }),
  });
  return data?.messages?.[0]?.id || null;
}

/** Bloqueia/desbloqueia um número na Cloud API. */
async function setBlocked(waId, blocked) {
  if (!isConfigured()) { console.log(`[whatsapp:mock] ${blocked ? 'bloquear' : 'desbloquear'} ${waId}`); return; }
  await graphRequest(`${wa.phoneNumberId}/block_users`, {
    method: blocked ? 'POST' : 'DELETE',
    body: JSON.stringify({ messaging_product: 'whatsapp', block_users: [{ user: waId }] }),
  });
}

/** Marca uma mensagem recebida como lida. */
async function markAsRead(waMessageId) {
  if (!isConfigured() || !waMessageId || waMessageId.startsWith('sim-')) return;
  try {
    await graphRequest(`${wa.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: waMessageId }),
    });
  } catch (err) {
    console.warn('[whatsapp] falha ao marcar como lida:', err.message);
  }
}

/** Busca a URL temporária de uma mídia e devolve o stream do arquivo. */
async function fetchMedia(mediaId) {
  if (!isConfigured()) throw new Error('WhatsApp não configurado');
  if (!/^[\w-]+$/.test(mediaId)) throw new Error('ID de mídia inválido');
  const meta = await graphRequest(mediaId);
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${wa.accessToken}` } });
  if (!res.ok) throw new Error(`Falha ao baixar mídia (HTTP ${res.status})`);
  return { stream: res.body, mimeType: meta.mime_type || 'application/octet-stream', size: meta.file_size };
}

/** Valida a assinatura X-Hub-Signature-256 do webhook (HMAC-SHA256 com o App Secret). */
function verifySignature(rawBody, signatureHeader) {
  if (!wa.appSecret) return !config.isProd;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', wa.appSecret).update(rawBody).digest('hex');
  const received = signatureHeader.slice(7);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

function getStatus() {
  return { provider: 'cloud', status: isConfigured() ? 'connected' : 'mock', me: wa.phoneNumberId || null };
}

module.exports = { isConfigured, sendText, sendMedia, sendReaction, setBlocked, markAsRead, fetchMedia, verifySignature, getStatus };
