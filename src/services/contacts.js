/**
 * Ficha do contato: campos, plano de consultas, consultas realizadas e log de atividade.
 */
const db = require('../db');
const realtime = require('../realtime');

class ContactError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const { consultationKinds, DEFAULT_KINDS } = require('../routes/settings');

/** Casa o texto enviado com um tipo configurado (sem diferenciar maiúsculas); aceita texto livre como reserva. */
function resolveKind(list, raw) {
  const t = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  if (!t) return list[0];
  return list.find((k) => k.toLowerCase() === t.toLowerCase()) || t;
}
const UPPER_KINDS = /placa|chassi|motor|renavam/i;

const CONTACT_COLS = `ct.id, ct.wa_id, ct.name, ct.profile_name, ct.avatar_media_id, ct.blocked, ct.cpf, ct.email, ct.notes,
  ct.phone2, ct.company, ct.city, ct.address, ct.birthdate, ct.last_seen_at, ct.created_at,
  ct.plan_id, ct.plan_name, ct.plan_credits, ct.plan_used, ct.plan_started_at, ct.plan_expires_at,
  CASE WHEN ct.plan_credits IS NULL THEN NULL ELSE GREATEST(ct.plan_credits - ct.plan_used, 0) END AS plan_left`;

async function get(id, client = db) {
  const { rows } = await client.query(`SELECT ${CONTACT_COLS} FROM contacts ct WHERE ct.id = $1`, [id]);
  return rows[0] || null;
}

/** Ficha completa: contato + contadores usados pelo painel. */
async function getFull(id) {
  const contact = await get(id);
  if (!contact) return null;
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM conversations c WHERE c.contact_id = $1) AS conversations_count,
       (SELECT COUNT(*)::int FROM contact_notes n WHERE n.contact_id = $1) AS notes_count,
       (SELECT COUNT(*)::int FROM consultations k WHERE k.contact_id = $1 AND k.reversed_at IS NULL) AS consultations_count,
       (SELECT COUNT(*)::int FROM contact_events e WHERE e.contact_id = $1) AS events_count`,
    [id]
  );
  return { ...contact, ...rows[0] };
}

async function logEvent(contactId, userId, type, description, client = db) {
  await client.query('INSERT INTO contact_events (contact_id, user_id, type, description) VALUES ($1, $2, $3, $4)', [contactId, userId || null, type, description]);
}

async function broadcast(id) {
  const contact = await getFull(id);
  if (contact) realtime.broadcast('contact:updated', contact);
  return contact;
}

// ---------- Campos da ficha ----------
async function update(id, user, body) {
  const sets = [];
  const params = [id];
  const changed = [];
  const push = (col, val, label) => { params.push(val); sets.push(`${col} = $${params.length}`); changed.push(label); };
  const text = (v, max) => { const s = String(v ?? '').trim().slice(0, max); return s || null; };
  if (body.name !== undefined) push('name', text(body.name, 120), 'nome');
  if (body.cpf !== undefined) {
    const cpf = String(body.cpf || '').replace(/\D/g, '');
    if (cpf && cpf.length !== 11 && cpf.length !== 14) throw new ContactError(400, 'CPF deve ter 11 dígitos (ou CNPJ 14)');
    push('cpf', cpf || null, 'CPF/CNPJ');
  }
  if (body.email !== undefined) {
    const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new ContactError(400, 'E-mail inválido');
    push('email', email || null, 'e-mail');
  }
  if (body.phone2 !== undefined) push('phone2', text(body.phone2, 40), 'telefone fixo');
  if (body.company !== undefined) push('company', text(body.company, 120), 'empresa');
  if (body.city !== undefined) push('city', text(body.city, 120), 'cidade');
  if (body.address !== undefined) push('address', text(body.address, 240), 'endereço');
  if (body.birthdate !== undefined) {
    const d = String(body.birthdate || '').trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new ContactError(400, 'Data de nascimento inválida');
    push('birthdate', d || null, 'nascimento');
  }
  if (!sets.length) throw new ContactError(400, 'Nada para atualizar');
  const { rowCount } = await db.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1`, params);
  if (!rowCount) throw new ContactError(404, 'Contato não encontrado');
  await logEvent(id, user.id, 'field', `${user.name} atualizou ${changed.join(', ')}`);
  return broadcast(id);
}

async function setBlocked(id, user, blocked) {
  await db.query('UPDATE contacts SET blocked = $2 WHERE id = $1', [id, blocked]);
  await logEvent(id, user.id, blocked ? 'block' : 'unblock', `${user.name} ${blocked ? 'bloqueou' : 'desbloqueou'} o contato`);
}

