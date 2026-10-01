/**
 * Distribuição automática de conversas.
 *
 * Pode receber agora = ativo, "recebe conversas novas", logado no chat, status "disponível", do setor da
 * conversa (atendente sem setor atende qualquer um) e abaixo do limite de clientes esperando resposta.
 *
 * Escolha, nesta ordem:
 *  1. afinidade: quem atendeu este cliente nos últimos N dias (se puder receber agora);
 *  2. critério configurado:
 *     - revezamento (padrão): a vez é de quem recebeu conversa há mais tempo; empate → menos esperando.
 *       Quem está presente recebe a mesma quantidade, independente de quem responde mais rápido.
 *     - carga: quem tem menos clientes esperando resposta; empate → revezamento.
 *       Favorece quem responde rápido (fica com zero esperando e recebe a próxima).
 *
 * Toda decisão passa por uma fila única (uma de cada vez): duas conversas chegando juntas não leem a
 * mesma situação e não vão as duas para a mesma pessoa. Cada decisão fica registrada em distribution_log,
 * com quem podia receber, os números de cada um e por que os outros ficaram de fora.
 *
 * Ninguém pode receber: a conversa fica sem responsável ("na fila"); a fila é esvaziada, em ordem de
 * chegada, sempre que alguém fica disponível (login, voltou de ausente, respondeu, finalizou uma conversa).
 *
 * Passagem de turno: quando o atendente fica offline (encerrou o expediente ou sumiu do chat por mais
 * que a tolerância), as conversas dele em que o cliente está esperando resposta voltam para a fila.
 * As paradas ficam com ele; se o cliente escrever enquanto ele está fora, aí vão para a fila também.
 */
const db = require('../db');
const realtime = require('../realtime');

const DEFAULTS = { enabled: false, waitingLimit: 5, affinity: true, affinityDays: 30, handoff: true, offlineGraceSeconds: 120, mode: 'rodizio' };
const MODES = ['rodizio', 'carga'];
// início do dia em Brasília (para "recebidas hoje")
const TODAY = `(date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`;
let cache = null;

async function settings() {
  if (cache) return cache;
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key LIKE 'distribution_%'`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  cache = {
    enabled: s.distribution_enabled === '1',
    waitingLimit: Math.max(0, num(s.distribution_waiting_limit, DEFAULTS.waitingLimit)),
    affinity: (s.distribution_affinity ?? '1') === '1',
    affinityDays: Math.max(0, num(s.distribution_affinity_days, DEFAULTS.affinityDays)),
    handoff: (s.distribution_handoff ?? '1') === '1',
    offlineGraceSeconds: Math.max(10, num(s.distribution_offline_grace_seconds, DEFAULTS.offlineGraceSeconds)),
    mode: MODES.includes(s.distribution_mode) ? s.distribution_mode : DEFAULTS.mode,
  };
  return cache;
}
function invalidate() { cache = null; }

// ---------- Uma decisão de cada vez ----------
let lock = Promise.resolve();
/** Executa fn depois da decisão anterior terminar (evita duas conversas lerem a mesma situação). */
function exclusive(fn) {
  const run = lock.then(() => fn());
  lock = run.catch(() => {});
  return run;
}

/**
 * Situação de cada atendente ativo: carga, quantas recebeu hoje e, se não pode receber agora, por quê.
 * sectorId: setor da conversa (atendente de outro setor fica de fora). forNew: conversa nova (exige "recebe novas").
 */
async function agentsSnapshot({ sectorId = null, forNew = true } = {}) {
  const cfg = await settings();
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.availability, u.receives_new, u.sector_id, s.name AS sector_name, u.last_assigned_at,
            (SELECT COUNT(*)::int FROM conversations c WHERE c.assigned_user_id = u.id AND c.status = 'open' AND c.last_message_direction IS DISTINCT FROM 'out') AS waiting,
            (SELECT COUNT(*)::int FROM conversations c WHERE c.assigned_user_id = u.id AND c.status = 'open' AND c.last_message_at > NOW() - INTERVAL '1 hour') AS active,
            (SELECT COUNT(*)::int FROM conversations c WHERE c.assigned_user_id = u.id AND c.status = 'open') AS open,
            (SELECT COUNT(*)::int FROM distribution_log d WHERE d.user_id = u.id AND d.created_at >= ${TODAY}) AS today
       FROM users u LEFT JOIN sectors s ON s.id = u.sector_id
      WHERE u.active = TRUE
      ORDER BY u.name`
  );
  return rows.map((u) => {
    const online = realtime.isOnline(u.id);
    let why = null;
    if (u.availability === 'offline') why = 'offline';
    else if (u.availability === 'away') why = 'ausente';
    else if (!online) why = 'fora do chat';
    else if (forNew && !u.receives_new) why = 'só recebe por transferência';
    else if (sectorId && u.sector_id && u.sector_id !== sectorId) why = `é de outro setor (${u.sector_name})`;
    else if (cfg.waitingLimit > 0 && u.waiting >= cfg.waitingLimit) why = `no limite (${u.waiting} esperando)`;
    return { ...u, online, eligible: !why, why_not: why };
  });
}

