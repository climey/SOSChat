/*
 * Provedor não oficial: WhatsApp Web via Baileys (login por QR code).
 * Gerencia várias contas (números) ao mesmo tempo; a sessão de cada uma fica no Postgres (wa_auth).
 */
const pino = require('pino');
const baileys = require('@whiskeysockets/baileys');

/** vCard do WhatsApp → { name, phones: [{ phone, wa_id }] } (mesmo formato da API oficial). */
function vcardToContact(c) {
  const vcard = String(c?.vcard || '');
  const phones = [];
  for (const line of vcard.split(/\r?\n/)) {
    const m = line.match(/^TEL[^:]*:(.+)$/i);
    if (!m) continue;
    const waid = (line.match(/waid=(\d+)/i) || [])[1] || null;
    const phone = m[1].trim();
    if (phone || waid) phones.push({ phone, wa_id: waid || phone.replace(/\D/g, '') || null });
  }
  const fn = (vcard.match(/^FN:(.+)$/im) || [])[1];
  return { name: { formatted_name: c?.displayName || (fn ? fn.trim() : '') || 'Contato' }, phones };
}
const db = require('../db');
const realtime = require('../realtime');

const {
  makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto,
  makeCacheableSignalKeyStore, fetchLatestBaileysVersion, downloadMediaMessage,
  getContentType, jidNormalizedUser, isJidGroup, isJidBroadcast, Browsers, WAMessageStubType,
} = baileys;

const avatarAttempts = new Map(); // waId -> timestamp da última tentativa de baixar a foto

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'error' });
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const ECHO_DELAY_MS = 1500; // espera a rota de envio gravar o wa_message_id antes de tratar o eco fromMe

const sessions = new Map(); // accountId -> Session
let cachedVersion = null;
let inbound = null; // carregado sob demanda para evitar dependência circular
const getInbound = () => (inbound = inbound || require('./inbound'));

