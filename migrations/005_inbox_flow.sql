-- Direção da última mensagem real (in = cliente falou por ultimo, fica em Entrada; out = atendente respondeu, fica em Esperando)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_direction TEXT;
UPDATE conversations c
   SET last_message_direction = (
     SELECT m.direction FROM messages m
      WHERE m.conversation_id = c.id AND m.type <> 'note'
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
   )
 WHERE last_message_direction IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_flow ON conversations(status, last_message_direction, last_message_at DESC);
