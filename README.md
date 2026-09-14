# SOS Chat

Plataforma de atendimento via WhatsApp da **SOS Buscas Online**. Caixa de entrada compartilhada, tags, relatórios e integração oficial com a WhatsApp Business Cloud API (Meta).

Stack: Node.js + Express · PostgreSQL · Socket.IO · HTML/JS vanilla · Railway.

## Rodando localmente

Pré-requisitos: Node 20+ e um PostgreSQL acessível (local ou o do Railway).

```bash
cp .env.example .env      # edite DATABASE_URL, JWT_SECRET e SEED_ADMIN_PASSWORD
npm install
npm run migrate           # cria as tabelas
npm run seed              # cria o primeiro admin
npm run dev               # http://localhost:3000
```

Sem credenciais do WhatsApp o sistema roda em **modo simulado**: envios só aparecem no log. Com `ENABLE_DEV_SIMULATOR=true` aparece o botão **+ Simular** na inbox para injetar mensagens de clientes fictícios e testar o fluxo completo.

## Deploy no Railway

1. Crie um projeto no Railway e adicione um serviço **PostgreSQL**. Ele injeta `DATABASE_URL` automaticamente.
2. Adicione um serviço a partir deste repositório. O `railway.json` já define `npm run migrate && npm run seed && npm start` como comando de início e `/health` como healthcheck.
3. Variáveis de ambiente do serviço:
   - `NODE_ENV=production`
   - `JWT_SECRET` (string longa e aleatória, ex.: `openssl rand -hex 32`)
   - `APP_URL` (URL pública gerada pelo Railway)
   - `PGSSL=true` apenas se a `DATABASE_URL` apontar para o proxy público. Com a URL interna (`postgres.railway.internal`), deixe `false`.
   - `WA_PROVIDER=baileys` para login por QR code, ou as credenciais da Cloud API (ver abaixo)
   - `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL` e `SEED_ADMIN_PASSWORD` (mínimo 6 caracteres). O seed roda a cada deploy e só cria o admin se ele ainda não existir.
4. Gere um domínio público em *Settings → Networking*.

## Conectando o WhatsApp

O sistema suporta dois provedores, escolhidos pela variável `WA_PROVIDER`:

| Provedor | Como conecta | Prós | Contras |
|---|---|---|---|
| `baileys` (recomendado para começar) | QR code, como o WhatsApp Web | Funciona em minutos com qualquer número, sem aprovação da Meta | Não oficial: viola os termos do WhatsApp e há risco de banimento, principalmente em envios em massa |
| `cloud` (padrão) | WhatsApp Business Cloud API da Meta | Oficial, estável, sem risco de ban | Exige app na Meta, número dedicado e templates fora da janela de 24h |

### Opção A: QR code (Baileys)

1. Defina `WA_PROVIDER=baileys` no ambiente e reinicie.
2. Entre como admin em **Configurações → Integração WhatsApp**. O QR code aparece em poucos segundos.
3. No celular do número de atendimento: **WhatsApp → Dispositivos conectados → Conectar dispositivo** e leia o QR.
4. A sessão fica gravada na tabela `wa_auth` do Postgres e sobrevive a reinícios e redeploys. Use **Desconectar número** para trocar de número.

Mensagens enviadas pelo celular também aparecem na inbox (como "Celular"). Mídias recebidas são baixadas e guardadas na tabela `media_files` (limite de 25 MB por arquivo).

### Opção B: API oficial (Cloud API da Meta)

1. Em [developers.facebook.com](https://developers.facebook.com) crie um app do tipo **Business** e adicione o produto **WhatsApp**.
2. Em *WhatsApp → API Setup* copie o **Phone number ID** (`WA_PHONE_NUMBER_ID`). Gere um **token permanente** por um usuário de sistema no Business Manager com permissão `whatsapp_business_messaging` (`WA_ACCESS_TOKEN`).
3. Em *App Settings → Basic* copie o **App Secret** (`WA_APP_SECRET`). Ele valida a assinatura de cada webhook recebido.
4. Em *WhatsApp → Configuration → Webhook* informe:
   - Callback URL: `https://SEU-DOMINIO/webhook/whatsapp`
   - Verify token: o mesmo valor de `WA_VERIFY_TOKEN`
   - Assine o campo **messages**.
5. Regra dos 24h: a Meta só permite texto livre até 24h após a última mensagem do cliente. Fora dessa janela é preciso usar **templates aprovados** (ainda não implementado, ver roadmap).

## Estrutura

```
src/
  server.js            Express, Socket.IO, segurança (helmet, CSRF, cookies)
  config.js            variáveis de ambiente
  db.js                pool do pg + transações
  realtime.js          eventos em tempo real para a inbox
  middleware/auth.js   JWT em cookie httpOnly, papéis admin/agent
  services/
    whatsapp.js        fachada que escolhe o provedor (WA_PROVIDER)
    wa-cloud.js        provedor oficial: Cloud API da Meta (envio, leitura, mídia, assinatura)
    wa-baileys.js      provedor QR code: WhatsApp Web via Baileys, sessão no Postgres
    inbound.js         processa webhooks: contatos, conversas, mensagens, status
    conversations.js   consultas de conversas com contato, responsável e tags
  routes/
    auth.js            login/logout/me
    conversations.js   listar, ler, enviar, atribuir, finalizar, tags
    tags.js            CRUD de tags (admin)
    users.js           CRUD de atendentes (admin)
    reports.js         resumo, volume, por atendente, por tag
    webhook.js         GET verificação e POST mensagens da Meta
    media.js           proxy autenticado de mídias do WhatsApp
    whatsapp.js        status da conexão, QR code, reconectar, desconectar
    dev.js             simulador de mensagens (só fora de produção)
migrations/            SQL versionado, aplicado por scripts/migrate.js
public/                login, inbox, relatórios e configurações
```

## API (resumo)

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/auth/login` | `{email, password}` → cookie de sessão |
| GET | `/api/conversations?status=open\|resolved\|all&assigned=all\|me\|unassigned&tag=ID&q=` | lista |
| GET | `/api/conversations/:id/messages` | histórico |
| POST | `/api/conversations/:id/messages` | `{body}` envia texto |
| PATCH | `/api/conversations/:id` | `{status, assigned_user_id}` |
| PUT | `/api/conversations/:id/tags` | `{tag_ids: []}` |
| POST | `/api/conversations/:id/read` | zera não lidas e marca como lida na Meta |
| GET | `/api/reports/summary\|volume\|agents\|tags?from&to&group` | relatórios |
| GET/POST/PATCH/DELETE | `/api/tags`, `/api/users` | administração |

Toda chamada que altera dados exige o header `X-Requested-With: XMLHttpRequest` (proteção CSRF) e o cookie de sessão.

## Roadmap

- [x] **Etapa 1 (MVP):** inbox compartilhada em tempo real, tags, responsável, finalizar/reabrir, relatórios, webhook oficial, mídia recebida
- [x] **Etapa 1.5:** login por QR code (Baileys) como provedor alternativo, com sessão no Postgres
- [ ] **Etapa 2:** envio de mídia e templates (janela de 24h), notas internas, respostas rápidas
- [ ] **Etapa 3:** integração com a plataforma de consultas (detectar placa/chassi na mensagem e mostrar dados do veículo no painel lateral)
- [ ] **Etapa 4:** filas/departamentos, horário de atendimento com mensagem automática, distribuição automática
- [ ] **Etapa 5:** múltiplos números, exportação de relatórios em CSV, auditoria