// ---------- Auth state por conta, no Postgres ----------
async function useDbAuthState(accountId) {
  const read = async (key) => {
    const { rows } = await db.query('SELECT value FROM wa_auth WHERE account_id = $1 AND key = $2', [accountId, key]);
    return rows[0] ? JSON.parse(rows[0].value, BufferJSON.reviver) : null;
  };
  const write = (client, key, value) => client.query(
    `INSERT INTO wa_auth (account_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [accountId, key, JSON.stringify(value, BufferJSON.replacer)]
  );
  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const keys = ids.map((id) => `${type}-${id}`);
          const { rows } = await db.query(
            'SELECT key, value FROM wa_auth WHERE account_id = $1 AND key = ANY($2::text[])', [accountId, keys]
          );
          const found = new Map(rows.map((r) => [r.key, JSON.parse(r.value, BufferJSON.reviver)]));
          const data = {};
          for (const id of ids) {
            let value = found.get(`${type}-${id}`) || null;
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          await db.withTransaction(async (client) => {
            for (const category of Object.keys(data)) {
              for (const id of Object.keys(data[category])) {
                const value = data[category][id];
                const key = `${category}-${id}`;
                if (value) await write(client, key, value);
                else await client.query('DELETE FROM wa_auth WHERE account_id = $1 AND key = $2', [accountId, key]);
              }
            }
          });
        },
      },
    },
    saveCreds: () => write(db, 'creds', creds),
    clear: () => db.query('DELETE FROM wa_auth WHERE account_id = $1', [accountId]),
  };
}

// ---------- Conversão de mensagens ----------
function toJid(waId) {
  return waId.includes('@') ? waId : `${waId}@s.whatsapp.net`;
}

/** Extrai o identificador do contato (número, ou "<id>@lid" quando o número não vem). */
function fromKey(key) {
  const jid = key.remoteJidAlt && key.remoteJid?.endsWith('@lid') ? key.remoteJidAlt : key.remoteJid;
  if (!jid) return null;
  const normalized = jidNormalizedUser(jid);
  if (normalized.endsWith('@s.whatsapp.net')) return normalized.split('@')[0];
  if (normalized.endsWith('@lid')) return normalized;
  return null;
}

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      || m.viewOnceMessageV2Extension?.message || m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

/**
 * Edição de mensagem: o WhatsApp manda um protocolMessage (MESSAGE_EDIT) com o novo conteúdo,
 * normalmente embrulhado em editedMessage. Devolve o protocolMessage ou null.
 */
function findEdit(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const pm = m.protocolMessage;
    if (pm && pm.editedMessage && (pm.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT || pm.type === undefined)) return pm;
    m = m.editedMessage?.message || m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || null;
  }
  return null;
}

/** Converte uma WAMessage da Baileys para o formato da Cloud API usado por inbound.extractContent. */
function toCloudMessage(m) {
  const ts = m.messageTimestamp;
  const base = { id: m.key.id, timestamp: String(typeof ts === 'object' && ts ? ts.toNumber() : Number(ts) || Math.floor(Date.now() / 1000)) };
  const edit = findEdit(m.message);
  if (edit) {
    const targetId = edit.key?.id || m.key.id;
    const inner = toCloudMessage({ key: { ...m.key, id: targetId }, message: edit.editedMessage, messageTimestamp: ts });
    return { ...base, type: 'edit', edit: { message_id: targetId, message: inner && inner.type !== 'edit' ? inner : null } };
  }
  const message = unwrap(m.message);
  if (!message) return null;
  const type = getContentType(message);
  const c = message[type] || {};
  // Citação: o WhatsApp manda o id da mensagem citada em contextInfo.stanzaId
  const quotedId = c?.contextInfo?.stanzaId;
  if (quotedId) base.context = { id: quotedId };
  switch (type) {
    case 'conversation': return { ...base, type: 'text', text: { body: message.conversation || '' } };
    case 'extendedTextMessage': return { ...base, type: 'text', text: { body: c.text || '' } };
    case 'imageMessage': return { ...base, type: 'image', image: { id: m.key.id, mime_type: c.mimetype, caption: c.caption } };
    case 'videoMessage': return { ...base, type: 'video', video: { id: m.key.id, mime_type: c.mimetype, caption: c.caption } };
    case 'audioMessage': return { ...base, type: 'audio', audio: { id: m.key.id, mime_type: c.mimetype } };
    case 'stickerMessage': return { ...base, type: 'sticker', sticker: { id: m.key.id, mime_type: c.mimetype } };
    case 'documentMessage': return { ...base, type: 'document', document: { id: m.key.id, mime_type: c.mimetype, caption: c.caption, filename: c.fileName } };
    case 'locationMessage':
    case 'liveLocationMessage': return { ...base, type: 'location', location: { latitude: c.degreesLatitude, longitude: c.degreesLongitude, name: c.name || c.caption } };
    case 'contactMessage': return { ...base, type: 'contacts', contacts: [vcardToContact(c)] };
    case 'contactsArrayMessage': return { ...base, type: 'contacts', contacts: (c.contacts || []).map(vcardToContact) };
    case 'reactionMessage': return { ...base, type: 'reaction', reaction: { message_id: c.key?.id, emoji: c.text || '' } };
    case 'buttonsResponseMessage': return { ...base, type: 'interactive', interactive: { button_reply: { title: c.selectedDisplayText } } };
    case 'listResponseMessage': return { ...base, type: 'interactive', interactive: { list_reply: { title: c.title } } };
    case 'templateButtonReplyMessage': return { ...base, type: 'interactive', interactive: { button_reply: { title: c.selectedDisplayText } } };
    case 'pollCreationMessage':
    case 'pollCreationMessageV3': return { ...base, type: 'text', text: { body: `[Enquete] ${c.name || ''}` } };
    case 'protocolMessage':
    case 'senderKeyDistributionMessage':
    case 'messageContextInfo':
    case 'editedMessage':
    case 'pollUpdateMessage':
    case 'albumMessage': // só anuncia um álbum; as imagens chegam em mensagens separadas
      return null; // eventos internos, sem conteúdo para o atendente
    default:
      if (!type || message.protocolMessage) return null; // só metadados, nada para mostrar
      console.warn('[baileys] tipo de mensagem não suportado:', type, Object.keys(message).join(','));
      return { ...base, type: 'unsupported' };
  }
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'sticker', 'document']);
/** Serializa uma mensagem para o log sem despejar bytes de mídia. */
function describeMessage(message) {
  const strip = (k, v) => (v && typeof v === 'object' && (v.type === 'Buffer' || ArrayBuffer.isView(v)) ? '<bytes>' : v);
  try { return JSON.stringify(message, strip).slice(0, 4000); } catch { return String(message); }
}
const STATUS_MAP = { 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read', 0: 'failed' };

function acceptChat(key) {
  const jid = key.remoteJid || '';
  if (!jid || isJidGroup(jid) || isJidBroadcast(jid) || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return false;
  return true;
}

// ---------- Sessão de uma conta ----------
class Session {
  constructor(account) {
    this.account = account; // { id, name, phone }
    this.state = { status: 'off', qr: null, me: account.phone || null, lastError: null, since: null };
    this.sock = null;
    this.auth = null;
    this.starting = false;
    this.stopped = false;
    this.timer = null;
  }

  status() {
    return {
      id: this.account.id, name: this.account.name, phone: this.state.me, auto_tag_id: this.account.auto_tag_id || null,
      status: this.state.status, hasQr: Boolean(this.state.qr), lastError: this.state.lastError, since: this.state.since,
    };
  }

  setStatus(status, extra = {}) {
    Object.assign(this.state, { status, since: new Date().toISOString() }, extra);
    realtime.broadcast('whatsapp:status', this.status());
  }

  schedule(fn, ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.stopped) fn(); }, ms);
  }

  async connect() {
    if (this.starting || this.stopped) return;
    this.starting = true;
    try {
      this.setStatus('connecting', { qr: null, lastError: null });
      this.auth = this.auth || (await useDbAuthState(this.account.id));
      cachedVersion = cachedVersion || (await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))).version;

      const s = makeWASocket({
        version: cachedVersion,
        auth: { creds: this.auth.state.creds, keys: makeCacheableSignalKeyStore(this.auth.state.keys, logger) },
        logger,
        browser: Browsers.ubuntu('SOS Chat'),
        markOnlineOnConnect: false, // mantém as notificações no celular
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
      });
      this.sock = s;

      s.ev.on('creds.update', () => this.auth?.saveCreds().catch((err) => console.error(`[baileys:${this.account.id}] falha ao salvar credenciais`, err)));
      s.ev.on('messages.upsert', (ev) => { if (this.sock === s) this.onMessagesUpsert(ev); });
      s.ev.on('messages.update', (ev) => { if (this.sock === s) this.onMessagesUpdate(ev); });
      s.ev.on('connection.update', (update) => { if (this.sock === s) this.onConnectionUpdate(s, update); });
    } catch (err) {
      console.error(`[baileys:${this.account.id}] falha ao iniciar`, err);
      this.setStatus('disconnected', { lastError: err.message });
      this.schedule(() => this.connect(), 10000);
    } finally {
      this.starting = false;
    }
  }

  async onConnectionUpdate(s, { connection, lastDisconnect, qr }) {
    const tag = `[baileys:${this.account.id}]`;
    if (qr) this.setStatus('qr', { qr });
    if (connection === 'open') {
      this.state.qr = null;
      this.state.me = s.user?.id ? jidNormalizedUser(s.user.id).split('@')[0] : null;
      this.setStatus('connected', { lastError: null });
      console.log(`${tag} conectado como ${this.state.me} (${this.account.name})`);
      if (this.state.me) {
        db.query('UPDATE wa_accounts SET phone = $2 WHERE id = $1', [this.account.id, this.state.me]).catch(() => {});
      }
      setTimeout(() => this.backfillAvatars().catch((err) => console.warn(`${tag} backfill de fotos falhou`, err.message)), 5000);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason[code] || String(code || 'desconhecido');
      console.warn(`${tag} conexão fechada (${reason})`);
      this.sock = null;
      if (this.stopped) { this.setStatus('off', { qr: null }); return; }
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession || code === DisconnectReason.forbidden) {
        await this.auth?.clear().catch(() => {});
        this.auth = null;
        this.state.me = null;
        this.setStatus('disconnected', { qr: null, lastError: `Sessão encerrada (${reason}). Escaneie o QR code novamente.` });
        this.schedule(() => this.connect(), 2000); // gera um novo QR
        return;
      }
      // Outro processo assumiu a sessão (ex.: container antigo e novo durante um deploy). Espera antes de disputar.
      const replaced = code === DisconnectReason.connectionReplaced;
      const delay = replaced ? 30000 : code === DisconnectReason.restartRequired ? 500 : 3000;
      this.setStatus('reconnecting', { qr: null, lastError: replaced ? 'Sessão aberta em outro processo, tentando de novo em 30s' : reason });
      this.schedule(() => this.connect(), delay);
    }
  }

  async storeMedia(m, cloudMsg) {
    if (!MEDIA_TYPES.has(cloudMsg.type)) return;
    const meta = cloudMsg[cloudMsg.type];
    try {
      const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: this.sock?.updateMediaMessage });
      if (buffer.length > MEDIA_MAX_BYTES) return;
      await db.query(
        `INSERT INTO media_files (id, mime, size, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [meta.id, meta.mime_type || 'application/octet-stream', buffer.length, buffer]
      );
    } catch (err) {
      console.warn(`[baileys:${this.account.id}] falha ao baixar mídia`, m.key.id, err.message);
    }
  }

  async onMessagesUpsert({ messages, type }) {
    if (type !== 'notify') return; // 'append' = histórico / ecos de envios via API
    for (const m of messages) {
      try {
        if (!m.message || !acceptChat(m.key)) continue;
        const waId = fromKey(m.key);
        if (!waId) continue;
        const cloudMsg = toCloudMessage(m);
        if (!cloudMsg) continue;
        console.log(`[baileys:${this.account.id}] recebida ${cloudMsg.type} ${m.key.id}${m.key.fromMe ? ' (do celular)' : ''} campos=${Object.keys(m.message).join(',')}`);
        if (cloudMsg.type === 'text' && /indispon|unavailable/i.test(cloudMsg.text?.body || '')) {
          console.warn(`[baileys:${this.account.id}] texto suspeito de mídia indisponível ${m.key.id}:`, describeMessage(m.message), 'stub=', m.messageStubType, JSON.stringify(m.messageStubParameters || null));
        }
        if (cloudMsg.type === 'edit') {
          // Edição (do cliente ou feita no celular): atualiza a mensagem original em vez de criar outra
          if (cloudMsg.edit.message) await getInbound().handleEdit(cloudMsg.edit.message_id, cloudMsg.edit.message);
          continue;
        }
        if (m.key.fromMe) {
          // Espera a rota de envio gravar o wa_message_id; se a mensagem já existe (enviada pela inbox), nada a fazer
          await new Promise((r) => setTimeout(r, ECHO_DELAY_MS));
          const echo = await getInbound().handleOutboundEcho(waId, cloudMsg, this.account.id);
          if (echo) await this.storeMedia(m, cloudMsg);
          continue;
        }
        await this.storeMedia(m, cloudMsg);
        await getInbound().handleInboundMessage(
          { ...cloudMsg, from: waId },
          m.pushName ? { profile: { name: m.pushName } } : {},
          this.account.id
        );
        this.refreshAvatar(waId).catch(() => {});
      } catch (err) {
        console.error(`[baileys:${this.account.id}] erro ao processar mensagem`, m.key?.id, err);
      }
    }
  }

  async onMessagesUpdate(updates) {
    for (const { key, update } of updates) {
      if (!key?.id) continue;
      try {
        // Mensagem editada
        const edited = update?.message?.editedMessage?.message;
        if (edited) {
          let cloudMsg = toCloudMessage({ key, message: edited, messageTimestamp: update.messageTimestamp });
          if (cloudMsg && cloudMsg.type === 'edit') cloudMsg = cloudMsg.edit.message;
          if (cloudMsg) await getInbound().handleEdit(key.id, cloudMsg);
          continue;
        }
        // Mensagem apagada para todos
        if (update?.messageStubType === WAMessageStubType.REVOKE || (update && 'message' in update && update.message === null)) {
          await getInbound().handleRevoke(key.id);
          continue;
        }
        const status = STATUS_MAP[update?.status];
        if (key.fromMe && status) await getInbound().handleStatus({ id: key.id, status });
      } catch (err) {
        console.error(`[baileys:${this.account.id}] erro ao processar atualização`, key.id, err);
      }
    }
  }

  /** Baixa a foto de perfil do contato (no máximo uma vez por dia) e guarda em media_files. */
  async refreshAvatar(waId) {
    if (!this.isConnected()) return;
    const now = Date.now();
    if ((avatarAttempts.get(waId) || 0) > now - 6 * 3600 * 1000) return;
    avatarAttempts.set(waId, now);
    const { rows } = await db.query('SELECT id, avatar_updated_at FROM contacts WHERE wa_id = $1', [waId]);
    if (!rows.length) return;
    if (rows[0].avatar_updated_at && now - new Date(rows[0].avatar_updated_at).getTime() < 24 * 3600 * 1000) return;
    const contactId = rows[0].id;
    let url = null;
    try {
      url = await this.sock.profilePictureUrl(toJid(waId), 'image', 10000);
    } catch (err) {
      // 404 / not-authorized = contato sem foto ou com privacidade "meus contatos"
      const code = err?.output?.statusCode || err?.data?.code || '';
      if (![401, 404, '401', '404'].includes(code)) console.warn(`[baileys:${this.account.id}] foto de ${waId}: ${err.message || code}`);
    }
    if (!url) {
      await db.query('UPDATE contacts SET avatar_updated_at = NOW() WHERE id = $1', [contactId]);
      return;
    }
    const res = await fetch(url);
    if (!res.ok) { console.warn(`[baileys:${this.account.id}] download da foto de ${waId} falhou: HTTP ${res.status}`); return; }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 5 * 1024 * 1024) return;
    const mediaId = `avatar-${String(waId).replace(/[^\w.-]/g, '_')}`;
    await db.query(
      `INSERT INTO media_files (id, mime, size, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET mime = EXCLUDED.mime, size = EXCLUDED.size, data = EXCLUDED.data, created_at = NOW()`,
      [mediaId, res.headers.get('content-type') || 'image/jpeg', buffer.length, buffer]
    );
    await db.query('UPDATE contacts SET avatar_media_id = $2, avatar_updated_at = NOW() WHERE id = $1', [contactId, mediaId]);
    realtime.broadcast('contact:avatar', { contact_id: contactId, avatar_media_id: mediaId, version: now });
  }

  /** Após conectar, busca aos poucos as fotos dos contatos que ainda não têm (1 a cada 1,5s para não chamar atenção). */
  async backfillAvatars() {
    const { rows } = await db.query(
      `SELECT DISTINCT ct.wa_id FROM contacts ct
         JOIN conversations c ON c.contact_id = ct.id
        WHERE c.account_id = $1 AND (ct.avatar_updated_at IS NULL OR ct.avatar_updated_at < NOW() - INTERVAL '7 days')
        ORDER BY ct.wa_id LIMIT 300`,
      [this.account.id]
    );
    if (!rows.length) return;
    console.log(`[baileys:${this.account.id}] buscando foto de ${rows.length} contato(s)`);
    for (const r of rows) {
      if (!this.isConnected()) return;
      await this.refreshAvatar(r.wa_id).catch(() => {});
      await new Promise((res) => setTimeout(res, 1500));
    }
  }

  isConnected() {
    return Boolean(this.sock) && this.state.status === 'connected';
  }

  /** Monta a referência mínima de uma mensagem para citar (o WhatsApp mostra a prévia pelo texto incluído). */
  quotedStub(jid, q) {
    return { key: { remoteJid: jid, fromMe: Boolean(q.fromMe), id: q.wa_message_id }, message: { conversation: String(q.body || '') } };
  }

  async sendText(to, body, opts = {}) {
    if (!this.isConnected()) throw new Error(`Número "${this.account.name}" desconectado. Escaneie o QR code em Configurações.`);
    const jid = toJid(to);
    const options = opts.quoted?.wa_message_id ? { quoted: this.quotedStub(jid, opts.quoted) } : undefined;
    const sent = await this.sock.sendMessage(jid, { text: body }, options);
    return sent?.key?.id || null;
  }

  /** Reage a uma mensagem (emoji vazio remove a reação). */
  async sendReaction(to, waMessageId, fromMe, emoji) {
    if (!this.isConnected()) throw new Error(`Número "${this.account.name}" desconectado.`);
    const jid = toJid(to);
    await this.sock.sendMessage(jid, { react: { text: emoji || '', key: { remoteJid: jid, fromMe: Boolean(fromMe), id: waMessageId } } });
  }

  /** Edita o texto de uma mensagem enviada (o WhatsApp aceita até 15 minutos depois do envio). */
  async editMessage(to, waMessageId, text) {
    if (!this.isConnected()) throw new Error(`Número "${this.account.name}" desconectado.`);
    const jid = toJid(to);
    await this.sock.sendMessage(jid, { text, edit: { remoteJid: jid, fromMe: true, id: waMessageId } });
  }

  /** Apaga para todos uma mensagem enviada. */
  async deleteMessage(to, waMessageId) {
    if (!this.isConnected()) throw new Error(`Número "${this.account.name}" desconectado.`);
    const jid = toJid(to);
    await this.sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: waMessageId } });
  }

  /** Envia mídia. file: { buffer, mimetype, filename, caption, kind: image|video|audio|document } */
  async sendMedia(to, file) {
    if (!this.isConnected()) throw new Error(`Número "${this.account.name}" desconectado. Escaneie o QR code em Configurações.`);
    const jid = toJid(to);
    let content;
    switch (file.kind) {
      case 'image': content = { image: file.buffer, caption: file.caption || undefined, mimetype: file.mimetype }; break;
      case 'video': content = { video: file.buffer, caption: file.caption || undefined, mimetype: file.mimetype }; break;
      case 'audio': content = { audio: file.buffer, mimetype: file.mimetype, ptt: Boolean(file.ptt), seconds: file.seconds || undefined, waveform: file.waveform || undefined }; break;
      default: content = { document: file.buffer, mimetype: file.mimetype, fileName: file.filename || 'arquivo', caption: file.caption || undefined };
    }
    const options = file.quoted?.wa_message_id ? { quoted: this.quotedStub(jid, file.quoted) } : undefined;
    const sent = await this.sock.sendMessage(jid, content, options);
    return sent?.key?.id || null;
  }

  /** Bloqueia ou desbloqueia o contato no WhatsApp (o cliente deixa de conseguir enviar mensagens). */
  async setBlocked(waId, blocked) {
    if (!this.isConnected()) throw new Error(`Número "${this.account.name}" desconectado`);
    await this.sock.updateBlockStatus(toJid(waId), blocked ? 'block' : 'unblock');
  }

  async markAsRead(waMessageId, waId) {
    if (!this.isConnected() || !waMessageId || !waId || waMessageId.startsWith('sim-')) return;
    try {
      await this.sock.readMessages([{ remoteJid: toJid(waId), id: waMessageId, fromMe: false }]);
    } catch (err) {
      console.warn(`[baileys:${this.account.id}] falha ao marcar como lida:`, err.message);
    }
  }

  /** Encerra a sessão no WhatsApp, limpa as credenciais e gera um novo QR. */
  async logout() {
    const old = this.sock;
    this.sock = null;
    try { if (old) await old.logout(); } catch { /* já desconectado */ }
    if (this.auth) await this.auth.clear().catch(() => {});
    else await db.query('DELETE FROM wa_auth WHERE account_id = $1', [this.account.id]);
    this.auth = null;
    this.state.me = null;
    this.setStatus('disconnected', { qr: null, lastError: null });
    await this.connect();
  }

  async reconnect() {
    const old = this.sock;
    this.sock = null;
    try { old?.end(new Error('reconexão manual')); } catch { /* ignora */ }
    await this.connect();
  }

  /** Desliga sem limpar a sessão. */
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const old = this.sock;
    this.sock = null;
    try { old?.end(new Error('encerrando')); } catch { /* ignora */ }
    this.setStatus('off', { qr: null });
  }
}

