-- Ações da lista de conversas: fixar, silenciar, ocultar; bloqueio de contato
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_conversations_pinned ON conversations(pinned) WHERE pinned;
