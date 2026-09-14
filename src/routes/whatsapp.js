const express = require('express');
const QRCode = require('qrcode');
const whatsapp = require('../services/whatsapp');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Status da conexão (todos os atendentes podem ver)
router.get('/status', (req, res) => {
  res.json(whatsapp.getStatus());
});

// QR code atual como imagem (data URL), só quando aguardando leitura
router.get('/qr', requireAdmin, async (req, res, next) => {
  try {
    const qr = whatsapp.getQr();
    if (!qr) return res.status(404).json({ error: 'Nenhum QR code disponível no momento' });
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280, color: { dark: '#000000', light: '#ffffff' } });
    res.json({ qr: dataUrl });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAdmin, async (req, res, next) => {
  try {
    await whatsapp.logout();
    res.json(whatsapp.getStatus());
  } catch (err) {
    next(err);
  }
});

router.post('/reconnect', requireAdmin, async (req, res, next) => {
  try {
    await whatsapp.reconnect();
    res.json(whatsapp.getStatus());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
