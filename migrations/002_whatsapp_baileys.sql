-- Sessão do WhatsApp Web (provedor baileys): credenciais e chaves Signal
CREATE TABLE IF NOT EXISTS wa_auth (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Mídias recebidas pelo provedor baileys (o WhatsApp Web não fornece URL, o arquivo é baixado na hora)
CREATE TABLE IF NOT EXISTS media_files (
  id         TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