// ---------- Gerenciador de contas ----------
async function loadAccounts() {
  const { rows } = await db.query('SELECT id, name, phone, active, auto_tag_id FROM wa_accounts WHERE active = TRUE ORDER BY id');
  return rows;
}

async function start() {
  const accounts = await loadAccounts();
  for (const account of accounts) {
    if (!sessions.has(account.id)) {
      const session = new Session(account);
      sessions.set(account.id, session);
      session.connect().catch((err) => console.error(`[baileys:${account.id}] erro ao conectar`, err));
    }
  }
  console.log(`[baileys] ${accounts.length} número(s) configurado(s)`);
}

function stop() {
  for (const s of sessions.values()) s.stop();
}

function getSession(accountId) {
  const s = sessions.get(Number(accountId));
  if (!s) throw new Error('Número não encontrado');
  return s;
}

/** Primeira conta conectada (usada para conversas antigas sem número associado). */
function pickAccount() {
  for (const s of sessions.values()) if (s.isConnected()) return s.account.id;
  return null;
}

async function addAccount(name) {
  const { rows } = await db.query('INSERT INTO wa_accounts (name) VALUES ($1) RETURNING id, name, phone, active, auto_tag_id', [name]);
  const session = new Session(rows[0]);
  sessions.set(rows[0].id, session);
  session.connect().catch((err) => console.error(`[baileys:${rows[0].id}] erro ao conectar`, err));
  return session.status();
}