async function remove(id) {
  const { rowCount } = await db.query('DELETE FROM contacts WHERE id = $1', [id]);
  if (!rowCount) throw new ContactError(404, 'Contato não encontrado');
}

// ---------- Plano ----------
function expiresFrom(startedAt, validityDays) {
  if (!validityDays) return null;
  return new Date(new Date(startedAt).getTime() + validityDays * 86400e3);
}

/**
 * Atribui (ou troca) o plano do contato. Aceita um plano do catálogo (plan_id) ou valores avulsos
 * (name + credits + validity_days). Zera as consultas usadas e reinicia o ciclo.
 */
async function setPlan(id, user, body) {
  const contact = await get(id);
  if (!contact) throw new ContactError(404, 'Contato não encontrado');
  let name, credits, validityDays = null, planId = null;
  if (body.plan_id) {
    const { rows } = await db.query('SELECT * FROM plans WHERE id = $1', [body.plan_id]);
    if (!rows.length) throw new ContactError(400, 'Plano não encontrado');
    planId = rows[0].id; name = rows[0].name; credits = rows[0].credits; validityDays = rows[0].validity_days;
  } else {
    name = String(body.name || '').trim().slice(0, 80) || 'Plano personalizado';
    credits = Number(body.credits);
    if (!Number.isInteger(credits) || credits < 0 || credits > 10000) throw new ContactError(400, 'Quantidade de consultas inválida');
    validityDays = body.validity_days ? Number(body.validity_days) : null;
    if (validityDays !== null && (!Number.isInteger(validityDays) || validityDays <= 0)) throw new ContactError(400, 'Validade inválida');
  }
  const startedAt = new Date();
  const expiresAt = body.expires_at ? new Date(body.expires_at) : expiresFrom(startedAt, validityDays);
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new ContactError(400, 'Data de vencimento inválida');
  await db.query(
    `UPDATE contacts SET plan_id = $2, plan_name = $3, plan_credits = $4, plan_used = 0, plan_started_at = $5, plan_expires_at = $6 WHERE id = $1`,
    [id, planId, name, credits, startedAt, expiresAt]
  );
  await logEvent(id, user.id, 'plan', `${user.name} ${contact.plan_credits === null ? 'atribuiu' : 'trocou para'} o plano ${name} (${credits} consulta(s))`);
  return broadcast(id);
}

/** Renova o ciclo: zera as usadas e recalcula o vencimento pela validade do plano (ou mantém o mesmo intervalo). */
async function renewPlan(id, user) {
  const contact = await get(id);
  if (!contact) throw new ContactError(404, 'Contato não encontrado');
  if (contact.plan_credits === null) throw new ContactError(400, 'Este contato não tem plano');
  let validityDays = null;
  if (contact.plan_id) {
    const { rows } = await db.query('SELECT validity_days, credits FROM plans WHERE id = $1', [contact.plan_id]);
    validityDays = rows[0]?.validity_days || null;
  }
  if (!validityDays && contact.plan_started_at && contact.plan_expires_at) {
    validityDays = Math.max(1, Math.round((new Date(contact.plan_expires_at) - new Date(contact.plan_started_at)) / 86400e3));
  }
  const startedAt = new Date();
  await db.query(
    'UPDATE contacts SET plan_used = 0, plan_started_at = $2, plan_expires_at = $3 WHERE id = $1',
    [id, startedAt, expiresFrom(startedAt, validityDays)]
  );
  await logEvent(id, user.id, 'plan', `${user.name} renovou o plano ${contact.plan_name} (${contact.plan_credits} consulta(s))`);
  return broadcast(id);
}

async function removePlan(id, user) {
  const contact = await get(id);
  if (!contact) throw new ContactError(404, 'Contato não encontrado');
  if (contact.plan_credits === null) throw new ContactError(400, 'Este contato não tem plano');
  await db.query('UPDATE contacts SET plan_id = NULL, plan_name = NULL, plan_credits = NULL, plan_used = 0, plan_started_at = NULL, plan_expires_at = NULL WHERE id = $1', [id]);
  await logEvent(id, user.id, 'plan', `${user.name} removeu o plano ${contact.plan_name}`);
  return broadcast(id);
}

