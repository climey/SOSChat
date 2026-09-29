-- Números oficiais (Cloud API da Meta) convivendo com os números por QR code na mesma inbox.
-- provider: 'baileys' (QR code) ou 'cloud' (API oficial); os campos abaixo só valem para 'cloud'.
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'baileys';
ALTER TABLE wa_accounts DROP CONSTRAINT IF EXISTS wa_accounts_provider_check;
ALTER TABLE wa_accounts ADD CONSTRAINT wa_accounts_provider_check CHECK (provider IN ('baileys', 'cloud'));
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS phone_number_id TEXT;
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS waba_id TEXT;
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS access_token TEXT;
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS verified_name TEXT;
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS wa_accounts_phone_number_id_idx ON wa_accounts (phone_number_id) WHERE phone_number_id IS NOT NULL AND active = TRUE;
