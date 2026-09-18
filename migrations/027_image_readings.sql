-- Leitura de numeração (placa, chassi, motor) em fotos enviadas pelos clientes
CREATE TABLE IF NOT EXISTS image_readings (
  message_id      INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'done', 'error')),
  items           JSONB NOT NULL DEFAULT '[]'::jsonb,
  error           TEXT,
  model           TEXT,
  usage           JSONB,
  requested_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_image_readings_conversation ON image_readings(conversation_id);

INSERT INTO app_settings (key, value) VALUES ('image_read_mode', 'auto') ON CONFLICT (key) DO NOTHING;
