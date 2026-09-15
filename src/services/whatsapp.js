/*
 * Fachada do WhatsApp. Escolhe o provedor pela variável WA_PROVIDER:
 *   - baileys: WhatsApp Web via QR code (não oficial), vários números
 *   - cloud:   WhatsApp Business Cloud API (oficial), um número
 *
 * Todas as funções recebem accountId (ignorado pelo provedor cloud).
 */
const config = require('../config');

const isBaileys = config.waProvider === 'baileys';
const provider = isBaileys ? require('./wa-baileys') : require('./wa-cloud');

function getStatus() {
  if (isBaileys) return provider.getStatus();
  const st = provider.getStatus();
  return { provider: 'cloud', accounts: [{ id: null, name: 'Cloud API (Meta)', phone: st.me, status: st.status, hasQr: false, lastError: null }] };
}

module.exports = {
  provider: config.waProvider,
  multiAccount: isBaileys,
  isConfigured: () => provider.isConfigured(),
  getStatus,
  pickAccount: () => (isBaileys ? provider.pickAccount() : null),
  sendText: (accountId, to, body) => (isBaileys ? provider.sendText(accountId, to, body) : provider.sendText(to, body)),
  markAsRead: (accountId, waMessageId, waId) => (isBaileys ? provider.markAsRead(accountId, waMessageId, waId) : provider.markAsRead(waMessageId)),
  sendMedia: (accountId, to, file) => (isBaileys ? provider.sendMedia(accountId, to, file) : provider.sendMedia(to, file)),
  fetchMedia: (mediaId) => provider.fetchMedia(mediaId),
  verifySignature: (rawBody, header) => provider.verifySignature(rawBody, header),
  start: () => (provider.start ? provider.start() : Promise.resolve()),
  stop: () => (provider.stop ? provider.stop() : undefined),
  // Gestão de contas (só baileys)
  addAccount: (name) => provider.addAccount(name),
  renameAccount: (id, name) => provider.renameAccount(id, name),
  removeAccount: (id) => provider.removeAccount(id),
  logout: (id) => provider.logout(id),
  reconnect: (id) => provider.reconnect(id),
  getQr: (id) => provider.getQr(id),
  refreshAvatar: (accountId, waId) => (isBaileys && accountId ? provider.refreshAvatar(accountId, waId) : Promise.resolve()),
};