/** Atendentes que podem receber agora, com quantos clientes cada um tem esperando. */
async function eligible(opts = {}) {
  return (await agentsSnapshot(opts)).filter((u) => u.eligible);
}

/** Último atendente que respondeu a este contato (em qualquer conversa), dentro do prazo da afinidade. */
async function lastAgentFor(contactId, days) {
  const { rows } = await db.query(
    `SELECT m.sender_user_id AS id FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.contact_id = $1 AND m.direction = 'out' AND m.type <> 'note' AND m.sender_user_id IS NOT NULL
        AND ($2::int = 0 OR m.created_at > NOW() - make_interval(days => $2::int))
      ORDER BY m.created_at DESC LIMIT 1`,
    [contactId, days]
  );
  return rows[0]?.id || null;
}

const ms = (d) => (d ? new Date(d).getTime() : 0);
/** Escolhe entre quem pode receber. Devolve { user, rule } ou null. */
function choose(candidates, preferredId, mode = DEFAULTS.mode) {
  if (!candidates.length) return null;
  if (preferredId) { const p = candidates.find((u) => u.id === preferredId); if (p) return { user: p, rule: 'afinidade' }; }
  const byTurn = (a, b) => ms(a.last_assigned_at) - ms(b.last_assigned_at);
  const byWaiting = (a, b) => a.waiting - b.waiting;
  const sorted = [...candidates].sort(mode === 'carga' ? (a, b) => byWaiting(a, b) || byTurn(a, b) : (a, b) => byTurn(a, b) || byWaiting(a, b));
  return { user: sorted[0], rule: mode === 'carga' ? 'carga' : 'revezamento' };
}

const RULE_TEXT = {
  afinidade: 'afinidade: já atendeu este cliente',
  revezamento: 'revezamento: era a vez',
  carga: 'menos clientes esperando',
};
/** Resumo de quem podia receber e de quem ficou de fora, guardado junto com a decisão. */
function detailsOf(snapshot, cfg, rule, chosenId) {
  return {
    mode: cfg.mode,
    rule,
    chosen: chosenId,
    affinity_days: cfg.affinity ? cfg.affinityDays : null,
    waiting_limit: cfg.waitingLimit,
    candidates: snapshot.filter((u) => u.eligible).map((u) => ({ id: u.id, name: u.name, waiting: u.waiting, today: u.today, last_assigned_at: u.last_assigned_at })),
    excluded: snapshot.filter((u) => !u.eligible).map((u) => ({ id: u.id, name: u.name, why: u.why_not })),
  };
}

/**
 * Atribui a conversa, registra e avisa o atendente. expectedOwner: dono esperado no momento da troca
 * (null = sem responsável); se outra decisão mudou o dono no meio do caminho, não faz nada.
 */
