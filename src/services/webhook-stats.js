/**
 * O que chegou da Meta no webhook: mostra no cartão do número oficial se as mensagens estão chegando ou
 * sendo recusadas, sem precisar abrir os logs do servidor. Fica no banco (sobrevive a deploys) e em memória.
 */
const db = require('../db');

const TEST_PNID = '123456123'; // número fictício que o botão "Teste" do painel da Meta usa
const KEYS = { rejected: 'webhook_rejected_count', lastRejectedAt: 'webhook_last_rejected_at', testAt: 'webhook_test_at' };

const stats = { rejected: 0, lastRejectedAt: null, testAt: null, byPnid: new Map() };

function saveSetting(key, value) {
  db.query(
    'INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
    [key, String(value)]
  ).catch(() => {});
}

/** Carrega o que já foi registrado (chamado ao iniciar o servidor). */
async function init() {
  try {
    const { rows } = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1::text[])', [Object.values(KEYS)]);
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    stats.rejected = Number(s[KEYS.rejected]) || 0;
    stats.lastRejectedAt = s[KEYS.lastRejectedAt] || null;
    stats.testAt = s[KEYS.testAt] || null;
    const acc = await db.query("SELECT phone_number_id, last_webhook_at FROM wa_accounts WHERE provider = 'cloud' AND last_webhook_at IS NOT NULL");
    for (const r of acc.rows) stats.byPnid.set(String(r.phone_number_id), new Date(r.last_webhook_at).toISOString());
  } catch (err) { console.warn('[webhook] não deu para carregar o registro:', err.message); }
}

function noteRejected() {
  stats.rejected += 1;
  stats.lastRejectedAt = new Date().toISOString();
  saveSetting(KEYS.rejected, stats.rejected);
  saveSetting(KEYS.lastRejectedAt, stats.lastRejectedAt);
}

function noteAccepted(body) {
  const now = new Date().toISOString();
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const pnid = change.value?.metadata?.phone_number_id;
      if (!pnid) continue;
      if (String(pnid) === TEST_PNID) { stats.testAt = now; saveSetting(KEYS.testAt, now); continue; }
      stats.byPnid.set(String(pnid), now);
      db.query("UPDATE wa_accounts SET last_webhook_at = NOW() WHERE provider = 'cloud' AND phone_number_id = $1", [String(pnid)]).catch(() => {});
    }
  }
}

/** Situação para um número oficial (phone_number_id). */
function forPhoneNumberId(pnid) {
  return {
    last_at: stats.byPnid.get(String(pnid)) || null,
    test_at: stats.testAt,
    rejected: stats.rejected,
    last_rejected_at: stats.lastRejectedAt,
  };
}

module.exports = { init, noteRejected, noteAccepted, forPhoneNumberId };
