-- Distribuição automática de conversas: status "offline" (expediente encerrado), quem recebe novas,
-- setor do atendente, rodízio e registro de cada distribuição
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_availability_check;
ALTER TABLE users ADD CONSTRAINT users_availability_check CHECK (availability IN ('available', 'away', 'offline'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS receives_new BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sector_id INTEGER REFERENCES sectors(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_assigned_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS distribution_log (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  from_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_distribution_log_conv ON distribution_log(conversation_id);
CREATE INDEX IF NOT EXISTS idx_distribution_log_user ON distribution_log(user_id, created_at);

INSERT INTO app_settings (key, value) VALUES
  ('distribution_enabled', '0'),
  ('distribution_waiting_limit', '5'),
  ('distribution_affinity', '1'),
  ('distribution_handoff', '1'),
  ('distribution_offline_grace_seconds', '120')
ON CONFLICT (key) DO NOTHING;
