-- Setores (departamentos) das conversas
CREATE TABLE IF NOT EXISTS sectors (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#868e96',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sectors (name, color, is_default) SELECT 'Geral', '#868e96', TRUE WHERE NOT EXISTS (SELECT 1 FROM sectors);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sector_id INTEGER REFERENCES sectors(id) ON DELETE SET NULL;
UPDATE conversations SET sector_id = (SELECT id FROM sectors WHERE is_default LIMIT 1) WHERE sector_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_sector ON conversations(sector_id);

-- Respostas rápidas: qualquer atendente pode criar; guarda quem criou
ALTER TABLE quick_replies ALTER COLUMN created_by DROP NOT NULL;
