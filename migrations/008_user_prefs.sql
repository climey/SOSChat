-- Fixar, silenciar e ocultar passam a ser preferências de cada atendente
CREATE TABLE IF NOT EXISTS conversation_prefs (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  muted           BOOLEAN NOT NULL DEFAULT FALSE,
  hidden          BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_prefs_user ON conversation_prefs(user_id);

-- Preserva o que já estava marcado (valia para todos) como preferência dos atendentes atuais
INSERT INTO conversation_prefs (conversation_id, user_id, pinned, muted, hidden)
SELECT c.id, u.id, c.pinned, c.muted, c.hidden
  FROM conversations c CROSS JOIN users u
 WHERE (c.pinned OR c.muted OR c.hidden) AND u.active = TRUE
ON CONFLICT DO NOTHING;

ALTER TABLE conversations DROP COLUMN IF EXISTS pinned;
ALTER TABLE conversations DROP COLUMN IF EXISTS muted;
ALTER TABLE conversations DROP COLUMN IF EXISTS hidden;
