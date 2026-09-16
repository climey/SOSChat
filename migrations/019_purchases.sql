-- Compras do cliente: cada plano atribuido/renovado e cada consulta avulsa com valor vira uma compra
CREATE TABLE IF NOT EXISTS purchases (
  id              SERIAL PRIMARY KEY,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'plan' CHECK (kind IN ('plan', 'single')),
  description     TEXT NOT NULL,
  credits         INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  price_cents     INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchases_contact ON purchases(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);

-- Backfill: atribuicoes, trocas e renovacoes de plano ja registradas no log viram compras
INSERT INTO purchases (contact_id, user_id, kind, description, credits, price_cents, created_at)
SELECT e.contact_id, e.user_id, 'plan',
       (regexp_match(e.description, 'o plano (.+) \((\d+) consulta'))[1],
       ((regexp_match(e.description, 'o plano (.+) \((\d+) consulta'))[2])::int,
       (SELECT p.price_cents FROM plans p WHERE p.name = (regexp_match(e.description, 'o plano (.+) \((\d+) consulta'))[1] LIMIT 1),
       e.created_at
  FROM contact_events e
 WHERE e.type = 'plan'
   AND (e.description LIKE '% atribuiu o plano %' OR e.description LIKE '% trocou para o plano %' OR e.description LIKE '% renovou o plano %')
   AND e.description ~ 'o plano (.+) \((\d+) consulta'
   AND NOT EXISTS (SELECT 1 FROM purchases);
