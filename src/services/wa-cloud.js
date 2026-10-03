/*
 * Provedor oficial: WhatsApp Business Cloud API (Meta).
 *
 * Dois usos:
 *  - modo legado (WA_PROVIDER=cloud): um único número, credenciais nas variáveis WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN;
 *  - números oficiais cadastrados em wa_accounts (provider = 'cloud'), convivendo com os de QR code no modo multi-número.
 *    O App Secret (assinatura do webhook) e o verify token continuam nas variáveis, porque são do app da Meta, não do número.
 *
 * Sem credenciais (ou com token "mock", só fora de produção) o cliente apenas registra no log: serve para desenvolvimento e testes.
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

const wa = config.whatsapp;
const GRAPH = 'https://graph.facebook.com';
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/** Traduz os erros mais comuns da Meta para o atendente. */
function explainGraphError(code, message) {
  switch (Number(code)) {
    case 131047: return 'Mais de 24 h desde a última mensagem do cliente: pela API oficial só é possível enviar um template aprovado (ainda não disponível no SOS Chat).';
    case 131030: return 'Este número não está na lista de destinatários permitidos (o app da Meta ainda está em modo de desenvolvimento).';
    case 131026: return 'Mensagem não entregue: o número pode não ter WhatsApp ou bloqueou o número oficial.';
    case 131056: return 'Muitas mensagens para este cliente em pouco tempo; aguarde um pouco e reenvie.';
    case 130429: return 'Limite de envios da API atingido; aguarde um pouco e reenvie.';
    case 190: return 'Token da Meta inválido ou expirado. Gere um token permanente e atualize em Configurações → Números.';
    case 100: return `A Meta recusou a chamada: ${message}`;
    default: return `WhatsApp API: ${message}`;
  }
}

