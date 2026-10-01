-- Finalização automática de conversas paradas e retorno do cliente reabrindo a mesma conversa
INSERT INTO app_settings (key, value) VALUES
  ('auto_resolve_enabled', '0'),
  ('auto_resolve_hours', '24'),
  ('return_window_days', '7')
ON CONFLICT (key) DO NOTHING;
