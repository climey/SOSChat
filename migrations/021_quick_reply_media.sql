-- Respostas rapidas: midia anexada e respostas pessoais de cada atendente
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'team';
ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_visibility_check;
ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_visibility_check CHECK (visibility IN ('team', 'personal'));
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS media_id   TEXT;
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS media_name TEXT;
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS media_size INTEGER;
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS media_kind TEXT;
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Texto deixa de ser obrigatorio: uma resposta pode ser so uma imagem
ALTER TABLE quick_replies ALTER COLUMN body DROP NOT NULL;

-- Atalho unico entre as da equipe; nas pessoais, unico por atendente
ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_shortcut_key;
DROP INDEX IF EXISTS quick_replies_shortcut_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_quick_replies_team ON quick_replies (shortcut) WHERE visibility = 'team';
CREATE UNIQUE INDEX IF NOT EXISTS uq_quick_replies_personal ON quick_replies (created_by, shortcut) WHERE visibility = 'personal';
CREATE INDEX IF NOT EXISTS idx_quick_replies_owner ON quick_replies (visibility, created_by);