async function assign(conv, user, rule, { fromUserId = null, expectedOwner = null, reasonText = null, details = null } = {}) {
  const upd = await db.query(
    `UPDATE conversations SET assigned_user_id = $2, attended = TRUE
      WHERE id = $1 AND status = 'open' AND assigned_user_id IS NOT DISTINCT FROM $3 RETURNING id`,
    [conv.id, user.id, expectedOwner]
  );
  if (!upd.rows.length) return null;
  await db.query('UPDATE users SET last_assigned_at = NOW() WHERE id = $1', [user.id]);
  const reason = reasonText || RULE_TEXT[rule] || rule;
  await db.query(
    'INSERT INTO distribution_log (conversation_id, user_id, from_user_id, reason, rule, details) VALUES ($1, $2, $3, $4, $5, $6)',
    [conv.id, user.id, fromUserId, reason, rule, details ? JSON.stringify(details) : null]
  );
  const load = user.waiting !== undefined ? `; tinha ${user.waiting} esperando e ${user.today ?? 0} recebida(s) hoje` : '';
  const text = `Distribuída para ${user.name} (${reason}${load})`;
  const note = await db.query(
    `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id) VALUES ($1, 'out', 'note', $2, 'sent', NULL) RETURNING *`,
    [conv.id, text]
  );
  const conversations = require('./conversations');
  const updated = await conversations.getById(conv.id);
  realtime.broadcast('message:new', { message: { ...note.rows[0], sender_name: 'Sistema' }, conversation: updated });
  realtime.broadcast('conversation:updated', updated);
  realtime.toUser(user.id, 'distribution:assigned', { conversation: updated, reason });
  return updated;
}

/** Decide e atribui (sempre dentro de exclusive). logQueue: registra quando ninguém pode receber. */
async function distributeNow(convIn, { forNew = true, logQueue = false } = {}) {
  const cfg = await settings();
  if (!cfg.enabled) return null;
  // situação atual da conversa (pode ter ganhado dono enquanto esperava a vez)
  const { rows } = await db.query('SELECT id, contact_id, sector_id, assigned_user_id, status FROM conversations WHERE id = $1', [convIn.id]);
  const conv = rows[0];
  if (!conv || conv.status !== 'open' || conv.assigned_user_id) return null;
  const snapshot = await agentsSnapshot({ sectorId: conv.sector_id || null, forNew });
  const candidates = snapshot.filter((u) => u.eligible);
  if (!candidates.length) {
    if (logQueue) {
      await db.query(
        'INSERT INTO distribution_log (conversation_id, user_id, reason, rule, details) VALUES ($1, NULL, $2, $3, $4)',
        [conv.id, 'na fila: ninguém podia receber', 'fila', JSON.stringify(detailsOf(snapshot, cfg, 'fila', null))]
      );
    }
    return null;
  }
  const preferred = cfg.affinity ? await lastAgentFor(conv.contact_id, cfg.affinityDays) : null;
  const pick = choose(candidates, preferred, cfg.mode);
  if (!pick) return null;
  return assign(conv, pick.user, pick.rule, { details: detailsOf(snapshot, cfg, pick.rule, pick.user.id) });
}

/** Tenta dar dono a uma conversa sem responsável. Devolve a conversa atualizada ou null (fila). */
function distribute(conv, opts = {}) {
  return exclusive(() => distributeNow(conv, opts));
}

/** Conversa nova do cliente: distribui na hora (se ninguém, fica na fila e o motivo é registrado). */
async function onNewConversation(conversation) {
  try {
    if (!conversation || conversation.assigned_user_id) return null;
    return await distribute(conversation, { forNew: true, logQueue: true });
  } catch (err) { console.warn('[distribuição] nova conversa:', err.message); return null; }
}

