/**
 * Recorrência do cliente medida pelo que ele compra, não por quantas vezes escreve.
 *
 *   Novo        até 1 consulta adquirida
 *   Ocasional   2 ou mais consultas, em qualquer prazo
 *   Recorrente  10+ consultas, em 3+ compras, espalhadas por 30 dias ou mais
 *   Fiel        25+ consultas, em 5+ compras, com a primeira compra há 6 meses ou mais
 *   Inativo     recorrente ou fiel sem comprar há 45 dias, ou há mais que o dobro do
 *               intervalo médio entre as compras dele (o que for maior)
 *
 * Os números ficam em app_settings e são editáveis em Configurações.
 */
const db = require('../db');

const DEFAULTS = {
  occasional_credits: 2,
  recurrent_credits: 10,
  recurrent_purchases: 3,
  recurrent_span_days: 30,
  loyal_credits: 25,
  loyal_purchases: 5,
  loyal_months: 6,
  inactive_days: 45,
};
const LIMITS = {
  occasional_credits: [1, 1000],
  recurrent_credits: [1, 100000],
  recurrent_purchases: [1, 1000],
  recurrent_span_days: [0, 3650],
  loyal_credits: [1, 100000],
  loyal_purchases: [1, 1000],
  loyal_months: [0, 120],
  inactive_days: [7, 3650],
};
const TIERS = { new: 'Novo', occasional: 'Ocasional', recurrent: 'Recorrente', loyal: 'Fiel' };
const FILTERS = ['new', 'occasional', 'recurrent', 'loyal', 'inactive'];
const RANK = { new: 0, occasional: 1, recurrent: 2, loyal: 3 };
const DAY_MS = 86400e3;
const MONTH_MS = 30.44 * DAY_MS;

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

/** Dias entre uma compra e outra, em média. Null enquanto houver só uma compra. */
function averageGapDays(c) {
  const n = Number(c.purchases_count || 0);
  if (n < 2 || !c.first_purchase_at || !c.last_purchase_at) return null;
  const span = (new Date(c.last_purchase_at).getTime() - new Date(c.first_purchase_at).getTime()) / DAY_MS;
  return span > 0 ? span / (n - 1) : null;
}

/** Faixa de um contato (ou de uma conversa, que traz os mesmos campos). */
function tierOf(c, th = cache.th, now = Date.now()) {
  const credits = Number(c.credits_bought || 0);
  const purchases = Number(c.purchases_count || 0);
  const first = c.first_purchase_at ? new Date(c.first_purchase_at).getTime() : null;
  const last = c.last_purchase_at ? new Date(c.last_purchase_at).getTime() : null;
  const spanDays = first && last ? (last - first) / DAY_MS : 0;
  const monthsSinceFirst = first ? (now - first) / MONTH_MS : 0;

  const isRecurrent = credits >= th.recurrent_credits && purchases >= th.recurrent_purchases && spanDays >= th.recurrent_span_days;
  const isLoyal = isRecurrent && credits >= th.loyal_credits && purchases >= th.loyal_purchases && monthsSinceFirst >= th.loyal_months;
  let tier = 'new';
  if (isLoyal) tier = 'loyal';
  else if (isRecurrent) tier = 'recurrent';
  else if (credits >= th.occasional_credits) tier = 'occasional';

  // Quem compra de dois em dois meses não pode virar inativo com 45 dias
  const gap = averageGapDays(c);
  const inactiveAfterDays = Math.max(th.inactive_days, gap ? gap * 2 : 0);
  const daysSinceLast = last ? (now - last) / DAY_MS : null;
  const inactive = (tier === 'recurrent' || tier === 'loyal') && daysSinceLast !== null && daysSinceLast > inactiveAfterDays;

  return {
    tier, label: TIERS[tier], inactive,
    credits_bought: credits, purchases_count: purchases,
    months_since_first: monthsSinceFirst, days_since_last: daysSinceLast,
    avg_gap_days: gap, inactive_after_days: Math.round(inactiveAfterDays),
  };
}

/** Explica em uma linha o que falta para o cliente subir de faixa (usado no painel). */
function nextStep(c, th = cache.th) {
  const t = tierOf(c, th);
  if (t.tier === 'loyal') return null;
  if (t.tier === 'recurrent') {
    const faltam = [];
    if (t.credits_bought < th.loyal_credits) faltam.push(`${th.loyal_credits - t.credits_bought} consulta(s)`);
    if (t.purchases_count < th.loyal_purchases) faltam.push(`${th.loyal_purchases - t.purchases_count} compra(s)`);
    if (t.months_since_first < th.loyal_months) faltam.push(`${Math.ceil(th.loyal_months - t.months_since_first)} mês(es) de casa`);
    return faltam.length ? `Para Fiel: ${faltam.join(', ')}` : null;
  }
  const faltam = [];
  if (t.credits_bought < th.recurrent_credits) faltam.push(`${th.recurrent_credits - t.credits_bought} consulta(s)`);
  if (t.purchases_count < th.recurrent_purchases) faltam.push(`${th.recurrent_purchases - t.purchases_count} compra(s)`);
  return faltam.length ? `Para Recorrente: ${faltam.join(', ')}` : null;
}

