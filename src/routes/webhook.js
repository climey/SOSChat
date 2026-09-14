const express = require('express');
const config = require('../config');
const whatsapp = require('../services/whatsapp');
const inbound = require('../services/inbound');

const router = express.Router();

// Verificação do webhook (configuração no painel da Meta)
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Recebimento de mensagens e status
router.post('/whatsapp', async (req, res) => {
  const signature = req.get('X-Hub-Signature-256');
  if (!whatsapp.verifySignature(req.rawBody || Buffer.alloc(0), signature)) {
    console.warn('[webhook] assinatura inválida');
    return res.sendStatus(401);
  }
  // Responde rápido para a Meta não reenviar; processa em seguida
  res.sendStatus(200);
  try {
    await inbound.processWebhook(req.body);
  } catch (err) {
    console.error('[webhook] erro no processamento', err);
  }
});

module.exports = router;
