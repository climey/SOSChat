const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const config = require('./config');
const db = require('./db');
const realtime = require('./realtime');
const whatsapp = require('./services/whatsapp');
const { requireCsrfHeader, requirePageAuth } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
realtime.init(server);

app.set('trust proxy', 1); // Railway fica atrás de proxy
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'"],
        // PDFs no visualizador: o leitor embutido do Chrome depende de object-src/frame-src da própria origem
        objectSrc: ["'self'"],
        frameSrc: ["'self'"],
        childSrc: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
  })
);
app.use(cookieParser());
app.use(
  express.json({
    limit: '1mb',
    // Guarda o corpo bruto para validar a assinatura do webhook
    verify: (req, _res, buf) => {
      if (req.originalUrl.startsWith('/webhook/')) req.rawBody = buf;
    },
  })
);

app.get('/health', (_req, res) => res.json({ ok: true, version: config.version, whatsapp: whatsapp.getStatus(), dev: config.enableDevSimulator }));

// Webhook da Meta (sem auth de usuário; validado por assinatura)
app.use('/webhook', require('./routes/webhook'));

// API autenticada
app.use('/api', requireCsrfHeader);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/tags', require('./routes/tags'));
app.use('/api/users', require('./routes/users'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/media', require('./routes/media'));
app.use('/api/whatsapp', require('./routes/whatsapp'));
app.use('/api/quick-replies', require('./routes/quick-replies'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/sectors', require('./routes/sectors'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/vehicles', require('./routes/vehicles'));
if (config.enableDevSimulator) {
  app.use('/api/dev', require('./routes/dev'));
  console.log('[dev] simulador de mensagens habilitado em POST /api/dev/simulate-inbound');
}

// Páginas protegidas
const publicDir = path.join(__dirname, '..', 'public');
app.get(['/', '/index.html', '/reports.html', '/settings.html'], requirePageAuth, (req, res) => {
  const file = req.path === '/' ? 'index.html' : req.path.slice(1);
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, file));
});
// no-cache = o navegador revalida a cada carregamento (304 quando nada mudou), evitando CSS/JS antigos após deploy
app.use(express.static(publicDir, { index: false, etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[erro]', err);
  res.status(500).json({ error: config.isProd ? 'Erro interno' : err.message });
});

async function start() {
  await db.query('SELECT 1');
  whatsapp.start().catch((err) => console.error('[whatsapp] falha ao iniciar provedor', err));
  require('./services/schedules').start();
  server.listen(config.port, () => {
    console.log(`SOS Chat rodando em ${config.appUrl} (${config.isProd ? 'produção' : 'desenvolvimento'})`);
    console.log(`[pré-consulta] ${require('./services/vehicle-lookup').chromeStatus()}`);
    console.log(`WhatsApp: provedor ${whatsapp.provider}${whatsapp.provider === 'cloud' ? (whatsapp.isConfigured() ? ' (Cloud API configurada)' : ' (modo simulado, sem credenciais)') : ' (QR code em Configurações)'}`);
  });
}

start().catch((err) => {
  console.error('Falha ao iniciar:', err.message);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('Encerrando...');
  whatsapp.stop();
  require('./services/vehicle-lookup').shutdown().catch(() => {});
  server.close(() => db.pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
});
