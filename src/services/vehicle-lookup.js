/**
 * Pré-consulta de placa: busca os dados básicos do veículo em um site público (Ke Placa),
 * guarda em cache e monta a mensagem de confirmação para o cliente.
 *
 * Cuidados: uma busca por vez, com intervalo mínimo entre elas; cache por 30 dias; tempo limite curto.
 * Se o site bloquear ou mudar, a busca falha de forma controlada e o atendente vê "não foi possível".
 */
const db = require('../db');

const SOURCE = 'keplaca';
const BASE_URL = 'https://www.keplaca.com/placa/';
const CACHE_DAYS = 30;
const MIN_INTERVAL_MS = 1500;
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const FIELD_MAP = {
  marca: 'marca', modelo: 'modelo', importado: 'importado', ano: 'ano', 'ano modelo': 'ano_modelo', cor: 'cor',
  cilindrada: 'cilindrada', potencia: 'potencia', 'potência': 'potencia', 'combustível': 'combustivel', combustivel: 'combustivel',
  chassi: 'chassi', motor: 'motor', passageiros: 'passageiros', uf: 'uf', 'município': 'municipio', municipio: 'municipio', segmento: 'segmento',
  'espécie': 'especie', especie: 'especie', categoria: 'categoria',
};

const DEFAULT_TEMPLATE = [
  'Encontrei este veículo para a placa {placa}:',
  '',
  '🚗 {marca} {modelo}',
  '📅 Ano {ano} · Cor {cor}',
  '⛽ {combustivel} · {potencia}',
  '📍 {municipio}/{uf}',
  '🔢 Chassi final {chassi}',
  '',
  'É esse mesmo o veículo que você quer consultar?',
].join('\n');

const decode = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/<[^>]+>/g, '').trim();

const normalizePlate = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isPlate = (p) => /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p);

/** Extrai os campos do HTML da página da placa. Devolve { found, fields, fipe }. */
function parse(html, plate) {
  const src = String(html || '');
  if (/A placa n[ãa]o foi encontrada/i.test(src) || !/<b>\s*Marca:\s*<\/b>/i.test(src)) return { found: false, fields: {}, fipe: [] };
  const fields = {};
  const rowRe = /<tr><td[^>]*><b>([^<]+?):<\/b><\/td><td>([^<]*)<\/td><\/tr>/g;
  let m;
  while ((m = rowRe.exec(src))) {
    const key = FIELD_MAP[decode(m[1]).toLowerCase()];
    if (key && !fields[key]) fields[key] = decode(m[2]);
  }
  if (fields.chassi) fields.chassi = fields.chassi.replace(/^\*+/, '…');
  if (fields.motor) fields.motor = fields.motor.replace(/^\*+/, '…');
  const fipe = [];
  const fipeRe = /<tr><td>FIPE: ([^<]+)<\/td><\/tr><tr><td>Modelo: ([^<]+)<\/td><\/tr><tr><td>Valor: ([^<]+)<\/td><\/tr>/g;
  while ((m = fipeRe.exec(src)) && fipe.length < 5) fipe.push({ codigo: decode(m[1]), modelo: decode(m[2]), valor: decode(m[3]) });
  const title = (src.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  return { found: Boolean(fields.marca || fields.modelo), fields, fipe, title: decode(title), plate };
}

// ---------- Busca com fila (uma por vez, intervalo mínimo) ----------
let fetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/html' }, redirect: 'follow', signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally { clearTimeout(timer); }
};
/** Troca a função de busca (usado nos testes para não acessar a internet). */
function _setFetcher(fn) { fetcher = fn; }

