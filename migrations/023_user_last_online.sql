-- Ultima vez que o atendente esteve conectado, para o painel "Equipe" mostrar quem esta offline e ha quanto tempo
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_online_at TIMESTAMPTZ;
