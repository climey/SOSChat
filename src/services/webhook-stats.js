/**
 * O que chegou da Meta no webhook desde o último reinício (só em memória): mostra no cartão do número oficial
 * se as mensagens estão chegando ou sendo recusadas, sem precisar abrir os logs do servidor.
 */
const TEST_PNID = '123456123'; // número fictício que o botão "Teste" do painel da Meta usa

const stats = { rejected: 0, lastRejectedAt: null, testAt: null, byPnid: new Map() };

function noteRejected() {
  stats.rejected += 1;
  stats.lastRejectedAt = new Date().toISOString();
}

function noteAccepted(body) {
  const now = new Date().toISOString();
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const pnid = change.value?.metadata?.phone_number_id;
      if (!pnid) continue;
      if (String(pnid) === TEST_PNID) stats.testAt = now;
      else stats.byPnid.set(String(pnid), now);
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

module.exports = { noteRejected, noteAccepted, forPhoneNumberId };
