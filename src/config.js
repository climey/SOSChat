require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';

function required(name) {
  const v = process.env[name];
  if (!v) {
    if (isProd) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
    console.warn(`[config] ${name} não definida (usando valor de desenvolvimento)`);
  }
  return v;
}

module.exports = {
  isProd,
  // Identifica a versão publicada (Railway injeta o commit); muda a cada deploy e a tela usa para se atualizar
  version: (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.APP_VERSION || `dev-${Date.now()}`).slice(0, 12),
  port: Number(process.env.PORT) || 3000,
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,
  databaseUrl: required('DATABASE_URL') || 'postgresql://postgres:postgres@localhost:5432/soschat',
  pgSsl: process.env.PGSSL === 'true',
  jwtSecret: required('JWT_SECRET') || 'dev-secret-nao-usar-em-producao',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  // 'baileys' = WhatsApp Web via QR code (não oficial); 'cloud' = API oficial da Meta
  waProvider: process.env.WA_PROVIDER === 'baileys' ? 'baileys' : 'cloud',
  whatsapp: {
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID || '',
    accessToken: process.env.WA_ACCESS_TOKEN || '',
    appSecret: process.env.WA_APP_SECRET || '',
    verifyToken: process.env.WA_VERIFY_TOKEN || 'sos-verify-token',
    apiVersion: process.env.WA_API_VERSION || 'v21.0',
  },
  enableDevSimulator: !isProd && process.env.ENABLE_DEV_SIMULATOR === 'true',
};
