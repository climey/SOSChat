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
2. Entre como admin em **Configurações → Números de WhatsApp**. A conta "Principal" já existe; clique em **Adicionar número** para cadastrar outros (ex.: Vendas, Suporte). Cada um gera seu próprio QR code.
3. No celular de cada número: **WhatsApp → Dispositivos conectados → Conectar dispositivo** e leia o QR correspondente.
4. As sessões ficam gravadas na tabela `wa_auth` do Postgres (uma por conta) e sobrevivem a reinícios e redeploys. **Desconectar** encerra a sessão para trocar o celular; **Remover** apaga a conta (as conversas ficam no histórico, sem número associado).

Todos os atendentes veem as conversas de todos os números em uma única caixa de entrada, com o marcador "via <nome do número>" e um filtro por número. A resposta sai automaticamente pelo número por onde o cliente falou. O mesmo cliente falando com dois números gera duas conversas separadas.

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
    whatsapp.js        contas de WhatsApp: status, QR code, adicionar, renomear, reconectar, desconectar, remover
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
| GET/POST/PATCH/DELETE | `/api/tags`, `/api/users`, `/api/plans` | administração (planos: catálogo de consultas) |
| GET/POST/PATCH/DELETE | `/api/quick-replies`, `/api/quick-replies/:id/media` | respostas rápidas da equipe ou pessoais, com mídia anexada |
| GET/PATCH/DELETE | `/api/contacts/:id` | ficha do contato (campos extras, exclusão só admin) |
| PUT/PATCH/DELETE, POST renew | `/api/contacts/:id/plan` | atribuir, ajustar, remover e renovar o plano de consultas |
| GET/POST/DELETE | `/api/contacts/:id/consultations` | registrar consulta (debita 1 do plano), estornar |
| GET/POST/PATCH/DELETE | `/api/contacts/:id/notes` | observações fixadas na ficha (separadas das notas internas da conversa) |
| GET | `/api/contacts/:id/events` | log de atividade do contato |
| PATCH | `/api/whatsapp/accounts/:id` | `{name, auto_tag_id}` renomeia o número e define a etiqueta automática das conversas novas |
| GET | `/api/reports/consultations?from&to&agent` | consultas por dia, tipo e atendente; situação dos planos |
| GET/POST/PATCH/DELETE | `/api/contacts/:id/purchases` | compras do cliente (planos atribuídos/renovados e avulsas com valor entram sozinhas; compra antiga à mão) |
| GET | `/api/reports/recurrence?from&to` | clientes por faixa (Novo/Ocasional/Recorrente/Fiel), inativos, mais frequentes, taxa de retorno |
| GET | `/api/conversations?recurrence=new\|occasional\|recurrent\|loyal\|inactive` | filtro por recorrência do cliente |

Toda chamada que altera dados exige o header `X-Requested-With: XMLHttpRequest` (proteção CSRF) e o cookie de sessão.

## Roadmap

- [x] **Etapa 1 (MVP):** inbox compartilhada em tempo real, tags, responsável, finalizar/reabrir, relatórios, webhook oficial, mídia recebida
- [x] **Etapa 1.5:** login por QR code (Baileys) como provedor alternativo, com sessão no Postgres
- [x] **Etapa 1.6:** vários números de WhatsApp na mesma inbox (modelo Umbler Talk), conversa amarrada ao número
- [x] **Etapa 1.7:** inbox no estilo Umbler Talk (abas Entrada/Esperando/Finalizados, notas internas, assinatura), envio de arquivos, busca na conversa, mensagens agendadas com cancelamento automático, player de áudio próprio
- [x] **Etapa 1.8:** menu de ações na conversa, preferências pessoais (fixar/silenciar/ocultar), respostas rápidas, transferência com nota, alerta de conversa parada, presença e "está digitando", ficha do contato, citação, reações, emojis, mensagem de voz (ffmpeg → OGG/Opus), atualização automática após deploy
- [x] **Etapa 1.9:** painel do contato no estilo Umbler (foto, abas Contato/Detalhes da conversa, observações, log de atividade, campos editáveis, bloquear/excluir) e **planos de consultas**: catálogo em Configurações, cartão de saldo no contato com chip `2/3` na lista e no cabeçalho, botão "Registrar consulta" (tipos configuráveis: Placa, Chassi, Motor, CRLV, CPF, CNPJ, Telefone, Nome completo, com detecção automática na conversa) que debita e gera nota interna, oferta de débito ao enviar PDF, aviso e etiqueta *Renovação* ao zerar, filtro por plano e relatório "Consultas e planos"
- [ ] **Etapa 2:** templates da Cloud API (janela de 24h), distribuição automática, saudação e horário de atendimento
- [ ] **Etapa 3:** integração com a plataforma de consultas (detectar placa/chassi na mensagem e mostrar dados do veículo no painel lateral)
- [ ] **Etapa 4:** filas/departamentos, horário de atendimento com mensagem automática, distribuição automática
- [ ] **Etapa 5:** relatórios por número, exportação em CSV, auditoria
