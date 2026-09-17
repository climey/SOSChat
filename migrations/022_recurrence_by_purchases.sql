-- Recorrencia passa a ser medida pelas consultas adquiridas, nao por dias com contato.
-- Estatisticas de compra guardadas no contato para a lista e os filtros ficarem rapidos.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS credits_bought    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS purchases_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_purchase_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_purchase_at  TIMESTAMPTZ;

WITH s AS (
  SELECT contact_id, COALESCE(SUM(credits), 0)::int AS credits, COUNT(*)::int AS n,
         MIN(created_at) AS first_at, MAX(created_at) AS last_at
    FROM purchases GROUP BY contact_id
)
UPDATE contacts ct
   SET credits_bought = s.credits, purchases_count = s.n, first_purchase_at = s.first_at, last_purchase_at = s.last_at
  FROM s WHERE s.contact_id = ct.id;
CREATE INDEX IF NOT EXISTS idx_contacts_purchase_stats ON contacts(credits_bought, purchases_count, last_purchase_at);

-- Regras novas (Configuracoes > Recorrencia de clientes)
INSERT INTO app_settings (key, value) VALUES
  ('recurrence_occasional_credits', '2'),
  ('recurrence_recurrent_credits', '10'),
  ('recurrence_recurrent_purchases', '3'),
  ('recurrence_recurrent_span_days', '30'),
  ('recurrence_loyal_credits', '25'),
  ('recurrence_loyal_purchases', '5')
ON CONFLICT (key) DO NOTHING;

-- Regras antigas (contagem por mensagens) saem de cena
DELETE FROM app_settings WHERE key IN ('recurrence_occasional_min', 'recurrence_recurrent_min', 'recurrence_min_span_days');
