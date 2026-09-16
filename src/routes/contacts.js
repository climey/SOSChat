const express = require('express');
const db = require('../db');
const realtime = require('../realtime');
const contacts = require('../services/contacts');
const conversations = require('../services/conversations');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function parseId(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }
function fail(res, err, next) {
  if (err instanceof contacts.ContactError) return res.status(err.status).json({ error: err.message });
  return next(err);
}
function withId(handler) {
  return async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Contato não encontrado' });
    try { await handler(id, req, res); } catch (err) { fail(res, err, next); }
  };
}

// Ficha: dados, contadores e conversas anteriores (todas, inclusive finalizadas)
router.get('/:id', withId(async (id, req, res) => {
  const contact = await contacts.getFull(id);
  if (!contact) return res.status(404).json({ error: 'Contato não encontrado' });
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
  res.json({ contact, conversations: convs.rows });
}));

router.patch('/:id', withId(async (id, req, res) => {
  const contact = await contacts.update(id, req.user, req.body || {});
  res.json({ contact });
}));

// Exclui o contato com todas as conversas e mensagens (só admin)
router.delete('/:id', requireAdmin, withId(async (id, req, res) => {
  const { rows } = await db.query('SELECT id FROM conversations WHERE contact_id = $1', [id]);
  await contacts.remove(id);
  await conversations.purgeOrphanMedia();
  for (const r of rows) realtime.broadcast('conversation:deleted', { id: r.id });
  res.json({ ok: true, conversations_deleted: rows.length });
}));

// ---------- Plano ----------
router.put('/:id/plan', withId(async (id, req, res) => res.json({ contact: await contacts.setPlan(id, req.user, req.body || {}) })));
router.patch('/:id/plan', withId(async (id, req, res) => res.json({ contact: await contacts.adjustPlan(id, req.user, req.body || {}) })));
router.post('/:id/plan/renew', withId(async (id, req, res) => res.json({ contact: await contacts.renewPlan(id, req.user) })));
router.delete('/:id/plan', withId(async (id, req, res) => res.json({ contact: await contacts.removePlan(id, req.user) })));

// ---------- Consultas ----------
router.get('/:id/consultations', withId(async (id, req, res) => res.json({ consultations: await contacts.listConsultations(id) })));
router.post('/:id/consultations', withId(async (id, req, res) => {
  const out = await contacts.registerConsultation(id, req.user, req.body || {});
  res.status(201).json(out);
}));
router.delete('/:id/consultations/:cid', withId(async (id, req, res) => {
  const cid = parseId(req.params.cid);
  if (!cid) return res.status(404).json({ error: 'Consulta não encontrada' });
  res.json(await contacts.reverseConsultation(id, cid, req.user));
}));

// ---------- Observações e log ----------
router.get('/:id/notes', withId(async (id, req, res) => res.json({ notes: await contacts.listNotes(id) })));
router.post('/:id/notes', withId(async (id, req, res) => res.status(201).json({ note: await contacts.addNote(id, req.user, req.body?.body) })));
router.patch('/:id/notes/:nid', withId(async (id, req, res) => {
  const nid = parseId(req.params.nid);
  if (!nid) return res.status(404).json({ error: 'Observação não encontrada' });
  res.json({ note: await contacts.updateNote(id, nid, req.user, req.body?.body) });
}));
router.delete('/:id/notes/:nid', withId(async (id, req, res) => {
  const nid = parseId(req.params.nid);
  if (!nid) return res.status(404).json({ error: 'Observação não encontrada' });
  await contacts.deleteNote(id, nid, req.user);
  res.json({ ok: true });
}));
router.get('/:id/events', withId(async (id, req, res) => res.json({ events: await contacts.listEvents(id) })));

module.exports = router;
