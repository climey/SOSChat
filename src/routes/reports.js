const express = require('express');
const db = require('../db');
const realtime = require('../realtime');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** Período (?from&to, padrão 30 dias) e o período imediatamente anterior, do mesmo tamanho. */
function period(query) {
  const to = DATE_RE.test(query.to) ? new Date(`${query.to}T23:59:59.999`) : new Date();
  const from = DATE_RE.test(query.from) ? new Date(`${query.from}T00:00:00`) : new Date(to.getTime() - 29 * 24 * 3600 * 1000);
  const span = to.getTime() - from.getTime();
  return { from, to, prevFrom: new Date(from.getTime() - span - 1), prevTo: new Date(from.getTime() - 1) };
}

/**
 * Filtros de conversa (número, setor, atendente) como fragmento SQL sobre o alias `c`.
 * Os valores entram em `params`; devolve o texto a anexar ao WHERE.
 */
function convFilter(query, params) {
  const parts = [];
  const account = parseId(query.account), sector = parseId(query.sector), agent = parseId(query.agent);
  if (account) { params.push(account); parts.push(`c.account_id = $${params.length}`); }
  if (sector) { params.push(sector); parts.push(`c.sector_id = $${params.length}`); }
  if (agent) { params.push(agent); parts.push(`c.assigned_user_id = $${params.length}`); }
  return parts.length ? ' AND ' + parts.join(' AND ') : '';
}

