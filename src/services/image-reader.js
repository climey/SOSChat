/**
 * Leitura de numeração em fotos: quando o cliente manda a foto da placa, do chassi ou do motor,
 * a imagem vai para o Claude (visão), que devolve o que leu de forma estruturada. O resultado entra
 * no mesmo fluxo de quem digitou o dado (conferência, cartão do veículo, confirmação ao cliente).
 *
 * A leitura é sempre manual: só quando o atendente clica em "Ler imagem" (cada leitura custa centavos).
 * Precisa de ANTHROPIC_API_KEY. O resultado fica guardado em image_readings; reler cobra de novo.
 */
const db = require('../db');
const realtime = require('../realtime');

const MODEL = process.env.VISION_MODEL || 'claude-opus-5';
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = /^image\/(jpeg|png|webp|gif)$/;

const SYSTEM = [
  'Você lê identificações de veículos brasileiros em fotos enviadas por clientes de uma empresa de consultas veiculares.',
  'Procure na foto: placa (7 caracteres: AAA9999 ou AAA9A99), chassi/VIN (17 caracteres, nunca contém I, O ou Q),',
  'número de motor (gravado no bloco do motor, geralmente letras e números) e Renavam (11 dígitos).',
  'Chassi e motor costumam estar estampados em metal, com sujeira, ferrugem, reflexo ou ângulo ruim: leia com cuidado,',
  'caractere por caractere, e informe onde ficou em dúvida (ex.: 8 ou B, 0 ou D, 5 ou S, 1 ou I, 2 ou Z).',
  'Responda SOMENTE com JSON, sem comentários, neste formato:',
  '{"items":[{"kind":"placa|chassi|motor|renavam","value":"LEITURA EM MAIÚSCULAS SEM ESPAÇOS","confidence":"alta|media|baixa",',
  '"alternativas":["outras leituras completas possíveis, no máximo 3"],"observacao":"frase curta sobre a dúvida, ou vazio"}]}',
  'Se a foto não mostrar nenhuma identificação de veículo, responda {"items":[]}.',
  'Não invente caracteres: se uma parte estiver ilegível, use "?" no lugar e marque confidence "baixa".',
].join('\n');

const PROMPT = 'Leia a identificação do veículo nesta foto e responda no formato JSON combinado.';

/** Chamada ao modelo (trocável nos testes). Devolve { items, usage, model }. */
let vision = async (buffer, mime) => {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' }, // leitura de caracteres: pensar pouco basta e sai mais barato
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  if (res.stop_reason === 'refusal') throw new Error('o modelo recusou ler esta imagem');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { items: parseItems(text), usage: res.usage, model: res.model };
};
function _setVision(fn) { vision = fn; }

/** Extrai o JSON da resposta (tolera texto em volta) e normaliza os itens. */
function parseItems(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  let json;
  try { json = JSON.parse(m[0]); } catch { return []; }
  const items = Array.isArray(json.items) ? json.items : [];
  const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9?]/g, '');
  const out = [];
  for (const it of items) {
    const kind = String(it.kind || '').toLowerCase();
    if (!['placa', 'chassi', 'motor', 'renavam'].includes(kind)) continue;
    const value = norm(it.value);
    if (!value || value.length < 4) continue;
    out.push({
      kind, value,
      confidence: ['alta', 'media', 'baixa'].includes(String(it.confidence || '').toLowerCase()) ? String(it.confidence).toLowerCase() : 'media',
      alternativas: (Array.isArray(it.alternativas) ? it.alternativas : []).map(norm).filter((a) => a && a !== value).slice(0, 3),
      observacao: String(it.observacao || '').slice(0, 200),
    });
  }
  return out.slice(0, 4);
}

async function mode() { return 'manual'; }
function configured() { return Boolean(process.env.ANTHROPIC_API_KEY); }

async function get(messageId) {
  const { rows } = await db.query('SELECT * FROM image_readings WHERE message_id = $1', [messageId]);
  return rows[0] || null;
}
async function listForConversation(conversationId) {
  const { rows } = await db.query('SELECT * FROM image_readings WHERE conversation_id = $1 ORDER BY message_id', [conversationId]);
  return rows;
}

async function save(messageId, conversationId, fields) {
  const { rows } = await db.query(
    `INSERT INTO image_readings (message_id, conversation_id, status, items, error, model, usage, requested_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (message_id) DO UPDATE SET status = EXCLUDED.status, items = EXCLUDED.items, error = EXCLUDED.error,
       model = COALESCE(EXCLUDED.model, image_readings.model), usage = COALESCE(EXCLUDED.usage, image_readings.usage),
       requested_by = COALESCE(EXCLUDED.requested_by, image_readings.requested_by), updated_at = NOW()
     RETURNING *`,
    [messageId, conversationId, fields.status, JSON.stringify(fields.items || []), fields.error || null, fields.model || null, fields.usage ? JSON.stringify(fields.usage) : null, fields.requested_by || null]
  );
  realtime.broadcast('reading:updated', rows[0]);
  return rows[0];
}

