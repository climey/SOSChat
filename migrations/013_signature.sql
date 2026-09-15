-- Assinatura livre do atendente (texto que vai no início da mensagem quando "Assinar" está ligado)
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature TEXT;