/** Cliente escreveu numa conversa cujo dono está offline: passa para quem está atendendo. */
async function onClientMessage(conversation) {
  try {
    const cfg = await settings();
    if (!cfg.enabled || !cfg.handoff || !conversation || !conversation.assigned_user_id) return null;
    return await exclusive(async () => {
      const { rows } = await db.query('SELECT id, name, availability FROM users WHERE id = $1', [conversation.assigned_user_id]);
      const owner = rows[0];
      if (!owner) return null;
      const ownerOff = owner.availability === 'offline' || !realtime.isOnline(owner.id);
      if (!ownerOff) return null;
      const snapshot = await agentsSnapshot({ sectorId: conversation.sector_id || null, forNew: false });
      const candidates = snapshot.filter((u) => u.eligible && u.id !== owner.id);
      const pick = choose(candidates, null, cfg.mode);
      if (!pick) return null;
      return assign(conversation, pick.user, 'assumida', {
        fromUserId: owner.id,
        expectedOwner: owner.id,
        reasonText: `assumida de ${owner.name}, que está offline`,
        details: { ...detailsOf(snapshot, cfg, 'assumida', pick.user.id), from: { id: owner.id, name: owner.name } },
      });
    });
  } catch (err) { console.warn('[distribuição] mensagem do cliente:', err.message); return null; }
}

/** Transferência para um setor sem escolher pessoa: distribui entre os do setor. */
async function onSectorTransfer(conversation) {
  try { return await distribute(conversation, { forNew: false }); } catch (err) { console.warn('[distribuição] setor:', err.message); return null; }
}

let draining = false;
let drainAgain = false;
/** Esvazia a fila (conversas abertas sem responsável), em ordem de chegada, enquanto houver quem possa receber. */
async function drainQueue() {
  const cfg = await settings();
  if (!cfg.enabled) return 0;
  if (draining) { drainAgain = true; return 0; }
  draining = true;
  let n = 0;
  try {
    const { rows } = await db.query(
      // só o que está esperando resposta do atendente: conversa parada sem dono não precisa de dono agora
      `SELECT id, contact_id, sector_id FROM conversations WHERE status = 'open' AND assigned_user_id IS NULL AND last_message_direction IS DISTINCT FROM 'out' ORDER BY last_message_at ASC, id ASC LIMIT 200`
    );
    for (const conv of rows) {
      const done = await distribute(conv, { forNew: true });
      if (done) n++;
    }
  } catch (err) { console.warn('[distribuição] fila:', err.message); }
  finally {
    draining = false;
    if (drainAgain) { drainAgain = false; setTimeout(() => drainQueue().catch(() => {}), 300); }
  }
  return n;
}
let drainTimer = null;
/** Agenda o esvaziamento da fila (junta vários gatilhos em um). */
function scheduleDrain(delay = 400) {
  clearTimeout(drainTimer);
  drainTimer = setTimeout(() => drainQueue().catch(() => {}), delay);
  if (drainTimer.unref) drainTimer.unref();
}

/** Passagem de turno: as conversas do atendente com cliente esperando voltam para a fila e são redistribuídas. */
async function handoff(userId, why) {
  const cfg = await settings();
  if (!cfg.enabled || !cfg.handoff) return 0;
  const { rows: urows } = await db.query('SELECT id, name FROM users WHERE id = $1', [userId]);
  const u = urows[0];
  if (!u) return 0;
  const rows = await exclusive(async () => (await db.query(
    `UPDATE conversations SET assigned_user_id = NULL
      WHERE assigned_user_id = $1 AND status = 'open' AND last_message_direction IS DISTINCT FROM 'out'
      RETURNING id, contact_id, sector_id`,
    [userId]
  )).rows);
  const conversations = require('./conversations');
  for (const c of rows) {
    await db.query(
      'INSERT INTO distribution_log (conversation_id, user_id, from_user_id, reason, rule) VALUES ($1, NULL, $2, $3, $4)',
      [c.id, userId, `voltou para a fila: ${u.name} ${why}`, 'devolvida']
    );
    const note = await db.query(
      `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id) VALUES ($1, 'out', 'note', $2, 'sent', NULL) RETURNING *`,
      [c.id, `Voltou para a fila: ${u.name} ${why}`]
    );
    const updated = await conversations.getById(c.id);
    realtime.broadcast('message:new', { message: { ...note.rows[0], sender_name: 'Sistema' }, conversation: updated });
    realtime.broadcast('conversation:updated', updated);
  }
  if (rows.length) scheduleDrain(100);
  return rows.length;
}