/** Ajuste manual do saldo (ex.: corrigir contagem antiga). */
async function adjustPlan(id, user, body) {
  const contact = await get(id);
  if (!contact) throw new ContactError(404, 'Contato não encontrado');
  if (contact.plan_credits === null) throw new ContactError(400, 'Este contato não tem plano');
  const sets = [];
  const params = [id];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (body.credits !== undefined) {
    const n = Number(body.credits);
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw new ContactError(400, 'Quantidade de consultas inválida');
    push('plan_credits', n);
  }
  if (body.used !== undefined) {
    const n = Number(body.used);
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw new ContactError(400, 'Consultas usadas inválidas');
    push('plan_used', n);
  }
  if (body.expires_at !== undefined) {
    const d = body.expires_at ? new Date(body.expires_at) : null;
    if (d && Number.isNaN(d.getTime())) throw new ContactError(400, 'Data de vencimento inválida');
    push('plan_expires_at', d);
  }
  if (body.name !== undefined) push('plan_name', String(body.name || '').trim().slice(0, 80) || contact.plan_name);
  if (!sets.length) throw new ContactError(400, 'Nada para ajustar');
  await db.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1`, params);
  const after = await get(id);
  await logEvent(id, user.id, 'plan', `${user.name} ajustou o plano: ${after.plan_used} usada(s) de ${after.plan_credits}`);
  return broadcast(id);
}

// ---------- Consultas ----------
/**
 * Registra uma consulta. Se `charge` for verdadeiro debita 1 do plano (exige saldo). Cria uma nota interna
 * na conversa e, ao zerar o saldo, marca a conversa com a etiqueta "Renovação".
 */
async function registerConsultation(id, user, body) {
  const kind = resolveKind(await consultationKinds(), body.kind);
  let reference = String(body.reference || '').trim().replace(/\s+/g, ' ').slice(0, 60) || null;
  if (reference && UPPER_KINDS.test(kind)) reference = reference.toUpperCase();
  const note = String(body.note || '').trim().slice(0, 500) || null;
  const conversationId = body.conversation_id ? Number(body.conversation_id) : null;
  const wantCharge = body.charge !== false;

  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT ${CONTACT_COLS} FROM contacts ct WHERE ct.id = $1 FOR UPDATE`, [id]);
    const contact = rows[0];
    if (!contact) throw new ContactError(404, 'Contato não encontrado');
    const hasPlan = contact.plan_credits !== null;
    const expired = Boolean(contact.plan_expires_at) && new Date(contact.plan_expires_at) < new Date();
    const charge = wantCharge && hasPlan;
    if (charge && contact.plan_left <= 0) throw new ContactError(409, 'O plano deste cliente não tem mais consultas disponíveis');
    if (charge && expired) throw new ContactError(409, 'O plano deste cliente está vencido. Renove antes de debitar');
    if (conversationId) {
      const { rows: conv } = await client.query('SELECT id FROM conversations WHERE id = $1 AND contact_id = $2', [conversationId, id]);
      if (!conv.length) throw new ContactError(400, 'Conversa não pertence a este contato');
    }
    const ins = await client.query(
      `INSERT INTO consultations (contact_id, conversation_id, user_id, kind, reference, charged, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, conversationId, user.id, kind, reference, charge, note]
    );
    if (charge) await client.query('UPDATE contacts SET plan_used = plan_used + 1 WHERE id = $1', [id]);
    const { rows: afterRows } = await client.query(`SELECT ${CONTACT_COLS} FROM contacts ct WHERE ct.id = $1`, [id]);
    const after = afterRows[0];
    const label = `${kind}${reference ? ' ' + reference : ''}`;
    const balance = charge ? ` · saldo ${after.plan_left}/${after.plan_credits}` : (hasPlan ? ' · sem debitar do plano' : ' · avulsa');
    await logEvent(id, user.id, 'consultation', `${user.name} registrou consulta ${label}${balance}`, client);
    let message = null;
    let tagged = false;
    if (conversationId) {
      const text = `Consulta registrada: ${label}${balance}${note ? ' · ' + note : ''}`;
      const m = await client.query(
        `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id) VALUES ($1, 'out', 'note', $2, 'sent', $3) RETURNING *`,
        [conversationId, text, user.id]
      );
      message = { ...m.rows[0], sender_name: user.name, sender_avatar: user.avatar_media_id || null };
      if (charge && after.plan_left === 0) {
        const t = await client.query(`SELECT id FROM tags WHERE name = 'Renovação'`);
        if (t.rows.length) {
          const r = await client.query('INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [conversationId, t.rows[0].id]);
          tagged = r.rowCount > 0;
        }
      }
    }
    return { consultation: { ...ins.rows[0], user_name: user.name, kind_label: kind }, contact: after, message, tagged };
  });

  const contact = await broadcast(id);
  if (result.message) {
    const conversations = require('./conversations');
    const conv = await conversations.getById(conversationId);
    realtime.broadcast('message:new', { message: result.message, conversation: conv });
    if (result.tagged) realtime.broadcast('conversation:updated', conv);
  }
  return { consultation: result.consultation, contact, message: result.message };
}

/** Estorna uma consulta (devolve o crédito se tinha sido debitada). */
async function reverseConsultation(id, consultationId, user) {
  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM consultations WHERE id = $1 AND contact_id = $2 FOR UPDATE', [consultationId, id]);
    const k = rows[0];
    if (!k) throw new ContactError(404, 'Consulta não encontrada');
    if (k.reversed_at) throw new ContactError(409, 'Consulta já estornada');
    await client.query('UPDATE consultations SET reversed_at = NOW(), reversed_by = $2 WHERE id = $1', [consultationId, user.id]);
    if (k.charged) await client.query('UPDATE contacts SET plan_used = GREATEST(plan_used - 1, 0) WHERE id = $1 AND plan_credits IS NOT NULL', [id]);
    await logEvent(id, user.id, 'consultation', `${user.name} estornou a consulta ${k.kind}${k.reference ? ' ' + k.reference : ''}${k.charged ? ' (crédito devolvido)' : ''}`, client);
    return k;
  });
  const contact = await broadcast(id);
  return { consultation: result, contact };
}

async function listConsultations(id, limit = 100) {
  const { rows } = await db.query(
    `SELECT k.*, u.name AS user_name, ru.name AS reversed_by_name
       FROM consultations k LEFT JOIN users u ON u.id = k.user_id LEFT JOIN users ru ON ru.id = k.reversed_by
      WHERE k.contact_id = $1 ORDER BY k.created_at DESC, k.id DESC LIMIT $2`,
    [id, limit]
  );
  return rows.map((r) => ({ ...r, kind_label: r.kind }));
}

async function listEvents(id, limit = 100) {
  const { rows } = await db.query(
    `SELECT e.*, u.name AS user_name FROM contact_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.contact_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
    [id, limit]
  );
  return rows;
}