let chain = Promise.resolve();
let lastAt = 0;
function queued(task) {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await task(); } finally { lastAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

async function fetchFromSite(plate) {
  const { status, text } = await queued(() => fetcher(BASE_URL + plate));
  if (status === 404) return { status: 'not_found', data: null };
  if (status !== 200) throw new Error(`site respondeu ${status}`);
  const parsed = parse(text, plate);
  if (!parsed.found) return { status: 'not_found', data: null };
  return { status: 'found', data: { fields: parsed.fields, fipe: parsed.fipe, title: parsed.title } };
}

/** Busca a placa (cache de 30 dias). Devolve { plate, status: found|not_found|error, data, fetched_at, cached, error }. */
async function lookup(raw, { force = false } = {}) {
  const plate = normalizePlate(raw);
  if (!isPlate(plate)) return { plate, status: 'invalid', data: null, error: 'Placa inválida' };
  if (!force) {
    const { rows } = await db.query(
      `SELECT status, data, fetched_at FROM vehicle_lookups WHERE plate = $1 AND source = $2 AND fetched_at > NOW() - make_interval(days => $3)`,
      [plate, SOURCE, CACHE_DAYS]
    );
    if (rows.length && rows[0].status !== 'error') return { plate, status: rows[0].status, data: rows[0].data, fetched_at: rows[0].fetched_at, cached: true };
  }
  let result;
  try {
    result = await fetchFromSite(plate);
  } catch (err) {
    await db.query(
      `INSERT INTO vehicle_lookups (plate, source, status, data, error, fetched_at) VALUES ($1, $2, 'error', NULL, $3, NOW())
       ON CONFLICT (plate, source) DO UPDATE SET status = 'error', error = EXCLUDED.error, fetched_at = NOW()`,
      [plate, SOURCE, String(err.message || err).slice(0, 200)]
    );
    return { plate, status: 'error', data: null, error: 'Não foi possível consultar o site agora', cached: false };
  }
  await db.query(
    `INSERT INTO vehicle_lookups (plate, source, status, data, error, fetched_at) VALUES ($1, $2, $3, $4, NULL, NOW())
     ON CONFLICT (plate, source) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, error = NULL, fetched_at = NOW()`,
    [plate, SOURCE, result.status, result.data ? JSON.stringify(result.data) : null]
  );
  return { plate, status: result.status, data: result.data, fetched_at: new Date().toISOString(), cached: false };
}

/** Preenche o modelo de mensagem com os dados do veículo; linhas cujo dado está vazio somem. */
function renderMessage(template, plate, data) {
  const f = (data && data.fields) || {};
  const vars = { placa: plate, ...f };
  const lines = String(template || DEFAULT_TEMPLATE).split('\n').map((line) => {
    let missing = false;
    const out = line.replace(/\{(\w+)\}/g, (_, k) => {
      const v = vars[k];
      if (v === undefined || v === null || v === '') { missing = true; return ''; }
      return String(v);
    });
    return missing && /\{/.test(line) ? null : out;
  }).filter((l) => l !== null);
  // remove linhas em branco duplicadas que sobraram
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function settings() {
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('vehicle_lookup_mode', 'vehicle_preview_template')`);
  const out = { mode: 'suggest', template: DEFAULT_TEMPLATE };
  for (const r of rows) {
    if (r.key === 'vehicle_lookup_mode' && ['off', 'suggest', 'auto'].includes(r.value)) out.mode = r.value;
    if (r.key === 'vehicle_preview_template' && r.value.trim()) out.template = r.value;
  }
  return out;
}

/** Envia a mensagem de confirmação do veículo para a conversa. `user` pode ser o sistema (auto). */
async function sendPreview(conversationId, plate, user, { auto = false } = {}) {
  const outbound = require('./outbound');
  const res = await lookup(plate);
  if (res.status !== 'found') throw new outbound.SendError(404, res.status === 'not_found' ? 'Placa não encontrada no site' : (res.error || 'Placa inválida'));
  const { template } = await settings();
  const body = renderMessage(template, res.plate, res.data);
  const sent = await outbound.sendText(conversationId, user, body, { auto });
  await db.query(
    `INSERT INTO vehicle_previews (conversation_id, plate, message_id, user_id, sent_at) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (conversation_id, plate) DO UPDATE SET message_id = EXCLUDED.message_id, user_id = EXCLUDED.user_id, sent_at = NOW()`,
    [conversationId, res.plate, sent.message.id, user.id || null]
  );
  return { ...sent, plate: res.plate, body };
}

async function previewSentAt(conversationId, plate) {
  const { rows } = await db.query('SELECT sent_at FROM vehicle_previews WHERE conversation_id = $1 AND plate = $2', [conversationId, normalizePlate(plate)]);
  return rows.length ? rows[0].sent_at : null;
}

const SYSTEM_USER = { id: null, name: 'Pré-consulta automática', avatar_media_id: null, role: 'system' };

/**
 * Modo automático: quando chega mensagem do cliente com uma placa válida, busca e envia a confirmação
 * (uma vez por placa em cada conversa). Erros nunca derrubam o fluxo da mensagem.
 */
async function maybeAutoPreview(message, conversation) {
  try {
    if (!message || message.direction !== 'in' || message.type !== 'text' || !message.body) return;
    const { mode } = await settings();
    if (mode !== 'auto') return;
    const RefCheck = require('../../public/js/refcheck.js');
    const plates = RefCheck.detect(message.body).filter((r) => r.kind === 'placa' && r.ok).map((r) => r.value);
    for (const plate of [...new Set(plates)].slice(0, 2)) {
      if (await previewSentAt(conversation.id, plate)) continue;
      const res = await lookup(plate);
      if (res.status !== 'found') continue;
      await sendPreview(conversation.id, plate, SYSTEM_USER, { auto: true });
    }
  } catch (err) {
    console.warn('[pré-consulta] falha no modo automático:', err.message);
  }
}

module.exports = { lookup, parse, renderMessage, sendPreview, previewSentAt, maybeAutoPreview, settings, normalizePlate, isPlate, DEFAULT_TEMPLATE, SYSTEM_USER, _setFetcher };
