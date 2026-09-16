-- Planos de consultas (catalogo administrado em Configuracoes)
CREATE TABLE IF NOT EXISTS plans (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  credits       INTEGER NOT NULL CHECK (credits >= 0),
  validity_days INTEGER CHECK (validity_days IS NULL OR validity_days > 0),
  price_cents   INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO plans (name, credits, validity_days)
SELECT v.name, v.credits, v.validity_days
  FROM (VALUES ('Plano 3 consultas', 3, NULL::int), ('Plano 5 consultas', 5, NULL::int), ('Plano 10 consultas', 10, NULL::int)) AS v(name, credits, validity_days)
 WHERE NOT EXISTS (SELECT 1 FROM plans);

-- Plano ativo do contato (snapshot: continua valendo mesmo se o plano do catalogo for apagado)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS plan_id         INTEGER REFERENCES plans(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS plan_name       TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS plan_credits    INTEGER;        -- NULL = sem plano
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS plan_used       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS plan_started_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;

-- Campos extras da ficha
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone2       TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company      TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city         TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address      TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS birthdate    DATE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
UPDATE contacts ct
   SET last_seen_at = (SELECT MAX(m.created_at) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                        WHERE c.contact_id = ct.id AND m.direction = 'in')
 WHERE last_seen_at IS NULL;

-- Consultas realizadas (com ou sem debito do plano)
CREATE TABLE IF NOT EXISTS consultations (
  id              SERIAL PRIMARY KEY,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'placa' CHECK (kind IN ('placa', 'chassi', 'crlv', 'outra')),
  reference       TEXT,
  charged         BOOLEAN NOT NULL DEFAULT FALSE,
  note            TEXT,
  reversed_at     TIMESTAMPTZ,
  reversed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_consultations_contact ON consultations(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consultations_created ON consultations(created_at);

-- Log de atividade do contato
CREATE TABLE IF NOT EXISTS contact_events (
  id          SERIAL PRIMARY KEY,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_events_contact ON contact_events(contact_id, created_at DESC);

INSERT INTO tags (name, color) VALUES ('Renovação', '#7048e8') ON CONFLICT (name) DO NOTHING;
INSERT INTO quick_replies (shortcut, title, body) VALUES
  ('renovar', 'Renovação do plano', 'Olá, {nome}! As consultas do seu plano acabaram. Quer renovar agora? Me avise que eu envio os dados para pagamento e libero na hora.')
ON CONFLICT (shortcut) DO NOTHING;