// ---------- Observações fixadas na ficha ----------
async function listNotes(id, limit = 100) {
  const { rows } = await db.query(
    `SELECT n.id, n.body, n.created_at, n.updated_at, n.user_id, u.name AS user_name, u.avatar_media_id AS user_avatar
       FROM contact_notes n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.contact_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
    [id, limit]
  );
  return rows;
}

function cleanNoteBody(body) {
  const text = String(body || '').trim().slice(0, 2000);
  if (!text) throw new ContactError(400, 'Escreva a observação');
  return text;
}

async function addNote(id, user, body) {
  const contact = await get(id);
  if (!contact) throw new ContactError(404, 'Contato não encontrado');
  const text = cleanNoteBody(body);
  const { rows } = await db.query('INSERT INTO contact_notes (contact_id, user_id, body) VALUES ($1, $2, $3) RETURNING *', [id, user.id, text]);
  await logEvent(id, user.id, 'note', `${user.name} fixou uma observação: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
  await broadcast(id);
  return { ...rows[0], user_name: user.name, user_avatar: user.avatar_media_id || null };
}

async function noteFor(id, noteId, user) {
  const { rows } = await db.query('SELECT * FROM contact_notes WHERE id = $1 AND contact_id = $2', [noteId, id]);
  if (!rows.length) throw new ContactError(404, 'Observação não encontrada');
  if (rows[0].user_id !== user.id && user.role !== 'admin') throw new ContactError(403, 'Só quem escreveu (ou um admin) pode alterar esta observação');
  return rows[0];
}

async function updateNote(id, noteId, user, body) {
  await noteFor(id, noteId, user);
  const text = cleanNoteBody(body);
  const { rows } = await db.query(
    `WITH up AS (UPDATE contact_notes SET body = $3, updated_at = NOW() WHERE id = $1 AND contact_id = $2 RETURNING *)
     SELECT up.*, u.name AS user_name, u.avatar_media_id AS user_avatar FROM up LEFT JOIN users u ON u.id = up.user_id`,
    [noteId, id, text]
  );
  await logEvent(id, user.id, 'note', `${user.name} editou uma observação`);
  await broadcast(id);
  return rows[0];
}

async function deleteNote(id, noteId, user) {
  const n = await noteFor(id, noteId, user);
  await db.query('DELETE FROM contact_notes WHERE id = $1', [noteId]);
  await logEvent(id, user.id, 'note', `${user.name} removeu a observação: ${n.body.slice(0, 80)}`);
  await broadcast(id);
}

module.exports = {
  ContactError, DEFAULT_KINDS, CONTACT_COLS, get, getFull, update, setBlocked, remove, logEvent,
  setPlan, renewPlan, removePlan, adjustPlan, registerConsultation, reverseConsultation,
  listConsultations, listEvents, listNotes, addNote, updateNote, deleteNote,
};