/** Métricas principais de um intervalo (usado para o período atual e o anterior). */
async function metrics(from, to, query) {
  const params = [from, to];
  const f = convFilter(query, params);
  const totals = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM conversations c WHERE c.created_at BETWEEN $1 AND $2 ${f}) AS conversations_total,
       (SELECT COUNT(*)::int FROM conversations c WHERE c.resolved_at BETWEEN $1 AND $2 ${f}) AS resolved_total,
       (SELECT COUNT(DISTINCT c.contact_id)::int FROM conversations c WHERE c.created_at BETWEEN $1 AND $2 ${f}) AS contacts_total,
       (SELECT COUNT(*)::int FROM conversations c WHERE c.created_at BETWEEN $1 AND $2 AND c.first_response_at IS NOT NULL ${f}) AS answered_total,
       (SELECT COUNT(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.direction = 'in' AND m.created_at BETWEEN $1 AND $2 ${f}) AS messages_in,
       (SELECT COUNT(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.direction = 'out' AND m.type <> 'note' AND m.created_at BETWEEN $1 AND $2 ${f}) AS messages_out,
       (SELECT EXTRACT(EPOCH FROM AVG(c.first_response_at - c.created_at))::int FROM conversations c
         WHERE c.first_response_at IS NOT NULL AND c.created_at BETWEEN $1 AND $2 ${f}) AS avg_first_response_seconds,
       (SELECT EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.first_response_at - c.created_at))::int FROM conversations c
         WHERE c.first_response_at IS NOT NULL AND c.created_at BETWEEN $1 AND $2 ${f}) AS median_first_response_seconds,
       (SELECT EXTRACT(EPOCH FROM AVG(c.resolved_at - c.created_at))::int FROM conversations c
         WHERE c.resolved_at BETWEEN $1 AND $2 ${f}) AS avg_resolution_seconds,
       (SELECT EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.resolved_at - c.created_at))::int FROM conversations c
         WHERE c.resolved_at BETWEEN $1 AND $2 ${f}) AS median_resolution_seconds`,
    params
  );
  // Tempo de resposta: cada resposta do atendente medida desde a última mensagem do cliente
  const resp = await db.query(
    `WITH seq AS (
       SELECT m.direction, m.created_at,
              LAG(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS prev_dir,
              LAG(m.created_at) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS prev_at
         FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.type <> 'note' ${f}
     )
     SELECT EXTRACT(EPOCH FROM AVG(created_at - prev_at))::int AS avg_response_seconds,
            EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY created_at - prev_at))::int AS median_response_seconds
       FROM seq WHERE direction = 'out' AND prev_dir = 'in' AND created_at BETWEEN $1 AND $2`,
    params
  );
  return { ...totals.rows[0], ...resp.rows[0] };
}

// Resumo com comparativo do período anterior
router.get('/summary', async (req, res, next) => {
  try {
    const p = period(req.query);
    const [current, previous] = await Promise.all([metrics(p.from, p.to, req.query), metrics(p.prevFrom, p.prevTo, req.query)]);
    const params = [];
    const f = convFilter(req.query, params);
    const open = await db.query(`SELECT COUNT(*)::int AS n FROM conversations c WHERE c.status = 'open' ${f}`, params);
    res.json({ from: p.from, to: p.to, prev_from: p.prevFrom, prev_to: p.prevTo, current: { ...current, open_now: open.rows[0].n }, previous });
  } catch (err) { next(err); }
});

// Volume por dia/semana/mês: conversas, mensagens recebidas/enviadas, finalizadas
router.get('/volume', async (req, res, next) => {
  try {
    const { from, to } = period(req.query);
    const group = ['day', 'week', 'month'].includes(req.query.group) ? req.query.group : 'day';
    const params = [from, to];
    const f = convFilter(req.query, params);
    const { rows } = await db.query(
      `WITH buckets AS (
         SELECT date_trunc('${group}', c.created_at) AS bucket, 'conv' AS kind FROM conversations c WHERE c.created_at BETWEEN $1 AND $2 ${f}
         UNION ALL
         SELECT date_trunc('${group}', c.resolved_at), 'resolved' FROM conversations c WHERE c.resolved_at BETWEEN $1 AND $2 ${f}
         UNION ALL
         SELECT date_trunc('${group}', m.created_at), 'in' FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.direction = 'in' AND m.created_at BETWEEN $1 AND $2 ${f}
         UNION ALL
         SELECT date_trunc('${group}', m.created_at), 'out' FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.direction = 'out' AND m.type <> 'note' AND m.created_at BETWEEN $1 AND $2 ${f}
       )
       SELECT bucket,
              COUNT(*) FILTER (WHERE kind = 'conv')::int AS conversations,
              COUNT(*) FILTER (WHERE kind = 'resolved')::int AS resolved,
              COUNT(*) FILTER (WHERE kind = 'in')::int AS messages_in,
              COUNT(*) FILTER (WHERE kind = 'out')::int AS messages_out
         FROM buckets GROUP BY bucket ORDER BY bucket`,
      params
    );
    res.json({ from, to, group, series: rows });
  } catch (err) { next(err); }
});

// Tendência diária de tempo de primeira resposta e de resolução (média e mediana)
router.get('/trend', async (req, res, next) => {
  try {
    const { from, to } = period(req.query);
    const params = [from, to];
    const f = convFilter(req.query, params);
    const { rows } = await db.query(
      `SELECT d.bucket,
              fr.avg_first, fr.median_first, rs.avg_res, rs.median_res
         FROM (SELECT DISTINCT date_trunc('day', c.created_at) AS bucket FROM conversations c WHERE c.created_at BETWEEN $1 AND $2 ${f}
               UNION SELECT DISTINCT date_trunc('day', c.resolved_at) FROM conversations c WHERE c.resolved_at BETWEEN $1 AND $2 ${f}) d
         LEFT JOIN (
           SELECT date_trunc('day', c.created_at) AS bucket,
                  EXTRACT(EPOCH FROM AVG(c.first_response_at - c.created_at))::int AS avg_first,
                  EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.first_response_at - c.created_at))::int AS median_first
             FROM conversations c WHERE c.first_response_at IS NOT NULL AND c.created_at BETWEEN $1 AND $2 ${f} GROUP BY 1
         ) fr ON fr.bucket = d.bucket
         LEFT JOIN (
           SELECT date_trunc('day', c.resolved_at) AS bucket,
                  EXTRACT(EPOCH FROM AVG(c.resolved_at - c.created_at))::int AS avg_res,
                  EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.resolved_at - c.created_at))::int AS median_res
             FROM conversations c WHERE c.resolved_at BETWEEN $1 AND $2 ${f} GROUP BY 1
         ) rs ON rs.bucket = d.bucket
        ORDER BY d.bucket`,
      params
    );
    res.json({ from, to, series: rows });
  } catch (err) { next(err); }
});

// Desempenho por atendente
router.get('/agents', async (req, res, next) => {
  try {
    const { from, to } = period(req.query);
    const params = [from, to];
    const f = convFilter({ account: req.query.account, sector: req.query.sector }, params);
    const { rows } = await db.query(
      `WITH seq AS (
         SELECT m.sender_user_id, m.direction, m.created_at,
                LAG(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS prev_dir,
                LAG(m.created_at) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS prev_at
           FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.type <> 'note' ${f}
       ),
       resp AS (
         SELECT sender_user_id AS uid,
                EXTRACT(EPOCH FROM AVG(created_at - prev_at))::int AS avg_response_seconds,
                EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY created_at - prev_at))::int AS median_response_seconds
           FROM seq WHERE direction = 'out' AND prev_dir = 'in' AND created_at BETWEEN $1 AND $2 GROUP BY sender_user_id
       ),
       assigned AS (
         SELECT c.assigned_user_id AS uid, COUNT(*)::int AS conversations,
                COUNT(*) FILTER (WHERE c.status = 'open')::int AS open_now
           FROM conversations c WHERE c.created_at BETWEEN $1 AND $2 ${f} GROUP BY c.assigned_user_id
       ),
       resolved AS (
         SELECT c.resolved_by_user_id AS uid, COUNT(*)::int AS resolved,
                EXTRACT(EPOCH FROM AVG(c.resolved_at - c.created_at))::int AS avg_resolution_seconds,
                EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.resolved_at - c.created_at))::int AS median_resolution_seconds
           FROM conversations c WHERE c.resolved_at BETWEEN $1 AND $2 ${f} GROUP BY c.resolved_by_user_id
       ),
       sent AS (
         SELECT m.sender_user_id AS uid, COUNT(*)::int AS messages_sent
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.direction = 'out' AND m.type <> 'note' AND m.created_at BETWEEN $1 AND $2 ${f} GROUP BY m.sender_user_id
       )
       SELECT u.id, u.name, u.active, u.availability,
              COALESCE(a.conversations, 0) AS conversations, COALESCE(a.open_now, 0) AS open_now,
              COALESCE(rs.resolved, 0) AS resolved, COALESCE(s.messages_sent, 0) AS messages_sent,
              rs.avg_resolution_seconds, rs.median_resolution_seconds,
              r.avg_response_seconds, r.median_response_seconds
         FROM users u
         LEFT JOIN assigned a ON a.uid = u.id
         LEFT JOIN resolved rs ON rs.uid = u.id
         LEFT JOIN sent s ON s.uid = u.id
         LEFT JOIN resp r ON r.uid = u.id
        WHERE u.active = TRUE OR a.conversations > 0 OR s.messages_sent > 0
        ORDER BY conversations DESC, u.name`,
      params
    );
    res.json({ from, to, agents: rows.map((r) => ({ ...r, online: realtime.isOnline(r.id) })) });
  } catch (err) { next(err); }
});

// Distribuições: tags, setores, números
router.get('/breakdown', async (req, res, next) => {
  try {
    const { from, to } = period(req.query);
    const params = [from, to];
    const f = convFilter(req.query, params);
    const [tags, sectors, accounts] = await Promise.all([
      db.query(
        `SELECT t.id, t.name, t.color, COUNT(c.id)::int AS conversations
           FROM tags t LEFT JOIN conversation_tags ct ON ct.tag_id = t.id
           LEFT JOIN conversations c ON c.id = ct.conversation_id AND c.created_at BETWEEN $1 AND $2 ${f}
          GROUP BY t.id ORDER BY conversations DESC, t.name`, params),
      db.query(
        `SELECT s.id, s.name, s.color, COUNT(c.id)::int AS conversations
           FROM sectors s LEFT JOIN conversations c ON c.sector_id = s.id AND c.created_at BETWEEN $1 AND $2 ${f}
          GROUP BY s.id ORDER BY conversations DESC, s.name`, params),
      db.query(
        `SELECT wa.id, wa.name, wa.phone, COUNT(c.id)::int AS conversations
           FROM wa_accounts wa LEFT JOIN conversations c ON c.account_id = wa.id AND c.created_at BETWEEN $1 AND $2 ${f}
          GROUP BY wa.id ORDER BY conversations DESC, wa.name`, params),
    ]);
    res.json({ from, to, tags: tags.rows, sectors: sectors.rows, accounts: accounts.rows });
  } catch (err) { next(err); }
});

// Mapa de calor: conversas iniciadas por dia da semana × hora (fuso de São Paulo)
router.get('/hours', async (req, res, next) => {
  try {
    const { from, to } = period(req.query);
    const params = [from, to];
    const f = convFilter(req.query, params);
    const { rows } = await db.query(
      `SELECT EXTRACT(DOW FROM c.created_at AT TIME ZONE 'America/Sao_Paulo')::int AS dow,
              EXTRACT(HOUR FROM c.created_at AT TIME ZONE 'America/Sao_Paulo')::int AS hour,
              COUNT(*)::int AS conversations
         FROM conversations c WHERE c.created_at BETWEEN $1 AND $2 ${f}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      params
    );
    res.json({ from, to, cells: rows });
  } catch (err) { next(err); }
});