async function renameAccount(accountId, name) {
  const s = getSession(accountId);
  await db.query('UPDATE wa_accounts SET name = $2 WHERE id = $1', [accountId, name]);
  s.account.name = name;
  s.setStatus(s.state.status);
  return s.status();
}

/** Etiqueta aplicada a toda conversa nova que chega por este número (null desliga). */
async function setAutoTag(accountId, tagId) {
  const s = getSession(accountId);
  await db.query('UPDATE wa_accounts SET auto_tag_id = $2 WHERE id = $1', [accountId, tagId]);
  s.account.auto_tag_id = tagId;
  s.setStatus(s.state.status);
  return s.status();
}

async function removeAccount(accountId) {
  const s = getSession(accountId);
  s.stopped = true;
  clearTimeout(s.timer);
  const old = s.sock;
  s.sock = null;
  try { if (old) await old.logout(); } catch { /* ignora */ }
  sessions.delete(s.account.id);
  await db.query('DELETE FROM wa_accounts WHERE id = $1', [s.account.id]); // wa_auth cai em cascata; conversas ficam com account_id NULL
  realtime.broadcast('whatsapp:status', { id: s.account.id, removed: true });
}

function getStatus() {
  return { provider: 'baileys', accounts: [...sessions.values()].map((s) => s.status()) };
}