class ReadError extends Error { constructor(status, message) { super(message); this.status = status; } }

/**
 * Lê a foto de uma mensagem. Devolve a linha de image_readings (status done/error).
 * Com force=false, uma leitura já feita é devolvida sem gastar de novo.
 */
async function read(messageId, { force = false, requestedBy = null } = {}) {
  const { rows } = await db.query(
    `SELECT m.id, m.conversation_id, m.type, m.direction, m.media_id, m.media_mime, m.deleted_at, f.mime, f.size, f.data
       FROM messages m LEFT JOIN media_files f ON f.id = m.media_id WHERE m.id = $1`,
    [messageId]
  );
  const m = rows[0];
  if (!m) throw new ReadError(404, 'Mensagem não encontrada');
  if (m.type !== 'image' || !m.media_id || m.deleted_at) throw new ReadError(400, 'Esta mensagem não é uma foto');
  if (!configured()) throw new ReadError(503, 'Leitura de fotos não configurada no servidor');
  if (!force) {
    const existing = await get(messageId);
    if (existing && existing.status === 'done') return existing;
  }
  let buffer = m.data;
  let mime = String(m.mime || m.media_mime || '').toLowerCase().split(';')[0];
  if (!buffer) {
    // mídia que não está no banco (Cloud API): busca no provedor
    try {
      const media = await require('./whatsapp').fetchMedia(m.media_id);
      buffer = media.buffer; mime = String(media.mimeType || mime).toLowerCase().split(';')[0];
    } catch (err) {
      return save(messageId, m.conversation_id, { status: 'error', error: 'Não foi possível obter a foto', requested_by: requestedBy });
    }
  }
  if (!ACCEPTED.test(mime)) return save(messageId, m.conversation_id, { status: 'error', error: `Formato de imagem não suportado (${mime || 'desconhecido'})`, requested_by: requestedBy });
  if (buffer.length > MAX_BYTES) return save(messageId, m.conversation_id, { status: 'error', error: 'Foto grande demais para leitura (máx. 5 MB)', requested_by: requestedBy });

  await save(messageId, m.conversation_id, { status: 'pending', items: [], requested_by: requestedBy });
  try {
    const t = Date.now();
    const { items, usage, model } = await vision(buffer, mime);
    console.log(`[leitura-foto] mensagem ${messageId}: ${items.length} item(ns) em ${Date.now() - t} ms (${usage ? `${usage.input_tokens} in / ${usage.output_tokens} out` : 'sem uso'})`);
    return save(messageId, m.conversation_id, { status: 'done', items, model, usage, requested_by: requestedBy });
  } catch (err) {
    const detail = String(err.message || err).slice(0, 300);
    console.warn(`[leitura-foto] mensagem ${messageId} falhou (${err.status || 'sem status'}): ${detail}`);
    return save(messageId, m.conversation_id, { status: 'error', error: explainError(err), requested_by: requestedBy, model: MODEL, usage: { error: detail, status: err.status || null } });
  }
}

/** Motivo em linguagem simples para o atendente/admin, a partir do erro da API. */
function explainError(err) {
  const st = Number(err && err.status);
  const msg = String((err && err.message) || '');
  if (st === 401 || /invalid x-api-key|authentication/i.test(msg)) return 'Chave da API de leitura inválida ou vencida. Um administrador precisa atualizar ANTHROPIC_API_KEY no servidor.';
  if (st === 403 || /permission/i.test(msg)) return 'A chave da API de leitura não tem permissão para este uso.';
  if (/credit|billing|balance/i.test(msg)) return 'A conta da API de leitura está sem créditos. Adicione créditos no console da Anthropic.';
  if (st === 429 || /rate limit/i.test(msg)) return 'Limite de uso da leitura atingido por agora. Tente de novo em instantes.';
  if (st === 404 || /model/i.test(msg) && /not found|not exist/i.test(msg)) return 'Modelo de leitura indisponível (VISION_MODEL). Avise um administrador.';
  if (st === 413 || /too large|exceeds/i.test(msg)) return 'Foto grande demais para a leitura.';
  if (st >= 500 || /overloaded|timeout|ECONN|fetch failed/i.test(msg)) return 'Serviço de leitura instável agora. Tente de novo em instantes.';
  return 'Não consegui ler a foto agora';
}

module.exports = { read, get, listForConversation, mode, configured, parseItems, ReadError, _setVision, analyze: (buf, mime) => vision(buf, mime), MODEL };
