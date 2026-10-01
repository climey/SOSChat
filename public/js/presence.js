/*
 * Presença fora da tela de conversas (Contatos, Relatórios, Configurações).
 *
 * Mantém o atendente conectado em tempo real: para a distribuição ele continua "no chat", então segue
 * recebendo clientes e não perde para a fila os que estão esperando resposta dele. Como ele não está vendo
 * as conversas, avisa com um cartão (com link para abrir), som e notificação do sistema quando chega
 * cliente novo para ele, uma transferência ou uma mensagem numa conversa dele.
 */
(function () {
  if (typeof io !== 'function' || !window.SOS) return;
  const { esc, formatPhone } = window.SOS;
  const socket = io({ withCredentials: true });
  const AV_LABEL = { available: 'Disponível', away: 'Ausente', offline: 'Offline' };
  const nameOf = (c) => c.contact_name || c.profile_name || formatPhone(c.wa_id);
  const baseTitle = document.title;
  let unseen = 0;

  function stack() {
    let el = document.getElementById('presence-notices');
    if (!el) {
      el = document.createElement('div');
      el.id = 'presence-notices';
      el.className = 'presence-notices';
      document.body.appendChild(el);
    }
    return el;
  }

  /** Cartão de aviso (um por conversa: um aviso novo da mesma conversa substitui o anterior). */
  function notice(conversationId, title, body) {
    const el = stack();
    const key = `conv-${conversationId}`;
    let card = el.querySelector(`[data-key="${key}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'presence-notice';
      card.dataset.key = key;
    }
    el.prepend(card);
    card.innerHTML = `<div class="pn-title">${esc(title)}</div>
      <div class="pn-body">${esc(body)}</div>
      <div class="pn-actions"><a class="btn btn-sm btn-primary" href="/?c=${Number(conversationId)}">Abrir conversa</a>
        <button type="button" class="btn btn-sm btn-ghost" data-close>Fechar</button></div>`;
    clearTimeout(card._timer);
    card._timer = setTimeout(() => card.remove(), 90000);
    while (el.children.length > 4) el.lastElementChild.remove();
    try { const p = window.SOS.sound.load(); window.SOS.sound.play(p.sound, p.volume); } catch { /* sem som */ }
    if (!document.hasFocus()) {
      unseen += 1;
      document.title = `(${unseen}) ${baseTitle}`;
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          const n = new Notification(title, { body, icon: '/img/logo.svg', tag: key });
          n.onclick = () => { window.focus(); location.href = `/?c=${Number(conversationId)}`; n.close(); };
        } catch { /* navegador sem suporte */ }
      }
    }
  }
  window.addEventListener('focus', () => { unseen = 0; document.title = baseTitle; });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.presence-notice [data-close]');
    if (b) b.closest('.presence-notice').remove();
  });

  socket.on('distribution:assigned', ({ conversation, reason }) => {
    notice(conversation.id, 'Nova conversa para você', `${nameOf(conversation)}${reason ? ` (${reason})` : ''}`);
  });
  socket.on('conversation:transferred', ({ conversation, from, note }) => {
    notice(conversation.id, 'Conversa transferida para você', `${from}: ${nameOf(conversation)}${note ? ' · ' + note : ''}`);
  });
  socket.on('message:new', ({ message, conversation }) => {
    const me = window.ME;
    if (!me || !conversation || !message || message.direction !== 'in' || conversation.assigned_user_id !== me.id) return;
    notice(conversation.id, `Mensagem de ${nameOf(conversation)}`, String(message.body || 'Nova mensagem').slice(0, 140));
  });
  socket.on('availability:changed', ({ availability, by }) => {
    window.SOS.toast(`Seu status foi alterado para ${AV_LABEL[availability] || availability}${by ? ` por ${by}` : ''}`, availability === 'offline');
  });

  // Ao sair da página (outro site na mesma aba), o navegador pode guardá-la em cache com a conexão aberta:
  // desconecta para não contar como presente; se a página voltar do cache, reconecta.
  window.addEventListener('pagehide', () => socket.disconnect());
  window.addEventListener('pageshow', (e) => { if (e.persisted) socket.connect(); });

  window.SOS.socket = socket;
})();