function getQr(accountId) {
  return getSession(accountId).state.qr;
}

// ---------- Interface do provedor ----------
function isConfigured() {
  return pickAccount() !== null;
}

function sendText(accountId, to, body, opts) {
  return getSession(accountId).sendText(to, body, opts);
}
function editMessage(accountId, to, waMessageId, text) {
  return getSession(accountId).editMessage(to, waMessageId, text);
}
function deleteMessage(accountId, to, waMessageId) {
  return getSession(accountId).deleteMessage(to, waMessageId);
}

function sendReaction(accountId, to, waMessageId, fromMe, emoji) {
  return getSession(accountId).sendReaction(to, waMessageId, fromMe, emoji);
}

function sendMedia(accountId, to, file) {
  return getSession(accountId).sendMedia(to, file);
}

function setBlocked(accountId, waId, blocked) {
  if (!accountId) throw new Error('Nenhum número conectado');
  return getSession(accountId).setBlocked(waId, blocked);
}

function markAsRead(accountId, waMessageId, waId) {
  if (!accountId) return Promise.resolve();
  return getSession(accountId).markAsRead(waMessageId, waId);
}

async function fetchMedia(mediaId) {
  const { rows } = await db.query('SELECT mime, size, data FROM media_files WHERE id = $1', [mediaId]);
  if (!rows.length) throw new Error('Mídia não disponível');
  return { buffer: rows[0].data, mimeType: rows[0].mime, size: rows[0].size };
}

function verifySignature() {
  return false; // webhook da Meta não se aplica a este provedor
}

module.exports = {
  start, stop, getStatus, getQr, pickAccount,
  addAccount, renameAccount, setAutoTag, removeAccount, toCloudMessage,
  refreshAvatar: (accountId, waId) => (sessions.has(Number(accountId)) ? getSession(accountId).refreshAvatar(waId) : Promise.resolve()),
  logout: (accountId) => getSession(accountId).logout(),
  reconnect: (accountId) => getSession(accountId).reconnect(),
  isConfigured, sendText, editMessage, deleteMessage, sendMedia, sendReaction, setBlocked, markAsRead, fetchMedia, verifySignature,
  _vcardToContact: vcardToContact,
};
