/**
 * Distribuição automática de conversas.
 *
 * Elegível agora = ativo, "recebe conversas novas", logado no chat, status "disponível", do setor da
 * conversa (atendente sem setor atende qualquer um) e abaixo do limite de clientes esperando resposta.
 * Escolha: afinidade (último atendente do contato, se elegível) → menos clientes esperando → rodízio
 * (quem recebeu conversa há mais tempo).
 *
 * Ninguém elegível: a conversa fica sem responsável ("na fila"); a fila é esvaziada, em ordem de
 * chegada, sempre que alguém fica elegível (login, voltou de ausente, respondeu, encerrou uma conversa).
 *
 * Passagem de turno: quando o atendente fica offline (encerrou o expediente ou sumiu do chat por mais
 * que a tolerância), as conversas dele em que o cliente está esperando resposta voltam para a fila.
 * As paradas ficam com ele; se o cliente escrever enquanto ele está fora, aí vão para a fila também.
 */
const db = require('../db');
const realtime = require('../realtime');

const DEFAULTS = { enabled: false, waitingLimit: 5, affinity: true, handoff: true, offlineGraceSeconds: 120 };
let cache = null;

async function settings() {
  if (cache) return cache;
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key LIKE 'distribution_%'`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = {
    enabled: s.distribution_enabled === '1',
    waitingLimit: Math.max(0, Number(s.distribution_waiting_limit ?? DEFAULTS.waitingLimit) || 0),
    affinity: (s.distribution_affinity ?? '1') === '1',
    handoff: (s.distribution_handoff ?? '1') === '1',
    offlineGraceSeconds: Math.max(10, Number(s.distribution_offline_grace_seconds ?? DEFAULTS.offlineGraceSeconds) || DEFAULTS.offlineGraceSeconds),
  };
  return cache;
}
function invalidate() { cache = null; }

/** Atendentes que podem receber agora, com quantos clientes cada um tem esperando. */
async function eligible({ sectorId = null, forNew = true } = {}) {
  const cfg = await settings();
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.sector_id, u.last_assigned_at,
            (SELECT COUNT(*)::int FROM conversations c WHERE c.assigned_user_id = u.id AND c.status = 'open' AND c.last_message_direction IS DISTINCT FROM 'out') AS waiting
       FROM users u
      WHERE u.active = TRUE AND u.availability = 'available' ${forNew ? 'AND u.receives_new = TRUE' : ''}
        AND ($1::int IS NULL OR u.sector_id IS NULL OR u.sector_id = $1)`,
    [sectorId]
  );
  return rows.filter((u) => realtime.isOnline(u.id) && (cfg.waitingLimit === 0 || u.waiting < cfg.waitingLimit));
}

/** Último atendente que respondeu a este contato (em qualquer conversa). */
async function lastAgentFor(contactId) {
  const { rows } = await db.query(
    `SELECT m.sender_user_id AS id FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.contact_id = $1 AND m.direction = 'out' AND m.type <> 'note' AND m.sender_user_id IS NOT NULL
      ORDER BY m.created_at DESC LIMIT 1`,
    [contactId]
  );
  return rows[0]?.id || null;
}

function choose(candidates, preferredId) {
  if (!candidates.length) return null;
  if (preferredId) { const p = candidates.find((u) => u.id === preferredId); if (p) return { user: p, reason: 'afinidade' }; }
  const sorted = [...candidates].sort((a, b) => (a.waiting - b.waiting) || ((a.last_assigned_at ? new Date(a.last_assigned_at).getTime() : 0) - (b.last_assigned_at ? new Date(b.last_assigned_at).getTime() : 0)));
  return { user: sorted[0], reason: 'rodízio' };
}