class CloudError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Cliente da Graph API para um número. creds: { phoneNumberId, accessToken } (lidos na hora, para aceitar troca de token). */
function makeClient(creds) {
  const pnid = () => creds.phoneNumberId;
  const token = () => creds.accessToken;
  const isConfigured = () => Boolean(pnid() && token()) && !(token() === 'mock' && !config.isProd);
  const mockId = () => `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  async function graphRequest(path, options = {}) {
    const url = `${GRAPH}/${wa.apiVersion}/${path}`;
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(explainGraphError(data?.error?.code, data?.error?.message || `HTTP ${res.status}`));
      err.code = data?.error?.code;
      err.details = data?.error;
      throw err;
    }
    return data;
  }

  /** Dados do número na Meta (valida o token e o phone_number_id). */
  async function info() {
    if (!isConfigured()) return { phone: pnid() ? `mock-${pnid()}` : null, verified_name: null, quality_rating: null, mock: true };
    const d = await graphRequest(`${pnid()}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`);
    return { phone: String(d.display_phone_number || '').replace(/\D/g, '') || null, verified_name: d.verified_name || null, quality_rating: d.quality_rating || null, mock: false };
  }

  /** Envia mensagem de texto. Retorna o ID da mensagem no WhatsApp. */
  async function sendText(to, body, opts = {}) {
    if (!isConfigured()) {
      console.log(`[whatsapp:mock] -> ${to}: ${body}${opts.quoted ? ` (citando ${opts.quoted.wa_message_id})` : ''}`);
      return mockId();
    }
    const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } };
    if (opts.quoted?.wa_message_id) payload.context = { message_id: opts.quoted.wa_message_id };
    const data = await graphRequest(`${pnid()}/messages`, { method: 'POST', body: JSON.stringify(payload) });
    return data?.messages?.[0]?.id || null;
  }

  /** Reação a uma mensagem (emoji vazio remove). */
  async function sendReaction(to, waMessageId, _fromMe, emoji) {
    if (!isConfigured()) { console.log(`[whatsapp:mock] reação ${emoji || '(remover)'} em ${waMessageId}`); return; }
    await graphRequest(`${pnid()}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'reaction', reaction: { message_id: waMessageId, emoji: emoji || '' } }),
    });
  }

  /** Envia mídia: faz upload para a Meta e depois envia a mensagem referenciando o ID. */
  async function sendMedia(to, file) {
    if (!isConfigured()) {
      console.log(`[whatsapp:mock] -> ${to}: [${file.kind}] ${file.filename || ''} ${file.caption || ''}`);
      return mockId();
    }
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', file.mimetype);
    form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.filename || 'arquivo');
    const up = await fetch(`${GRAPH}/${wa.apiVersion}/${pnid()}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: form });
    const upData = await up.json().catch(() => ({}));
    if (!up.ok || !upData.id) throw new Error(`WhatsApp API (upload): ${upData?.error?.message || `HTTP ${up.status}`}`);

    const kind = file.kind === 'audio' ? 'audio' : file.kind;
    const media = { id: upData.id };
    if (kind !== 'audio' && file.caption) media.caption = file.caption;
    if (kind === 'document' && file.filename) media.filename = file.filename;
    const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: kind, [kind]: media };
    if (file.quoted?.wa_message_id) payload.context = { message_id: file.quoted.wa_message_id };
    const data = await graphRequest(`${pnid()}/messages`, { method: 'POST', body: JSON.stringify(payload) });
    return data?.messages?.[0]?.id || null;
  }

  /** Bloqueia/desbloqueia um número. */
  async function setBlocked(waId, blocked) {
    if (!isConfigured()) { console.log(`[whatsapp:mock] ${blocked ? 'bloquear' : 'desbloquear'} ${waId}`); return; }
    await graphRequest(`${pnid()}/block_users`, { method: blocked ? 'POST' : 'DELETE', body: JSON.stringify({ messaging_product: 'whatsapp', block_users: [{ user: waId }] }) });
  }

  /** Marca uma mensagem recebida como lida. */
  async function markAsRead(waMessageId) {
    if (!isConfigured() || !waMessageId || waMessageId.startsWith('sim-')) return;
    try {
      await graphRequest(`${pnid()}/messages`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: waMessageId }) });
    } catch (err) {
      console.warn('[whatsapp] falha ao marcar como lida:', err.message);
    }
  }

  /** Busca a URL temporária de uma mídia e devolve o stream do arquivo. */
  async function fetchMedia(mediaId) {
    if (!isConfigured()) throw new Error('WhatsApp não configurado');
    if (!/^[\w-]+$/.test(mediaId)) throw new Error('ID de mídia inválido');
    const meta = await graphRequest(mediaId);
    const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${token()}` } });
    if (!res.ok) throw new Error(`Falha ao baixar mídia (HTTP ${res.status})`);
    return { stream: res.body, mimeType: meta.mime_type || 'application/octet-stream', size: meta.file_size };
  }

  /** Baixa uma mídia recebida e guarda em media_files (a URL da Meta expira e exige o token do número). */
  async function storeInboundMedia(msg) {
    const kind = ['image', 'video', 'audio', 'sticker', 'document'].find((k) => k === msg.type);
    const mediaId = kind && msg[kind]?.id;
    if (!mediaId || !isConfigured()) return;
    try {
      const m = await fetchMedia(mediaId);
      const buffer = Buffer.from(await new Response(m.stream).arrayBuffer());
      if (buffer.length > MEDIA_MAX_BYTES) return;
      await db.query('INSERT INTO media_files (id, mime, size, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [mediaId, m.mimeType, buffer.length, buffer]);
    } catch (err) {
      console.warn('[whatsapp] falha ao baixar mídia recebida', mediaId, err.message);
    }
  }

  async function editMessage(to, waMessageId, text) {
    if (!isConfigured()) { console.log(`[whatsapp:mock] editar ${waMessageId} -> ${text}`); return; }
    throw new Error('A API oficial da Meta não permite editar mensagens');
  }
  async function deleteMessage(to, waMessageId) {
    if (!isConfigured()) { console.log(`[whatsapp:mock] apagar ${waMessageId}`); return; }
    throw new Error('A API oficial da Meta não permite apagar mensagens');
  }

  /** Inscreve este app na conta do WhatsApp (WABA): sem isso a Meta não manda as mensagens dela para o nosso webhook. */
  async function subscribeApp(wabaId) {
    if (!isConfigured() || !wabaId) return false;
    await graphRequest(`${wabaId}/subscribed_apps`, { method: 'POST' });
    return true;
  }

  return { isConfigured, info, subscribeApp, sendText, editMessage, deleteMessage, sendMedia, sendReaction, setBlocked, markAsRead, fetchMedia, storeInboundMedia };
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

// ---------- Modo legado: um número pelas variáveis de ambiente ----------
const envClient = makeClient({ phoneNumberId: wa.phoneNumberId, accessToken: wa.accessToken });
function getStatus() {
  return { provider: 'cloud', status: envClient.isConfigured() ? 'connected' : 'mock', me: wa.phoneNumberId || null };
}

// ---------- Números oficiais cadastrados (wa_accounts.provider = 'cloud') ----------
const registry = new Map(); // id -> { account, api }
const COLS = 'id, name, phone, active, auto_tag_id, provider, phone_number_id, waba_id, access_token, verified_name, last_error, checked_at';

function register(row) {
  const entry = { account: row };
  entry.api = makeClient({ get phoneNumberId() { return entry.account.phone_number_id; }, get accessToken() { return entry.account.access_token; } });
  registry.set(row.id, entry);
  return entry;
}
function statusOf(entry) {
  const a = entry.account;
  return {
    id: a.id, name: a.name, phone: a.phone, auto_tag_id: a.auto_tag_id || null, provider: 'cloud',
    status: a.last_error ? 'error' : (entry.api.isConfigured() ? 'connected' : 'mock'),
    hasQr: false, lastError: a.last_error || null, since: a.checked_at,
    phone_number_id: a.phone_number_id, waba_id: a.waba_id || null, verified_name: a.verified_name || null,
  };
}
function broadcastStatus(entry) {
  require('../realtime').broadcast('whatsapp:status', statusOf(entry));
}
const accounts = {
  async load() {
    const { rows } = await db.query(`SELECT ${COLS} FROM wa_accounts WHERE active = TRUE AND provider = 'cloud' ORDER BY id`);
    for (const row of rows) if (!registry.has(row.id)) register(row);
    if (rows.length) console.log(`[cloud] ${rows.length} número(s) oficial(is) configurado(s)`);
    // confere os tokens em segundo plano
    for (const row of rows) accounts.check(row.id).catch(() => {});
  },
  has: (id) => registry.has(Number(id)),
  get: (id) => registry.get(Number(id)) || null,
  byPhoneNumberId: (pnid) => [...registry.values()].find((e) => e.account.phone_number_id === String(pnid)) || null,
  statuses: () => [...registry.values()].map(statusOf),
  /** Primeiro número oficial pronto para enviar. */
  pick() {
    for (const e of registry.values()) if (!e.account.last_error) return e.account.id;
    return null;
  },
  /** Confere o token na Meta e atualiza telefone/nome verificado; erros ficam gravados para a tela. */
  async check(id) {
    const entry = registry.get(Number(id));
    if (!entry) throw new CloudError(404, 'Número não encontrado');
    try {
      const i = await entry.api.info();
      try { await entry.api.subscribeApp(entry.account.waba_id); }
      catch (err) { throw new Error(`Número conectado, mas a Meta não deixou inscrever o app na conta do WhatsApp (sem isso as mensagens não chegam): ${err.message}`); }
      const { rows } = await db.query(
        `UPDATE wa_accounts SET phone = COALESCE($2, phone), verified_name = $3, last_error = NULL, checked_at = NOW() WHERE id = $1 RETURNING ${COLS}`,
        [entry.account.id, i.mock ? null : i.phone, i.verified_name]
      );
      if (rows.length) entry.account = rows[0];
    } catch (err) {
      const { rows } = await db.query(`UPDATE wa_accounts SET last_error = $2, checked_at = NOW() WHERE id = $1 RETURNING ${COLS}`, [entry.account.id, String(err.message).slice(0, 300)]);
      if (rows.length) entry.account = rows[0];
    }
    broadcastStatus(entry);
    return statusOf(entry);
  },
  /** Cadastra um número oficial. Valida as credenciais na Meta antes de gravar. */
  async add({ name, phoneNumberId, accessToken, wabaId }) {
    name = String(name || '').trim().slice(0, 60);
    phoneNumberId = String(phoneNumberId || '').trim();
    accessToken = String(accessToken || '').trim();
    wabaId = String(wabaId || '').trim() || null;
    if (!name) throw new CloudError(400, 'Informe um nome para o número (ex.: Oficial)');
    if (!/^\d{5,25}$/.test(phoneNumberId)) throw new CloudError(400, 'Phone number ID inválido (é o número longo em WhatsApp → API Setup, não o telefone)');
    if (accessToken.length < 4) throw new CloudError(400, 'Informe o token de acesso permanente');
    if (wabaId && !/^\d{5,25}$/.test(wabaId)) throw new CloudError(400, 'WABA ID inválido');
    const dup = await db.query('SELECT id FROM wa_accounts WHERE phone_number_id = $1 AND active = TRUE', [phoneNumberId]);
    if (dup.rows.length) throw new CloudError(400, 'Este Phone number ID já está cadastrado');
    let i;
    try { i = await makeClient({ phoneNumberId, accessToken }).info(); }
    catch (err) { throw new CloudError(400, `A Meta recusou as credenciais: ${err.message}`); }
    const { rows } = await db.query(
      `INSERT INTO wa_accounts (name, provider, phone_number_id, waba_id, access_token, phone, verified_name, checked_at)
       VALUES ($1, 'cloud', $2, $3, $4, $5, $6, NOW()) RETURNING ${COLS}`,
      [name, phoneNumberId, wabaId, accessToken, i.mock ? null : i.phone, i.verified_name]
    );
    const entry = register(rows[0]);
    return accounts.check(entry.account.id);
  },
  /** Atualiza nome, etiqueta automática ou credenciais (token/IDs, revalidados na Meta). */
  async update(id, patch) {
    const entry = registry.get(Number(id));
    if (!entry) throw new CloudError(404, 'Número não encontrado');
    const sets = []; const vals = [entry.account.id];
    const push = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.name !== undefined) { const n = String(patch.name || '').trim().slice(0, 60); if (!n) throw new CloudError(400, 'Informe o nome do número'); push('name', n); }
    if (patch.auto_tag_id !== undefined) push('auto_tag_id', patch.auto_tag_id);
    if (patch.waba_id !== undefined) { const w = String(patch.waba_id || '').trim() || null; if (w && !/^\d{5,25}$/.test(w)) throw new CloudError(400, 'WABA ID inválido'); push('waba_id', w); }
    const newToken = patch.access_token !== undefined ? String(patch.access_token || '').trim() : null;
    const newPnid = patch.phone_number_id !== undefined ? String(patch.phone_number_id || '').trim() : null;
    if (newToken !== null || newPnid !== null) {
      const phoneNumberId = newPnid ?? entry.account.phone_number_id;
      const accessToken = newToken ?? entry.account.access_token;
      if (!/^\d{5,25}$/.test(phoneNumberId)) throw new CloudError(400, 'Phone number ID inválido');
      if (accessToken.length < 4) throw new CloudError(400, 'Informe o token de acesso');
      let i;
      try { i = await makeClient({ phoneNumberId, accessToken }).info(); }
      catch (err) { throw new CloudError(400, `A Meta recusou as credenciais: ${err.message}`); }
      push('phone_number_id', phoneNumberId); push('access_token', accessToken);
      if (!i.mock && i.phone) push('phone', i.phone);
      push('verified_name', i.verified_name); push('last_error', null); push('checked_at', new Date());
    }
    if (!sets.length) throw new CloudError(400, 'Nada para atualizar');
    const { rows } = await db.query(`UPDATE wa_accounts SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLS}`, vals);
    entry.account = rows[0];
    if (newToken !== null || newPnid !== null || patch.waba_id !== undefined) return accounts.check(entry.account.id);
    broadcastStatus(entry);
    return statusOf(entry);
  },
  async remove(id) {
    const entry = registry.get(Number(id));
    if (!entry) throw new CloudError(404, 'Número não encontrado');
    registry.delete(entry.account.id);
    await db.query('DELETE FROM wa_accounts WHERE id = $1', [entry.account.id]); // conversas ficam com account_id NULL
    require('../realtime').broadcast('whatsapp:status', { id: entry.account.id, removed: true });
  },
};

module.exports = {
  ...envClient, getStatus, verifySignature, makeClient, accounts, CloudError, explainGraphError,
};
