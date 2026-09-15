const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** Período: ?from=YYYY-MM-DD&to=YYYY-MM-DD (padrão: últimos 30 dias). */
function period(query) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const to = DATE_RE.test(query.to) ? new Date(`${query.to}T23:59:59.999`) : new Date();
  const from = DATE_RE.test(query.from)
    ? new Date(`${query.from}T00:00:00`)
    : new Date(to.getTime() - 29 * 24 * 3600 * 1000);
  return { from, to };
}

// Resumo: totais e tempos médios
router.get('/summary', async (req, res, next) => {
  try {
    const { from, to } = period(req.query);
    const p = [from, to];

    const totals = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM conversations WHERE created_at BETWEEN $1 AND $2) AS conversations_total,
         (SELECT COUNT(*)::int FROM conversations WHERE resolved_at BETWEEN $1 AND $2) AS resolved_total,
         (SELECT COUNT(*)::int FROM conversations WHERE status = 'open') AS open_now,
         (SELECT COUNT(*)::int FROM messages WHERE direction = 'in'  AND created_at BETWEEN $1 AND $2) AS messages_in,
         (SELECT COUNT(*)::int FROM messages WHERE direction = 'out' AND type <> 'note' AND created_at BETWEEN $1 AND $2) AS messages_out,
         (SELECT COUNT(DISTINCT contact_id)::int FROM conversations WHERE created_at BETWEEN $1 AND $2) AS contacts_total,
         (SELECT EXTRACT(EPOCH FROM AVG(first_response_at - created_at))::int
            FROM conversations WHERE first_response_at IS NOT NULL AND created_at BETWEEN $1 AND $2) AS avg_first_response_seconds,
         (SELECT EXTRACT(EPOCH FROM AVG(resolved_at - created_at))::int
            FROM conversations WHERE resolved_at BETWEEN $1 AND $2) AS avg_resolution_seconds`,
      p
    );

    // Tempo médio de resposta: para cada resposta do atendente, o tempo desde a última mensagem do cliente
    const resp = await db.query(
      `WITH seq AS (
         SELECT direction, created_at,
                LAG(direction) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS prev_dir,
                LAG(created_at) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS prev_at
           FROM messages WHERE type <> 'note'
       )
       SELECT EXTRACT(EPOCH FROM AVG(created_at - prev_at))::int AS avg_response_seconds,
              EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY created_at - prev_at))::int AS median_response_seconds
         FROM seq
        WHERE direction = 'out' AND prev_dir = 'in' AND created_at BETWEEN $1 AND $2`,
      p
    );

    res.json({ from, to, ...totals.rows[0], ...resp.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Volume de conversas e mensagens por dia/semana/mês
router.get('/volume', async (req, res, next) => {
  try {
    const { from, to } = period(req.query);
    const group = ['day', 'week', 'month'].includes(req.query.group) ? req.query.group : 'day';
    // group é validado contra lista fixa acima antes de entrar no SQL
    const { rows } = await db.query(
      `WITH buckets AS (
         SELECT date_trunc('${group}', created_at) AS bucket, 'conv' AS kind FROM conversations WHERE created_at BETWEEN $1 AND $2
         UNION ALL
         SELECT date_trunc('${group}', created_at), 'in'  FROM messages WHERE direction = 'in'  AND created_at BETWEEN $1 AND $2
         UNION ALL
         SELECT date_trunc('${group}', created_at), 'out' FROM messages WHERE direction = 'out' AND type <> 'note' AND created_at BETWEEN $1 AND $2
       )
       SELECT bucket,
              COUNT(*) FILTER (WHERE kind = 'conv')::int AS conversations,
              COUNT(*) FILTER (WHERE kind = 'in')::int  AS messages_in,
              COUNT(*) FILTER (WHERE kind = 'out')::int AS messages_out
         FROM buckets GROUP BY bucket ORDER BY bucket`,
      [from, to]
    );
    res.json({ from, to, group, series: rows });
  } catch (err) {
    next(err);
  }
});

// Desempenho por atendente
router.get('/agents', async (req, res, next) => {
  try {
    const { from, to } = period(req.query);
    const { rows } = await db.query(
      `WITH seq AS (
         SELECT sender_user_id, direction, created_at,
                LAG(direction) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS prev_dir,
                LAG(created_at) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS prev_at
           FROM messages WHERE type <> 'note'
       ),
       resp AS (
         SELECT sender_user_id,
                EXTRACT(EPOCH FROM AVG(created_at - prev_at))::int AS avg_response_seconds
           FROM seq
          WHERE direction = 'out' AND prev_dir = 'in' AND created_at BETWEEN $1 AND $2
          GROUP BY sender_user_id
       ),
       assigned AS (
         SELECT assigned_user_id AS uid, COUNT(*)::int AS conversations
           FROM conversations WHERE created_at BETWEEN $1 AND $2 GROUP BY assigned_user_id
       ),
       resolved AS (
         SELECT resolved_by_user_id AS uid, COUNT(*)::int AS resolved,
                EXTRACT(EPOCH FROM AVG(resolved_at - created_at))::int AS avg_resolution_seconds
           FROM conversations WHERE resolved_at BETWEEN $1 AND $2 GROUP BY resolved_by_user_id
       ),
       sent AS (
         SELECT sender_user_id AS uid, COUNT(*)::int AS messages_sent
           FROM messages WHERE direction = 'out' AND type <> 'note' AND created_at BETWEEN $1 AND $2 GROUP BY sender_user_id
       )
       SELECT u.id, u.name, u.active,
              COALESCE(a.conversations, 0) AS conversations,
              COALESCE(rs.resolved, 0) AS resolved,
              COALESCE(s.messages_sent, 0) AS messages_sent,
              rs.avg_resolution_seconds,
              r.avg_response_seconds
         FROM users u
         LEFT JOIN assigned a ON a.uid = u.id
         LEFT JOIN resolved rs ON rs.uid = u.id
         LEFT JOIN sent s ON s.uid = u.id
         LEFT JOIN resp r ON r.sender_user_id = u.id
        ORDER BY conversations DESC, u.name`,
      [from, to]
    );
    res.json({ from, to, agents: rows });
  } catch (err) {
    next(err);
  }
});

// Conversas por tag
router.get('/tags', async (req, res, next) => {
  try {
    const { from, to } = period(req.query);
    const { rows } = await db.query(
      `SELECT t.id, t.name, t.color,
              COUNT(c.id)::int AS conversations
         FROM tags t
         LEFT JOIN conversation_tags ct ON ct.tag_id = t.id
         LEFT JOIN conversations c ON c.id = ct.conversation_id AND c.created_at BETWEEN $1 AND $2
        GROUP BY t.id ORDER BY conversations DESC, t.name`,
      [from, to]
    );
    res.json({ from, to, tags: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
