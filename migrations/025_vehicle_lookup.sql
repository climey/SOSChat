-- Pre-consulta de placa: cache das buscas no site publico e registro do que ja foi enviado ao cliente
CREATE TABLE IF NOT EXISTS vehicle_lookups (
  plate      TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'keplaca',
  status     TEXT NOT NULL CHECK (status IN ('found', 'not_found', 'error')),
  data       JSONB,
  error      TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plate, source)
);

CREATE TABLE IF NOT EXISTS vehicle_previews (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  plate           TEXT NOT NULL,
  message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, plate)
);

INSERT INTO app_settings (key, value) VALUES ('vehicle_lookup_mode', 'suggest') ON CONFLICT (key) DO NOTHING;