// Origem por DDD (o front agrupa em estado e região)
router.get('/origin', async (req, res, next) => {
  try {
    const { from, to } = period(req.query);
    const params = [from, to];
    const f = convFilter(req.query, params);
    const { rows } = await db.query(
      `SELECT CASE WHEN ct.wa_id ~ '^55[1-9][0-9]' THEN substring(ct.wa_id from 3 for 2) ELSE 'intl' END AS ddd,
              COUNT(*)::int AS conversations, COUNT(DISTINCT c.contact_id)::int AS contacts
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
        WHERE c.created_at BETWEEN $1 AND $2 ${f}
        GROUP BY 1 ORDER BY conversations DESC`,
      params
    );
    res.json({ from, to, ddd: rows });
  } catch (err) { next(err); }
});

// Agora: situação em tempo real
router.get('/now', async (req, res, next) => {
  try {
    const params = [];
    const f = convFilter(req.query, params);
    const settings = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('sla_warn_minutes', 'sla_alert_minutes')`);
    const sla = Object.fromEntries(settings.rows.map((r) => [r.key, Number(r.value)]));
    const alertMin = sla.sla_alert_minutes || 15;
    params.push(alertMin);
    const alertParam = params.length;
    const [state, oldest, lastHour, opened, inbound] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FILTER (WHERE c.status = 'open' AND c.attended = FALSE)::int AS queued,
                COUNT(*) FILTER (WHERE c.status = 'open' AND c.last_message_direction IS DISTINCT FROM 'out')::int AS waiting,
                COUNT(*) FILTER (WHERE c.status = 'open' AND c.last_message_direction = 'out')::int AS in_progress,
                COUNT(*) FILTER (WHERE c.status = 'open' AND c.last_message_direction IS DISTINCT FROM 'out'
                                   AND c.last_message_at < NOW() - ($${alertParam} || ' minutes')::interval)::int AS overdue,
                COUNT(*) FILTER (WHERE c.status = 'open' AND c.assigned_user_id IS NULL)::int AS unassigned
           FROM conversations c WHERE TRUE ${f}`, params),
      db.query(
        `SELECT c.id, ct.name AS contact_name, ct.profile_name, ct.wa_id, c.last_message_at, u.name AS assigned_user_name,
                EXTRACT(EPOCH FROM (NOW() - c.last_message_at))::int AS waiting_seconds
           FROM conversations c JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN users u ON u.id = c.assigned_user_id
          WHERE c.status = 'open' AND c.last_message_direction IS DISTINCT FROM 'out' ${f}
          ORDER BY c.last_message_at ASC LIMIT 8`, params.slice(0, params.length - 1)),
      db.query(
        `WITH seq AS (
           SELECT m.direction, m.created_at,
                  LAG(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS prev_dir,
                  LAG(m.created_at) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS prev_at
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE m.type <> 'note' AND m.created_at > NOW() - INTERVAL '2 hours' ${f}
         )
         SELECT EXTRACT(EPOCH FROM AVG(created_at - prev_at))::int AS avg_response_seconds,
                EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY created_at - prev_at))::int AS median_response_seconds,
                COUNT(*)::int AS replies
           FROM seq WHERE direction = 'out' AND prev_dir = 'in' AND created_at > NOW() - INTERVAL '1 hour'`, params.slice(0, params.length - 1)),
      db.query(
        `SELECT date_trunc('hour', c.created_at) + (floor(EXTRACT(MINUTE FROM c.created_at) / 5) * 5) * INTERVAL '1 minute' AS bucket,
                COUNT(*)::int AS conversations
           FROM conversations c WHERE c.created_at > NOW() - INTERVAL '1 hour' ${f}
          GROUP BY 1 ORDER BY 1`, params.slice(0, params.length - 1)),
      db.query(
        `SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.direction = 'in' AND m.created_at > NOW() - INTERVAL '1 hour' ${f}`, params.slice(0, params.length - 1)),
    ]);
    const agents = await db.query(`SELECT id, name, availability FROM users WHERE active = TRUE ORDER BY name`);
    res.json({
      at: new Date(),
      sla,
      ...state.rows[0],
      oldest_waiting: oldest.rows,
      last_hour: { ...lastHour.rows[0], opened: opened.rows, messages_in: inbound.rows[0].n },
      agents: agents.rows.map((a) => ({ ...a, online: realtime.isOnline(a.id) })),
    });
  } catch (err) { next(err); }
});

