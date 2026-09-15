-- Foto de perfil do atendente (arquivo em media_files)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_media_id TEXT;
