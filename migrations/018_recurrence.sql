-- Recorrencia do cliente: estatisticas guardadas no contato e atualizadas a cada mensagem recebida
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS interactions     INTEGER NOT NULL DEFAULT 0; -- dias distintos com mensagem do cliente
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS active_months    INTEGER NOT NULL DEFAULT 0; -- meses distintos com mensagem do cliente
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_contact_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS plan_renewals    INTEGER NOT NULL DEFAULT 0;

WITH s AS (
  SELECT c.contact_id,
         COUNT(DISTINCT date_trunc('day', m.created_at))::int   AS days,
         COUNT(DISTINCT date_trunc('month', m.created_at))::int AS months,
         MIN(m.created_at) AS first_at
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
   WHERE m.direction = 'in'
   GROUP BY c.contact_id
)
UPDATE contacts ct SET interactions = s.days, active_months = s.months, first_contact_at = s.first_at
  FROM s WHERE s.contact_id = ct.id;
UPDATE contacts SET first_contact_at = created_at WHERE first_contact_at IS NULL;
UPDATE contacts ct SET plan_renewals = (SELECT COUNT(*)::int FROM contact_events e WHERE e.contact_id = ct.id AND e.type = 'plan' AND e.description LIKE '%renovou o plano%');
CREATE INDEX IF NOT EXISTS idx_contacts_recurrence ON contacts(interactions, last_seen_at);

-- Regras (editaveis em Configuracoes > Recorrencia)
INSERT INTO app_settings (key, value) VALUES
  ('recurrence_occasional_min', '2'),
  ('recurrence_recurrent_min', '5'),
  ('recurrence_loyal_months', '6'),
  ('recurrence_inactive_days', '45')
ON CONFLICT (key) DO NOTHING;

-- Marcacao manual complementar
INSERT INTO tags (name, color) VALUES ('VIP', '#F59F00'), ('Parceiro', '#1098AD') ON CONFLICT (name) DO NOTHING;
