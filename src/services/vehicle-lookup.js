/**
 * Pré-consulta de placa ou chassi: busca os dados básicos do veículo em um site público (Ke Placa),
 * guarda em cache e monta a mensagem de confirmação para o cliente.
 *
 * O site fica atrás da Cloudflare e só aceita navegador de verdade: a busca é feita por um Chromium
 * headless (puppeteer-core + Chromium do sistema), que abre sob demanda e fecha quando fica ocioso.
 * Sem Chromium disponível, tenta o fetch comum (que costuma ser barrado) e informa o motivo.
 *
 * Cuidados: uma busca por vez, com intervalo mínimo entre elas; cache por 30 dias; tempo limite curto.
 */
const db = require('../db');
const fs = require('fs');
const { execSync } = require('child_process');

const SOURCE = 'keplaca';
const URLS = { placa: 'https://www.keplaca.com/placa/', chassi: 'https://www.keplaca.com/chassi/' };
const KIND_LABEL = { placa: 'a placa', chassi: 'o chassi' };
const CACHE_DAYS = 30;
const MIN_INTERVAL_MS = 1500;
const TIMEOUT_MS = 20000;
const BROWSER_IDLE_MS = 2 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const FIELD_MAP = {
  marca: 'marca', modelo: 'modelo', importado: 'importado', ano: 'ano', 'ano modelo': 'ano_modelo', cor: 'cor',
  cilindrada: 'cilindrada', potencia: 'potencia', 'potência': 'potencia', 'combustível': 'combustivel', combustivel: 'combustivel',
  chassi: 'chassi', motor: 'motor', passageiros: 'passageiros', uf: 'uf', 'município': 'municipio', municipio: 'municipio', segmento: 'segmento',
  'espécie': 'especie', especie: 'especie', 'especie veiculo': 'especie', 'espécie veículo': 'especie', categoria: 'categoria', placa: 'placa',
};

const DEFAULT_TEMPLATE = [
  'Encontrei este veículo para {tipo} {referencia}:',
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

const normalizeRef = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normalizePlate = normalizeRef;
const isPlate = (p) => /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p);
const isChassi = (c) => /^[A-HJ-NPR-Z0-9]{17}$/.test(c);
/** Descobre o tipo pelo tamanho do valor: 7 caracteres é placa, 17 é chassi. */
function kindOf(ref, hint) {
  if (hint === 'chassi' || hint === 'placa') return hint;
  if (ref.length === 7) return 'placa';
  if (ref.length === 17) return 'chassi';
  return null;
}

/** Extrai os campos do HTML da página (placa ou chassi têm a mesma tabela). Devolve { found, fields, fipe }. */
function parse(html, ref) {
  const src = String(html || '');
  if (/n[ãa]o foi encontrad[ao]/i.test(src) || !/<b>\s*Marca:\s*<\/b>/i.test(src)) return { found: false, fields: {}, fipe: [] };
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
  return { found: Boolean(fields.marca || fields.modelo), fields, fipe, title: decode(title), ref, plate: ref };
}

const isBlocked = (html) => /Attention Required!\s*\|\s*Cloudflare|Just a moment/i.test(String(html || ''));

