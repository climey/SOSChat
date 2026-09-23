-- Dados estruturados de mensagens especiais (ex.: contatos compartilhados: nomes e telefones do vCard)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta JSONB;