/** Atribui a conversa, registra e avisa o atendente. */
async function assign(conv, user, reason, { fromUserId = null } = {}) {
  await db.query('UPDATE conversations SET assigned_user_id = $2, attended = TRUE WHERE id = $1 AND status = $3', [conv.id, user.id, 'open']);
  await db.query('UPDATE users SET last_assigned_at = NOW() WHERE id = $1', [user.id]);
  await db.query('INSERT INTO distribution_log (conversation_id, user_id, from_user_id, reason) VALUES ($1, $2, $3, $4)', [conv.id, user.id, fromUserId, reason]);
  const text = `Distribuída para ${user.name} (${reason}${user.waiting !== undefined ? `, ${user.waiting} esperando` : ''})`;
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

/** Tenta dar dono a uma conversa sem responsável. Devolve a conversa atualizada ou null (fila). */
async function distribute(conv, { forNew = true, fromUserId = null } = {}) {
  const cfg = await settings();
  if (!cfg.enabled) return null;
  const candidates = await eligible({ sectorId: conv.sector_id || null, forNew });
  if (!candidates.length) return null;
  const preferred = cfg.affinity ? await lastAgentFor(conv.contact_id) : null;
  const pick = choose(candidates, preferred);
  return pick ? assign(conv, pick.user, pick.reason, { fromUserId }) : null;
}

/** Conversa nova do cliente: distribui na hora (se ninguém, fica na fila). */
async function onNewConversation(conversation) {
  try {
    if (!conversation || conversation.assigned_user_id) return null;
    return await distribute(conversation, { forNew: true });
  } catch (err) { console.warn('[distribuição] nova conversa:', err.message); return null; }
}

/** Cliente escreveu numa conversa cujo dono está offline: passa para quem está atendendo. */
async function onClientMessage(conversation) {
  try {
    const cfg = await settings();
    if (!cfg.enabled || !cfg.handoff || !conversation || !conversation.assigned_user_id) return null;
    const { rows } = await db.query('SELECT id, name, availability FROM users WHERE id = $1', [conversation.assigned_user_id]);
    const owner = rows[0];
    if (!owner) return null;
    const ownerOff = owner.availability === 'offline' || !realtime.isOnline(owner.id);
    if (!ownerOff) return null;
    const candidates = await eligible({ sectorId: conversation.sector_id || null, forNew: false });
    const pick = choose(candidates.filter((u) => u.id !== owner.id), null);
    if (!pick) return null;
    return await assign(conversation, pick.user, `assumida de ${owner.name}, que está offline`, { fromUserId: owner.id });
  } catch (err) { console.warn('[distribuição] mensagem do cliente:', err.message); return null; }
}

/** Transferência para um setor sem escolher pessoa: distribui entre os do setor. */
async function onSectorTransfer(conversation) {
  try { return await distribute(conversation, { forNew: false }); } catch (err) { console.warn('[distribuição] setor:', err.message); return null; }
}

let draining = false;
let drainAgain = false;
/** Esvazia a fila (conversas abertas sem responsável), em ordem de chegada, enquanto houver elegíveis. */
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
  const { rows } = await db.query(
    `UPDATE conversations SET assigned_user_id = NULL
      WHERE assigned_user_id = $1 AND status = 'open' AND last_message_direction IS DISTINCT FROM 'out'
      RETURNING id, contact_id, sector_id`,
    [userId]
  );
  const conversations = require('./conversations');
  for (const c of rows) {
    await db.query('INSERT INTO distribution_log (conversation_id, user_id, from_user_id, reason) VALUES ($1, NULL, $2, $3)', [c.id, userId, `voltou para a fila: ${u.name} ${why}`]);
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

/** Resumo para a tela de Configurações e para o painel Equipe. */
async function status() {
  const cfg = await settings();
  const queued = (await db.query(`SELECT COUNT(*)::int AS n FROM conversations WHERE status = 'open' AND assigned_user_id IS NULL AND last_message_direction IS DISTINCT FROM 'out'`)).rows[0].n;
  const el = cfg.enabled ? await eligible({ forNew: true }) : [];
  return { ...cfg, queued, eligible: el.map((u) => ({ id: u.id, name: u.name, waiting: u.waiting })) };
}

module.exports = { settings, invalidate, eligible, distribute, onNewConversation, onClientMessage, onSectorTransfer, drainQueue, scheduleDrain, handoff, onUserOffline, onUserOnline, status, DEFAULTS };
