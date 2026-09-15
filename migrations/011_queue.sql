-- Fila de espera: attended = alguém já assumiu ou respondeu a conversa.
-- Esperando = abertas e não atendidas (fila); Entrada = abertas em atendimento.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS attended BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE conversations SET attended = TRUE WHERE first_response_at IS NOT NULL OR assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_queue ON conversations(status, attended, created_at);
