-- Usuários (atendentes e admins)
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Contatos do WhatsApp (wa_id = telefone em formato internacional, ex: 5511999999999)
CREATE TABLE IF NOT EXISTS contacts (
  id           SERIAL PRIMARY KEY,
  wa_id        TEXT NOT NULL UNIQUE,
  name         TEXT,
  profile_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversas (uma conversa "aberta" por contato por vez)
CREATE TABLE IF NOT EXISTS conversations (
  id                   SERIAL PRIMARY KEY,
  contact_id           INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  assigned_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  unread_count         INTEGER NOT NULL DEFAULT 0,
  last_message_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_preview TEXT,
  first_response_at    TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  resolved_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversations_status_last ON conversations(status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_assigned ON conversations(assigned_user_id);

-- Mensagens
CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  wa_message_id   TEXT UNIQUE,
  type            TEXT NOT NULL DEFAULT 'text',
  body            TEXT,
  media_id        TEXT,
  media_mime      TEXT,
  status          TEXT NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'pending', 'sent', 'delivered', 'read', 'failed')),
  error           TEXT,
  sender_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- Tags / etiquetas
CREATE TABLE IF NOT EXISTS tags (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#E03131',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_tags (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id          INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);

-- Tags padrão da SOS Buscas
INSERT INTO tags (name, color) VALUES
  ('Placa', '#E03131'),
  ('Chassi', '#F08C00'),
  ('CRLV', '#1971C2'),
  ('Reclamação', '#C2255C'),
  ('Dúvida', '#2F9E44')
ON CONFLICT (name) DO NOTHING;
