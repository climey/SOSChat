-- Distribuição: critério configurável (revezamento ou carga), afinidade com prazo e registro detalhado de cada decisão
ALTER TABLE distribution_log ADD COLUMN IF NOT EXISTS rule TEXT;
ALTER TABLE distribution_log ADD COLUMN IF NOT EXISTS details JSONB;
CREATE INDEX IF NOT EXISTS idx_distribution_log_created ON distribution_log(created_at DESC);

-- registros antigos: deduz a regra pelo texto do motivo
UPDATE distribution_log SET rule = CASE
    WHEN reason = 'afinidade' THEN 'afinidade'
    WHEN reason = 'rodízio' THEN 'carga'
    WHEN reason LIKE 'assumida de %' THEN 'assumida'
    WHEN reason LIKE 'voltou para a fila%' THEN 'devolvida'
    ELSE NULL END
 WHERE rule IS NULL;

INSERT INTO app_settings (key, value) VALUES
  ('distribution_mode', 'rodizio'),
  ('distribution_affinity_days', '30')
ON CONFLICT (key) DO NOTHING;
