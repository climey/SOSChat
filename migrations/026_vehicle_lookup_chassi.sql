-- Pre-consulta tambem por chassi: a chave passa a incluir o tipo da referencia (placa ou chassi)
ALTER TABLE vehicle_lookups ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'placa';
ALTER TABLE vehicle_lookups DROP CONSTRAINT IF EXISTS vehicle_lookups_pkey;
ALTER TABLE vehicle_lookups ADD PRIMARY KEY (kind, plate, source);

ALTER TABLE vehicle_previews ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'placa';
ALTER TABLE vehicle_previews DROP CONSTRAINT IF EXISTS vehicle_previews_pkey;
ALTER TABLE vehicle_previews ADD PRIMARY KEY (conversation_id, kind, plate);
