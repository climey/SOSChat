-- Mensagens e notas agendadas
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id                       SERIAL PRIMARY KEY,
  conversation_id          INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind                     TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'note')),
  body                     TEXT NOT NULL,
  send_at                  TIMESTAMPTZ NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  cancel_on_contact_reply  BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_on_agent_reply    BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_on_resolve        BOOLEAN NOT NULL DEFAULT TRUE,
  cancel_reason            TEXT,
  sent_message_id          INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  error                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at              TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_messages(status, send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_conversation ON scheduled_messages(conversation_id);
