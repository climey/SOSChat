-- Recorrente exige contatos espalhados no tempo: minimo de dias entre o primeiro e o ultimo contato
INSERT INTO app_settings (key, value) VALUES ('recurrence_min_span_days', '30') ON CONFLICT (key) DO NOTHING;
