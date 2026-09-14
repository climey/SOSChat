/*
 * Fachada do WhatsApp. Escolhe o provedor pela variável WA_PROVIDER:
 *   - baileys: WhatsApp Web via QR code (não oficial, sem aprovação da Meta)
 *   - cloud:   WhatsApp Business Cloud API (oficial)
 */
const config = require('../config');

const provider = config.waProvider === 'baileys' ? require('./wa-baileys') : require('./wa-cloud');

module.exports = {
  provider: config.waProvider,
  isConfigured: () => provider.isConfigured(),
  sendText: (to, body) => provider.sendText(to, body),
  markAsRead: (waMessageId, waId) => provider.markAsRead(waMessageId, waId),
  fetchMedia: (mediaId) => provider.fetchMedia(mediaId),
  verifySignature: (rawBody, header) => provider.verifySignature(rawBody, header),
  getStatus: () => provider.getStatus(),
  start: () => (provider.start ? provider.start() : Promise.resolve()),
  stop: () => (provider.stop ? provider.stop() : undefined),
  logout: () => (provider.logout ? provider.logout() : Promise.resolve()),
  reconnect: () => (provider.reconnect ? provider.reconnect() : Promise.resolve()),
  getQr: () => (provider.getQr ? provider.getQr() : null),
};
