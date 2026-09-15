/* Caixa de entrada compartilhada */
(function () {
  const { api, esc, initials, formatPhone, fmtTime, fmtClock, fmtDay, fmtDuration, toast } = SOS;

  const state = {
    me: null,
    tags: [],
    users: [],
    conversations: [],
    currentId: null,
    currentConv: null,
    messages: [],
    filters: { status: 'inbox', assigned: 'all', tag: '', account: '', q: '', hidden: 'none' },
    accounts: new Map(), // id -> status do número (só provedor baileys)
    prefs: new Map(), // conversa id -> { pinned, muted, hidden } deste atendente
    multiAccount: false,
    composeMode: 'message', // message | note
    search: { open: false, q: '', hits: [], idx: -1 },
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    items: $('conv-items'), search: $('search'), tagFilter: $('tag-filter'), accountFilter: $('account-filter'),
    cntActive: $('cnt-active'), railUnread: $('rail-unread'), filtersDrawer: $('filters-drawer'), btnFilters: $('btn-filters'),
    chatEmpty: $('chat-empty'), chatPanel: $('chat-panel'), chatTitle: $('chat-title'), chatTags: $('chat-tags'),
    messages: $('chat-messages'), banner: $('wa-banner'),
    composer: $('composer'), compose: $('compose'), composeText: $('compose-text'), composeSend: $('compose-send'), composeHint: $('compose-hint'),
    signToggle: $('sign-toggle'), signName: $('sign-name'), composeMode: $('compose-mode'),
    btnResolve: $('btn-resolve'), btnDetails: $('btn-details'), btnAssignMe: $('btn-assign-me'), details: $('details'),
    dName: $('d-name'), dPhone: $('d-phone'), dNameInput: $('d-name-input'),
    dStatus: $('d-status'), dTimes: $('d-times'), dAssignee: $('d-assignee'), dTags: $('d-tags'),
  };

  const WA_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.1-1.8-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.8 1-.9 1.2-.2.2-.3.2-.6.1-.3-.1-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.6l.4-.5c.2-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.1.2 2.1 3.2 5.1 4.5 2.5 1 3 .8 3.6.8.6-.1 1.8-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.2-.3-.3-.6-.4zM12 2C6.5 2 2 6.5 2 12c0 1.9.5 3.7 1.5 5.3L2 22l4.8-1.5C8.3 21.4 10.1 22 12 22c5.5 0 10-4.5 10-10S17.5 2 12 2z"/></svg>';
  const contactName = (c) => c.contact_name || c.profile_name || formatPhone(c.wa_id);
  const current = () => state.conversations.find((c) => c.id === state.currentId) || state.currentConv || null;

  function avatarHtml(c, cls = '', withChannel = true) {
    const img = c.avatar_media_id ? `<img src="/api/media/${esc(c.avatar_media_id)}" alt="" loading="lazy">` : '';
    const ch = withChannel ? `<span class="ch" title="WhatsApp">${WA_ICON}</span>` : '';
    return `<div class="avatar ${cls}">${esc(initials(contactName(c)))}${img}${ch}</div>`;
  }

  // ---------- Estado dos números ----------
  const ACCOUNT_LABELS = { qr: 'aguardando leitura do QR code', connecting: 'conectando…', reconnecting: 'reconectando…', disconnected: 'desconectado', off: 'desligado' };
  function accountOffline(accountId) {
    if (!state.multiAccount || !accountId) return false;
    const a = state.accounts.get(Number(accountId));
    return Boolean(a) && a.status !== 'connected';
  }
  function anyAccountConnected() {
    for (const a of state.accounts.values()) if (a.status === 'connected') return true;
    return false;
  }
  function renderBanner() {
    const c = current();
    if (!c || !state.multiAccount) { els.banner.hidden = true; return; }
    const a = c.account_id ? state.accounts.get(Number(c.account_id)) : null;
    let text = null;
    let warn = false;
    if (c.account_id && !a) {
      text = 'O número desta conversa foi removido. Respostas sairão pelo primeiro número conectado.';
      warn = true;
    } else if (a && a.status !== 'connected') {
      warn = a.status === 'connecting' || a.status === 'reconnecting';
      text = `Número "${a.name}" ${ACCOUNT_LABELS[a.status] || a.status}. Mensagens deste cliente não estão chegando e envios vão falhar até reconectar.`
        + (a.lastError ? ` (${a.lastError})` : '');
    } else if (!c.account_id && !anyAccountConnected()) {
      text = 'Nenhum número de WhatsApp conectado.';
    }
    if (!text) { els.banner.hidden = true; return; }
    els.banner.className = `wa-banner ${warn ? 'warn' : ''}`;
    els.banner.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>${state.me.role === 'admin' ? '<a href="/settings.html">Abrir Configurações</a>' : ''}`;
    els.banner.hidden = false;
  }

  // ---------- Lista de conversas ----------
  async function loadConversations() {
    const f = state.filters;
    const qs = new URLSearchParams({ status: f.status, assigned: f.assigned });
    if (f.tag) qs.set('tag', f.tag);
    if (f.account) qs.set('account', f.account);
    if (f.q) qs.set('q', f.q);
    if (f.hidden !== 'none') qs.set('hidden', f.hidden);
    const { conversations } = await api('GET', `/api/conversations?${qs}`);
    conversations.forEach(rememberPrefs);
    state.conversations = conversations;
    renderList();
  }

  // Fixar, silenciar e ocultar são preferências pessoais: as atualizações em tempo real chegam sem elas,
  // então a tela guarda as suas e aplica por cima.
  function rememberPrefs(c) {
    state.prefs.set(c.id, { pinned: Boolean(c.pinned), muted: Boolean(c.muted), hidden: Boolean(c.hidden) });
  }
  function applyPrefs(c) {
    const p = state.prefs.get(c.id);
    return p ? { ...c, ...p } : c;
  }

  function tickHtml(c) {
    if (c.last_message_direction !== 'out') return '';
    return '<span class="tick">✓✓</span>';
  }
  const PIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
  const MUTE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const BLOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';
  const HIDE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  function flagsHtml(c) {
    const f = [];
    if (c.pinned) f.push(`<span title="Fixada">${PIN_ICON}</span>`);
    if (c.muted) f.push(`<span title="Notificações silenciadas">${MUTE_ICON}</span>`);
    if (c.contact_blocked) f.push(`<span title="Contato bloqueado">${BLOCK_ICON}</span>`);
    if (c.hidden) f.push(`<span title="Oculta">${HIDE_ICON}</span>`);
    return f.length ? `<span class="flags">${f.join('')}</span>` : '';
  }
  /** Prévia da lista com ícone por tipo, como no WhatsApp. */
  function previewText(c) {
    const p = stripWa(c.last_message_preview || '');
    const map = [[/^\[Imagem\]\s*/, '📷 '], [/^\[Vídeo\]\s*/, '🎥 '], [/^\[Áudio\]/, '🎤 Áudio'], [/^\[Figurinha\]/, '🩷 Figurinha'], [/^\[Arquivo\]\s*/, '📄 '], [/^\[Documento\]/, '📄 Documento'], [/^\[Localização\]/, '📍 Localização'], [/^\[Contato\]/, '👤 Contato']];
    for (const [re, rep] of map) if (re.test(p)) return p.replace(re, rep);
    return p;
  }

  function renderList() {
    const list = state.conversations;
    if (!list.length) {
      els.items.innerHTML = '<div class="empty"><div>Nenhuma conversa aqui</div></div>';
    } else {
      els.items.innerHTML = list.map((c) => `
        <div class="conv-item ${c.id === state.currentId ? 'active' : ''} ${c.unread_count > 0 ? 'unread' : ''} ${c.pinned ? 'pinned' : ''}" data-id="${c.id}">
          ${avatarHtml(c, 'lg')}
          <div class="body">
            <div class="top">
              <span class="name">${esc(contactName(c))}</span>
              ${flagsHtml(c)}
              <span class="time">${esc(fmtTime(c.last_message_at))}</span>
            </div>
            <div class="mid">
              <span class="preview">${tickHtml(c)}<span>${esc(previewText(c))}</span></span>
              ${c.unread_count > 0 ? `<span class="badge">${c.unread_count}</span>` : ''}
              ${c.assigned_user_name
                ? `<span class="agent" title="Responsável: ${esc(c.assigned_user_name)}">${esc(initials(c.assigned_user_name))}</span>`
                : '<span class="agent none" title="Sem responsável">?</span>'}
            </div>
            <div class="meta">
              ${c.tags.map((t) => `<span class="tag" style="color:${esc(t.color)}"><i class="dot"></i>${esc(t.name)}</span>`).join('')}
              ${c.status === 'resolved' ? '<span class="tag">Finalizada</span>' : ''}
              ${c.scheduled_count > 0 ? `<span class="chip-soft" title="${c.scheduled_count} mensagem(ns) agendada(s)">⏰ ${c.scheduled_count}</span>` : ''}
              <span class="spacer"></span>
              ${c.account_name && state.multiAccount ? `<span class="chip-soft ${accountOffline(c.account_id) ? 'off' : ''}">${esc(c.account_name)}</span>` : ''}
            </div>
          </div>
          <button type="button" class="more" data-menu="${c.id}" title="Mais opções"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
        </div>`).join('');
    }
    els.cntActive.textContent = list.length ? list.length : '';
    const unread = list.reduce((n, c) => n + (c.status === 'open' && c.unread_count > 0 ? 1 : 0), 0);
    els.railUnread.hidden = unread === 0;
    els.railUnread.textContent = unread > 99 ? '99+' : unread;
  }

  els.items.addEventListener('click', (e) => {
    const more = e.target.closest('button[data-menu]');
    if (more) { e.stopPropagation(); openConvMenu(Number(more.dataset.menu), more); return; }
    const item = e.target.closest('.conv-item');
    if (item) openConversation(Number(item.dataset.id));
  });
  els.items.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.conv-item');
    if (!item) return;
    e.preventDefault();
    openConvMenu(Number(item.dataset.id), null, { x: e.clientX, y: e.clientY });
  });

  // ---------- Menu de ações da conversa ----------
  const MI = {
    leave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
    take: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></svg>',
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    unread: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    wait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    pin: PIN_ICON, block: BLOCK_ICON, hide: HIDE_ICON, mute: MUTE_ICON,
  };
  let menuConvId = null;
  function openConvMenu(id, anchor, at) {
    const c = state.conversations.find((x) => x.id === id);
    if (!c) return;
    menuConvId = id;
    const mine = c.assigned_user_id === state.me.id;
    const items = [
      mine ? ['leave', MI.leave, 'Sair da conversa'] : ['take', MI.take, 'Assumir conversa'],
      ['tag', MI.tag, 'Adicionar etiqueta'],
      ['mute', c.muted ? MI.bell : MI.mute, c.muted ? 'Ativar notificações' : 'Silenciar notificações'],
      ['unread', MI.unread, c.unread_count > 0 ? 'Marcar como lida' : 'Marcar como não lida'],
      'sep',
      c.status === 'resolved' ? ['reopen', MI.check, 'Reabrir conversa'] : ['resolve', MI.check, 'Finalizar conversa'],
      c.status === 'open' ? (c.last_message_direction === 'out' ? ['inbox', MI.wait, 'Voltar para Entrada'] : ['waiting', MI.wait, 'Marcar como esperando']) : null,
      ['pin', MI.pin, c.pinned ? 'Desafixar (só para você)' : 'Fixar (só para você)'],
      ['hide', MI.hide, c.hidden ? 'Mostrar conversa' : 'Ocultar (só para você)'],
      'sep',
      ['block', MI.block, c.contact_blocked ? 'Desbloquear contato' : 'Bloquear contato', 'danger'],
      state.me.role === 'admin' ? ['delete', MI.hide, 'Excluir conversa', 'danger'] : null,
    ].filter(Boolean);
    const menu = $('conv-menu');
    menu.innerHTML = items.map((it) => it === 'sep' ? '<div class="sep"></div>'
      : `<button type="button" data-act="${it[0]}" class="${it[3] || ''}">${it[1]}${esc(it[2])}</button>`).join('');
    menu.hidden = false;
    const r = anchor ? anchor.getBoundingClientRect() : null;
    let x = at ? at.x : r.right - menu.offsetWidth;
    let y = at ? at.y : r.bottom + 4;
    x = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8));
    y = Math.min(y, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    document.querySelectorAll('.conv-item.menu-open').forEach((el) => el.classList.remove('menu-open'));
    anchor?.closest('.conv-item')?.classList.add('menu-open');
  }
  function closeConvMenu() {
    $('conv-menu').hidden = true;
    document.querySelectorAll('.conv-item.menu-open').forEach((el) => el.classList.remove('menu-open'));
    menuConvId = null;
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('#conv-menu')) closeConvMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeConvMenu(); });
  window.addEventListener('resize', closeConvMenu);
  $('conv-menu').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    const c = state.conversations.find((x) => x.id === menuConvId);
    closeConvMenu();
    if (!b || !c) return;
    const patch = (body) => api('PATCH', `/api/conversations/${c.id}`, body);
    // Preferência pessoal: o servidor não transmite para os outros, então a tela se atualiza com a resposta
    const pref = async (body) => { const { conversation } = await patch(body); rememberPrefs(conversation); upsertConversation(conversation); if (conversation.id === state.currentId) renderChat(); };
    try {
      switch (b.dataset.act) {
        case 'leave': await patch({ assigned_user_id: null }); toast('Você saiu da conversa'); break;
        case 'take': await patch({ assigned_user_id: state.me.id }); toast('Conversa assumida'); break;
        case 'tag': await openConversation(c.id); setDetailsOpen(true); els.dTags.scrollIntoView({ block: 'center' }); break;
        case 'mute': await pref({ muted: !c.muted }); toast(c.muted ? 'Notificações ativadas para você' : 'Notificações silenciadas só para você'); break;
        case 'unread': await patch({ unread: !(c.unread_count > 0) }); break;
        case 'resolve': await patch({ status: 'resolved' }); toast('Conversa finalizada'); break;
        case 'reopen': await patch({ status: 'open' }); toast('Conversa reaberta'); break;
        case 'waiting': await patch({ waiting: true }); toast('Movida para Esperando'); break;
        case 'inbox': await patch({ waiting: false }); toast('Movida para Entrada'); break;
        case 'pin': await pref({ pinned: !c.pinned }); break;
        case 'hide': await pref({ hidden: !c.hidden }); toast(c.hidden ? 'Conversa visível de novo' : 'Oculta só na sua lista. Use "Mostrar ocultas" nos filtros para ver.'); break;
        case 'block':
          if (!c.contact_blocked && !confirm(`Bloquear ${contactName(c)} no WhatsApp? Ele não conseguirá mais enviar mensagens para este número.`)) return;
          await api('PATCH', `/api/conversations/${c.id}/contact`, { blocked: !c.contact_blocked });
          toast(c.contact_blocked ? 'Contato desbloqueado' : 'Contato bloqueado');
          break;
        case 'delete':
          if (!confirm(`Excluir a conversa com ${contactName(c)} e todo o histórico? Isso não pode ser desfeito.`)) return;
          await api('DELETE', `/api/conversations/${c.id}`);
          toast('Conversa excluída');
          break;
        default: break;
      }
    } catch (err) { toast(err.message, true); }
  });

  // Filtros
  function setStatusFilter(status) {
    state.filters.status = status;
    document.querySelectorAll('#status-filters button').forEach((b) => b.classList.toggle('active', b.dataset.status === status));
    $('filter-all-status').classList.toggle('active', status === 'all');
    loadConversations();
  }
  document.querySelectorAll('#status-filters button').forEach((b) => b.addEventListener('click', () => setStatusFilter(b.dataset.status)));
  $('filter-all-status').addEventListener('click', () => setStatusFilter(state.filters.status === 'all' ? 'inbox' : 'all'));
  $('filter-hidden').addEventListener('click', () => {
    state.filters.hidden = state.filters.hidden === 'none' ? 'only' : 'none';
    $('filter-hidden').classList.toggle('active', state.filters.hidden === 'only');
    loadConversations();
  });
  document.querySelectorAll('#assigned-filters .chip').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#assigned-filters .chip').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.filters.assigned = b.dataset.assigned;
    loadConversations();
  }));
  els.tagFilter.addEventListener('change', () => { state.filters.tag = els.tagFilter.value; loadConversations(); });
  els.accountFilter.addEventListener('change', () => { state.filters.account = els.accountFilter.value; loadConversations(); });
  els.btnFilters.addEventListener('click', () => {
    els.filtersDrawer.hidden = !els.filtersDrawer.hidden;
    els.btnFilters.classList.toggle('active', !els.filtersDrawer.hidden);
  });
  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filters.q = els.search.value.trim(); loadConversations(); }, 250);
  });

  // ---------- Conversa aberta ----------
  async function openConversation(id) {
    state.currentId = id;
    const [{ conversation }, { messages }] = await Promise.all([
      api('GET', `/api/conversations/${id}`),
      api('GET', `/api/conversations/${id}/messages`),
    ]);
    rememberPrefs(conversation);
    state.currentConv = conversation;
    state.messages = messages;
    if (state.search.open) closeSearch();
    upsertConversation(conversation);
    renderChat();
    renderMessages(true);
    renderDetails();
    els.composeText.focus();
    if (conversation.unread_count > 0) api('POST', `/api/conversations/${id}/read`).catch(() => {});
  }

  function renderChat() {
    const c = current();
    if (!c) return;
    els.chatEmpty.hidden = true;
    els.chatPanel.hidden = false;
    $('chat-avatar').outerHTML = avatarHtml(c).replace('<div class="avatar ', '<div id="chat-avatar" class="avatar ');
    els.chatTitle.textContent = contactName(c);
    els.chatTags.innerHTML =
      `<span class="sub">${esc(formatPhone(c.wa_id))}</span>` +
      c.tags.map((t) => `<span class="tag" style="color:${esc(t.color)}"><i class="dot"></i>${esc(t.name)}</span>`).join('') +
      (c.account_name && state.multiAccount ? `<span class="chip-soft ${accountOffline(c.account_id) ? 'off' : ''}">via ${esc(c.account_name)}</span>` : '') +
      `<span class="chip-soft">${c.assigned_user_name ? esc(c.assigned_user_name) : 'Sem responsável'}</span>` +
      (c.status === 'resolved' ? '<span class="tag">Finalizada</span>' : '');
    els.btnResolve.title = c.status === 'resolved' ? 'Reabrir conversa' : 'Finalizar conversa';
    els.btnResolve.classList.toggle('success', c.status !== 'resolved');
    els.btnAssignMe.hidden = c.assigned_user_id === state.me.id;
    $('schedule-badge').hidden = !(c.scheduled_count > 0);
    $('schedule-badge').textContent = c.scheduled_count || 0;
    renderBanner();
  }

  function statusIcon(m) {
    if (m.direction !== 'out' || m.type === 'note') return '';
    const map = { pending: ['◌', ''], sent: ['✓', ''], delivered: ['✓✓', ''], read: ['✓✓', 'read'], failed: ['⚠ falhou', 'failed'] };
    const [txt, cls] = map[m.status] || ['', ''];
    return `<span class="st ${cls}" title="${esc(m.error || m.status)}">${txt}</span>`;
  }

  const isPlaceholder = (body) => /^\[[^\]]*\]$/.test(body || '');

  function mediaHtml(m) {
    if (!m.media_id || m.deleted_at) return '';
    const src = `/api/media/${esc(m.media_id)}`;
    if (m.type === 'image' || m.type === 'sticker') {
      return `<img class="media-img" src="${src}" alt="" loading="lazy" data-lb="${m.id}">`;
    }
    if (m.type === 'audio') return audioPlayerHtml(m, src);
    if (m.type === 'video') {
      return `<span class="media-wrap"><video class="media-video" controls preload="metadata" src="${src}"></video>
        <button type="button" class="media-expand" data-lb="${m.id}" title="Abrir em tela cheia"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button></span>`;
    }
    return docCardHtml(m, src);
  }

  const DOC_KINDS = [
    [/pdf/, 'PDF', '#e03131'], [/word|officedocument\.wordprocessingml|msword/, 'DOC', '#1c7ed6'],
    [/excel|spreadsheet|csv/, 'XLS', '#2f9e44'], [/powerpoint|presentation/, 'PPT', '#f08c00'],
    [/zip|rar|7z|compressed/, 'ZIP', '#868e96'], [/text\/plain/, 'TXT', '#868e96'], [/xml|json/, 'XML', '#7048e8'],
  ];
  function docKind(m) {
    const mime = (m.media_mime || '').toLowerCase();
    const ext = ((m.body || '').match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    for (const [re, label, color] of DOC_KINDS) if (re.test(mime)) return { label, color };
    return { label: (ext || 'ARQ').toUpperCase().slice(0, 4), color: '#868e96' };
  }
  const isPdf = (m) => /pdf/i.test(m.media_mime || '') || /\.pdf$/i.test(m.body || '');
  function docCardHtml(m, src) {
    const name = m.body && !isPlaceholder(m.body) ? m.body : 'Documento';
    const k = docKind(m);
    const size = m.media_size ? SOS.fmtBytes(Number(m.media_size)) : '';
    const viewable = isPdf(m);
    return `<div class="doc-card">
      <div class="doc-main">
        <span class="doc-icon" style="background:${k.color}">${esc(k.label)}</span>
        <div class="doc-info"><div class="doc-name" title="${esc(name)}">${esc(name)}</div><div class="doc-meta">${esc(k.label)}${size ? ' · ' + esc(size) : ''}</div></div>
      </div>
      <div class="doc-actions">
        ${viewable ? `<button type="button" data-lb="${m.id}">Ver</button>` : ''}
        <a href="${src}" download="${esc(name)}">Baixar</a>
      </div>
    </div>`;
  }

  /** Formatação do WhatsApp: *negrito*, _itálico_, ~tachado~, \`\`\`mono\`\`\` (aplicada sobre texto já escapado). */
  function waFormat(html) {
    return html
      .replace(/```([\s\S]+?)```/g, '<code>$1</code>')
      .replace(/(^|[\s(>])\*([^*\n]+?)\*(?=[\s.,;:!?)<]|$)/g, '$1<b>$2</b>')
      .replace(/(^|[\s(>])_([^_\n]+?)_(?=[\s.,;:!?)<]|$)/g, '$1<i>$2</i>')
      .replace(/(^|[\s(>])~([^~\n]+?)~(?=[\s.,;:!?)<]|$)/g, '$1<s>$2</s>');
  }
  const stripWa = (text) => String(text || '').replace(/[*_~]/g, '');

  function renderMessages(scroll) {
    let lastDay = null;
    els.messages.innerHTML = state.messages.map((m) => {
      const day = fmtDay(m.created_at);
      const sep = day !== lastDay ? `<div class="day-sep">${esc(day)}</div>` : '';
      lastDay = day;
      const isNote = m.type === 'note';
      const rowCls = isNote ? 'note' : m.direction;
      const showBody = m.deleted_at || !m.media_id || !(isPlaceholder(m.body) || m.type === 'document');
      const agent = m.direction === 'out'
        ? `<span class="agent-avatar" title="${esc(m.sender_name || 'Sistema')}">${esc(initials(m.sender_name || 'S'))}</span>` : '';
      const sender = m.direction === 'out' && m.sender_name
        ? `<div class="sender">${isNote ? 'Nota interna · ' : ''}${esc(m.sender_name)}</div>` : '';
      const dimmed = state.search.q && !state.search.hits.includes(m.id) ? 'dimmed' : '';
      return `${sep}<div class="msg-row ${rowCls} ${m.deleted_at ? 'deleted' : ''} ${dimmed}" data-id="${m.id}">
        <div class="msg">${sender}${mediaHtml(m)}${showBody ? `<span class="body">${waFormat(highlight(m.body))}</span>` : ''}
          <span class="foot">${m.edited_at && !m.deleted_at ? '<span class="edited">editada</span>' : ''}<span>${esc(fmtClock(m.created_at))}</span>${statusIcon(m)}</span>
        </div>${agent}
      </div>`;
    }).join('');
    if (scroll) els.messages.scrollTop = els.messages.scrollHeight;
  }

  // ---------- Visualizador de mídia (lightbox) ----------
  const lb = { items: [], idx: -1, zoom: 1 };
  const VIDEO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
  const DOC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  const lbMedia = () => state.messages.filter((m) => m.media_id && !m.deleted_at && (['image', 'sticker', 'video'].includes(m.type) || (m.type === 'document' && isPdf(m))));

  function openLightbox(messageId) {
    lb.items = lbMedia();
    lb.idx = lb.items.findIndex((m) => m.id === messageId);
    if (lb.idx < 0) return;
    $('lightbox').hidden = false;
    document.body.style.overflow = 'hidden';
    renderStrip();
    showLightbox();
  }
  function closeLightbox() {
    $('lightbox').hidden = true;
    document.body.style.overflow = '';
    $('lb-stage').innerHTML = '';
  }
  function showLightbox() {
    const m = lb.items[lb.idx];
    if (!m) return closeLightbox();
    const c = current();
    lb.zoom = 1;
    const src = `/api/media/${esc(m.media_id)}`;
    const isVideo = m.type === 'video';
    const isDoc = m.type === 'document';
    $('lb-stage').innerHTML = isVideo
      ? `<video controls autoplay src="${src}"></video>`
      : isDoc
        ? `<iframe class="lb-pdf" src="${src}#view=FitH" title="${esc(m.body || 'PDF')}"></iframe>`
        : `<img src="${src}" alt="" id="lb-img">`;
    const who = m.direction === 'in' ? (c ? contactName(c) : 'Cliente') : (m.sender_name || 'Você');
    $('lb-name').textContent = who;
    $('lb-date').textContent = new Date(m.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' às');
    $('lb-avatar').outerHTML = (m.direction === 'in' && c
      ? avatarHtml(c, 'sm', false)
      : `<div class="avatar sm">${esc(initials(m.sender_name || 'V'))}</div>`).replace('<div class="avatar ', '<div id="lb-avatar" class="avatar ');
    $('lb-download').href = src;
    $('lb-download').setAttribute('download', isDoc ? (m.body || 'documento.pdf') : `${m.type}-${m.id}${isVideo ? '.mp4' : '.jpg'}`);
    const caption = !isDoc && m.body && !isPlaceholder(m.body) ? m.body : '';
    $('lb-caption').hidden = !caption;
    $('lb-caption').textContent = caption;
    $('lb-prev').disabled = lb.idx <= 0;
    $('lb-next').disabled = lb.idx >= lb.items.length - 1;
    $('lb-zoom-in').hidden = isVideo || isDoc;
    $('lb-zoom-out').hidden = isVideo || isDoc;
    $('lb-open').hidden = !isDoc;
    $('lb-open').href = src;
    document.querySelectorAll('.lb-thumb').forEach((t) => t.classList.toggle('current', Number(t.dataset.id) === m.id));
    document.querySelector('.lb-thumb.current')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
  function renderStrip() {
    $('lb-strip').innerHTML = lb.items.map((m) => `<div class="lb-thumb" data-id="${m.id}" title="${esc(m.type === 'document' ? m.body : fmtClock(m.created_at))}">${
      m.type === 'video' ? VIDEO_ICON : m.type === 'document' ? `<span class="lb-doc">${DOC_ICON}<small>PDF</small></span>` : `<img src="/api/media/${esc(m.media_id)}" alt="" loading="lazy">`
    }</div>`).join('');
  }
  function stepLightbox(dir) {
    const n = lb.idx + dir;
    if (n < 0 || n >= lb.items.length) return;
    lb.idx = n;
    showLightbox();
  }
  function setZoom(z) {
    const img = $('lb-img');
    if (!img) return;
    lb.zoom = Math.min(4, Math.max(1, z));
    img.classList.toggle('zoomed', lb.zoom > 1);
    img.style.transform = lb.zoom > 1 ? `scale(${lb.zoom})` : '';
    img.style.transformOrigin = 'center';
  }
  els.messages.addEventListener('click', (e) => {
    const t = e.target.closest('[data-lb]');
    if (t) { e.preventDefault(); openLightbox(Number(t.dataset.lb)); }
  });
  $('lb-close').addEventListener('click', closeLightbox);
  $('lb-prev').addEventListener('click', () => stepLightbox(-1));
  $('lb-next').addEventListener('click', () => stepLightbox(1));
  $('lb-zoom-in').addEventListener('click', () => setZoom(lb.zoom + 0.5));
  $('lb-zoom-out').addEventListener('click', () => setZoom(lb.zoom - 0.5));
  $('lb-strip').addEventListener('click', (e) => {
    const t = e.target.closest('.lb-thumb');
    if (!t) return;
    lb.idx = lb.items.findIndex((m) => m.id === Number(t.dataset.id));
    showLightbox();
  });
  $('lb-stage').addEventListener('click', (e) => {
    if (e.target.id === 'lb-img') setZoom(lb.zoom > 1 ? 1 : 2);
    else if (e.target === $('lb-stage')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if ($('lightbox').hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
    else if (e.key === '+' || e.key === '=') setZoom(lb.zoom + 0.5);
    else if (e.key === '-') setZoom(lb.zoom - 0.5);
  });

  // ---------- Player de áudio ----------
  const players = new Map(); // message id -> Audio (sobrevive às re-renderizações)
  const fmtSecs = (s) => (!Number.isFinite(s) || s < 0 ? '--:--' : `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`);
  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

  function audioPlayerHtml(m, src) {
    const c = current();
    const who = m.direction === 'in'
      ? (c ? avatarHtml(c, 'sm', false) : '<div class="avatar sm">?</div>')
      : `<div class="avatar sm" title="${esc(m.sender_name || '')}">${esc(initials(m.sender_name || 'S'))}</div>`;
    const a = players.get(m.id);
    const playing = a && !a.paused;
    const cur = a ? a.currentTime : 0;
    const dur = a && Number.isFinite(a.duration) ? a.duration : NaN;
    return `<div class="audio-player" data-id="${m.id}" data-src="${src}">
      ${who}
      <button type="button" class="ap-play" title="${playing ? 'Pausar' : 'Ouvir'}">${playing ? PAUSE_ICON : PLAY_ICON}</button>
      <div class="ap-main">
        <input type="range" class="ap-seek" min="0" max="1000" value="${dur ? Math.round((cur / dur) * 1000) : 0}" aria-label="Posição">
        <div class="ap-times"><span class="ap-cur">${fmtSecs(cur)}</span><span class="ap-dur">${fmtSecs(dur)}</span></div>
      </div>
      <button type="button" class="ap-speed" title="Velocidade">${a ? a.playbackRate : 1}x</button>
      <a class="ap-dl" href="${src}" download title="Baixar áudio"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>
    </div>`;
  }
  function playerEl(id) { return els.messages.querySelector(`.audio-player[data-id="${id}"]`); }
  function syncPlayer(id) {
    const el = playerEl(id);
    const a = players.get(id);
    if (!el || !a) return;
    const dur = Number.isFinite(a.duration) ? a.duration : NaN;
    el.querySelector('.ap-play').innerHTML = a.paused ? PLAY_ICON : PAUSE_ICON;
    el.querySelector('.ap-cur').textContent = fmtSecs(a.currentTime);
    el.querySelector('.ap-dur').textContent = fmtSecs(dur);
    el.querySelector('.ap-speed').textContent = `${a.playbackRate}x`;
    const seek = el.querySelector('.ap-seek');
    if (!seek.matches(':active')) seek.value = dur ? Math.round((a.currentTime / dur) * 1000) : 0;
    seek.style.setProperty('--p', `${seek.value / 10}%`);
    el.classList.toggle('playing', !a.paused);
  }
  function getPlayer(id, src) {
    if (players.has(id)) return players.get(id);
    const a = new Audio(src);
    a.preload = 'metadata';
    a.addEventListener('timeupdate', () => syncPlayer(id));
    a.addEventListener('loadedmetadata', () => {
      // alguns áudios do WhatsApp chegam sem duração; força o cálculo
      if (!Number.isFinite(a.duration)) { a.currentTime = 1e9; a.addEventListener('durationchange', () => { a.currentTime = 0; syncPlayer(id); }, { once: true }); }
      syncPlayer(id);
    });
    a.addEventListener('play', () => { for (const [oid, o] of players) if (oid !== id && !o.paused) o.pause(); syncPlayer(id); });
    a.addEventListener('pause', () => syncPlayer(id));
    a.addEventListener('ended', () => { a.currentTime = 0; syncPlayer(id); });
    a.addEventListener('error', () => toast('Não foi possível reproduzir este áudio neste navegador', true));
    players.set(id, a);
    return a;
  }
  els.messages.addEventListener('click', (e) => {
    const el = e.target.closest('.audio-player');
    if (!el) return;
    const id = Number(el.dataset.id);
    if (e.target.closest('.ap-play')) {
      const a = getPlayer(id, el.dataset.src);
      if (a.paused) a.play().catch(() => {}); else a.pause();
    } else if (e.target.closest('.ap-speed')) {
      const a = getPlayer(id, el.dataset.src);
      a.playbackRate = a.playbackRate >= 2 ? 1 : a.playbackRate === 1 ? 1.5 : 2;
      syncPlayer(id);
    }
  });
  els.messages.addEventListener('input', (e) => {
    const seek = e.target.closest('.ap-seek');
    if (!seek) return;
    const el = seek.closest('.audio-player');
    const a = getPlayer(Number(el.dataset.id), el.dataset.src);
    if (Number.isFinite(a.duration)) a.currentTime = (seek.value / 1000) * a.duration;
    seek.style.setProperty('--p', `${seek.value / 10}%`);
  });

  // ---------- Anexos ----------
  const attach = { file: null, url: null };
  const attachInputs = { doc: $('file-doc'), media: $('file-media'), audio: $('file-audio') };
  const MEDIA_MAX = 25 * 1024 * 1024;

  $('btn-attach').addEventListener('click', (e) => { e.stopPropagation(); $('attach-menu').hidden = !$('attach-menu').hidden; });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#attach-menu') && !e.target.closest('#btn-attach')) $('attach-menu').hidden = true;
  });
  $('attach-menu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pick]');
    if (!b) return;
    $('attach-menu').hidden = true;
    const input = attachInputs[b.dataset.pick];
    input.value = '';
    input.click();
  });
  Object.values(attachInputs).forEach((inp) => inp.addEventListener('change', () => { if (inp.files[0]) setAttachment(inp.files[0]); }));

  function setAttachment(file) {
    if (state.composeMode === 'note') { toast('Anexos só em mensagens, não em notas', true); return; }
    if (file.size > MEDIA_MAX) { toast('Arquivo acima de 25 MB', true); return; }
    clearAttachment();
    attach.file = file;
    const isImg = file.type.startsWith('image/');
    if (isImg) attach.url = URL.createObjectURL(file);
    const p = $('attach-preview');
    p.innerHTML = `${isImg ? `<img src="${attach.url}" alt="">` : '<span class="ic">📎</span>'}
      <div class="info"><div class="name">${esc(file.name)}</div><div class="size">${esc(SOS.fmtBytes(file.size))} · ${esc(file.type || 'arquivo')}</div></div>
      <button type="button" class="icon-btn" id="attach-remove" title="Remover anexo">✕</button>`;
    p.hidden = false;
    $('attach-remove').addEventListener('click', clearAttachment);
    els.composeText.placeholder = 'Legenda (opcional)…';
    els.composeSend.textContent = 'Enviar arquivo';
    els.composeText.focus();
  }
  function clearAttachment() {
    if (attach.url) URL.revokeObjectURL(attach.url);
    attach.file = null;
    attach.url = null;
    $('attach-preview').hidden = true;
    $('attach-preview').innerHTML = '';
    if (state.composeMode !== 'note') {
      els.composeText.placeholder = 'Digite sua mensagem ou arraste um arquivo…';
      els.composeSend.textContent = 'Enviar';
    }
  }
  async function sendAttachment(id, caption) {
    const fd = new FormData();
    fd.append('file', attach.file, attach.file.name);
    fd.append('caption', els.signToggle.checked && caption ? `*${state.me.name}:*\n${caption}` : caption);
    els.composeSend.disabled = true;
    els.composeSend.textContent = 'Enviando…';
    try {
      await SOS.upload(`/api/conversations/${id}/media`, fd);
      clearAttachment();
      els.composeText.value = '';
      autosize();
    } catch (err) {
      toast(err.message, true);
      els.composeSend.textContent = 'Enviar arquivo';
    } finally {
      els.composeSend.disabled = false;
      els.composeText.focus();
    }
  }
  // Arrastar para o compositor e colar imagem (Ctrl+V)
  ['dragenter', 'dragover'].forEach((ev) => els.composer.addEventListener(ev, (e) => {
    if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); els.composer.classList.add('dragover'); }
  }));
  ['dragleave', 'drop'].forEach((ev) => els.composer.addEventListener(ev, () => els.composer.classList.remove('dragover')));
  els.composer.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) { e.preventDefault(); setAttachment(f); }
  });
  els.composeText.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f) { e.preventDefault(); setAttachment(f); }
  });

  // ---------- Busca na conversa ----------
  function highlight(text) {
    const safe = esc(text);
    const q = state.search.q;
    if (!q) return safe;
    const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, (m) => `<mark class="hit">${m}</mark>`);
  }
  function openSearch() {
    state.search.open = true;
    $('msg-search').hidden = false;
    $('btn-search').classList.add('active');
    $('msg-search-input').focus();
    $('msg-search-input').select();
  }
  function closeSearch() {
    Object.assign(state.search, { open: false, q: '', hits: [], idx: -1 });
    $('msg-search').hidden = true;
    $('btn-search').classList.remove('active');
    $('msg-search-input').value = '';
    $('msg-search-count').textContent = '';
    renderMessages(false);
    els.composeText.focus();
  }
  function runSearch(raw) {
    const q = raw.trim();
    state.search.q = q;
    state.search.hits = q ? state.messages.filter((m) => (m.body || '').toLowerCase().includes(q.toLowerCase())).map((m) => m.id) : [];
    state.search.idx = state.search.hits.length ? state.search.hits.length - 1 : -1; // começa pela mais recente
    renderMessages(false);
    focusHit();
  }
  function stepSearch(dir) {
    const s = state.search;
    if (!s.hits.length) return;
    s.idx = (s.idx + dir + s.hits.length) % s.hits.length;
    focusHit();
  }
  function focusHit() {
    const s = state.search;
    $('msg-search-count').textContent = s.q ? (s.hits.length ? `${s.idx + 1} de ${s.hits.length}` : 'nada encontrado') : '';
    els.messages.querySelectorAll('mark.hit.current').forEach((m) => m.classList.remove('current'));
    if (s.idx < 0) return;
    const row = els.messages.querySelector(`.msg-row[data-id="${s.hits[s.idx]}"]`);
    if (!row) return;
    row.querySelectorAll('mark.hit').forEach((m) => m.classList.add('current'));
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  $('btn-search').addEventListener('click', () => (state.search.open ? closeSearch() : openSearch()));
  $('msg-search-close').addEventListener('click', closeSearch);
  let msTimer;
  $('msg-search-input').addEventListener('input', () => {
    clearTimeout(msTimer);
    msTimer = setTimeout(() => runSearch($('msg-search-input').value), 150);
  });
  $('msg-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearch();
    if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
  });
  $('msg-search-prev').addEventListener('click', () => stepSearch(-1));
  $('msg-search-next').addEventListener('click', () => stepSearch(1));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && state.currentId && $('schedule-drawer').hidden) { e.preventDefault(); openSearch(); }
  });

  // ---------- Agendamento ----------
  const sched = { items: [], editing: null, kind: 'message' };
  const pad2 = (n) => String(n).padStart(2, '0');
  const toLocalInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const fmtWhen = (d) => d.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  function relTime(d) {
    const diff = d.getTime() - Date.now();
    if (diff < -60000) return 'horário já passou';
    const m = Math.max(1, Math.round(diff / 60000));
    if (m < 60) return `daqui a ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `daqui a ${h}h${m % 60 ? ` ${m % 60}min` : ''}`;
    const days = Math.floor(h / 24);
    return `daqui a ${days} dia${days > 1 ? 's' : ''}`;
  }
  function presetDate(key) {
    const d = new Date();
    if (key === '1h') return new Date(d.getTime() + 3600e3);
    if (key === '3h') return new Date(d.getTime() + 3 * 3600e3);
    d.setDate(d.getDate() + 1);
    if (key === 'nextbiz9') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    d.setHours(key === 'tomorrow14' ? 14 : 9, 0, 0, 0);
    return d;
  }
  function setWhen(d) { $('sched-when').value = toLocalInput(d); updateRelative(); }
  function updateRelative() {
    const d = new Date($('sched-when').value);
    $('sched-relative').textContent = Number.isNaN(d.getTime()) ? '' : `${relTime(d)} · ${fmtWhen(d)}`;
  }
  function setSchedKind(kind) {
    sched.kind = kind;
    document.querySelectorAll('#sched-kind button').forEach((b) => {
      b.classList.toggle('active', b.dataset.kind === kind);
      b.classList.toggle('note', kind === 'note' && b.dataset.kind === 'note');
    });
    $('sched-body').placeholder = kind === 'note' ? 'Nota interna que aparecerá na conversa no horário…' : 'Escreva a mensagem que será enviada…';
  }
  function setSchedTab(tab) {
    document.querySelectorAll('#schedule-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.drawer-body [data-tab]').forEach((el) => { el.hidden = el.dataset.tab !== tab; });
  }
  function resetSchedForm() {
    sched.editing = null;
    $('sched-body').value = '';
    $('sched-c-contact').checked = false;
    $('sched-c-agent').checked = false;
    $('sched-c-resolve').checked = true;
    $('sched-submit').textContent = 'Agendar';
    $('sched-cancel-edit').hidden = true;
    setSchedKind('message');
    setWhen(new Date(Date.now() + 3600e3));
  }
  function openSchedule() {
    const c = current();
    if (!c) return;
    $('schedule-drawer').hidden = false;
    $('schedule-contact').innerHTML = avatarHtml(c, 'sm', false) + `<span>${esc(contactName(c))}</span>`;
    $('sched-sign-name').textContent = state.me.name;
    $('sched-sign').checked = els.signToggle.checked;
    resetSchedForm();
    setSchedTab('new');
    loadSchedules();
  }
  function closeSchedule() { $('schedule-drawer').hidden = true; }

  async function loadSchedules() {
    const c = current();
    if (!c) return;
    try {
      const { schedules } = await api('GET', `/api/conversations/${c.id}/schedules`);
      sched.items = schedules;
    } catch (err) { toast(err.message, true); return; }
    const pending = sched.items.filter((s) => s.status === 'pending');
    const done = sched.items.filter((s) => s.status !== 'pending');
    $('sched-cnt-pending').textContent = `(${pending.length})`;
    $('sched-cnt-done').textContent = `(${done.length})`;
    $('schedule-list').innerHTML = pending.length ? pending.map(schedItem).join('') : '<div class="empty" style="height:auto">Nenhuma mensagem agendada</div>';
    $('schedule-done').innerHTML = done.length ? done.map(schedItem).join('') : '<div class="empty" style="height:auto">Nada concluído ainda</div>';
  }
  function schedItem(s) {
    const when = new Date(s.send_at);
    const st = { pending: 'Agendada', sent: 'Enviada', cancelled: 'Cancelada', failed: 'Falhou' }[s.status] || s.status;
    const rules = s.status === 'pending' ? [
      s.cancel_on_contact_reply && 'cancela se o cliente responder',
      s.cancel_on_agent_reply && 'cancela se um atendente responder',
      s.cancel_on_resolve && 'cancela ao finalizar',
    ].filter(Boolean).map((x) => `<span>· ${x}</span>`).join('') : '';
    return `<div class="sched-item ${s.status}" data-id="${s.id}">
      <div class="when"><span>${esc(fmtWhen(when))}</span>${s.status === 'pending' ? `<span class="rel">${esc(relTime(when))}</span>` : `<span class="chip-soft">${st}</span>`}</div>
      <div class="body">${esc(s.body)}</div>
      <div class="meta"><span class="tag">${s.kind === 'note' ? 'Nota interna' : 'Mensagem'}</span><span>por ${esc(s.user_name || '—')}</span>
        ${s.cancel_reason ? `<span>· ${esc(s.cancel_reason)}</span>` : ''}${s.error ? `<span style="color:#ff6b6b">· ${esc(s.error)}</span>` : ''}${rules}</div>
      ${s.status === 'pending'
        ? '<div class="row-actions"><button class="btn btn-sm" data-act="now">Enviar agora</button><button class="btn btn-sm" data-act="edit">Editar</button><button class="btn btn-sm btn-ghost" data-act="cancel">Cancelar</button></div>'
        : (s.status !== 'sent' ? '<div class="row-actions"><button class="btn btn-sm" data-act="retry">Reagendar</button></div>' : '')}
    </div>`;
  }
  function fillFormFrom(s, asEdit) {
    setSchedTab('new');
    setSchedKind(s.kind);
    $('sched-body').value = s.body;
    $('sched-c-contact').checked = s.cancel_on_contact_reply;
    $('sched-c-agent').checked = s.cancel_on_agent_reply;
    $('sched-c-resolve').checked = s.cancel_on_resolve;
    setWhen(asEdit ? new Date(s.send_at) : new Date(Date.now() + 5 * 60e3));
    sched.editing = asEdit ? s.id : null;
    $('sched-submit').textContent = asEdit ? 'Salvar alterações' : 'Agendar';
    $('sched-cancel-edit').hidden = !asEdit;
    $('sched-body').focus();
  }

  $('btn-schedule').addEventListener('click', openSchedule);
  $('schedule-close').addEventListener('click', closeSchedule);
  $('schedule-drawer').addEventListener('click', (e) => { if (e.target === $('schedule-drawer')) closeSchedule(); });
  $('schedule-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setSchedTab(b.dataset.tab); });
  $('sched-presets').addEventListener('click', (e) => { const b = e.target.closest('button[data-preset]'); if (b) setWhen(presetDate(b.dataset.preset)); });
  $('sched-when').addEventListener('input', updateRelative);
  $('sched-kind').addEventListener('click', (e) => { const b = e.target.closest('button[data-kind]'); if (b) setSchedKind(b.dataset.kind); });
  $('sched-cancel-edit').addEventListener('click', resetSchedForm);
  $('schedule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = current();
    if (!c) return;
    const when = new Date($('sched-when').value);
    const text = $('sched-body').value.trim();
    const body = sched.kind === 'message' && $('sched-sign').checked && text ? `*${state.me.name}:*\n${text}` : text;
    const payload = {
      kind: sched.kind, body, send_at: when.toISOString(),
      cancel_on_contact_reply: $('sched-c-contact').checked,
      cancel_on_agent_reply: $('sched-c-agent').checked,
      cancel_on_resolve: $('sched-c-resolve').checked,
    };
    $('sched-submit').disabled = true;
    try {
      if (sched.editing) await api('PATCH', `/api/conversations/${c.id}/schedules/${sched.editing}`, payload);
      else await api('POST', `/api/conversations/${c.id}/schedules`, payload);
      toast(sched.editing ? 'Agendamento atualizado' : `Agendado para ${fmtWhen(when)}`);
      resetSchedForm();
      await loadSchedules();
      setSchedTab('pending');
    } catch (err) { toast(err.message, true); }
    finally { $('sched-submit').disabled = false; }
  });
  document.querySelector('.drawer-body').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const c = current();
    const id = Number(b.closest('.sched-item').dataset.id);
    const s = sched.items.find((x) => x.id === id);
    if (!c || !s) return;
    try {
      if (b.dataset.act === 'now') { if (!confirm('Enviar esta mensagem agora?')) return; await api('POST', `/api/conversations/${c.id}/schedules/${id}/send-now`); toast('Enviada'); }
      else if (b.dataset.act === 'cancel') { if (!confirm('Cancelar este agendamento?')) return; await api('DELETE', `/api/conversations/${c.id}/schedules/${id}`); toast('Agendamento cancelado'); }
      else if (b.dataset.act === 'edit') { fillFormFrom(s, true); return; }
      else if (b.dataset.act === 'retry') { fillFormFrom(s, false); return; }
      await loadSchedules();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Compositor ----------
  function setComposeMode(mode) {
    state.composeMode = mode;
    document.querySelectorAll('#compose-mode button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
      b.classList.toggle('note', b.dataset.mode === 'note' && mode === 'note');
    });
    els.composer.classList.toggle('note-mode', mode === 'note');
    if (mode === 'note') clearAttachment();
    $('btn-attach').hidden = mode === 'note';
    els.composeText.placeholder = mode === 'note' ? 'Escreva uma nota interna (o cliente não vê)…' : 'Digite sua mensagem ou arraste um arquivo…';
    els.composeSend.textContent = mode === 'note' ? 'Salvar nota' : (attach.file ? 'Enviar arquivo' : 'Enviar');
    els.composeSend.classList.toggle('btn-primary', mode !== 'note');
    els.composeHint.textContent = mode === 'note' ? 'Visível só para a equipe' : 'Enter envia · Shift+Enter quebra linha';
    els.composeText.focus();
  }
  els.composeMode.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setComposeMode(b.dataset.mode);
  });

  try { els.signToggle.checked = localStorage.getItem('sos.sign') === '1'; } catch { /* sem storage */ }
  els.signToggle.addEventListener('change', () => {
    try { localStorage.setItem('sos.sign', els.signToggle.checked ? '1' : '0'); } catch { /* ignora */ }
  });

  els.compose.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = els.composeText.value.trim();
    const id = state.currentId;
    if (!id) return;
    if (attach.file && state.composeMode !== 'note') { await sendAttachment(id, text); return; }
    if (!text) return;
    els.composeSend.disabled = true;
    els.composeText.value = '';
    autosize();
    try {
      if (state.composeMode === 'note') {
        await api('POST', `/api/conversations/${id}/notes`, { body: text });
      } else {
        const body = els.signToggle.checked ? `*${state.me.name}:*\n${text}` : text;
        await api('POST', `/api/conversations/${id}/messages`, { body });
      }
    } catch (err) {
      toast(err.message, true);
      els.composeText.value = text;
      autosize();
    } finally {
      els.composeSend.disabled = false;
      els.composeText.focus();
    }
  });
  els.composeText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.compose.requestSubmit(); }
  });
  function autosize() {
    els.composeText.style.height = 'auto';
    els.composeText.style.height = Math.min(els.composeText.scrollHeight, 180) + 'px';
  }
  els.composeText.addEventListener('input', autosize);

  // Ações do cabeçalho
  els.btnResolve.addEventListener('click', async () => {
    const c = current();
    if (!c) return;
    try {
      await api('PATCH', `/api/conversations/${c.id}`, { status: c.status === 'resolved' ? 'open' : 'resolved' });
      toast(c.status === 'resolved' ? 'Conversa reaberta' : 'Conversa finalizada');
    } catch (err) { toast(err.message, true); }
  });
  els.btnAssignMe.addEventListener('click', async () => {
    const c = current();
    if (!c) return;
    try {
      await api('PATCH', `/api/conversations/${c.id}`, { assigned_user_id: state.me.id });
      toast('Conversa assumida');
    } catch (err) { toast(err.message, true); }
  });
  function setDetailsOpen(open) {
    els.details.hidden = !open;
    els.btnDetails.classList.toggle('active', open);
    try { localStorage.setItem('sos.details', open ? '1' : '0'); } catch { /* ignora */ }
  }
  els.btnDetails.addEventListener('click', () => setDetailsOpen(els.details.hidden));

  // ---------- Painel de detalhes ----------
  function renderDetails() {
    const c = current();
    if (!c) { els.details.hidden = true; return; }
    let open = false;
    try { open = localStorage.getItem('sos.details') === '1'; } catch { /* ignora */ }
    setDetailsOpen(open);
    $('d-avatar').outerHTML = avatarHtml(c, '', false).replace('<div class="avatar ', '<div id="d-avatar" class="avatar ');
    els.dName.textContent = contactName(c);
    els.dPhone.textContent = formatPhone(c.wa_id) + (c.profile_name ? ` · perfil: ${c.profile_name}` : '');
    if (document.activeElement !== els.dNameInput) els.dNameInput.value = c.contact_name || '';
    els.dStatus.innerHTML = `<span class="status-pill ${c.status}">${c.status === 'open' ? 'Aberta' : 'Finalizada'}</span>`;
    const times = [`Iniciada ${new Date(c.created_at).toLocaleString('pt-BR')}`];
    if (c.first_response_at) times.push(`1ª resposta em ${fmtDuration((new Date(c.first_response_at) - new Date(c.created_at)) / 1000)}`);
    if (c.resolved_at) times.push(`Resolvida em ${fmtDuration((new Date(c.resolved_at) - new Date(c.created_at)) / 1000)}`);
    els.dTimes.innerHTML = times.map(esc).join('<br>');
    els.dAssignee.value = c.assigned_user_id || '';
    const selected = new Set(c.tags.map((t) => t.id));
    els.dTags.innerHTML = state.tags.map((t) => `
      <span class="tag selectable ${selected.has(t.id) ? 'on' : ''}" data-id="${t.id}" style="--tag-color:${esc(t.color)}">
        <i class="dot" style="background:${esc(t.color)}"></i>${esc(t.name)}
      </span>`).join('');
  }

  els.dTags.addEventListener('click', async (e) => {
    const el = e.target.closest('.tag.selectable');
    const c = current();
    if (!el || !c) return;
    const id = Number(el.dataset.id);
    const ids = new Set(c.tags.map((t) => t.id));
    ids.has(id) ? ids.delete(id) : ids.add(id);
    try { await api('PUT', `/api/conversations/${c.id}/tags`, { tag_ids: [...ids] }); }
    catch (err) { toast(err.message, true); }
  });
  els.dAssignee.addEventListener('change', async () => {
    const c = current();
    if (!c) return;
    try { await api('PATCH', `/api/conversations/${c.id}`, { assigned_user_id: els.dAssignee.value ? Number(els.dAssignee.value) : null }); }
    catch (err) { toast(err.message, true); }
  });
  els.dNameInput.addEventListener('change', async () => {
    const c = current();
    if (!c) return;
    try { await api('PATCH', `/api/conversations/${c.id}/contact`, { name: els.dNameInput.value }); toast('Nome salvo'); }
    catch (err) { toast(err.message, true); }
  });

  // ---------- Tempo real ----------
  function matchesFilters(c) {
    const f = state.filters;
    if (f.status === 'inbox' && !(c.status === 'open' && c.last_message_direction !== 'out')) return false;
    if (f.status === 'waiting' && !(c.status === 'open' && c.last_message_direction === 'out')) return false;
    if (f.status === 'resolved' && c.status !== 'resolved') return false;
    if (f.status === 'open' && c.status !== 'open') return false;
    if (f.assigned === 'me' && c.assigned_user_id !== state.me.id) return false;
    if (f.assigned === 'unassigned' && c.assigned_user_id) return false;
    if (f.tag && !c.tags.some((t) => String(t.id) === String(f.tag))) return false;
    if (f.account && String(c.account_id) !== String(f.account)) return false;
    if (f.hidden === 'none' && c.hidden) return false;
    if (f.hidden === 'only' && !c.hidden) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (![c.wa_id, c.contact_name, c.profile_name].some((v) => (v || '').toLowerCase().includes(q))) return false;
    }
    return true;
  }

  function upsertConversation(raw) {
    const conv = applyPrefs(raw);
    const idx = state.conversations.findIndex((c) => c.id === conv.id);
    if (matchesFilters(conv)) {
      if (idx >= 0) state.conversations[idx] = conv; else state.conversations.push(conv);
      state.conversations.sort((a, b) => (b.pinned - a.pinned) || (new Date(b.last_message_at) - new Date(a.last_message_at)));
    } else if (idx >= 0) {
      state.conversations.splice(idx, 1);
    }
    if (conv.id === state.currentId) state.currentConv = conv;
    renderList();
  }

  function connectSocket() {
    const socket = io({ withCredentials: true });
    socket.on('conversation:updated', (conv) => {
      upsertConversation(conv);
      if (conv.id === state.currentId) { renderChat(); renderDetails(); }
    });
    socket.on('message:new', ({ message, conversation }) => {
      upsertConversation(conversation);
      if (message.conversation_id === state.currentId) {
        if (!state.messages.some((m) => m.id === message.id)) {
          state.messages.push(message);
          const nearBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120;
          renderMessages(nearBottom || message.direction === 'out');
        }
        if (message.direction === 'in' && document.hasFocus()) api('POST', `/api/conversations/${state.currentId}/read`).catch(() => {});
      } else if (message.direction === 'in') {
        notify(applyPrefs(conversation), message);
      }
    });
    socket.on('message:status', ({ id, status, error }) => {
      const m = state.messages.find((x) => x.id === id);
      if (m) { m.status = status; m.error = error; renderMessages(false); }
    });
    socket.on('message:updated', (updated) => {
      const i = state.messages.findIndex((x) => x.id === updated.id);
      if (i >= 0) { state.messages[i] = { ...state.messages[i], ...updated }; renderMessages(false); }
    });
    socket.on('whatsapp:status', (a) => {
      if (!state.multiAccount || !a?.id) return;
      if (a.removed) state.accounts.delete(a.id); else state.accounts.set(a.id, a);
      renderBanner();
      renderList();
      if (current()) renderChat();
    });
    socket.on('conversation:deleted', ({ id }) => {
      state.conversations = state.conversations.filter((c) => c.id !== id);
      if (state.currentId === id) { state.currentId = null; state.currentConv = null; els.chatPanel.hidden = true; els.chatEmpty.hidden = false; els.details.hidden = true; }
      renderList();
    });
    socket.on('conversations:reload', () => {
      loadConversations();
      if (state.currentId) api('GET', `/api/conversations/${state.currentId}`).catch(() => { state.currentId = null; els.chatPanel.hidden = true; els.chatEmpty.hidden = false; });
    });
    socket.on('schedule:updated', ({ conversation_id, pending }) => {
      const c = state.conversations.find((x) => x.id === conversation_id);
      if (c) { c.scheduled_count = pending; renderList(); }
      if (state.currentConv?.id === conversation_id) {
        state.currentConv.scheduled_count = pending;
        renderChat();
        if (!$('schedule-drawer').hidden) loadSchedules();
      }
    });
    socket.on('contact:avatar', ({ contact_id, avatar_media_id }) => {
      let touched = false;
      for (const c of state.conversations) if (c.contact_id === contact_id) { c.avatar_media_id = avatar_media_id; touched = true; }
      if (state.currentConv?.contact_id === contact_id) { state.currentConv.avatar_media_id = avatar_media_id; renderChat(); renderDetails(); }
      if (touched) renderList();
    });
    socket.on('connect_error', () => toast('Conexão em tempo real perdida, tentando reconectar…', true));
    // Um deploy derruba e religa o socket: boa hora para conferir se há versão nova
    socket.io.on('reconnect', () => SOS.checkVersion(canReloadNow));
  }

  function notify(conv, message) {
    if (conv.muted) return;
    if (!('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) return;
    const n = new Notification(contactName(conv), { body: message.body || 'Nova mensagem', icon: '/img/logo.svg' });
    n.onclick = () => { window.focus(); openConversation(conv.id); n.close(); };
  }

  // ---------- Simulador (dev) ----------
  async function setupSimulator() {
    try {
      const h = await api('GET', '/health');
      if (!h.dev) return;
      $('btn-simulate').hidden = false;
      $('btn-simulate').addEventListener('click', () => { $('sim-modal').hidden = false; });
      $('sim-cancel').addEventListener('click', () => { $('sim-modal').hidden = true; });
      $('sim-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/api/dev/simulate-inbound', { from: $('sim-from').value, name: $('sim-name').value, text: $('sim-text').value });
          $('sim-modal').hidden = true;
        } catch (err) { toast(err.message, true); }
      });
    } catch { /* ignora */ }
  }

  // Seguro recarregar sozinho quando não há texto, anexo ou agendamento sendo escrito
  function canReloadNow() {
    return !els.composeText.value.trim() && !attach.file
      && ($('schedule-drawer').hidden || !$('sched-body').value.trim());
  }

  // ---------- Init ----------
  async function init() {
    state.me = await SOS.loadMe();
    els.signName.textContent = state.me.name;
    $('me-avatar').title = `${state.me.name} · ${state.me.role === 'admin' ? 'Administrador' : 'Atendente'}`;
    const [{ tags }, { users }] = await Promise.all([api('GET', '/api/tags'), api('GET', '/api/users')]);
    state.tags = tags;
    state.users = users;
    els.tagFilter.innerHTML = '<option value="">Todas as tags</option>' + tags.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    els.dAssignee.innerHTML = '<option value="">Sem responsável</option>' + users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
    try {
      const wa = await api('GET', '/api/whatsapp/status');
      state.multiAccount = wa.provider === 'baileys';
      for (const a of wa.accounts || []) if (a.id) state.accounts.set(a.id, a);
      if (state.multiAccount && wa.accounts.length > 1) {
        els.accountFilter.innerHTML = '<option value="">Todos os números</option>' +
          wa.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}${a.phone ? ' · ' + esc(a.phone) : ''}</option>`).join('');
        els.accountFilter.hidden = false;
      }
    } catch { /* sem status, segue sem filtro */ }
    await loadConversations();
    connectSocket();
    setupSimulator();
    SOS.initUpdater(canReloadNow);
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }

  init().catch((err) => toast(err.message, true));
})();
