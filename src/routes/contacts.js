const express = require('express');
const db = require('../db');
const realtime = require('../realtime');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const CONTACT_COLS = 'id, wa_id, name, profile_name, avatar_media_id, blocked, cpf, email, notes, created_at';

function parseId(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }

// Ficha: dados + conversas anteriores (todas, inclusive finalizadas)
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Contato não encontrado' });
    const { rows } = await db.query(`SELECT ${CONTACT_COLS} FROM contacts WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Contato não encontrado' });
    const convs = await db.query(
      `SELECT c.id, c.status, c.created_at, c.resolved_at, c.last_message_at, c.last_message_preview,
              u.name AS assigned_user_name, wa.name AS account_name,
              (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.type <> 'note') AS messages_count
         FROM conversations c
         LEFT JOIN users u ON u.id = c.assigned_user_id
         LEFT JOIN wa_accounts wa ON wa.id = c.account_id
        WHERE c.contact_id = $1
        ORDER BY c.last_message_at DESC LIMIT 50`,
      [id]
    );
    res.json({ contact: rows[0], conversations: convs.rows });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Contato não encontrado' });
    const b = req.body || {};
    const sets = [];
    const params = [id];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (b.name !== undefined) push('name', String(b.name).trim().slice(0, 120) || null);
    if (b.cpf !== undefined) {
      const cpf = String(b.cpf).replace(/\D/g, '');
      if (cpf && cpf.length !== 11 && cpf.length !== 14) return res.status(400).json({ error: 'CPF deve ter 11 dígitos (ou CNPJ 14)' });
      push('cpf', cpf || null);
    }
    if (b.email !== undefined) {
      const email = String(b.email).trim().toLowerCase().slice(0, 160);
      if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido' });
      push('email', email || null);
    }
    if (b.notes !== undefined) push('notes', String(b.notes).trim().slice(0, 4000) || null);
    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
    const { rows } = await db.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 RETURNING ${CONTACT_COLS}`, params);
    if (!rows.length) return res.status(404).json({ error: 'Contato não encontrado' });
    realtime.broadcast('contact:updated', rows[0]);
    res.json({ contact: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