// ---------- Chromium headless (abre sob demanda, fecha quando ocioso) ----------
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) { if (fs.existsSync(c)) return c; continue; }
    try { const p = execSync(process.platform === 'win32' ? `where ${c}` : `which ${c}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim(); if (p) return p; } catch { /* não está no PATH */ }
  }
  return null;
}

let browser = null;
let browserIdleTimer = null;
async function getBrowser() {
  if (browser && browser.connected) return browser;
  const exe = findChrome();
  if (!exe) throw new Error('Chromium não encontrado no servidor');
  const puppeteer = require('puppeteer-core');
  browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--lang=pt-BR'],
  });
  browser.on('disconnected', () => { browser = null; });
  console.log('[pré-consulta] Chromium aberto:', exe);
  return browser;
}
function scheduleBrowserClose() {
  clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(async () => {
    const b = browser; browser = null;
    try { if (b) await b.close(); console.log('[pré-consulta] Chromium fechado por ociosidade'); } catch { /* já fechado */ }
  }, BROWSER_IDLE_MS);
  if (browserIdleTimer.unref) browserIdleTimer.unref();
}

async function fetchViaBrowser(url) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });
    await page.setViewport({ width: 1280, height: 900 });
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    let status = resp ? resp.status() : 0;
    let html = await page.content();
    // desafio "Just a moment": o próprio Chromium resolve em alguns segundos e a página recarrega
    for (let i = 0; i < 4 && /Just a moment/i.test(html); i++) {
      await new Promise((r) => setTimeout(r, 2500));
      html = await page.content();
      status = 200;
    }
    return { status, text: html };
  } finally {
    await page.close().catch(() => {});
    scheduleBrowserClose();
  }
}

async function fetchViaHttp(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/html' }, redirect: 'follow', signal: controller.signal });
    return { status: res.status, text: await res.text() };
  } finally { clearTimeout(timer); }
}

/** Estratégia padrão: Chromium; sem ele, fetch comum. */
let fetcher = async (url) => {
  if (findChrome()) return fetchViaBrowser(url);
  return fetchViaHttp(url);
};
/** Troca a função de busca (usado nos testes para não acessar a internet). */
function _setFetcher(fn) { fetcher = fn; }
function browserAvailable() { return Boolean(findChrome()); }

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

async function fetchFromSite(kind, ref) {
  const { status, text } = await queued(() => fetcher(URLS[kind] + ref));
  if (status === 404) return { status: 'not_found', data: null };
  if (isBlocked(text)) throw new Error(`o site barrou a consulta (Cloudflare, ${status})${findChrome() ? '' : '; o servidor está sem Chromium'}`);
  if (status !== 200) throw new Error(`site respondeu ${status}`);
  const parsed = parse(text, ref);
  if (!parsed.found) return { status: 'not_found', data: null };
  return { status: 'found', data: { fields: parsed.fields, fipe: parsed.fipe, title: parsed.title } };
}

/**
 * Busca a placa ou o chassi (cache de 30 dias).
 * Devolve { kind, ref, plate, status: found|not_found|error|invalid, data, fetched_at, cached, error }.
 */
async function lookup(raw, { force = false, kind: hint = null } = {}) {
  const ref = normalizeRef(raw);
  const kind = kindOf(ref, hint);
  if (!kind || (kind === 'placa' && !isPlate(ref)) || (kind === 'chassi' && !isChassi(ref))) {
    return { kind, ref, plate: ref, status: 'invalid', data: null, error: kind === 'chassi' ? 'Chassi inválido (17 caracteres, sem I, O e Q)' : (kind === 'placa' ? 'Placa inválida' : 'Informe uma placa (7 caracteres) ou um chassi (17)') };
  }
  if (!force) {
    const { rows } = await db.query(
      `SELECT status, data, fetched_at FROM vehicle_lookups WHERE kind = $1 AND plate = $2 AND source = $3 AND fetched_at > NOW() - make_interval(days => $4)`,
      [kind, ref, SOURCE, CACHE_DAYS]
    );
    if (rows.length && rows[0].status !== 'error') return { kind, ref, plate: ref, status: rows[0].status, data: rows[0].data, fetched_at: rows[0].fetched_at, cached: true };
  }
  let result;
  try {
    result = await fetchFromSite(kind, ref);
  } catch (err) {
    const detail = String(err.message || err).slice(0, 200);
    console.warn(`[pré-consulta] ${kind} ${ref}: ${detail}`);
    await db.query(
      `INSERT INTO vehicle_lookups (kind, plate, source, status, data, error, fetched_at) VALUES ($1, $2, $3, 'error', NULL, $4, NOW())
       ON CONFLICT (kind, plate, source) DO UPDATE SET status = 'error', error = EXCLUDED.error, fetched_at = NOW()`,
      [kind, ref, SOURCE, detail]
    );
    return { kind, ref, plate: ref, status: 'error', data: null, error: `Não foi possível consultar agora: ${detail}`, cached: false };
  }
  await db.query(
    `INSERT INTO vehicle_lookups (kind, plate, source, status, data, error, fetched_at) VALUES ($1, $2, $3, $4, $5, NULL, NOW())
     ON CONFLICT (kind, plate, source) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, error = NULL, fetched_at = NOW()`,
    [kind, ref, SOURCE, result.status, result.data ? JSON.stringify(result.data) : null]
  );
  return { kind, ref, plate: ref, status: result.status, data: result.data, fetched_at: new Date().toISOString(), cached: false };
}

/**
 * Preenche o modelo de mensagem com os dados do veículo; linhas cujo dado está vazio somem.
 * Se o modelo personalizado ficar vazio (ex.: escrito só com {placa} e a busca foi por chassi), usa o padrão.
 */
function renderMessage(template, ref, data, kind = 'placa') {
  const out = fillTemplate(template, ref, data, kind);
  return out || fillTemplate(DEFAULT_TEMPLATE, ref, data, kind);
}
function fillTemplate(template, ref, data, kind) {
  const f = (data && data.fields) || {};
  const vars = {
    ...f,
    tipo: KIND_LABEL[kind] || 'a referência',
    referencia: ref,
    placa: f.placa || (kind === 'placa' ? ref : ''),
    chassi: f.chassi || (kind === 'chassi' ? ref : ''),
  };
  const lines = String(template || DEFAULT_TEMPLATE).split('\n').map((line) => {
    let missing = false;
    const out = line.replace(/\{(\w+)\}/g, (_, k) => {
      const v = vars[k];
      if (v === undefined || v === null || v === '') { missing = true; return ''; }
      return String(v);
    });
    return missing && /\{/.test(line) ? null : out;
  }).filter((l) => l !== null);
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
async function sendPreview(conversationId, raw, user, { auto = false, kind = null } = {}) {
  const outbound = require('./outbound');
  const res = await lookup(raw, { kind });
  if (res.status !== 'found') throw new outbound.SendError(404, res.status === 'not_found' ? 'Veículo não encontrado no site' : (res.error || 'Referência inválida'));
  const { template } = await settings();
  const body = renderMessage(template, res.ref, res.data, res.kind);
  const sent = await outbound.sendText(conversationId, user, body, { auto });
  await db.query(
    `INSERT INTO vehicle_previews (conversation_id, kind, plate, message_id, user_id, sent_at) VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (conversation_id, kind, plate) DO UPDATE SET message_id = EXCLUDED.message_id, user_id = EXCLUDED.user_id, sent_at = NOW()`,
    [conversationId, res.kind, res.ref, sent.message.id, user.id || null]
  );
  return { ...sent, kind: res.kind, ref: res.ref, plate: res.ref, body };
}

async function previewSentAt(conversationId, raw, kind = null) {
  const ref = normalizeRef(raw);
  const k = kindOf(ref, kind);
  if (!k) return null;
  const { rows } = await db.query('SELECT sent_at FROM vehicle_previews WHERE conversation_id = $1 AND kind = $2 AND plate = $3', [conversationId, k, ref]);
  return rows.length ? rows[0].sent_at : null;
}

const SYSTEM_USER = { id: null, name: 'Pré-consulta automática', avatar_media_id: null, role: 'system' };

/**
 * Modo automático: quando chega mensagem do cliente com placa ou chassi válido, busca e envia a
 * confirmação (uma vez por referência em cada conversa). Erros nunca derrubam o fluxo da mensagem.
 */
async function maybeAutoPreview(message, conversation) {
  try {
    if (!message || message.direction !== 'in' || message.type !== 'text' || !message.body) return;
    const { mode } = await settings();
    if (mode !== 'auto') return;
    const RefCheck = require('../../public/js/refcheck.js');
    const refs = RefCheck.detect(message.body).filter((r) => (r.kind === 'placa' || r.kind === 'chassi') && r.ok).map((r) => ({ kind: r.kind, value: r.value }));
    const seen = new Set();
    for (const { kind, value } of refs) {
      if (seen.has(kind + value) || seen.size >= 2) continue;
      seen.add(kind + value);
      if (await previewSentAt(conversation.id, value, kind)) continue;
      const res = await lookup(value, { kind });
      if (res.status !== 'found') continue;
      await sendPreview(conversation.id, value, SYSTEM_USER, { auto: true, kind });
    }
  } catch (err) {
    console.warn('[pré-consulta] falha no modo automático:', err.message);
  }
}

async function shutdown() {
  clearTimeout(browserIdleTimer);
  const b = browser; browser = null;
  if (b) await b.close().catch(() => {});
}

module.exports = {
  lookup, parse, renderMessage, sendPreview, previewSentAt, maybeAutoPreview, settings, normalizePlate, normalizeRef, isPlate, isChassi, kindOf,
  DEFAULT_TEMPLATE, SYSTEM_USER, _setFetcher, browserAvailable, fetchViaBrowser, shutdown,
};
