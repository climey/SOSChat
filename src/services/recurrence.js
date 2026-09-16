/**
 * Recorrência do cliente: faixa (Novo, Ocasional, Recorrente, Fiel) calculada a partir das estatísticas
 * guardadas no contato (dias com contato, meses ativos, primeiro e último contato) e das regras em app_settings.
 */
const db = require('../db');

const DEFAULTS = { occasional_min: 2, recurrent_min: 5, loyal_months: 6, inactive_days: 45 };
const LIMITS = { occasional_min: [2, 100], recurrent_min: [2, 1000], loyal_months: [1, 120], inactive_days: [7, 3650] };
const TIERS = { new: 'Novo', occasional: 'Ocasional', recurrent: 'Recorrente', loyal: 'Fiel' };
const FILTERS = ['new', 'occasional', 'recurrent', 'loyal', 'inactive'];
const MONTH_MS = 30.44 * 86400e3;

let cache = { at: 0, th: { ...DEFAULTS } };

function clampInt(v, [min, max], fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Regras atuais (cache de 30 s). */
async function thresholds(force = false) {
  if (!force && Date.now() - cache.at < 30000) return cache.th;
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key LIKE 'recurrence_%'`);
  const th = { ...DEFAULTS };
  for (const r of rows) {
    const k = r.key.replace('recurrence_', '');
    if (k in DEFAULTS) th[k] = clampInt(r.value, LIMITS[k], DEFAULTS[k]);
  }
  cache = { at: Date.now(), th };
  return th;
}
function invalidate() { cache.at = 0; }

/** Faixa de um contato (ou conversa, que traz os mesmos campos). */
function tierOf(c, th = cache.th, now = Date.now()) {
  const n = Number(c.interactions || 0);
  const months = Number(c.active_months || 0);
  const first = c.first_contact_at ? new Date(c.first_contact_at) : null;
  const monthsSince = first ? (now - first.getTime()) / MONTH_MS : 0;
  let tier = 'new';
  if (n >= th.recurrent_min && months >= 2) tier = monthsSince >= th.loyal_months ? 'loyal' : 'recurrent';
  else if (n >= th.occasional_min) tier = 'occasional';
  const last = c.last_seen_at ? new Date(c.last_seen_at) : null;
  const inactive = (tier === 'recurrent' || tier === 'loyal') && Boolean(last) && now - last.getTime() > th.inactive_days * 86400e3;
  return { tier, label: TIERS[tier], inactive, months_since_first: monthsSince, interactions: n, active_months: months };
}

/** Fragmento SQL (sobre o alias da tabela contacts) para filtrar por faixa. Os números vêm validados. */
function whereSql(filter, th, a = 'ct') {
  const rec = `(${a}.interactions >= ${th.recurrent_min} AND ${a}.active_months >= 2)`;
  const loyal = `(${rec} AND ${a}.first_contact_at <= NOW() - make_interval(months => ${th.loyal_months}))`;
  switch (filter) {
    case 'new': return `${a}.interactions < ${th.occasional_min}`;
    case 'occasional': return `(${a}.interactions >= ${th.occasional_min} AND NOT ${rec})`;
    case 'recurrent': return `(${rec} AND NOT ${loyal})`;
    case 'loyal': return loyal;
    case 'inactive': return `(${rec} AND ${a}.last_seen_at < NOW() - make_interval(days => ${th.inactive_days}))`;
    default: return null;
  }
}

/** Expressão SQL que devolve a faixa ('new'|'occasional'|'recurrent'|'loyal') de cada linha. */
function tierSql(th, a = 'ct') {
  return `CASE WHEN ${whereSql('loyal', th, a)} THEN 'loyal' WHEN ${whereSql('recurrent', th, a)} THEN 'recurrent'
               WHEN ${a}.interactions >= ${th.occasional_min} THEN 'occasional' ELSE 'new' END`;
}

/**
 * Recalcula as estatísticas do contato a partir das mensagens recebidas e registra marcos no log
 * (primeiro contato, virou recorrente, virou fiel). Chamado a cada mensagem do cliente.
 */
async function refreshContact(contactId, client = db) {
  const th = await thresholds();
  const { rows: before } = await client.query('SELECT interactions, active_months, first_contact_at, last_seen_at FROM contacts WHERE id = $1', [contactId]);
  if (!before.length) return null;
  const { rows } = await client.query(
    `WITH s AS (
       SELECT COUNT(DISTINCT date_trunc('day', m.created_at))::int AS days,
              COUNT(DISTINCT date_trunc('month', m.created_at))::int AS months,
              MIN(m.created_at) AS first_at, MAX(m.created_at) AS last_at
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.contact_id = $1 AND m.direction = 'in'
     )
     UPDATE contacts ct
        SET interactions = s.days, active_months = s.months,
            first_contact_at = COALESCE(s.first_at, ct.first_contact_at, ct.created_at),
            last_seen_at = GREATEST(COALESCE(ct.last_seen_at, s.last_at), s.last_at)
       FROM s WHERE ct.id = $1
     RETURNING ct.interactions, ct.active_months, ct.first_contact_at, ct.last_seen_at`,
    [contactId]
  );
  const after = rows[0];
  if (!after) return null;
  const was = tierOf(before[0], th);
  const now = tierOf(after, th);
  const events = [];
  if (Number(before[0].interactions) === 0 && after.interactions > 0) events.push('Primeiro contato do cliente');
  const rank = { new: 0, occasional: 1, recurrent: 2, loyal: 3 };
  if (rank[now.tier] > rank[was.tier]) {
    if (now.tier === 'occasional') events.push(`Voltou a falar com a SOS: ${after.interactions} dias com contato`);
    if (now.tier === 'recurrent') events.push(`Passou a cliente recorrente (${after.interactions} dias com contato em ${after.active_months} meses)`);
    if (now.tier === 'loyal') events.push(`Passou a cliente fiel (recorrente há mais de ${th.loyal_months} meses)`);
  }
  for (const description of events) {
    await client.query('INSERT INTO contact_events (contact_id, type, description) VALUES ($1, $2, $3)', [contactId, 'milestone', description]);
  }
  return { ...after, ...now };
}

module.exports = { DEFAULTS, LIMITS, TIERS, FILTERS, thresholds, invalidate, tierOf, whereSql, tierSql, refreshContact, clampInt };
