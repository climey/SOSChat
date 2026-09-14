/* Provedor não oficial: WhatsApp Web via Baileys (login por QR code). Sessão persistida no Postgres. */
const pino = require('pino');
const baileys = require('@whiskeysockets/baileys');
const db = require('../db');
const realtime = require('../realtime');

const {
  makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto,
  makeCacheableSignalKeyStore, fetchLatestBaileysVersion, downloadMediaMessage,
  getContentType, jidNormalizedUser, isJidGroup, isJidBroadcast, Browsers,
} = baileys;

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'error' });
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const ECHO_DELAY_MS = 1500; // espera a rota de envio gravar o wa_message_id antes de tratar o eco fromMe

const state = { status: 'off', qr: null, me: null, lastError: null, since: null };
let sock = null;
let auth = null;
let starting = false;
let stopRequested = false;
let inbound = null; // carregado sob demanda para evitar dependência circular

function setStatus(status, extra = {}) {
  Object.assign(state, { status, since: new Date().toISOString() }, extra);
  realtime.broadcast('whatsapp:status', getStatus());
}

function getStatus() {
  return { provider: 'baileys', status: state.status, me: state.me, hasQr: Boolean(state.qr), lastError: state.lastError, since: state.since };
}

// ---------- Auth state no Postgres ----------
async function useDbAuthState() {
  const read = async (key) => {
    const { rows } = await db.query('SELECT value FROM wa_auth WHERE key = $1', [key]);
    return rows[0] ? JSON.parse(rows[0].value, BufferJSON.reviver) : null;
  };
  const write = (client, key, value) => client.query(
    `INSERT INTO wa_auth (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value, BufferJSON.replacer)]
  );
  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const keys = ids.map((id) => `${type}-${id}`);
          const { rows } = await db.query('SELECT key, value FROM wa_auth WHERE key = ANY($1::text[])', [keys]);
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
                else await client.query('DELETE FROM wa_auth WHERE key = $1', [key]);
              }
            }
          });
        },
      },
    },
    saveCreds: () => write(db, 'creds', creds),
    clear: () => db.query('DELETE FROM wa_auth'),
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

/** Converte uma WAMessage da Baileys para o formato da Cloud API usado por inbound.extractContent. */
function toCloudMessage(m) {
  const message = unwrap(m.message);
  if (!message) return null;
  const type = getContentType(message);
  const ts = m.messageTimestamp;
  const base = { id: m.key.id, timestamp: String(typeof ts === 'object' && ts ? ts.toNumber() : Number(ts) || Math.floor(Date.now() / 1000)) };
  const c = message[type] || {};
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
    case 'contactMessage': return { ...base, type: 'contacts', contacts: [{ name: { formatted_name: c.displayName } }] };
    case 'contactsArrayMessage': return { ...base, type: 'contacts', contacts: (c.contacts || []).map((x) => ({ name: { formatted_name: x.displayName } })) };
    case 'reactionMessage': return { ...base, type: 'reaction', reaction: { emoji: c.text } };
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
      return null; // eventos internos, sem conteúdo para o atendente
    default:
      return { ...base, type: 'unsupported' };
  }
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'sticker', 'document']);

async function storeMedia(m, cloudMsg) {
  if (!MEDIA_TYPES.has(cloudMsg.type)) return;
  const meta = cloudMsg[cloudMsg.type];
  try {
    const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    if (buffer.length > MEDIA_MAX_BYTES) {
      logger.warn({ id: m.key.id }, 'mídia acima do limite, não armazenada');
      return;
    }
    await db.query(
      `INSERT INTO media_files (id, mime, size, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [meta.id, meta.mime_type || 'application/octet-stream', buffer.length, buffer]
    );
  } catch (err) {
    console.warn('[baileys] falha ao baixar mídia', m.key.id, err.message);
  }
}

