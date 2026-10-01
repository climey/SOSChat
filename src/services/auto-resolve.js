/**
 * Finalização automática: conversa aberta em que a última mensagem foi do atendente e ninguém escreveu
 * há N horas é finalizada pelo sistema. Conversa com cliente esperando resposta nunca é finalizada sozinha,
 * nem conversa com mensagem agendada pendente.
 */
const db = require('../db');
const realtime = require('../realtime');

const TICK_MS = 60 * 1000;
const BATCH = 200;
let timer = null;
let running = false;

async function config() {
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('auto_resolve_enabled', 'auto_resolve_hours')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const hours = Number(s.auto_resolve_hours);
  return { enabled: s.auto_resolve_enabled === '1', hours: Number.isInteger(hours) && hours >= 1 ? hours : 24 };
}

/** Uma passada: finaliza o que venceu. Devolve quantas conversas foram finalizadas. */
async function run() {
  if (running) return 0;
  running = true;
  try {
    const cfg = await config();
    if (!cfg.enabled) return 0;
    const ids = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE conversations c SET status = 'resolved', resolved_at = NOW(), resolved_by_user_id = NULL
          WHERE c.id IN (
            SELECT id FROM conversations
             WHERE status = 'open' AND last_message_direction = 'out'
               AND last_message_at < NOW() - make_interval(hours => $1::int)
               AND NOT EXISTS (SELECT 1 FROM scheduled_messages s WHERE s.conversation_id = conversations.id AND s.status = 'pending')
             ORDER BY last_message_at LIMIT $2
             FOR UPDATE SKIP LOCKED)
          RETURNING c.id`,
        [cfg.hours, BATCH]
      );
      const found = rows.map((r) => r.id);
      if (found.length) {
        await client.query(
          `INSERT INTO messages (conversation_id, direction, type, body, status, sender_user_id)
           SELECT id, 'out', 'note', $2, 'sent', NULL FROM unnest($1::int[]) AS id`,
          [found, `Finalizada automaticamente: ${cfg.hours} h sem mensagens depois da última resposta.`]
        );
      }
      return found;
    });
    if (!ids.length) return 0;
    if (ids.length > 30) realtime.broadcast('conversations:reload', {});
    else {
      const conversations = require('./conversations');
      for (const id of ids) realtime.broadcast('conversation:updated', await conversations.getById(id));
    }
    console.log(`[finalização automática] ${ids.length} conversa(s) finalizada(s) após ${cfg.hours} h paradas`);
    return ids.length;
  } catch (err) {
    console.error('[finalização automática] erro', err.message);
    return 0;
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => run(), TICK_MS);
  timer.unref();
  setTimeout(() => run(), 5000).unref();
}

module.exports = { run, start, config };
