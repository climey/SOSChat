-- A coluna last_online_at so passou a ser preenchida a partir da sua criacao, entao quem ja atendia
-- antes aparecia como "nunca entrou". Usa a ultima atividade conhecida como melhor estimativa.
UPDATE users u
   SET last_online_at = GREATEST(
         COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.sender_user_id = u.id), u.created_at),
         COALESCE((SELECT MAX(e.created_at) FROM contact_events e WHERE e.user_id = u.id), u.created_at)
       )
 WHERE u.last_online_at IS NULL;
