-- Os planos da SOS nao vencem: exemplos iniciais passam a ser sem validade
UPDATE plans SET validity_days = NULL
 WHERE validity_days = 30 AND name IN ('Plano 3 consultas', 'Plano 5 consultas', 'Plano 10 consultas');
UPDATE contacts ct SET plan_expires_at = NULL
  FROM plans p WHERE p.id = ct.plan_id AND p.validity_days IS NULL AND ct.plan_expires_at IS NOT NULL;
