const db = require('../db');

const CONVERSATION_SELECT = `
  SELECT c.id, c.status, c.assigned_user_id, c.unread_count, c.last_message_at,
         c.last_message_preview, c.last_message_direction, c.first_response_at, c.resolved_at, c.created_at,
         c.pinned, c.muted, c.hidden,
         ct.id AS contact_id, ct.wa_id, ct.name AS contact_name, ct.profile_name, ct.avatar_media_id, ct.blocked AS contact_blocked,
         u.name AS assigned_user_name,
         c.account_id, wa.name AS account_name, wa.phone AS account_phone,
         COALESCE(sc.n, 0) AS scheduled_count
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN users u ON u.id = c.assigned_user_id
    LEFT JOIN wa_accounts wa ON wa.id = c.account_id
    LEFT JOIN (SELECT conversation_id, COUNT(*)::int AS n FROM scheduled_messages WHERE status = 'pending' GROUP BY conversation_id) sc
           ON sc.conversation_id = c.id
`;

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

async function getById(id, client = db) {
  const { rows } = await client.query(`${CONVERSATION_SELECT} WHERE c.id = $1`, [id]);
  if (!rows.length) return null;
  await attachTags(rows, client);
  return rows[0];
}

/**
 * Lista conversas com filtros. Todos os valores entram como parâmetros.
 * filters: { status, assigned: 'me'|'unassigned'|'all', userId, tagId, q, limit, offset }
 */
async function list(filters = {}) {
  const where = [];
  const params = [];
  let joins = '';
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  // inbox = abertas aguardando o atendente; waiting = abertas aguardando o cliente
  if (filters.status === 'inbox') where.push(`c.status = 'open' AND c.last_message_direction IS DISTINCT FROM 'out'`);
  else if (filters.status === 'waiting') where.push(`c.status = 'open' AND c.last_message_direction = 'out'`);
  else if (filters.status && filters.status !== 'all') add('c.status = ?', filters.status);
  if (filters.assigned === 'me') add('c.assigned_user_id = ?', filters.userId);
  if (filters.assigned === 'unassigned') where.push('c.assigned_user_id IS NULL');
  if (filters.accountId) add('c.account_id = ?', filters.accountId);
  if (filters.hidden === 'only') where.push('c.hidden = TRUE');
  else if (filters.hidden !== 'all') where.push('c.hidden = FALSE');
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

  const sql = `${CONVERSATION_SELECT} ${joins}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.pinned DESC, c.last_message_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await db.query(sql, params);
  return attachTags(rows, db);
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

module.exports = { getById, list, purgeOrphanMedia, countOrphans, deleteOrphans, deleteByAccount };
