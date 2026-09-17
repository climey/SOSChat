const db = require('../db');
const recurrence = require('./recurrence');

/**
 * SELECT base. `userParam` é o índice do parâmetro com o id do atendente ($1, $2...), para trazer as
 * preferências pessoais (fixada, silenciada, oculta); sem ele, vêm como false.
 */
function selectSql(userParam) {
  const prefsJoin = userParam
    ? `LEFT JOIN conversation_prefs cp ON cp.conversation_id = c.id AND cp.user_id = $${userParam}`
    : `LEFT JOIN conversation_prefs cp ON FALSE`;
  return `
  SELECT c.id, c.status, c.assigned_user_id, c.unread_count, c.last_message_at,
         c.last_message_preview, c.last_message_direction, c.first_response_at, c.resolved_at, c.created_at, c.attended,
         COALESCE(cp.pinned, FALSE) AS pinned, COALESCE(cp.muted, FALSE) AS muted, COALESCE(cp.hidden, FALSE) AS hidden,
         ct.id AS contact_id, ct.wa_id, ct.name AS contact_name, ct.profile_name, ct.avatar_media_id, ct.blocked AS contact_blocked,
         ct.plan_name, ct.plan_credits, ct.plan_expires_at,
         ct.interactions, ct.active_months, ct.first_contact_at, ct.last_seen_at,
         ct.credits_bought, ct.purchases_count, ct.first_purchase_at, ct.last_purchase_at,
         (SELECT COUNT(*)::int FROM contact_notes n WHERE n.contact_id = ct.id) AS notes_count,
         CASE WHEN ct.plan_credits IS NULL THEN NULL ELSE GREATEST(ct.plan_credits - ct.plan_used, 0) END AS plan_left,
         u.name AS assigned_user_name, u.avatar_media_id AS assigned_user_avatar,
         (SELECT COALESCE(json_agg(json_build_object('id', p.id, 'name', p.name, 'avatar', p.avatar_media_id, 'last_at', p.last_at) ORDER BY p.last_at DESC), '[]'::json)
            FROM (SELECT u2.id, u2.name, u2.avatar_media_id, MAX(m.created_at) AS last_at
                    FROM messages m JOIN users u2 ON u2.id = m.sender_user_id
                   WHERE m.conversation_id = c.id
                   GROUP BY u2.id, u2.name, u2.avatar_media_id
                   ORDER BY MAX(m.created_at) DESC LIMIT 5) p) AS participants,
         c.account_id, wa.name AS account_name, wa.phone AS account_phone,
         c.sector_id, se.name AS sector_name, se.color AS sector_color,
         COALESCE(sc.n, 0) AS scheduled_count
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN users u ON u.id = c.assigned_user_id
    LEFT JOIN wa_accounts wa ON wa.id = c.account_id
    LEFT JOIN sectors se ON se.id = c.sector_id
    LEFT JOIN (SELECT conversation_id, COUNT(*)::int AS n FROM scheduled_messages WHERE status = 'pending' GROUP BY conversation_id) sc
           ON sc.conversation_id = c.id
    ${prefsJoin}
`;
}

/** Anexa o array `tags` a cada conversa (uma query para o lote inteiro). */
async function attachTags(rows, client) {
  for (const r of rows) r.tags = [];
  if (!rows.length) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { rows: tagRows } = await client.query(
    `SELECT ct.conversation_id, t.id, t.name, t.color
       FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id
      WHERE ct.conversation_id = ANY($1::int[])
      ORDER BY t.name`,
    [[...byId.keys()]]
  );
  for (const t of tagRows) {
    byId.get(t.conversation_id)?.tags.push({ id: t.id, name: t.name, color: t.color });
  }
  return rows;
}

/** userId opcional: traz as preferências pessoais desse atendente. */
async function getById(id, client = db, userId = null) {
  const { rows } = userId
    ? await client.query(`${selectSql(2)} WHERE c.id = $1`, [id, userId])
    : await client.query(`${selectSql(null)} WHERE c.id = $1`, [id]);
  if (!rows.length) return null;
  await attachTags(rows, client);
  return rows[0];
}

/** Grava preferências pessoais (fixar, silenciar, ocultar) do atendente para a conversa. */
async function setPrefs(conversationId, userId, prefs) {
  const cols = ['pinned', 'muted', 'hidden'].filter((k) => prefs[k] !== undefined);
  if (!cols.length) return;
  const values = cols.map((k) => Boolean(prefs[k]));
  await db.query(
    `INSERT INTO conversation_prefs (conversation_id, user_id, ${cols.join(', ')})
     VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = NOW()`,
    [conversationId, userId, ...values]
  );
}

/**
 * Lista conversas com filtros. Todos os valores entram como parâmetros.
 * filters: { status, assigned: 'me'|'unassigned'|'all', userId, tagId, q, limit, offset }
 */
