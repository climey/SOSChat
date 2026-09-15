-- Edição e exclusão de mensagens
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Foto de perfil dos contatos (armazenada em media_files)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_media_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;
