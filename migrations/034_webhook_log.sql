-- Registro do que chega da Meta no webhook (sobrevive a reinícios): por número oficial e no geral
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;