function acceptChat(key) {
  const jid = key.remoteJid || '';
  if (!jid || isJidGroup(jid) || isJidBroadcast(jid) || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return false;
  return true;
}

async function onMessagesUpsert({ messages, type }) {
  if (type !== 'notify') return; // 'append' = histórico / ecos de envios via API
  inbound = inbound || require('./inbound');
  for (const m of messages) {
    try {
      if (!m.message || !acceptChat(m.key)) continue;
      const waId = fromKey(m.key);
      if (!waId) continue;
      const cloudMsg = toCloudMessage(m);
      if (!cloudMsg) continue;

      if (m.key.fromMe) {
        // Mensagem enviada pelo celular (ou eco de envio pela API): registra como saída
        await new Promise((r) => setTimeout(r, ECHO_DELAY_MS));
        await inbound.handleOutboundEcho(waId, cloudMsg);
        continue;
      }
      await storeMedia(m, cloudMsg);
      await inbound.handleInboundMessage({ ...cloudMsg, from: waId }, m.pushName ? { profile: { name: m.pushName } } : {});
    } catch (err) {
      console.error('[baileys] erro ao processar mensagem', m.key?.id, err);
    }
  }
}

const STATUS_MAP = { 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read', 0: 'failed' };

async function onMessagesUpdate(updates) {
  inbound = inbound || require('./inbound');
  for (const { key, update } of updates) {
    const status = STATUS_MAP[update?.status];
    if (!key?.fromMe || !status) continue;
    try {
      await inbound.handleStatus({ id: key.id, status });
    } catch (err) {
      console.error('[baileys] erro ao atualizar status', key.id, err);
    }
  }
}

// ---------- Conexão ----------
async function connect() {
  if (starting) return;
  starting = true;
  stopRequested = false;
  try {
    setStatus('connecting', { qr: null, lastError: null });
    auth = auth || (await useDbAuthState());
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const s = makeWASocket({
      version,
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('SOS Chat'),
      markOnlineOnConnect: false, // mantém as notificações no celular
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });
    sock = s;

    s.ev.on('creds.update', () => auth?.saveCreds().catch((err) => console.error('[baileys] falha ao salvar credenciais', err)));
    s.ev.on('messages.upsert', (ev) => { if (sock === s) onMessagesUpsert(ev); });
    s.ev.on('messages.update', (ev) => { if (sock === s) onMessagesUpdate(ev); });
    s.ev.on('connection.update', async (update) => {
      if (sock !== s) return; // evento de um socket já substituído (reconnect/logout manual)
      const { connection, lastDisconnect, qr } = update;
      if (qr) setStatus('qr', { qr });
      if (connection === 'open') {
        state.qr = null;
        state.me = s.user?.id ? jidNormalizedUser(s.user.id).split('@')[0] : null;
        setStatus('connected', { lastError: null });
        console.log(`[baileys] conectado como ${state.me}`);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason[code] || String(code || 'desconhecido');
        console.warn(`[baileys] conexão fechada (${reason})`);
        sock = null;
        if (stopRequested) { setStatus('off', { qr: null }); return; }
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession || code === DisconnectReason.forbidden) {
          await auth.clear().catch(() => {});
          auth = null;
          state.me = null;
          setStatus('disconnected', { qr: null, lastError: `Sessão encerrada (${reason}). Escaneie o QR code novamente.` });
          setTimeout(() => connect(), 2000); // gera um novo QR
          return;
        }
        // Outro processo assumiu a sessão (ex.: container antigo e novo durante um deploy). Espera antes de disputar.
        const delay = code === DisconnectReason.connectionReplaced ? 30000 : code === DisconnectReason.restartRequired ? 500 : 3000;
        setStatus('reconnecting', { qr: null, lastError: code === DisconnectReason.connectionReplaced ? 'Sessão aberta em outro processo, tentando de novo em 30s' : reason });
        setTimeout(() => connect(), delay);
      }
    });
  } catch (err) {
    console.error('[baileys] falha ao iniciar', err);
    setStatus('disconnected', { lastError: err.message });
    setTimeout(() => connect(), 10000);
  } finally {
    starting = false;
  }
}

async function start() {
  await connect();
}

/** Encerra a sessão no WhatsApp, limpa as credenciais e gera um novo QR. */
async function logout() {
  const old = sock;
  sock = null; // eventos do socket antigo passam a ser ignorados
  try { if (old) await old.logout(); } catch { /* já desconectado */ }
  if (auth) await auth.clear().catch(() => {});
  else await db.query('DELETE FROM wa_auth');
  auth = null;
  state.me = null;
  setStatus('disconnected', { qr: null, lastError: null });
  await connect();
}

async function reconnect() {
  const old = sock;
  sock = null;
  try { old?.end(new Error('reconexão manual')); } catch { /* ignora */ }
  await connect();
}

/** Desliga sem limpar a sessão (usado no encerramento do processo). */
function stop() {
  stopRequested = true;
  const old = sock;
  sock = null;
  try { old?.end(new Error('encerrando')); } catch { /* ignora */ }
  setStatus('off', { qr: null });
}

function getQr() {
  return state.qr;
}

// ---------- Interface do provedor ----------
function isConfigured() {
  return state.status === 'connected';
}

async function sendText(to, body) {
  if (!sock || state.status !== 'connected') throw new Error('WhatsApp desconectado. Escaneie o QR code em Configurações.');
  const sent = await sock.sendMessage(toJid(to), { text: body });
  return sent?.key?.id || null;
}

async function markAsRead(waMessageId, waId) {
  if (!sock || state.status !== 'connected' || !waMessageId || !waId || waMessageId.startsWith('sim-')) return;
  try {
    await sock.readMessages([{ remoteJid: toJid(waId), id: waMessageId, fromMe: false }]);
  } catch (err) {
    console.warn('[baileys] falha ao marcar como lida:', err.message);
  }
}

async function fetchMedia(mediaId) {
  const { rows } = await db.query('SELECT mime, size, data FROM media_files WHERE id = $1', [mediaId]);
  if (!rows.length) throw new Error('Mídia não disponível');
  return { buffer: rows[0].data, mimeType: rows[0].mime, size: rows[0].size };
}

function verifySignature() {
  return false; // webhook da Meta não se aplica a este provedor
}

module.exports = { start, stop, logout, reconnect, getQr, getStatus, isConfigured, sendText, markAsRead, fetchMedia, verifySignature };
