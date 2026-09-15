/* Mensagens agendadas: criação, cancelamento automático e envio no horário. */
const db = require('../db');
const realtime = require('../realtime');

const TICK_MS = 20 * 1000;
let timer = null;
let running = false;

const SELECT = `
  SELECT s.*, u.name AS user_name
    FROM scheduled_messages s LEFT JOIN users u ON u.id = s.user_id
`;

async function pendingCount(conversationId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages WHERE conversation_id = $1 AND status = 'pending'`, [conversationId]
  );
  return rows[0].n;
}

async function notify(conversationId) {
  realtime.broadcast('schedule:updated', { conversation_id: conversationId, pending: await pendingCount(conversationId) });
}

async function list(conversationId) {
  const { rows } = await db.query(`${SELECT} WHERE s.conversation_id = $1 ORDER BY s.status = 'pending' DESC, s.send_at DESC LIMIT 200`, [conversationId]);
  return rows;
}

async function create(conversationId, user, data) {
  const body = String(data.body || '').trim();
  const sendAt = new Date(data.send_at);
  const kind = data.kind === 'note' ? 'note' : 'message';
  if (!body) throw Object.assign(new Error('Escreva a mensagem'), { status: 400 });
  if (body.length > 4096) throw Object.assign(new Error('Mensagem excede 4096 caracteres'), { status: 400 });
  if (Number.isNaN(sendAt.getTime())) throw Object.assign(new Error('Data e hora inválidas'), { status: 400 });
  if (sendAt.getTime() < Date.now() - 60 * 1000) throw Object.assign(new Error('O horário já passou'), { status: 400 });
  const { rows } = await db.query(
    `INSERT INTO scheduled_messages
       (conversation_id, user_id, kind, body, send_at, cancel_on_contact_reply, cancel_on_agent_reply, cancel_on_resolve)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [conversationId, user.id, kind, body, sendAt, Boolean(data.cancel_on_contact_reply), Boolean(data.cancel_on_agent_reply), data.cancel_on_resolve !== false]
  );
  await notify(conversationId);
  return getById(rows[0].id);
}

async function getById(id) {
  const { rows } = await db.query(`${SELECT} WHERE s.id = $1`, [id]);
  return rows[0] || null;
}

async function update(id, conversationId, data) {
  const sets = [];
  const params = [id, conversationId];
  if (data.body !== undefined) {
    const body = String(data.body).trim();
    if (!body) throw Object.assign(new Error('Escreva a mensagem'), { status: 400 });
    params.push(body); sets.push(`body = $${params.length}`);
  }
  if (data.send_at !== undefined) {
    const sendAt = new Date(data.send_at);
    if (Number.isNaN(sendAt.getTime())) throw Object.assign(new Error('Data e hora inválidas'), { status: 400 });
    params.push(sendAt); sets.push(`send_at = $${params.length}`);
  }
  for (const f of ['cancel_on_contact_reply', 'cancel_on_agent_reply', 'cancel_on_resolve']) {
    if (data[f] !== undefined) { params.push(Boolean(data[f])); sets.push(`${f} = $${params.length}`); }
  }
  if (data.kind !== undefined) { params.push(data.kind === 'note' ? 'note' : 'message'); sets.push(`kind = $${params.length}`); }
  if (!sets.length) throw Object.assign(new Error('Nada para atualizar'), { status: 400 });
  const { rowCount } = await db.query(
    `UPDATE scheduled_messages SET ${sets.join(', ')} WHERE id = $1 AND conversation_id = $2 AND status = 'pending'`, params
  );
  if (!rowCount) throw Object.assign(new Error('Agendamento não encontrado ou já processado'), { status: 404 });
  await notify(conversationId);
  return getById(id);
}

async function cancel(id, conversationId, reason) {
  const { rowCount } = await db.query(
    `UPDATE scheduled_messages SET status = 'cancelled', cancel_reason = $3, finished_at = NOW()
      WHERE id = $1 AND conversation_id = $2 AND status = 'pending'`,
    [id, conversationId, reason]
  );
  if (!rowCount) throw Object.assign(new Error('Agendamento não encontrado ou já processado'), { status: 404 });
  await notify(conversationId);
  return getById(id);
}

/** Cancelamento automático por gatilho: 'contact' (cliente respondeu), 'agent' (atendente respondeu), 'resolve' (finalizada). */
async function cancelFor(conversationId, trigger) {
  const column = { contact: 'cancel_on_contact_reply', agent: 'cancel_on_agent_reply', resolve: 'cancel_on_resolve' }[trigger];
  const reason = { contact: 'O cliente enviou uma nova mensagem', agent: 'Um atendente respondeu antes', resolve: 'A conversa foi finalizada' }[trigger];
  if (!column) return 0;
  const { rowCount } = await db.query(
    `UPDATE scheduled_messages SET status = 'cancelled', cancel_reason = $2, finished_at = NOW()
      WHERE conversation_id = $1 AND status = 'pending' AND ${column} = TRUE`,
    [conversationId, reason]
  );
  if (rowCount) await notify(conversationId);
  return rowCount;
}

/** Envia imediatamente um agendamento pendente (botão "Enviar agora" ou o relógio chegou). */
async function dispatch(id) {
  const outbound = require('./outbound');
  const s = await getById(id);
  if (!s || s.status !== 'pending') return s;
  const user = { id: s.user_id, name: s.user_name || 'Agendamento' };
  try {
    const result = s.kind === 'note'
      ? await outbound.addNote(s.conversation_id, user, s.body)
      : await outbound.sendText(s.conversation_id, user, s.body, { scheduled: true });
    const failed = result.message.status === 'failed';
    await db.query(
      `UPDATE scheduled_messages SET status = $2, sent_message_id = $3, error = $4, finished_at = NOW() WHERE id = $1`,
      [id, failed ? 'failed' : 'sent', result.message.id, failed ? result.message.error : null]
    );
  } catch (err) {
    await db.query(`UPDATE scheduled_messages SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`, [id, String(err.message).slice(0, 500)]);
  }
  await notify(s.conversation_id);
  return getById(id);
}

/** Uma passada do agendador: pega o que venceu e envia. Seguro para rodar em paralelo (SKIP LOCKED). */
async function tick() {
  if (running) return 0;
  running = true;
  let count = 0;
  try {
    const { rows } = await db.query(
      `SELECT id FROM scheduled_messages WHERE status = 'pending' AND send_at <= NOW() ORDER BY send_at LIMIT 20 FOR UPDATE SKIP LOCKED`
    );
    for (const r of rows) {
      await dispatch(r.id);
      count++;
    }
  } catch (err) {
    console.error('[agendador] erro', err);
  } finally {
    running = false;
  }
  return count;
}

function start() {
  if (timer) return;
  timer = setInterval(() => tick(), TICK_MS);
  timer.unref();
  setTimeout(() => tick(), 3000).unref();
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { list, create, update, cancel, cancelFor, dispatch, tick, start, stop, pendingCount };