/** Fragmento SQL (sobre o alias da tabela contacts) para filtrar por faixa. Os números vêm validados. */
function whereSql(filter, th, a = 'ct') {
  const rec = `(${a}.credits_bought >= ${th.recurrent_credits} AND ${a}.purchases_count >= ${th.recurrent_purchases}`
    + ` AND ${a}.last_purchase_at - ${a}.first_purchase_at >= make_interval(days => ${th.recurrent_span_days}))`;
  const loyal = `(${rec} AND ${a}.credits_bought >= ${th.loyal_credits} AND ${a}.purchases_count >= ${th.loyal_purchases}`
    + ` AND ${a}.first_purchase_at <= NOW() - make_interval(months => ${th.loyal_months}))`;
  // limite de inatividade: 45 dias ou o dobro do intervalo médio entre compras, o que for maior
  const gapDays = `(EXTRACT(EPOCH FROM (${a}.last_purchase_at - ${a}.first_purchase_at)) / 86400.0) / GREATEST(${a}.purchases_count - 1, 1)`;
  const limit = `GREATEST(${th.inactive_days}::numeric, CASE WHEN ${a}.purchases_count > 1 THEN 2 * (${gapDays}) ELSE 0 END)`;
  switch (filter) {
    case 'new': return `${a}.credits_bought < ${th.occasional_credits}`;
    case 'occasional': return `(${a}.credits_bought >= ${th.occasional_credits} AND NOT ${rec})`;
    case 'recurrent': return `(${rec} AND NOT ${loyal})`;
    case 'loyal': return loyal;
    case 'inactive': return `(${rec} AND ${a}.last_purchase_at < NOW() - make_interval(days => 0, secs => ${limit} * 86400))`;
    default: return null;
  }
}

/** Expressão SQL que devolve a faixa ('new'|'occasional'|'recurrent'|'loyal') de cada linha. */
function tierSql(th, a = 'ct') {
  return `CASE WHEN ${whereSql('loyal', th, a)} THEN 'loyal' WHEN ${whereSql('recurrent', th, a)} THEN 'recurrent'
               WHEN ${a}.credits_bought >= ${th.occasional_credits} THEN 'occasional' ELSE 'new' END`;
}

/**
 * Recalcula as estatísticas de compra do contato e registra no log quando ele muda de faixa.
 * Chamado sempre que uma compra é criada, ajustada ou removida.
 */
async function refreshPurchases(contactId, client = db) {
  const th = await thresholds();
  const { rows: before } = await client.query(
    'SELECT credits_bought, purchases_count, first_purchase_at, last_purchase_at FROM contacts WHERE id = $1', [contactId]
  );
  if (!before.length) return null;
  const { rows } = await client.query(
    `WITH s AS (
       SELECT COALESCE(SUM(credits), 0)::int AS credits, COUNT(*)::int AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM purchases WHERE contact_id = $1
     )
     UPDATE contacts ct
        SET credits_bought = s.credits, purchases_count = s.n, first_purchase_at = s.first_at, last_purchase_at = s.last_at
       FROM s WHERE ct.id = $1
     RETURNING ct.credits_bought, ct.purchases_count, ct.first_purchase_at, ct.last_purchase_at`,
    [contactId]
  );
  const after = rows[0];
  if (!after) return null;
  const was = tierOf(before[0], th);
  const now = tierOf(after, th);
  if (RANK[now.tier] > RANK[was.tier]) {
    const text = now.tier === 'occasional'
      ? `Passou a cliente ocasional (${after.credits_bought} consultas adquiridas)`
      : now.tier === 'recurrent'
        ? `Passou a cliente recorrente (${after.credits_bought} consultas em ${after.purchases_count} compras)`
        : `Passou a cliente fiel (${after.credits_bought} consultas em ${after.purchases_count} compras, cliente há ${Math.floor(now.months_since_first)} meses)`;
    await client.query('INSERT INTO contact_events (contact_id, type, description) VALUES ($1, $2, $3)', [contactId, 'milestone', text]);
  }
  return { ...after, ...now };
}

/**
 * Atualiza os contadores de conversa do contato (dias com contato, meses ativos, último contato).
 * Não decide mais a faixa, que agora vem das compras; serve para o bloco "Histórico do cliente".
 */
async function refreshContact(contactId, client = db) {
  const { rows: before } = await client.query('SELECT interactions FROM contacts WHERE id = $1', [contactId]);
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
     RETURNING ct.interactions, ct.active_months, ct.first_contact_at, ct.last_seen_at, ct.credits_bought, ct.purchases_count, ct.first_purchase_at, ct.last_purchase_at`,
    [contactId]
  );
  const after = rows[0];
  if (!after) return null;
  if (Number(before[0].interactions) === 0 && after.interactions > 0) {
    await client.query('INSERT INTO contact_events (contact_id, type, description) VALUES ($1, $2, $3)', [contactId, 'milestone', 'Primeiro contato do cliente']);
  }
  return { ...after, ...tierOf(after, await thresholds()) };
}

module.exports = {
  DEFAULTS, LIMITS, TIERS, FILTERS, thresholds, invalidate, tierOf, nextStep,
  whereSql, tierSql, refreshContact, refreshPurchases, averageGapDays, clampInt,
};