// Tolerância para "sumiu do chat": só passa as conversas se continuar offline depois do prazo
const offlineTimers = new Map();
function onUserOffline(userId) {
  clearTimeout(offlineTimers.get(userId));
  settings().then((cfg) => {
    if (!cfg.enabled || !cfg.handoff) return;
    const t = setTimeout(async () => {
      offlineTimers.delete(userId);
      if (realtime.isOnline(userId)) return;
      const n = await handoff(userId, 'saiu do chat').catch(() => 0);
      if (n) console.log(`[distribuição] ${userId} offline há ${cfg.offlineGraceSeconds}s: ${n} conversa(s) voltaram para a fila`);
    }, cfg.offlineGraceSeconds * 1000);
    if (t.unref) t.unref();
    offlineTimers.set(userId, t);
  }).catch(() => {});
}
function onUserOnline(userId) {
  clearTimeout(offlineTimers.get(userId));
  offlineTimers.delete(userId);
  scheduleDrain();
}

/** Painel: configuração, fila e a situação de cada atendente agora (com o que recebeu hoje, por regra). */
async function status() {
  const cfg = await settings();
  const queued = (await db.query(`SELECT COUNT(*)::int AS n FROM conversations WHERE status = 'open' AND assigned_user_id IS NULL AND last_message_direction IS DISTINCT FROM 'out'`)).rows[0].n;
  const agents = await agentsSnapshot({ forNew: true });
  const { rows: byRule } = await db.query(
    `SELECT user_id, COALESCE(rule, 'outro') AS rule, COUNT(*)::int AS n FROM distribution_log
      WHERE user_id IS NOT NULL AND created_at >= ${TODAY} GROUP BY 1, 2`
  );
  const rulesOf = (id) => Object.fromEntries(byRule.filter((r) => r.user_id === id).map((r) => [r.rule, r.n]));
  return {
    ...cfg,
    queued,
    eligible: agents.filter((u) => u.eligible).map((u) => ({ id: u.id, name: u.name, waiting: u.waiting })),
    agents: agents.map((u) => ({
      id: u.id, name: u.name, availability: u.availability, online: u.online, receives_new: u.receives_new, sector_name: u.sector_name,
      waiting: u.waiting, active: u.active, open: u.open, today: u.today, today_by_rule: rulesOf(u.id),
      last_assigned_at: u.last_assigned_at, eligible: u.eligible, why_not: u.why_not,
    })),
  };
}

/** Últimas decisões (mais novas primeiro). userId filtra por atendente (recebeu ou perdeu a conversa). */
async function recentLog({ limit = 50, userId = null } = {}) {
  const { rows } = await db.query(
    `SELECT d.id, d.created_at, d.conversation_id, d.reason, d.rule, d.details,
            d.user_id, u.name AS user_name, d.from_user_id, f.name AS from_user_name,
            COALESCE(NULLIF(ct.name, ''), NULLIF(ct.profile_name, ''), ct.wa_id) AS contact
       FROM distribution_log d
       JOIN conversations c ON c.id = d.conversation_id
       JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN users u ON u.id = d.user_id
       LEFT JOIN users f ON f.id = d.from_user_id
      WHERE ($2::int IS NULL OR d.user_id = $2 OR d.from_user_id = $2)
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200), userId]
  );
  return rows;
}

module.exports = {
  settings, invalidate, eligible, agentsSnapshot, choose, distribute, onNewConversation, onClientMessage, onSectorTransfer,
  drainQueue, scheduleDrain, handoff, onUserOffline, onUserOnline, status, recentLog, DEFAULTS, MODES,
};
