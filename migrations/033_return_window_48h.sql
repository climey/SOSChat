-- Retorno do cliente: prazo padrão passa de 7 dias para 48 horas (2 dias).
-- Só troca se o valor ainda for o padrão anterior (não sobrescreve um prazo escolhido pelo admin).
UPDATE app_settings SET value = '2', updated_at = NOW() WHERE key = 'return_window_days' AND value = '7';
