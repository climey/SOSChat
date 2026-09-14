-- Vários números de WhatsApp (contas), cada um com sua sessão
CREATE TABLE IF NOT EXISTS wa_accounts (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conta padrão "Principal" (herda a sessão já existente, se houver)
INSERT INTO wa_accounts (id, name)
SELECT 1, 'Principal' WHERE NOT EXISTS (SELECT 1 FROM wa_accounts);
SELECT setval(pg_get_serial_sequence('wa_accounts', 'id'), GREATEST(1, (SELECT MAX(id) FROM wa_accounts)));

-- Sessão passa a ser por conta
ALTER TABLE wa_auth ADD COLUMN IF NOT EXISTS account_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE wa_auth DROP CONSTRAINT IF EXISTS wa_auth_pkey;
ALTER TABLE wa_auth ADD PRIMARY KEY (account_id, key);
ALTER TABLE wa_auth ALTER COLUMN account_id DROP DEFAULT;
ALTER TABLE wa_auth DROP CONSTRAINT IF EXISTS wa_auth_account_fk;
ALTER TABLE wa_auth ADD CONSTRAINT wa_auth_account_fk FOREIGN KEY (account_id) REFERENCES wa_accounts(id) ON DELETE CASCADE;

-- Cada conversa pertence ao número por onde o cliente falou
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES wa_accounts(id) ON DELETE SET NULL;
UPDATE conversations SET account_id = 1 WHERE account_id IS NULL AND EXISTS (SELECT 1 FROM wa_accounts WHERE id = 1);
CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(account_id);