async function list(filters = {}) {
  const where = [];
  const params = [filters.userId || null]; // $1 = atendente (preferências pessoais)
  let joins = '';
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  // inbox = todas as abertas; waiting = abertas aguardando resposta do atendente (última mensagem é do cliente)
  if (filters.status === 'inbox') where.push(`c.status = 'open'`);
  else if (filters.status === 'waiting') where.push(`c.status = 'open' AND c.last_message_direction IS DISTINCT FROM 'out'`);
  else if (filters.status && filters.status !== 'all') add('c.status = ?', filters.status);
  if (filters.assigned === 'me') add('c.assigned_user_id = ?', filters.userId);
  if (filters.assigned === 'unassigned') where.push('c.assigned_user_id IS NULL');
  if (filters.accountId) add('c.account_id = ?', filters.accountId);
  if (filters.sectorId) add('c.sector_id = ?', filters.sectorId);
  if (filters.plan === 'with') where.push('ct.plan_credits IS NOT NULL');
  else if (filters.plan === 'without') where.push('ct.plan_credits IS NULL');
  else if (filters.plan === 'empty') where.push('ct.plan_credits IS NOT NULL AND ct.plan_used >= ct.plan_credits');
  else if (filters.plan === 'expired') where.push('ct.plan_credits IS NOT NULL AND ct.plan_expires_at < NOW()');
  if (filters.recurrence) { const rs = recurrence.whereSql(filters.recurrence, await recurrence.thresholds()); if (rs) where.push(rs); }
  if (filters.hidden === 'only') where.push('COALESCE(cp.hidden, FALSE) = TRUE');
  else if (filters.hidden !== 'all') where.push('COALESCE(cp.hidden, FALSE) = FALSE');
  if (filters.tagId) {
    params.push(filters.tagId);
    // (conversation_id, tag_id) é chave primária, então o JOIN não duplica linhas
    joins += ` JOIN conversation_tags ft ON ft.conversation_id = c.id AND ft.tag_id = $${params.length}`;
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    const p = `$${params.length}`;
    where.push(`(ct.wa_id ILIKE ${p} OR ct.name ILIKE ${p} OR ct.profile_name ILIKE ${p})`);
  }

  const limit = Math.min(Number(filters.limit) || 50, 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  params.push(limit, offset);

  // Esperando: quem espera há mais tempo primeiro. Entrada e demais: fixadas, depois a atividade mais recente.
  const order = filters.status === 'waiting'
    ? 'COALESCE(cp.pinned, FALSE) DESC, c.last_message_at ASC'
    : 'COALESCE(cp.pinned, FALSE) DESC, c.last_message_at DESC';
  const sql = `${selectSql(1)} ${joins}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order}
    LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await db.query(sql, params);
  return attachTags(rows, db);
}

/** Contagem por aba (Esperando / Entrada / Finalizados) com os mesmos filtros da lista, exceto status. */
async function counts(filters = {}) {
  const params = [filters.userId || null];
  const where = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  let joins = '';
  if (filters.assigned === 'me') add('c.assigned_user_id = ?', filters.userId);
  if (filters.assigned === 'unassigned') where.push('c.assigned_user_id IS NULL');
  if (filters.accountId) add('c.account_id = ?', filters.accountId);
  if (filters.sectorId) add('c.sector_id = ?', filters.sectorId);
  if (filters.plan === 'with') where.push('ct.plan_credits IS NOT NULL');
  else if (filters.plan === 'without') where.push('ct.plan_credits IS NULL');
  else if (filters.plan === 'empty') where.push('ct.plan_credits IS NOT NULL AND ct.plan_used >= ct.plan_credits');
  else if (filters.plan === 'expired') where.push('ct.plan_credits IS NOT NULL AND ct.plan_expires_at < NOW()');
  if (filters.recurrence) { const rs = recurrence.whereSql(filters.recurrence, await recurrence.thresholds()); if (rs) where.push(rs); }
  if (filters.hidden === 'only') where.push('COALESCE(cp.hidden, FALSE) = TRUE');
  else if (filters.hidden !== 'all') where.push('COALESCE(cp.hidden, FALSE) = FALSE');
  if (filters.tagId) { params.push(filters.tagId); joins += ` JOIN conversation_tags ft ON ft.conversation_id = c.id AND ft.tag_id = $${params.length}`; }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    const p = `$${params.length}`;
    joins += ' JOIN contacts ctq ON ctq.id = c.contact_id';
    where.push(`(ctq.wa_id ILIKE ${p} OR ctq.name ILIKE ${p} OR ctq.profile_name ILIKE ${p})`);
  }
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE c.status = 'open' AND c.last_message_direction IS DISTINCT FROM 'out')::int AS waiting,
            COUNT(*) FILTER (WHERE c.status = 'open')::int AS inbox,
            COUNT(*) FILTER (WHERE c.status = 'open' AND c.attended = FALSE)::int AS queued,
            COUNT(*) FILTER (WHERE c.status = 'resolved')::int AS resolved
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN conversation_prefs cp ON cp.conversation_id = c.id AND cp.user_id = $1
       ${joins} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    params
  );
  return rows[0];
}

/** Id do setor padrão (para conversas novas). */
async function defaultSectorId(client = db) {
  const { rows } = await client.query('SELECT id FROM sectors WHERE is_default ORDER BY id LIMIT 1');
  return rows[0]?.id || null;
}

/** Remove arquivos de mídia que nenhuma mensagem nem contato referencia mais. */
async function purgeOrphanMedia() {
  const { rowCount } = await db.query(
    `DELETE FROM media_files mf
      WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.media_id = mf.id)
        AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.avatar_media_id = mf.id)`
  );
  return rowCount;
}

/** Conversas de números que foram removidos (account_id nulo). */
async function countOrphans() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM conversations WHERE account_id IS NULL');
  return rows[0].n;
}

async function deleteOrphans() {
  const { rowCount } = await db.query('DELETE FROM conversations WHERE account_id IS NULL');
  await purgeOrphanMedia();
  return rowCount;
}

async function deleteByAccount(accountId) {
  const { rowCount } = await db.query('DELETE FROM conversations WHERE account_id = $1', [accountId]);
  await purgeOrphanMedia();
  return rowCount;
}

module.exports = { getById, list, counts, setPrefs, defaultSectorId, purgeOrphanMedia, countOrphans, deleteOrphans, deleteByAccount };
