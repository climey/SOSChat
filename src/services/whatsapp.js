/*
 * Fachada do WhatsApp. Escolhe o modo pela variável WA_PROVIDER:
 *   - baileys: modo multi-número. Cada número em wa_accounts é por QR code (Baileys) ou oficial (Cloud API da Meta,
 *              provider = 'cloud'); a fachada encaminha cada chamada pelo número da conversa.
 *   - cloud:   modo legado, um único número oficial pelas variáveis WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN.
 *
 * Todas as funções recebem accountId (ignorado no modo legado).
 */
const config = require('../config');
const cloud = require('./wa-cloud');

const isBaileys = config.waProvider === 'baileys';
const baileys = isBaileys ? require('./wa-baileys') : null;

/** Cliente oficial do número, ou null quando o número é por QR code (ou no modo legado). */
const cloudOf = (accountId) => (isBaileys && accountId ? cloud.accounts.get(accountId) : null);
/** Encaminha para o cliente oficial do número, para o Baileys ou, no modo legado, para o número das variáveis. */
function via(accountId, method, args, baileysArgs = [accountId, ...args]) {
  if (!isBaileys) return cloud[method](...args);
  const c = cloudOf(accountId);
  return c ? c.api[method](...args) : baileys[method](...baileysArgs);
}

function getStatus() {
  if (isBaileys) {
    const accounts = [...baileys.getStatus().accounts.map((a) => ({ ...a, provider: 'baileys' })), ...cloud.accounts.statuses()].sort((a, b) => a.id - b.id);
    return { provider: 'baileys', accounts };
  }
  const st = cloud.getStatus();
  return { provider: 'cloud', accounts: [{ id: null, name: 'Cloud API (Meta)', phone: st.me, status: st.status, hasQr: false, lastError: null, provider: 'cloud' }] };
}

function pickAccount() {
  if (!isBaileys) return null;
  return baileys.pickAccount() || cloud.accounts.pick();
}

module.exports = {
  provider: config.waProvider,
  multiAccount: isBaileys,
  isConfigured: () => (isBaileys ? pickAccount() !== null : cloud.isConfigured()),
  getStatus,
  pickAccount,
  /** Tipo do número: 'cloud' (oficial) ou 'baileys' (QR code). */
  providerOf: (accountId) => (cloudOf(accountId) ? 'cloud' : (isBaileys ? 'baileys' : 'cloud')),
  cloudAccountByPhoneNumberId: (pnid) => (isBaileys ? cloud.accounts.byPhoneNumberId(pnid) : null),
  sendText: (accountId, to, body, opts) => via(accountId, 'sendText', [to, body, opts]),
  editMessage: (accountId, to, waMessageId, text) => via(accountId, 'editMessage', [to, waMessageId, text]),
  deleteMessage: (accountId, to, waMessageId) => via(accountId, 'deleteMessage', [to, waMessageId]),
  sendReaction: (accountId, to, waMessageId, fromMe, emoji) => via(accountId, 'sendReaction', [to, waMessageId, fromMe, emoji]),
  markAsRead: (accountId, waMessageId, waId) => {
    if (isBaileys && !accountId) return Promise.resolve();
    return via(accountId, 'markAsRead', [waMessageId, waId], [accountId, waMessageId, waId]);
  },
  sendMedia: (accountId, to, file) => via(accountId, 'sendMedia', [to, file]),
  setBlocked: (accountId, waId, blocked) => via(accountId, 'setBlocked', [waId, blocked]),
  // No modo multi-número toda mídia recebida fica em media_files; só o modo legado busca na Meta
  fetchMedia: (mediaId) => (isBaileys ? baileys.fetchMedia(mediaId) : cloud.fetchMedia(mediaId)),
  verifySignature: (rawBody, header) => cloud.verifySignature(rawBody, header),
  start: async () => {
    if (!isBaileys) return;
    await baileys.start();
    await cloud.accounts.load();
  },
  stop: () => (baileys ? baileys.stop() : undefined),
  // Gestão de números (só modo multi-número)
  addAccount: (name, opts = {}) => (opts.provider === 'cloud'
    ? cloud.accounts.add({ name, phoneNumberId: opts.phone_number_id, accessToken: opts.access_token, wabaId: opts.waba_id })
    : baileys.addAccount(name)),
  renameAccount: (id, name) => (cloudOf(id) ? cloud.accounts.update(id, { name }) : baileys.renameAccount(id, name)),
  setAutoTag: (id, tagId) => (cloudOf(id) ? cloud.accounts.update(id, { auto_tag_id: tagId }) : baileys.setAutoTag(id, tagId)),
  updateCloudAccount: (id, patch) => cloud.accounts.update(id, patch),
  removeAccount: (id) => (cloudOf(id) ? cloud.accounts.remove(id) : baileys.removeAccount(id)),
  logout: (id) => {
    if (cloudOf(id)) throw new cloud.CloudError(400, 'Número oficial não tem sessão para encerrar. Para desligá-lo, remova o número.');
    return baileys.logout(id);
  },
  reconnect: (id) => (cloudOf(id) ? cloud.accounts.check(id) : baileys.reconnect(id)),
  getQr: (id) => (cloudOf(id) ? null : baileys.getQr(id)),
  refreshAvatar: (accountId, waId) => (isBaileys && accountId && !cloudOf(accountId) ? baileys.refreshAvatar(accountId, waId) : Promise.resolve()),
  // Diagnóstico de mensagens cifradas que não puderam ser lidas e reinício da sessão com um contato (só QR code)
  decryptFailures: () => (isBaileys ? baileys.decryptFailures() : []),
  resetSession: (accountId, waId) => (isBaileys && !cloudOf(accountId) ? baileys.resetSession(accountId, waId) : Promise.reject(new Error('Só disponível em número conectado pelo QR code'))),
  CloudError: cloud.CloudError,
};