// Consultas registradas e situação dos planos
router.get('/consultations', async (req, res, next) => {
  try {
    const { from, to, prevFrom, prevTo } = period(req.query);
    const agent = parseId(req.query.agent);
    const params = [from, to];
    let f = '';
    if (agent) { params.push(agent); f = ` AND k.user_id = $${params.length}`; }
    const base = `FROM consultations k WHERE k.reversed_at IS NULL AND k.created_at BETWEEN $1 AND $2 ${f}`;
    const totals = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE k.charged)::int AS charged,
              COUNT(*) FILTER (WHERE NOT k.charged)::int AS loose,
              COUNT(DISTINCT k.contact_id)::int AS contacts ${base}`, params);
    const prevParams = [prevFrom, prevTo, ...params.slice(2)];
    const prev = await db.query(`SELECT COUNT(*)::int AS total ${base}`, prevParams);
    const byDay = await db.query(
      `SELECT date_trunc('day', k.created_at) AS bucket, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE k.charged)::int AS charged, COUNT(*) FILTER (WHERE NOT k.charged)::int AS loose
         ${base} GROUP BY 1 ORDER BY 1`, params);
    const byKind = await db.query(`SELECT k.kind, COUNT(*)::int AS total ${base} GROUP BY k.kind ORDER BY total DESC`, params);
    const byAgent = await db.query(
      `SELECT COALESCE(u.name, 'Sem atendente') AS name, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE k.charged)::int AS charged
         FROM consultations k LEFT JOIN users u ON u.id = k.user_id
        WHERE k.reversed_at IS NULL AND k.created_at BETWEEN $1 AND $2 ${f}
        GROUP BY u.name ORDER BY total DESC`, params);
    const topContacts = await db.query(
      `SELECT ct.id, COALESCE(ct.name, ct.profile_name, ct.wa_id) AS name, ct.wa_id, ct.plan_name, ct.plan_credits, ct.plan_used, COUNT(*)::int AS total
         FROM consultations k JOIN contacts ct ON ct.id = k.contact_id
        WHERE k.reversed_at IS NULL AND k.created_at BETWEEN $1 AND $2 ${f}
        GROUP BY ct.id ORDER BY total DESC LIMIT 15`, params);
    const plans = await db.query(
      `SELECT COUNT(*)::int AS with_plan,
              COUNT(*) FILTER (WHERE plan_used >= plan_credits)::int AS empty,
              COUNT(*) FILTER (WHERE plan_used < plan_credits AND plan_credits - plan_used <= 1)::int AS low,
              COUNT(*) FILTER (WHERE plan_expires_at IS NOT NULL AND plan_expires_at < NOW())::int AS expired,
              COUNT(*) FILTER (WHERE plan_expires_at IS NOT NULL AND plan_expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days')::int AS expiring,
              COALESCE(SUM(GREATEST(plan_credits - plan_used, 0)), 0)::int AS credits_left
         FROM contacts WHERE plan_credits IS NOT NULL`);
    const byPlan = await db.query(
      `SELECT COALESCE(plan_name, 'Sem nome') AS name, COUNT(*)::int AS contacts,
              COUNT(*) FILTER (WHERE plan_used >= plan_credits)::int AS empty
         FROM contacts WHERE plan_credits IS NOT NULL GROUP BY plan_name ORDER BY contacts DESC`);
    const attention = await db.query(
      `SELECT ct.id, COALESCE(ct.name, ct.profile_name, ct.wa_id) AS name, ct.wa_id, ct.plan_name, ct.plan_credits, ct.plan_used, ct.plan_expires_at,
              (SELECT c.id FROM conversations c WHERE c.contact_id = ct.id ORDER BY c.last_message_at DESC LIMIT 1) AS conversation_id
         FROM contacts ct
        WHERE ct.plan_credits IS NOT NULL
          AND (ct.plan_used >= ct.plan_credits OR (ct.plan_expires_at IS NOT NULL AND ct.plan_expires_at < NOW() + INTERVAL '7 days'))
        ORDER BY ct.plan_expires_at NULLS LAST, ct.plan_used DESC LIMIT 30`);
    res.json({
      current: totals.rows[0], previous: prev.rows[0],
      series: byDay.rows, kinds: byKind.rows, agents: byAgent.rows, contacts: topContacts.rows,
      plans: { ...plans.rows[0], by_plan: byPlan.rows, attention: attention.rows },
    });
  } catch (err) { next(err); }
});

// Recorrência dos clientes: faixas atuais, inativos, mais frequentes e taxa de retorno
router.get('/recurrence', async (req, res, next) => {
  try {
    const recurrence = require('../services/recurrence');
    const th = await recurrence.thresholds();
    const { from, to, prevFrom, prevTo } = period(req.query);
    const tierExpr = recurrence.tierSql(th);
    const tiers = await db.query(
      `SELECT COUNT(*) FILTER (WHERE tier = 'new')::int AS new, COUNT(*) FILTER (WHERE tier = 'occasional')::int AS occasional,
              COUNT(*) FILTER (WHERE tier = 'recurrent')::int AS recurrent, COUNT(*) FILTER (WHERE tier = 'loyal')::int AS loyal,
              COUNT(*) FILTER (WHERE tier IN ('recurrent', 'loyal') AND last_seen_at < NOW() - make_interval(days => ${th.inactive_days}))::int AS inactive,
              COUNT(*)::int AS total
         FROM (SELECT ${tierExpr} AS tier, ct.last_seen_at FROM contacts ct WHERE ct.interactions > 0) t`);
    const newInPeriod = await db.query(
      `SELECT COUNT(*)::int AS current, (SELECT COUNT(*)::int FROM contacts WHERE first_contact_at BETWEEN $3 AND $4) AS previous
         FROM contacts WHERE first_contact_at BETWEEN $1 AND $2`, [from, to, prevFrom, prevTo]);
    const ret = await db.query(
      `SELECT COUNT(*)::int AS base,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                                              WHERE c.contact_id = ct.id AND m.direction = 'in' AND m.created_at BETWEEN $1 AND $2))::int AS returned
         FROM contacts ct WHERE ct.first_contact_at BETWEEN $3 AND $4`, [from, to, prevFrom, prevTo]);
    const active = await db.query(
      `SELECT COUNT(DISTINCT c.contact_id)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direction = 'in' AND m.created_at BETWEEN $1 AND $2`, [from, to]);
    const inactive = await db.query(
      `SELECT ct.id, COALESCE(ct.name, ct.profile_name, ct.wa_id) AS name, ct.wa_id, ct.interactions, ct.active_months, ct.first_contact_at, ct.last_seen_at, ct.plan_name,
              ${tierExpr} AS tier,
              (SELECT c.id FROM conversations c WHERE c.contact_id = ct.id ORDER BY c.last_message_at DESC LIMIT 1) AS conversation_id
         FROM contacts ct WHERE ${recurrence.whereSql('inactive', th)}
        ORDER BY ct.interactions DESC, ct.last_seen_at ASC LIMIT 40`);
    const top = await db.query(
      `SELECT ct.id, COALESCE(ct.name, ct.profile_name, ct.wa_id) AS name, ct.wa_id, ct.interactions, ct.active_months, ct.first_contact_at, ct.last_seen_at, ct.plan_name,
              ${tierExpr} AS tier,
              (SELECT COUNT(*)::int FROM consultations k WHERE k.contact_id = ct.id AND k.reversed_at IS NULL) AS consultations,
              (SELECT c.id FROM conversations c WHERE c.contact_id = ct.id ORDER BY c.last_message_at DESC LIMIT 1) AS conversation_id
         FROM contacts ct WHERE ct.interactions > 1
        ORDER BY ct.interactions DESC, ct.active_months DESC LIMIT 20`);
    res.json({
      thresholds: th, tiers: tiers.rows[0],
      new_clients: newInPeriod.rows[0], active_clients: active.rows[0].n,
      return_rate: { base: ret.rows[0].base, returned: ret.rows[0].returned, pct: ret.rows[0].base ? Math.round((ret.rows[0].returned / ret.rows[0].base) * 100) : null },
      inactive: inactive.rows, top: top.rows,
    });
  } catch (err) { next(err); }
});

module.exports = router;
