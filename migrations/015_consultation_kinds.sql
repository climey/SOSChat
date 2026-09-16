-- Tipos de consulta passam a ser configuraveis (Configuracoes > Planos de consultas)
ALTER TABLE consultations DROP CONSTRAINT IF EXISTS consultations_kind_check;
UPDATE consultations SET kind = CASE kind
  WHEN 'placa' THEN 'Placa' WHEN 'chassi' THEN 'Chassi' WHEN 'crlv' THEN 'CRLV' WHEN 'outra' THEN 'Outra' ELSE kind END;
ALTER TABLE consultations ALTER COLUMN kind SET DEFAULT 'Placa';
INSERT INTO app_settings (key, value)
VALUES ('consultation_kinds', '["Placa","Chassi","Motor","CRLV","CPF","CNPJ","Telefone","Nome completo"]')
ON CONFLICT (key) DO NOTHING;
