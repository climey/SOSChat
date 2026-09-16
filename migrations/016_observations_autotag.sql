-- Observacoes fixadas na ficha do contato (separadas das notas internas da conversa)
CREATE TABLE IF NOT EXISTS contact_notes (
  id         SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact ON contact_notes(contact_id, created_at DESC);

-- O campo livre antigo vira a primeira observacao do contato
INSERT INTO contact_notes (contact_id, body, created_at)
SELECT id, notes, created_at FROM contacts WHERE notes IS NOT NULL AND BTRIM(notes) <> '';
UPDATE contacts SET notes = NULL WHERE notes IS NOT NULL;

-- Etiqueta aplicada automaticamente a toda conversa nova que chega por um numero
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS auto_tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL;
