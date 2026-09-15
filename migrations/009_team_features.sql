-- Respostas rápidas
CREATE TABLE IF NOT EXISTS quick_replies (
  id         SERIAL PRIMARY KEY,
  shortcut   TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO quick_replies (shortcut, title, body) VALUES
  ('oi', 'Saudação', 'Olá, {nome}! Aqui é {atendente} da SOS Buscas Online. Como posso ajudar?'),
  ('prazo', 'Prazo de liberação', 'O prazo de liberação é de 2 a 15 minutos após o envio do comprovante.'),
  ('fim', 'Encerramento', 'A SOS Buscas Online agradece pela confiança! Qualquer dúvida, é só chamar.')
ON CONFLICT (shortcut) DO NOTHING;

-- Configurações gerais (chave/valor)
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO app_settings (key, value) VALUES ('sla_warn_minutes', '5'), ('sla_alert_minutes', '15')
ON CONFLICT (key) DO NOTHING;

-- Status manual do atendente (a presença online/offline é calculada pela conexão)
ALTER TABLE users ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'available'
  CHECK (availability IN ('available', 'away'));

-- Ficha do contato
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS cpf TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;

-- Citação e reações
ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb;
