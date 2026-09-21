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
    filters: { status: 'inbox', assigned: 'all', tag: '', account: '', sector: '', plan: '', recurrence: '', q: '', hidden: 'none' },
    plans: [], // catálogo de planos de consultas
    contact: null, // ficha completa do contato da conversa aberta
    contactNotes: [], // observações fixadas do contato da conversa aberta
    vehicles: new Map(), // placa -> resultado da pré-consulta (ou 'loading')
    team: [], // atendentes e a presença de cada um
    accounts: new Map(), // id -> status do número (só provedor baileys)
    prefs: new Map(), // conversa id -> { pinned, muted, hidden } deste atendente
    presence: new Map(), // user id -> { online, availability }
    settings: { sla_warn_minutes: 5, sla_alert_minutes: 15 },
    quickReplies: [],
    sectors: [],
    reply: null, // mensagem sendo citada
    typing: new Map(), // conversa id -> Map(user id -> { name, until })
    viewers: new Map(), // conversa id -> [{ id, name, avatar }] com a conversa aberta agora
    multiAccount: false,
    composeMode: 'message', // message | note
    search: { open: false, q: '', hits: [], idx: -1 },
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    items: $('conv-items'), search: $('search'), tagFilter: $('tag-filter'), accountFilter: $('account-filter'),
    cntInbox: $('cnt-inbox'), cntWaiting: $('cnt-waiting'), railUnread: $('rail-unread'), filtersDrawer: $('filters-drawer'), btnFilters: $('btn-filters'),
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
    if (f.sector) qs.set('sector', f.sector);
    if (f.plan) qs.set('plan', f.plan);
    if (f.recurrence) qs.set('recurrence', f.recurrence);
    if (f.q) qs.set('q', f.q);
    if (f.hidden !== 'none') qs.set('hidden', f.hidden);
    const { conversations } = await api('GET', `/api/conversations?${qs}`);
    conversations.forEach(rememberPrefs);
    state.conversations = conversations;
    renderList();
    loadCounts();
  }

  // Contadores das abas (Entrada / Esperando), com os mesmos filtros
  let countsTimer = null;
  function loadCounts() {
    clearTimeout(countsTimer);
    countsTimer = setTimeout(async () => {
      const f = state.filters;
      const qs = new URLSearchParams({ assigned: f.assigned });
      if (f.tag) qs.set('tag', f.tag);
      if (f.account) qs.set('account', f.account);
      if (f.sector) qs.set('sector', f.sector);
      if (f.plan) qs.set('plan', f.plan);
      if (f.recurrence) qs.set('recurrence', f.recurrence);
    if (f.recurrence) qs.set('recurrence', f.recurrence);
    if (f.plan) qs.set('plan', f.plan);
    if (f.recurrence) qs.set('recurrence', f.recurrence);
      if (f.q) qs.set('q', f.q);
      if (f.hidden !== 'none') qs.set('hidden', f.hidden);
      try {
        const c = await api('GET', `/api/conversations/counts?${qs}`);
        els.cntInbox.textContent = c.inbox ? c.inbox : '';
        els.cntInbox.title = c.queued ? `${c.queued} nunca respondida(s)` : '';
        els.cntWaiting.textContent = c.waiting ? c.waiting : '';
        els.cntWaiting.parentElement.classList.toggle('has-queue', c.waiting > 0);
      } catch { /* ignora */ }
    }, 200);
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

  /** ✓ / ✓✓ / ✓✓ azul (lido) da última mensagem enviada, como no WhatsApp. */
  function tickHtml(c) {
    if (c.last_message_direction !== 'out') return '';
    const map = { pending: ['◌', '', 'Enviando'], sent: ['✓', '', 'Enviada'], delivered: ['✓✓', '', 'Entregue'], read: ['✓✓', 'read', 'Lida pelo cliente'], failed: ['⚠', 'failed', 'Falhou'] };
    const [txt, cls, title] = map[c.last_out_status] || ['✓✓', '', ''];
    return `<span class="tick ${cls}" title="${title}">${txt}</span>`;
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
  /** Foto de perfil de um atendente (ou nada, mantendo as iniciais). */
  const avatarVersion = new Map();
  function userImg(mediaId) {
    if (!mediaId) return '';
    const v = avatarVersion.get(mediaId) || '';
    return `<img src="/api/media/${esc(mediaId)}${v ? `?v=${v}` : ''}" alt="" loading="lazy">`;
  }
  /**
   * Atendentes desta conversa: o responsável primeiro (marcado), depois quem já respondeu nela.
   * Mostra até 3 avatares empilhados e "+N" quando houver mais.
   */
  function conversationAgents(c) {
    const list = [];
    const seen = new Set();
    if (c.assigned_user_id) {
      const p = (c.participants || []).find((x) => x.id === c.assigned_user_id);
      list.push({ id: c.assigned_user_id, name: c.assigned_user_name, avatar: c.assigned_user_avatar || (p && p.avatar), responsible: true });
      seen.add(c.assigned_user_id);
    }
    for (const p of c.participants || []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      list.push({ id: p.id, name: p.name, avatar: p.avatar, responsible: false });
    }
    return list;
  }
  function agentsHtml(c, max = 3) {
    const list = conversationAgents(c);
    if (!list.length) return '<span class="agents"><span class="agent none" title="Ninguém atendeu ainda">?</span></span>';
    const shown = list.slice(0, max);
    const rest = list.length - shown.length;
    const title = list.map((a) => a.name + (a.responsible ? ' (responsável)' : '')).join(', ');
    const chips = shown.map((a) => `<span class="agent ${a.responsible ? 'responsible' : ''}">${esc(initials(a.name || '?'))}${userImg(a.avatar)}${pdot(a.id)}</span>`).join('');
    return `<span class="agents" title="${esc(title)}">${chips}${rest > 0 ? `<span class="agent more">+${rest}</span>` : ''}</span>`;
  }
  /** Bolinha de presença de um atendente (verde online, amarelo ausente, cinza offline). */
  function pdot(userId) {
    const p = state.presence.get(Number(userId));
    const cls = p?.online ? (p.availability === 'away' ? 'away' : 'online') : '';
    const title = p?.online ? (p.availability === 'away' ? 'Ausente' : 'Online') : 'Offline';
    return `<span class="pdot ${cls}" title="${title}"></span>`;
  }
  /** Tempo que o cliente está esperando resposta, com cor pelo limite configurado. */
  function waitHtml(c) {
    if (c.status !== 'open' || c.last_message_direction === 'out') return '';
    const min = Math.floor((Date.now() - new Date(c.last_message_at).getTime()) / 60000);
    if (min < 1) return '';
    const cls = min >= state.settings.sla_alert_minutes ? 'alert' : min >= state.settings.sla_warn_minutes ? 'warn' : '';
    const label = min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${min % 60 ? pad2(min % 60) : ''}`;
    return `<span class="wait ${cls}" title="Cliente aguardando resposta há ${label}">⏱ ${label}</span>`;
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
              ${activityHtml(c.id) || `<span class="preview">${tickHtml(c)}<span>${esc(previewText(c))}</span></span>`}
              ${waitHtml(c)}
              ${c.unread_count > 0 ? `<span class="badge">${c.unread_count}</span>` : ''}
              ${agentsHtml(c)}
            </div>
            <div class="meta">
              ${c.tags.map((t) => `<span class="tag" style="color:${esc(t.color)}"><i class="dot"></i>${esc(t.name)}</span>`).join('')}
              ${planChip(c)}
              ${recChip(c)}
              ${c.notes_count > 0 ? `<span class="obs-pin" title="${c.notes_count} observação(ões) fixada(s) na ficha">${PIN_ICON}</span>` : ''}
              ${c.status === 'resolved' ? '<span class="tag">Finalizada</span>' : ''}
              ${c.status === 'open' && !c.attended ? '<span class="tag new">Na fila</span>' : ''}
              ${c.scheduled_count > 0 ? `<span class="chip-soft" title="${c.scheduled_count} mensagem(ns) agendada(s)">⏰ ${c.scheduled_count}</span>` : ''}
              <span class="spacer"></span>
              ${c.account_name && state.multiAccount ? `<span class="chip-soft ${accountOffline(c.account_id) ? 'off' : ''}">${esc(c.account_name)}</span>` : ''}
              ${sectorChip(c)}
            </div>
          </div>
          <button type="button" class="more" data-menu="${c.id}" title="Mais opções"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
        </div>`).join('');
    }
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
      c.status === 'open' ? (c.last_message_direction === 'out' ? ['waiting', MI.wait, 'Mover para Esperando'] : ['inbox', MI.wait, 'Tirar de Esperando (marcar como respondida)']) : null,
      ['sector', MI.tag, 'Mudar setor'],
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
    const anchor = document.querySelector(`.conv-item[data-id="${menuConvId}"] .more`);
    closeConvMenu();
    if (!b || !c) return;
    if (b.dataset.act === 'sector') { e.stopPropagation(); openSectorPopup(c, anchor || els.items); return; }
    if (b.dataset.act === 'tag') { e.stopPropagation(); openTagPopup(c, anchor || els.items); return; }
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
        case 'waiting': await patch({ waiting: true }); toast('Conversa movida para Esperando'); break;
        case 'inbox': await patch({ waiting: false }); toast('Conversa tirada de Esperando: agora só na Entrada'); break;
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
  $('sector-filter').addEventListener('change', () => { state.filters.sector = $('sector-filter').value; loadConversations(); });
  $('plan-filter').addEventListener('change', () => { state.filters.plan = $('plan-filter').value; loadConversations(); });
  $('rec-filter').addEventListener('change', () => { state.filters.recurrence = $('rec-filter').value; loadConversations(); });
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
    emitViewing(id);
    state.vehicles.clear();
    const [{ conversation }, { messages }, readings] = await Promise.all([
      api('GET', `/api/conversations/${id}`),
      api('GET', `/api/conversations/${id}/messages`),
      api('GET', `/api/readings?conversation=${id}`).catch(() => ({ readings: [] })),
    ]);
    state.readings = new Map((readings.readings || []).map((r) => [r.message_id, r]));
    rememberPrefs(conversation);
    state.currentConv = conversation;
    state.messages = messages;
    if (state.search.open) closeSearch();
    clearReply();
    cancelEdit();
    loadContactCard(conversation);
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
      planChip(c) +
      recChip(c, true) +
      `<button type="button" class="tag-quick" id="btn-tag-quick" title="Adicionar ou remover etiquetas">${TAG_ICON}</button>` +
      c.tags.map((t) => `<span class="tag" style="color:${esc(t.color)}"><i class="dot"></i>${esc(t.name)}</span>`).join('') +
      sectorChip(c, true) +
      (c.account_name && state.multiAccount ? `<span class="chip-soft ${accountOffline(c.account_id) ? 'off' : ''}">via ${esc(c.account_name)}</span>` : '') +
      (() => {
        const list = conversationAgents(c);
        if (!list.length) return '<span class="chip-soft">Sem responsável</span>';
        const names = list.slice(0, 2).map((a) => `${pdot(a.id)}&nbsp;${esc(a.name)}${a.responsible && list.length > 1 ? ' (resp.)' : ''}`).join(' · ');
        const rest = list.length - Math.min(2, list.length);
        return `<span class="chip-soft" title="${esc(list.map((a) => a.name).join(', '))}">${names}${rest > 0 ? ` +${rest}` : ''}</span>`;
      })() +
      (c.status === 'resolved' ? '<span class="tag">Finalizada</span>' : '') +
      typingHtml(c.id);
    els.btnResolve.title = c.status === 'resolved' ? 'Reabrir conversa' : 'Finalizar conversa';
    els.btnResolve.classList.toggle('success', c.status !== 'resolved');
    els.btnAssignMe.hidden = c.assigned_user_id === state.me.id;
    $('schedule-badge').hidden = !(c.scheduled_count > 0);
    $('schedule-badge').textContent = c.scheduled_count || 0;
    renderBanner();
    renderPlanHint();
    renderObsStrip();
    renderActivityBar();
    renderRefHint();
    if (Number($('debit-prompt').dataset.conv) !== c.id) $('debit-prompt').hidden = true;
  }

  function statusIcon(m) {
    if (m.direction !== 'out' || m.type === 'note') return '';
    const map = { pending: ['◌', ''], sent: ['✓', ''], delivered: ['✓✓', ''], read: ['✓✓', 'read'], failed: ['⚠ falhou', 'failed'] };
    const [txt, cls] = map[m.status] || ['', ''];
    if (m.status === 'failed') return `<button type="button" class="st failed st-failed" data-msg-act="failed" title="${esc(m.error || 'Não foi entregue ao WhatsApp')} — clique para ver e reenviar">${txt}</button>`;
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
        ? `<span class="agent-avatar" title="${esc(m.sender_name || 'Sistema')}">${esc(initials(m.sender_name || 'S'))}${userImg(m.sender_avatar)}</span>` : '';
      const sender = m.direction === 'out' && m.sender_name
        ? `<div class="sender">${isNote ? 'Nota interna · ' : ''}${esc(m.sender_name)}</div>` : '';
      const dimmed = state.search.q && !state.search.hits.includes(m.id) ? 'dimmed' : '';
      const canAct = !isNote && !m.deleted_at && (m.wa_message_id || m.status === 'failed');
      const mine = m.direction === 'out' && !m.deleted_at && (!m.sender_user_id || m.sender_user_id === state.me.id || state.me.role === 'admin');
      const age = Date.now() - new Date(m.created_at).getTime();
      const canEdit = mine && !isNote && m.type === 'text' && m.wa_message_id && m.status !== 'failed' && m.status !== 'pending' && age <= EDIT_WINDOW_MS;
      const canDelete = mine && (isNote || !m.wa_message_id || age <= DELETE_WINDOW_MS);
      const actions = canAct ? `<div class="msg-actions">
          ${m.status === 'failed' ? `<button type="button" data-msg-act="retry" title="Reenviar">↻</button>` : `<button type="button" data-msg-act="reply" title="Responder">${REPLY_ICON}</button>
          <button type="button" data-msg-act="react" title="Reagir">😊</button>`}
          ${canEdit ? `<button type="button" data-msg-act="edit" title="Editar (até 15 min depois do envio)">${EDIT_ICON}</button>` : ''}
          ${canDelete ? `<button type="button" data-msg-act="delete" title="Apagar para todos">${TRASH_ICON}</button>` : ''}
        </div>` : (isNote && !m.deleted_at && m.body ? `<div class="msg-actions"><button type="button" data-msg-act="pin" title="Fixar na ficha do contato (vira observação permanente)">📌</button>${mine ? `<button type="button" data-msg-act="edit" title="Editar nota">${EDIT_ICON}</button><button type="button" data-msg-act="delete" title="Apagar nota">${TRASH_ICON}</button>` : ''}</div>` : '');
      const stickerCls = m.type === 'sticker' && m.media_id && !m.deleted_at ? 'sticker' : '';
      return `${sep}<div class="msg-row ${rowCls} ${m.deleted_at ? 'deleted' : ''} ${dimmed} ${stickerCls}" data-id="${m.id}">
        <div class="msg">${sender}${quoteHtml(m)}${mediaHtml(m)}${showBody ? `<span class="body">${waFormat(highlight(m.body))}</span>` : ''}
          <span class="foot">${m.edited_at && !m.deleted_at ? '<span class="edited">editada</span>' : ''}<span>${esc(fmtClock(m.created_at))}</span>${statusIcon(m)}</span>
          ${reactionsHtml(m)}
        </div>${agent}${actions}
      </div>`;
    }).join('');
    if (scroll) els.messages.scrollTop = els.messages.scrollHeight;
  }

  // ---------- Setores e etiqueta rápida ----------
  const TAG_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
  function sectorChip(c, clickable = false) {
    if (!c.sector_id) return clickable ? `<span class="sector-chip clickable" id="sector-chip" title="Definir setor"><span class="dot"></span>Sem setor</span>` : '';
    return `<span class="sector-chip ${clickable ? 'clickable' : ''}" ${clickable ? 'id="sector-chip" title="Mudar setor"' : ''} style="--sector-color:${esc(c.sector_color || '#868e96')}"><span class="dot"></span>${esc(c.sector_name)}</span>`;
  }
  function placeMenu(menu, anchor) {
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`;
  }
  let tagPopupConv = null;
  function openTagPopup(conv, anchor) {
    tagPopupConv = conv.id;
    const selected = new Set(conv.tags.map((t) => t.id));
    $('tag-popup').innerHTML = `<div class="hint">Clique para marcar ou desmarcar</div><div class="tag-picker">${state.tags.map((t) => `
      <span class="tag selectable ${selected.has(t.id) ? 'on' : ''}" data-id="${t.id}" style="--tag-color:${esc(t.color)}"><i class="dot" style="background:${esc(t.color)}"></i>${esc(t.name)}</span>`).join('') || '<span class="muted small">Nenhuma tag cadastrada</span>'}</div>`;
    placeMenu($('tag-popup'), anchor);
  }
  $('tag-popup').addEventListener('click', async (e) => {
    e.stopPropagation();
    const el = e.target.closest('.tag.selectable');
    const c = state.conversations.find((x) => x.id === tagPopupConv) || (state.currentConv?.id === tagPopupConv ? state.currentConv : null);
    if (!el || !c) return;
    const id = Number(el.dataset.id);
    const ids = new Set(c.tags.map((t) => t.id));
    ids.has(id) ? ids.delete(id) : ids.add(id);
    el.classList.toggle('on');
    try { await api('PUT', `/api/conversations/${c.id}/tags`, { tag_ids: [...ids] }); }
    catch (err) { toast(err.message, true); }
  });
  let sectorPopupConv = null;
  function openSectorPopup(conv, anchor) {
    sectorPopupConv = conv.id;
    $('sector-popup').innerHTML = state.sectors.map((s) => `<button type="button" data-sector="${s.id}" class="${s.id === conv.sector_id ? 'selected' : ''}"><span class="sector-chip" style="--sector-color:${esc(s.color)}"><span class="dot"></span></span>${esc(s.name)}${s.is_default ? ' <span class="muted small">(padrão)</span>' : ''}</button>`).join('')
      || '<div class="qr-empty">Nenhum setor. Admin cria em Configurações.</div>';
    placeMenu($('sector-popup'), anchor);
  }
  $('sector-popup').addEventListener('click', async (e) => {
    e.stopPropagation();
    const b = e.target.closest('button[data-sector]');
    $('sector-popup').hidden = true;
    if (!b || !sectorPopupConv) return;
    try { await api('PATCH', `/api/conversations/${sectorPopupConv}`, { sector_id: Number(b.dataset.sector) }); toast('Setor alterado'); }
    catch (err) { toast(err.message, true); }
  });
  els.chatTags.addEventListener('click', (e) => {
    const c = current();
    if (!c) return;
    if (e.target.closest('#btn-tag-quick')) { e.stopPropagation(); openTagPopup(c, e.target.closest('#btn-tag-quick')); }
    else if (e.target.closest('#sector-chip')) { e.stopPropagation(); openSectorPopup(c, e.target.closest('#sector-chip')); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#tag-popup') && !e.target.closest('#btn-tag-quick')) $('tag-popup').hidden = true;
    if (!e.target.closest('#sector-popup') && !e.target.closest('#sector-chip')) $('sector-popup').hidden = true;
  });
  async function loadSectors() {
    try {
      const { sectors } = await api('GET', '/api/sectors');
      state.sectors = sectors;
      $('sector-filter').innerHTML = '<option value="">Todos os setores</option>' + sectors.map((s) => `<option value="${s.id}">${esc(s.name)}${s.open_count ? ` (${s.open_count})` : ''}</option>`).join('');
      $('sector-filter').value = state.filters.sector;
    } catch { /* ignora */ }
  }

  // ---------- Citação e reações (renderização) ----------
  const REPLY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
  const quotedLabel = (q) => {
    const c = current();
    return q.direction === 'in' ? (c ? contactName(c) : 'Cliente') : (q.sender_name || 'Você');
  };
  const quotedText = (q) => {
    if (!q) return '';
    const map = { image: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio', sticker: 'Figurinha', document: `📄 ${q.body || 'Documento'}` };
    return q.media_id || ['image', 'video', 'audio', 'sticker', 'document'].includes(q.type) ? (isPlaceholder(q.body) || !q.body ? map[q.type] || q.body : q.body) : stripWa(q.body);
  };
  function quoteHtml(m) {
    if (!m.quoted) return '';
    return `<span class="quote" data-goto="${m.quoted.id}"><span class="qname">${esc(quotedLabel(m.quoted))}</span><span class="qbody">${esc(quotedText(m.quoted))}</span></span>`;
  }
  function reactionsHtml(m) {
    const r = m.reactions || {};
    const items = [];
    if (r.contact) items.push(`<span class="reaction" title="Reação do cliente">${esc(r.contact)}</span>`);
    if (r.me) items.push(`<span class="reaction mine" data-unreact="${m.id}" title="Sua reação (clique para remover)">${esc(r.me)}</span>`);
    return items.length ? `<div class="reactions">${items.join('')}</div>` : '';
  }
  els.messages.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) {
      const row = els.messages.querySelector(`.msg-row[data-id="${go.dataset.goto}"]`);
      if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1500); }
      return;
    }
    const un = e.target.closest('[data-unreact]');
    if (un) { await sendReaction(Number(un.dataset.unreact), ''); return; }
    const act = e.target.closest('button[data-msg-act]');
    if (!act) return;
    const id = Number(act.closest('.msg-row').dataset.id);
    const m = state.messages.find((x) => x.id === id);
    if (!m) return;
    if (act.dataset.msgAct === 'reply') setReply(m);
    if (act.dataset.msgAct === 'react') { e.stopPropagation(); openEmojiPicker({ forReaction: id, anchor: act }); }
    if (act.dataset.msgAct === 'pin') pinNoteToContact(m);
    if (act.dataset.msgAct === 'edit') startEdit(m);
    if (act.dataset.msgAct === 'delete') deleteMessage(m);
    if (act.dataset.msgAct === 'failed') explainFailure(m);
    if (act.dataset.msgAct === 'retry') retryMessage(m);
  });
  /** Motivo da falha em linguagem simples + reenvio. */
  function failureText(err) {
    const e = String(err || '');
    if (/desconectad|QR code|Nenhum número/i.test(e)) return 'O número de WhatsApp está desconectado. Reconecte pelo QR code em Configurações → Números e reenvie.';
    if (/timed out|Timed Out|timeout/i.test(e)) return 'O WhatsApp demorou demais para confirmar (queda de conexão ou instabilidade). Costuma resolver reenviando.';
    if (/rate|429|too many/i.test(e)) return 'O WhatsApp limitou o envio por excesso de mensagens. Aguarde um pouco e reenvie.';
    if (/not on whatsapp|não está no WhatsApp|jid/i.test(e)) return 'Este número não parece ter WhatsApp.';
    return e ? `O WhatsApp não aceitou o envio: ${e}` : 'O WhatsApp não aceitou o envio.';
  }
  function explainFailure(m) {
    const why = failureText(m.error);
    if (confirm(`${why}\n\nReenviar esta mensagem agora?`)) retryMessage(m);
  }
  async function retryMessage(m) {
    try {
      const { message } = await api('POST', `/api/conversations/${m.conversation_id}/messages/${m.id}/retry`);
      Object.assign(m, message);
      renderMessages(false);
      toast('Mensagem reenviada');
    } catch (err) {
      toast(failureText(err.message), true);
      const cur = state.messages.find((x) => x.id === m.id);
      if (cur) { cur.error = err.message; renderMessages(false); }
    }
  }
  const EDIT_WINDOW_MS = 15 * 60 * 1000;
  const DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;
  const EDIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
  /** Edição no próprio compositor, como no WhatsApp: o texto atual entra na caixa e Enter salva. */
  function startEdit(m) {
    clearReply();
    clearAttachment();
    setComposeMode(m.type === 'note' ? 'note' : 'message');
    state.editing = m;
    const p = $('edit-preview');
    p.innerHTML = `<div class="info"><div class="qname">${m.type === 'note' ? 'Editando nota interna' : 'Editando mensagem'} <small class="muted">· Enter salva · Esc cancela</small></div><div class="qbody">${esc(m.body || '')}</div></div><button type="button" class="icon-btn" id="edit-cancel" title="Cancelar edição">✕</button>`;
    p.hidden = false;
    $('edit-cancel').addEventListener('click', cancelEdit);
    els.composeText.value = m.body || '';
    els.composeSend.textContent = 'Salvar';
    autosize();
    els.composeText.focus();
    els.composeText.setSelectionRange(els.composeText.value.length, els.composeText.value.length);
  }
  function cancelEdit() {
    if (!state.editing) return;
    state.editing = null;
    $('edit-preview').hidden = true;
    $('edit-preview').innerHTML = '';
    els.composeText.value = '';
    els.composeSend.textContent = 'Enviar';
    autosize();
  }
  async function saveEdit(text) {
    const m = state.editing;
    if (!m) return;
    if (!text) { toast('A mensagem não pode ficar vazia', true); return; }
    els.composeSend.disabled = true;
    try {
      await api('PATCH', `/api/conversations/${m.conversation_id}/messages/${m.id}`, { body: text });
      cancelEdit();
      toast('Mensagem editada');
    } catch (err) { toast(err.message, true); }
    finally { els.composeSend.disabled = false; els.composeText.focus(); }
  }
  async function deleteMessage(m) {
    const isNote = m.type === 'note';
    if (!confirm(isNote ? 'Apagar esta nota interna?' : 'Apagar esta mensagem para todos? O cliente verá "Mensagem apagada".')) return;
    try { await api('DELETE', `/api/conversations/${m.conversation_id}/messages/${m.id}`); toast(isNote ? 'Nota apagada' : 'Mensagem apagada para todos'); }
    catch (err) { toast(err.message, true); }
  }
  function setReply(m) {
    state.reply = m;
    const p = $('reply-preview');
    p.innerHTML = `<div class="info"><div class="qname">${esc(m.direction === 'in' ? contactName(current()) : (m.sender_name || 'Você'))}</div><div class="qbody">${esc(quotedText(m))}</div></div><button type="button" class="icon-btn" id="reply-cancel" title="Cancelar">✕</button>`;
    p.hidden = false;
    $('reply-cancel').addEventListener('click', clearReply);
    els.composeText.focus();
  }
  function clearReply() { state.reply = null; $('reply-preview').hidden = true; $('reply-preview').innerHTML = ''; }
  async function sendReaction(messageId, emoji) {
    const c = current();
    if (!c) return;
    try { await api('POST', `/api/conversations/${c.id}/messages/${messageId}/react`, { emoji }); }
    catch (err) { toast(err.message, true); }
  }

  // ---------- Emojis (seletor no estilo do WhatsApp) ----------
  const EMOJI_CATS = (window.EMOJI_DATA?.categories || []).map((c) => ({ ...c, list: c.emojis.split(/\s+/).filter(Boolean) }));
  const EMOJI_KW = window.EMOJI_DATA?.keywords || {};
  const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const RECENT_MAX = 27;
  let emojiTarget = null; // null = compositor; número = reação na mensagem
  let emojiScrollHandler = null;

  function recentEmojis() {
    try { return JSON.parse(localStorage.getItem('sos.emoji.recent') || '[]'); } catch { return []; }
  }
  function rememberEmoji(e) {
    const list = [e, ...recentEmojis().filter((x) => x !== e)].slice(0, RECENT_MAX);
    try { localStorage.setItem('sos.emoji.recent', JSON.stringify(list)); } catch { /* ignora */ }
  }
  function insertAtCaret(text) {
    const t = els.composeText;
    const s = t.selectionStart ?? t.value.length, e = t.selectionEnd ?? t.value.length;
    t.value = t.value.slice(0, s) + text + t.value.slice(e);
    t.selectionStart = t.selectionEnd = s + text.length;
    t.focus();
    autosize();
  }
  const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const emojiGrid = (list) => `<div class="ep-grid">${list.map((x) => `<button type="button" data-emoji="${x}" title="${esc(EMOJI_KW[x] || '')}">${x}</button>`).join('')}</div>`;

  function renderEmojiPicker(query = '') {
    const picker = $('emoji-picker');
    const q = normalize(query.trim());
    const quick = emojiTarget
      ? `<div class="ep-quick">${QUICK_REACTIONS.map((x) => `<button type="button" data-emoji="${x}">${x}</button>`).join('')}</div>` : '';
    let body;
    if (q) {
      const hits = [];
      for (const c of EMOJI_CATS) {
        const catMatch = normalize(c.title).includes(q);
        for (const e of c.list) if (catMatch || normalize(EMOJI_KW[e] || '').includes(q)) hits.push(e);
      }
      body = hits.length ? `<div class="ep-section"><div class="ep-title">Resultados</div>${emojiGrid([...new Set(hits)])}</div>`
        : '<div class="ep-empty">Nenhum emoji encontrado</div>';
    } else {
      const recent = recentEmojis();
      body = (recent.length ? `<div class="ep-section" data-cat="recent"><div class="ep-title">Usados recentemente</div>${emojiGrid(recent)}</div>` : '')
        + EMOJI_CATS.map((c) => `<div class="ep-section" data-cat="${c.id}"><div class="ep-title">${esc(c.title)}</div>${emojiGrid(c.list)}</div>`).join('');
    }
    picker.innerHTML = `
      ${quick}
      <div class="ep-tabs">
        ${recentEmojis().length && !q ? '<button type="button" data-cat="recent" title="Usados recentemente">🕒</button>' : ''}
        ${EMOJI_CATS.map((c) => `<button type="button" data-cat="${c.id}" title="${esc(c.title)}">${c.icon}</button>`).join('')}
      </div>
      <div class="ep-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input type="search" id="ep-search" placeholder="Pesquisar emoji" value="${esc(query)}" autocomplete="off"></div>
      <div class="ep-body" id="ep-body">${body}</div>`;
    const bodyEl = $('ep-body');
    const tabs = [...picker.querySelectorAll('.ep-tabs button')];
    const syncTab = () => {
      const sections = [...bodyEl.querySelectorAll('.ep-section[data-cat]')];
      let cur = sections[0]?.dataset.cat;
      for (const s of sections) if (s.offsetTop - bodyEl.offsetTop <= bodyEl.scrollTop + 8) cur = s.dataset.cat;
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.cat === cur));
    };
    bodyEl.addEventListener('scroll', syncTab);
    syncTab();
    const input = $('ep-search');
    let t;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { renderEmojiPicker(input.value); $('ep-search').focus(); $('ep-search').setSelectionRange(input.value.length, input.value.length); }, 120); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEmojiPicker(); });
  }
  function openEmojiPicker({ forReaction = null, anchor = null } = {}) {
    emojiTarget = forReaction;
    const picker = $('emoji-picker');
    picker.classList.toggle('for-reaction', Boolean(forReaction));
    renderEmojiPicker('');
    picker.hidden = false;
    if (forReaction && anchor) {
      const r = anchor.getBoundingClientRect();
      picker.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - picker.offsetWidth - 8))}px`;
      picker.style.top = `${Math.max(8, r.top - picker.offsetHeight - 8)}px`;
    } else {
      picker.style.left = ''; picker.style.top = '';
      $('ep-search')?.focus();
    }
  }
  function closeEmojiPicker() { $('emoji-picker').hidden = true; emojiTarget = null; }
  $('btn-emoji').addEventListener('click', (e) => { e.stopPropagation(); if ($('emoji-picker').hidden) openEmojiPicker(); else closeEmojiPicker(); });
  $('emoji-picker').addEventListener('click', async (e) => {
    e.stopPropagation();
    const tab = e.target.closest('.ep-tabs button[data-cat]');
    if (tab) {
      const sec = $('ep-body').querySelector(`.ep-section[data-cat="${tab.dataset.cat}"]`);
      if (sec) $('ep-body').scrollTo({ top: sec.offsetTop - $('ep-body').offsetTop, behavior: 'smooth' });
      return;
    }
    const em = e.target.closest('button[data-emoji]');
    if (!em) return;
    rememberEmoji(em.dataset.emoji);
    if (emojiTarget) { const id = emojiTarget; closeEmojiPicker(); await sendReaction(id, em.dataset.emoji); }
    else insertAtCaret(em.dataset.emoji);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#emoji-picker') && !e.target.closest('#btn-emoji') && !e.target.closest('[data-msg-act="react"]')) closeEmojiPicker(); });

  // ---------- Respostas rápidas ----------
  let qrIndex = 0;
  function fillVars(text) {
    const c = current();
    const first = (s) => String(s || '').trim().split(/\s+/)[0] || '';
    return text
      .replace(/\{nome\}/gi, c ? first(contactName(c)) : '')
      .replace(/\{nome_completo\}/gi, c ? contactName(c) : '')
      .replace(/\{atendente\}/gi, first(state.me.name))
      .replace(/\{telefone\}/gi, c ? formatPhone(c.wa_id) : '');
  }
  /** Aba do painel de respostas rápidas: todas (equipe + minhas) ou só as minhas. */
  let qrTab = 'all';
  function qrMatches(q) {
    const term = (q || '').toLowerCase();
    return state.quickReplies.filter((r) => {
      if (qrTab === 'mine' && r.visibility !== 'personal') return false;
      if (!term) return true;
      return r.shortcut.includes(term) || r.title.toLowerCase().includes(term) || (r.body || '').toLowerCase().includes(term);
    });
  }
  const QR_KIND_LABEL = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', document: 'Documento' };
  function qrMediaHtml(r) {
    if (!r.media_id) return '';
    if (r.media_kind === 'image') return `<img class="qr-thumb" src="/api/media/${esc(r.media_id)}" alt="" loading="lazy">`;
    const label = QR_KIND_LABEL[r.media_kind] || 'Arquivo';
    return `<span class="qr-file" title="${esc(r.media_name || label)}">${esc(label)}</span>`;
  }
  function renderQuickPopup(term) {
    const list = qrMatches(term);
    const pop = $('qr-popup');
    qrIndex = Math.min(qrIndex, Math.max(0, list.length - 1));
    const mine = state.quickReplies.filter((r) => r.visibility === 'personal').length;
    const tabs = `<div class="qr-tabs" id="qr-tabs">
      <button type="button" class="${qrTab === 'all' ? 'active' : ''}" data-qrtab="all">Todas <span>${state.quickReplies.length}</span></button>
      <button type="button" class="${qrTab === 'mine' ? 'active' : ''}" data-qrtab="mine">Minhas <span>${mine}</span></button></div>`;
    const items = list.length
      ? list.map((r, i) => `<div class="qr-item ${i === qrIndex ? 'active' : ''}" data-id="${r.id}">
          ${qrMediaHtml(r)}
          <div class="qr-text"><div class="qr-head"><span class="qr-sc">/${esc(r.shortcut)}</span>${esc(r.title)}
            ${r.visibility === 'personal' ? '<span class="qr-tag">minha</span>' : ''}</div>
          <div class="qr-body">${esc(r.body || (r.media_name || 'Mídia'))}</div></div></div>`).join('')
      : `<div class="qr-empty">${qrTab === 'mine' ? 'Você ainda não tem respostas próprias. Crie em Configurações.' : (state.quickReplies.length ? 'Nenhuma resposta combina' : 'Nenhuma resposta rápida cadastrada. Crie em Configurações.')}</div>`;
    pop.innerHTML = tabs + `<div class="qr-list">${items}</div>`;
    pop.hidden = false;
    pop.dataset.term = term || '';
  }
  function closeQuickPopup() { $('qr-popup').hidden = true; }
  /** Aplica a resposta: texto vai para a caixa e a mídia vira anexo pendente, para o atendente revisar antes de enviar. */
  async function applyQuick(id) {
    const r = state.quickReplies.find((x) => x.id === Number(id));
    if (!r) return;
    const v = els.composeText.value;
    const text = r.body ? fillVars(r.body) : '';
    if (text) els.composeText.value = /^\/\S*$/.test(v.trim()) || !v ? text : v + (v.endsWith(' ') ? '' : ' ') + text;
    else if (/^\/\S*$/.test(v.trim())) els.composeText.value = '';
    closeQuickPopup();
    autosize();
    els.composeText.focus();
    if (r.media_id) await attachQuickMedia(r);
  }
  async function attachQuickMedia(r) {
    if (state.composeMode === 'note') { toast('Mídia só em mensagens, não em notas', true); return; }
    try {
      const res = await fetch(`/api/media/${encodeURIComponent(r.media_id)}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Não foi possível carregar a mídia da resposta');
      const blob = await res.blob();
      const file = new File([blob], r.media_name || 'arquivo', { type: r.media_mime || blob.type || 'application/octet-stream' });
      setAttachment(file);
    } catch (err) { toast(err.message, true); }
  }
  $('btn-quick').addEventListener('click', (e) => { e.stopPropagation(); if ($('qr-popup').hidden) { qrIndex = 0; renderQuickPopup(''); } else closeQuickPopup(); });
  $('qr-popup').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-qrtab]');
    if (tab) { e.stopPropagation(); qrTab = tab.dataset.qrtab; qrIndex = 0; renderQuickPopup($('qr-popup').dataset.term || ''); return; }
    const it = e.target.closest('.qr-item');
    if (it) applyQuick(it.dataset.id);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#qr-popup') && !e.target.closest('#btn-quick')) closeQuickPopup(); });
  els.composeText.addEventListener('input', () => {
    const v = els.composeText.value;
    const m = v.match(/^\/(\S*)$/);
    if (m && state.composeMode === 'message') { qrIndex = 0; renderQuickPopup(m[1]); } else closeQuickPopup();
    emitTyping();
  });
  els.composeText.addEventListener('keydown', (e) => {
    const pop = $('qr-popup');
    if (pop.hidden) return;
    const list = qrMatches(pop.dataset.term || '');
    if (e.key === 'ArrowDown') { e.preventDefault(); qrIndex = (qrIndex + 1) % Math.max(list.length, 1); renderQuickPopup(pop.dataset.term || ''); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); qrIndex = (qrIndex - 1 + list.length) % Math.max(list.length, 1); renderQuickPopup(pop.dataset.term || ''); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && list.length) { e.preventDefault(); e.stopImmediatePropagation(); applyQuick(list[qrIndex].id); }
    else if (e.key === 'Escape') closeQuickPopup();
  }, true);

  // ---------- Painel da equipe ----------
  const TEAM_LABEL = { available: 'Disponível', away: 'Ausente', offline: 'Offline' };
  let teamTimer = null;
  async function loadTeam() {
    try {
      const { users, summary } = await api('GET', '/api/users/team');
      state.team = users;
      $('team-online').hidden = !summary.available;
      $('team-online').textContent = summary.available;
      if (!$('team-modal').hidden) renderTeam(summary);
    } catch { /* ignora */ }
  }
  function renderTeam(summary) {
    const users = state.team || [];
    const s = summary || {
      available: users.filter((u) => u.status === 'available').length,
      away: users.filter((u) => u.status === 'away').length,
      offline: users.filter((u) => u.status === 'offline').length,
    };
    $('team-summary').innerHTML = [
      ['available', 'online agora', s.available],
      ['away', 'ausente', s.away],
      ['offline', 'offline', s.offline],
    ].map(([k, label, n]) => `<div class="team-stat ${k}"><b>${n}</b><span>${esc(label)}</span></div>`).join('');
    const order = { available: 0, away: 1, offline: 2 };
    const list = [...users].sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));
    $('team-list').innerHTML = list.map((u) => {
      const me = u.id === state.me.id;
      const dot = u.status === 'offline' ? '' : (u.status === 'away' ? 'away' : 'online');
      // sem registro de acesso, a última resposta é a melhor pista de quando a pessoa esteve no sistema
      const seenAt = u.last_online_at || u.last_reply_at;
      const when = u.status === 'offline'
        ? (seenAt ? `visto ${sinceText(seenAt)}` : 'nunca entrou')
        : (u.last_reply_at ? `última resposta ${sinceText(u.last_reply_at)}` : 'sem respostas ainda');
      const load = u.open_conversations
        ? `${u.open_conversations} conversa${u.open_conversations > 1 ? 's' : ''}${u.waiting_conversations ? ` · ${u.waiting_conversations} esperando` : ''}`
        : 'sem conversas atribuídas';
      return `<div class="team-row ${u.status}">
        <span class="agent">${esc(initials(u.name))}${userImg(u.avatar_media_id)}<span class="pdot ${dot}"></span></span>
        <div class="team-info">
          <div class="team-name">${esc(u.name)}${me ? ' <span class="muted">(você)</span>' : ''}${u.role === 'admin' ? ' <span class="tag">admin</span>' : ''}</div>
          <div class="team-meta">${esc(load)} · ${esc(when)}</div>
        </div>
        <span class="team-status ${u.status}">${esc(TEAM_LABEL[u.status])}</span>
      </div>`;
    }).join('') || '<div class="d-empty">Nenhum atendente cadastrado</div>';
  }
  function openTeam() {
    $('team-modal').hidden = false;
    renderTeam();
    loadTeam();
    clearInterval(teamTimer);
    teamTimer = setInterval(loadTeam, 30000);
  }
  function closeTeam() { $('team-modal').hidden = true; clearInterval(teamTimer); }
  $('btn-team').addEventListener('click', () => ($('team-modal').hidden ? openTeam() : closeTeam()));
  $('team-close').addEventListener('click', closeTeam);
  $('team-modal').addEventListener('click', (e) => { if (e.target === $('team-modal')) closeTeam(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('team-modal').hidden) closeTeam(); });

  // ---------- Presença e "está digitando" ----------
  let typingSocket = null;
  let lastTypingAt = 0;
  function emitTyping() {
    if (!typingSocket || !state.currentId || state.composeMode === 'note') return;
    const now = Date.now();
    if (now - lastTypingAt < 2000) return;
    lastTypingAt = now;
    typingSocket.emit('typing', { conversation_id: state.currentId, active: true });
  }
  function emitViewing(conversationId) {
    if (!typingSocket) return;
    typingSocket.emit('viewing', { conversation_id: conversationId || null });
  }
  /** Outros atendentes (fora eu) digitando nesta conversa. */
  function typingNames(conversationId) {
    const map = state.typing.get(conversationId);
    if (!map) return [];
    return [...map.values()].filter((t) => t.until > Date.now()).map((t) => t.name);
  }
  /** Outros atendentes com esta conversa aberta agora. */
  function viewerNames(conversationId) {
    return (state.viewers.get(conversationId) || []).filter((v) => v.id !== state.me.id).map((v) => v.name);
  }
  /** Aviso curto para a lista: digitando tem prioridade sobre apenas visualizando. */
  function activityHtml(conversationId) {
    const typing = typingNames(conversationId);
    if (typing.length) return `<span class="act typing">${TYPE_ICON}${esc(typing.join(', '))} está digitando…</span>`;
    const viewing = viewerNames(conversationId);
    if (viewing.length) return `<span class="act viewing">${EYE_ICON}${esc(viewing.join(', '))} está vendo</span>`;
    return '';
  }
  const TYPE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6.01" y2="10"/><line x1="10" y1="10" x2="10.01" y2="10"/><line x1="14" y1="10" x2="14.01" y2="10"/><line x1="18" y1="10" x2="18.01" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/></svg>';
  const EYE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  function typingHtml(conversationId) {
    const map = state.typing.get(conversationId);
    if (!map) return '';
    const names = [...map.values()].filter((t) => t.until > Date.now()).map((t) => t.name);
    return names.length ? `<span class="typing">${esc(names.join(', '))} está digitando…</span>` : '';
  }
  setInterval(() => {
    // limpa "digitando" vencidos e atualiza os cronômetros de espera
    let changed = false;
    for (const [cid, map] of state.typing) { for (const [uid, t] of map) if (t.until <= Date.now()) { map.delete(uid); changed = true; } if (!map.size) state.typing.delete(cid); }
    if (changed && current()) { renderChat(); renderActivityBar(); }
    renderList();
  }, 30000);
  function setPresence(userId, data) {
    const cur = state.presence.get(userId) || { online: false, availability: 'available' };
    state.presence.set(userId, { ...cur, ...data });
  }
  function renderMyPresence() {
    const p = state.presence.get(state.me.id);
    const el = $('me-avatar');
    el.querySelector('.pdot')?.remove();
    el.insertAdjacentHTML('beforeend', `<span class="pdot ${p?.availability === 'away' ? 'away' : 'online'}"></span>`);
    el.title = `${state.me.name} · ${p?.availability === 'away' ? 'Ausente' : 'Disponível'} (clique para mudar)`;
  }
  $('me-avatar').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('presence-menu');
    const r = e.currentTarget.getBoundingClientRect();
    menu.hidden = false;
    menu.style.left = `${r.right + 8}px`;
    menu.style.top = `${Math.min(r.top, window.innerHeight - menu.offsetHeight - 8)}px`;
  });
  $('presence-menu').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-availability]');
    $('presence-menu').hidden = true;
    if (!b) return;
    try { await api('PATCH', '/api/users/me/availability', { availability: b.dataset.availability }); setPresence(state.me.id, { availability: b.dataset.availability, online: true }); renderMyPresence(); renderList(); }
    catch (err) { toast(err.message, true); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#presence-menu') && !e.target.closest('#me-avatar')) $('presence-menu').hidden = true; });

  // ---------- Transferir (setor, atendente ou número) ----------
  const tr = { tab: 'sector', sel: null, sectorsOpen: new Map() };
  const T_ICON = {
    sector: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    account: WA_ICON,
  };
  const T_PLACEHOLDER = { sector: 'Pesquisar setor', user: 'Pesquisar atendente', account: 'Pesquisar número' };
  const T_HINT = {
    sector: 'A conversa vai para a fila do setor escolhido, sem responsável, até alguém do setor assumir.',
    user: 'O atendente recebe um aviso e a conversa passa a ser dele.',
    account: 'As próximas respostas saem pelo número escolhido. O cliente vai receber a mensagem de outro número.',
  };
  function transferItems() {
    const c = current();
    const q = normalize($('transfer-search').value.trim());
    const match = (s) => !q || normalize(s).includes(q);
    if (tr.tab === 'sector') {
      return state.sectors.filter((s) => match(s.name)).map((s) => ({
        id: s.id, name: s.name, icon: `<span class="t-icon" style="color:${esc(s.color)}">${T_ICON.sector}</span>`,
        sub: s.is_default ? 'Setor padrão' : '', meta: s.open_count ? `${s.open_count} abertas` : 'sem abertas', metaCls: s.open_count ? '' : 'off', current: c?.sector_id === s.id,
      }));
    }
    if (tr.tab === 'user') {
      return state.users.filter((u) => u.active !== false && u.id !== state.me.id && match(u.name))
        .sort((a, b) => (Number(state.presence.get(b.id)?.online) - Number(state.presence.get(a.id)?.online)) || a.name.localeCompare(b.name))
        .map((u) => {
          const p = state.presence.get(u.id);
          const on = p?.online;
          return { id: u.id, name: u.name, icon: `<span class="t-icon">${esc(initials(u.name))}${userImg(u.avatar_media_id)}${pdot(u.id)}</span>`,
            sub: u.role === 'admin' ? 'Admin' : 'Atendente', meta: on ? (p.availability === 'away' ? 'ausente' : 'online') : 'offline', metaCls: on ? '' : 'off', current: c?.assigned_user_id === u.id };
        });
    }
    return [...state.accounts.values()].filter((a) => match(a.name) || match(a.phone || '')).map((a) => ({
      id: a.id, name: a.name, icon: `<span class="t-icon" style="color:var(--wa)">${T_ICON.account}</span>`,
      sub: a.phone ? formatPhone(a.phone) : '', meta: a.status === 'connected' ? 'conectado' : 'desconectado', metaCls: a.status === 'connected' ? '' : 'off', current: c?.account_id === a.id,
    }));
  }
  function renderTransfer() {
    const items = transferItems();
    $('transfer-search').placeholder = T_PLACEHOLDER[tr.tab];
    $('transfer-hint').textContent = T_HINT[tr.tab];
    $('transfer-list').innerHTML = items.length ? items.map((it) => `
      <div class="t-item ${tr.sel === it.id ? 'sel' : ''} ${it.current ? 'current' : ''}" data-id="${it.id}" title="${it.current ? 'A conversa já está aqui' : ''}">
        ${it.icon}
        <div class="t-main"><div class="t-name">${esc(it.name)}${it.current ? ' <span class="muted small">(atual)</span>' : ''}</div>${it.sub ? `<div class="t-sub">${esc(it.sub)}</div>` : ''}</div>
        <span class="t-meta ${it.metaCls}">${esc(it.meta)}</span>
        <span class="t-radio"></span>
      </div>`).join('') : '<div class="empty" style="height:auto;padding:24px">Nada encontrado</div>';
    $('transfer-submit').disabled = !tr.sel;
    $('transfer-submit').textContent = tr.sel ? `Transferir para ${esc(items.find((i) => i.id === tr.sel)?.name || '')}` : 'Transferir';
  }
  function openTransfer() {
    const c = current();
    if (!c) return;
    tr.tab = 'sector'; tr.sel = null;
    document.querySelectorAll('#transfer-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.ttab === 'sector'));
    $('transfer-search').value = '';
    $('transfer-note').value = '';
    if (!state.multiAccount || state.accounts.size < 2) document.querySelector('#transfer-tabs [data-ttab="account"]').hidden = true;
    renderTransfer();
    $('transfer-modal').hidden = false;
    $('transfer-search').focus();
  }
  $('btn-transfer').addEventListener('click', openTransfer);
  $('transfer-cancel').addEventListener('click', () => { $('transfer-modal').hidden = true; });
  $('transfer-modal').addEventListener('click', (e) => { if (e.target === $('transfer-modal')) $('transfer-modal').hidden = true; });
  $('transfer-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ttab]');
    if (!b) return;
    tr.tab = b.dataset.ttab; tr.sel = null;
    document.querySelectorAll('#transfer-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $('transfer-search').value = '';
    renderTransfer();
    $('transfer-search').focus();
  });
  $('transfer-search').addEventListener('input', renderTransfer);
  $('transfer-list').addEventListener('click', (e) => {
    const it = e.target.closest('.t-item');
    if (!it || it.classList.contains('current')) return;
    tr.sel = Number(it.dataset.id);
    renderTransfer();
  });
  $('transfer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = current();
    if (!c || !tr.sel) return;
    const body = { note: $('transfer-note').value };
    body[tr.tab === 'sector' ? 'sector_id' : tr.tab === 'user' ? 'user_id' : 'account_id'] = tr.sel;
    if (tr.tab === 'account' && !confirm('O cliente vai passar a receber as respostas de outro número. Continuar?')) return;
    $('transfer-submit').disabled = true;
    try {
      await api('POST', `/api/conversations/${c.id}/transfer`, body);
      $('transfer-modal').hidden = true;
      toast('Conversa transferida');
    } catch (err) { toast(err.message, true); $('transfer-submit').disabled = false; }
  });

  // ---------- Gravação de áudio ----------
  const rec = { recorder: null, chunks: [], start: 0, timer: null, stream: null, cancelled: false };
  function recSupported() { return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder); }
  function recMime() {
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(t)) return t;
    return '';
  }
  async function startRecording() {
    if (!recSupported()) { toast('Seu navegador não permite gravar áudio', true); return; }
    try {
      const inputId = SOS.sound.load().inputId;
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: inputId ? { deviceId: { exact: inputId } } : true })
        .catch(() => navigator.mediaDevices.getUserMedia({ audio: true })); // microfone escolhido sumiu: usa o padrão
    } catch { toast('Permita o uso do microfone para gravar', true); return; }
    rec.chunks = []; rec.cancelled = false; rec.start = Date.now();
    rec.recorder = new MediaRecorder(rec.stream, recMime() ? { mimeType: recMime() } : undefined);
    rec.recorder.addEventListener('dataavailable', (e) => { if (e.data.size) rec.chunks.push(e.data); });
    rec.recorder.addEventListener('stop', onRecordingStop);
    rec.recorder.start(250);
    $('rec-bar').hidden = false;
    $('btn-mic').classList.add('recording');
    els.composeText.hidden = true;
    clearInterval(rec.timer);
    rec.timer = setInterval(() => { const s = Math.floor((Date.now() - rec.start) / 1000); $('rec-time').textContent = `${Math.floor(s / 60)}:${pad2(s % 60)}`; if (s >= 300) stopRecording(false); }, 250);
  }
  function stopRecording(cancel) {
    rec.cancelled = cancel;
    clearInterval(rec.timer);
    try { rec.recorder?.state !== 'inactive' && rec.recorder.stop(); } catch { /* ignora */ }
    rec.stream?.getTracks().forEach((t) => t.stop());
    $('rec-bar').hidden = true;
    $('btn-mic').classList.remove('recording');
    els.composeText.hidden = false;
    $('rec-time').textContent = '0:00';
  }
  async function onRecordingStop() {
    if (rec.cancelled || !rec.chunks.length || !state.currentId) return;
    if (Date.now() - rec.start < 800) { toast('Áudio muito curto', true); return; }
    const type = rec.recorder.mimeType || 'audio/webm';
    const blob = new Blob(rec.chunks, { type });
    const fd = new FormData();
    fd.append('file', blob, `voz.${type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'}`);
    if (state.reply) fd.append('quoted_message_id', state.reply.id);
    $('btn-mic').disabled = true;
    try {
      await SOS.upload(`/api/conversations/${state.currentId}/audio`, fd);
      clearReply();
    } catch (err) { toast(err.message, true); }
    finally { $('btn-mic').disabled = false; }
  }
  $('btn-mic').addEventListener('click', () => { if (rec.recorder && rec.recorder.state === 'recording') stopRecording(false); else startRecording(); });
  $('rec-cancel').addEventListener('click', () => stopRecording(true));
  $('rec-send').addEventListener('click', () => stopRecording(false));

  // ---------- Ficha do contato, plano e consultas ----------
  const PLAN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9a2 2 0 0 0 2-2V5h14v2a2 2 0 0 0 2 2v6a2 2 0 0 0-2 2v2H5v-2a2 2 0 0 0-2-2z"/><line x1="13" y1="5" x2="13" y2="19" stroke-dasharray="2 2"/></svg>';
  const CLOCK_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  const CAL_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  const DOTS_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  const ARROW_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';
  const ARROW_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';

  // ---- Recorrência do cliente (mesma regra do servidor, com os limites de Configurações) ----
  const REC_LABEL = { new: 'Novo', occasional: 'Ocasional', recurrent: 'Recorrente', loyal: 'Fiel' };
  const REC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
  function recThresholds() {
    const st = state.settings || {};
    return {
      occasional_credits: st.recurrence_occasional_credits || 2,
      recurrent_credits: st.recurrence_recurrent_credits || 10,
      recurrent_purchases: st.recurrence_recurrent_purchases || 3,
      recurrent_span_days: st.recurrence_recurrent_span_days ?? 30,
      loyal_credits: st.recurrence_loyal_credits || 25,
      loyal_purchases: st.recurrence_loyal_purchases || 5,
      loyal_months: st.recurrence_loyal_months ?? 6,
      inactive_days: st.recurrence_inactive_days || 45,
    };
  }
  /** Mesma regra do servidor: a faixa vem das consultas adquiridas. */
  function tierOf(c) {
    const th = recThresholds();
    const credits = Number(c.credits_bought || 0);
    const purchases = Number(c.purchases_count || 0);
    const first = c.first_purchase_at ? new Date(c.first_purchase_at).getTime() : null;
    const last = c.last_purchase_at ? new Date(c.last_purchase_at).getTime() : null;
    const spanDays = first && last ? (last - first) / 86400e3 : 0;
    const monthsSince = first ? (Date.now() - first) / (30.44 * 86400e3) : 0;
    const isRecurrent = credits >= th.recurrent_credits && purchases >= th.recurrent_purchases && spanDays >= th.recurrent_span_days;
    const isLoyal = isRecurrent && credits >= th.loyal_credits && purchases >= th.loyal_purchases && monthsSince >= th.loyal_months;
    const tier = isLoyal ? 'loyal' : isRecurrent ? 'recurrent' : credits >= th.occasional_credits ? 'occasional' : 'new';
    const gap = purchases > 1 && spanDays > 0 ? spanDays / (purchases - 1) : null;
    const limitDays = Math.max(th.inactive_days, gap ? gap * 2 : 0);
    const daysSinceLast = last ? (Date.now() - last) / 86400e3 : null;
    const inactive = (tier === 'recurrent' || tier === 'loyal') && daysSinceLast !== null && daysSinceLast > limitDays;
    return { tier, label: REC_LABEL[tier], inactive, credits, purchases, monthsSince, gap, limitDays };
  }
  function sinceText(d) {
    if (!d) return '';
    const days = Math.floor((Date.now() - new Date(d)) / 86400e3);
    if (days < 1) return 'hoje';
    if (days < 30) return `há ${days} dia${days > 1 ? 's' : ''}`;
    const months = Math.floor(days / 30.44);
    if (months < 12) return `há ${months} m${months > 1 ? 'eses' : 'ês'}`;
    const years = Math.floor(months / 12);
    const rest = months % 12;
    return `há ${years} ano${years > 1 ? 's' : ''}${rest ? ` e ${rest} m${rest > 1 ? 'eses' : 'ês'}` : ''}`;
  }
  /** Chip "Recorrente · há 8 meses". Novo só aparece no cabeçalho, para não poluir a lista. */
  function recChip(c, header = false) {
    if (c.credits_bought === undefined) return '';
    const t = tierOf(c);
    if (t.tier === 'new' && !header) return '';
    const cls = t.inactive ? 'inactive' : t.tier;
    const text = t.inactive ? `${t.label} inativo` : t.label;
    const since = t.tier !== 'new' && c.first_purchase_at ? ` · cliente ${sinceText(c.first_purchase_at)}` : '';
    const title = `${t.credits} consulta${t.credits === 1 ? '' : 's'} adquirida${t.credits === 1 ? '' : 's'} em ${t.purchases} compra${t.purchases === 1 ? '' : 's'}${t.inactive ? ` · sem comprar ${sinceText(c.last_purchase_at)}` : ''}`;
    return `<span class="rec-chip ${cls}" title="${esc(title)}">${REC_ICON}${esc(text)}${esc(since)}</span>`;
  }
  const money = (c) => 'R$ ' + (Number(c || 0) / 100).toFixed(2).replace('.', ',');
  function renderKinds(ct) {
    const kinds = Array.isArray(ct.consultations_by_kind) ? ct.consultations_by_kind : [];
    const total = kinds.reduce((n, k) => n + k.total, 0);
    const loose = kinds.reduce((n, k) => n + k.loose, 0);
    const bought = Number(ct.credits_bought || 0);
    $('d-kinds').innerHTML = `<h5>Consultas por tipo <span class="muted" style="font-weight:500">· ${total} no total${loose ? ` · ${loose} avulsa${loose > 1 ? 's' : ''}` : ''}</span></h5>
      ${kinds.length ? `<div class="kind-grid">${kinds.map((k) => `<span class="kind-pill" title="${k.charged} do plano · ${k.loose} avulsa(s)"><b>${k.total}</b>${esc(k.kind)}</span>`).join('')}</div>` : '<div class="d-empty">Nenhuma consulta registrada ainda.</div>'}
      <div class="kind-buy">${ct.purchases_count ? `Comprou <b>${ct.plans_bought}</b> plano${ct.plans_bought === 1 ? '' : 's'} · <b>${bought}</b> consulta${bought === 1 ? '' : 's'}${ct.spent_cents ? ` · <b>${money(ct.spent_cents)}</b>` : ''}${bought ? ` · usou ${total} (${Math.min(100, Math.round((total / Math.max(1, bought)) * 100))}%)` : ''}` : 'Nenhuma compra registrada.'}</div>`;
  }
  function renderHistory(ct) {
    const t = tierOf(ct);
    const n = Number(ct.interactions || 0);
    const th = recThresholds();
    const step = (() => {
      if (t.tier === 'loyal') return '';
      const alvo = t.tier === 'recurrent' ? 'Fiel' : 'Recorrente';
      const credits = t.tier === 'recurrent' ? th.loyal_credits : th.recurrent_credits;
      const purchases = t.tier === 'recurrent' ? th.loyal_purchases : th.recurrent_purchases;
      const faltam = [];
      if (t.credits < credits) faltam.push(`${credits - t.credits} consulta${credits - t.credits > 1 ? 's' : ''}`);
      if (t.purchases < purchases) faltam.push(`${purchases - t.purchases} compra${purchases - t.purchases > 1 ? 's' : ''}`);
      if (t.tier === 'recurrent' && t.monthsSince < th.loyal_months) faltam.push(`${Math.ceil(th.loyal_months - t.monthsSince)} mês(es) de casa`);
      return faltam.length ? `Para ${alvo}: faltam ${faltam.join(', ')}` : '';
    })();
    const rows = [
      ['Consultas adquiridas', `${t.credits} em ${t.purchases} compra${t.purchases === 1 ? '' : 's'}`],
      ['Cliente desde', ct.first_purchase_at ? `${new Date(ct.first_purchase_at).toLocaleDateString('pt-BR')} (${sinceText(ct.first_purchase_at)})` : 'ainda não comprou'],
      ['Última compra', ct.last_purchase_at ? sinceText(ct.last_purchase_at) : 'nenhuma'],
      ['Compra a cada', t.gap ? `${Math.round(t.gap)} dias (em média)` : 'ainda sem padrão'],
      ['Consultas usadas', ct.consultations_count ? `${ct.consultations_count}${ct.last_consultation_at ? ` · última ${esc(ct.last_consultation_kind || '')} ${sinceText(ct.last_consultation_at)}` : ''}` : 'nenhuma registrada'],
      ['Total gasto', ct.spent_cents ? money(ct.spent_cents) : 'sem valores informados'],
      ['Atendimentos', `${n} dia${n === 1 ? '' : 's'} com contato · último ${ct.last_seen_at ? sinceText(ct.last_seen_at) : 'sem registro'}`],
    ];
  $('d-hist').innerHTML = `<h5>Histórico do cliente <span class="rec-chip ${t.inactive ? 'inactive' : t.tier}">${REC_ICON}${esc(t.inactive ? t.label + ' inativo' : t.label)}</span></h5>
      <div class="d-hist-grid">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join('')}</div>${step ? `<div class="d-hist-step">${esc(step)}</div>` : ''}`;
  }

  /** Situação do plano a partir de uma conversa ou de uma ficha (ambas trazem plan_credits/plan_left). */
  function planState(c) {
    if (!c || c.plan_credits === null || c.plan_credits === undefined) return null;
    const expired = Boolean(c.plan_expires_at) && new Date(c.plan_expires_at) < new Date();
    const left = Number(c.plan_left ?? Math.max(0, c.plan_credits - (c.plan_used || 0)));
    const cls = expired ? 'is-expired' : left === 0 ? 'is-empty' : left <= 1 ? 'is-low' : 'is-ok';
    return { expired, left, total: Number(c.plan_credits), cls, name: c.plan_name || 'Plano' };
  }
  function planChip(c) {
    const p = planState(c);
    if (!p) return '';
    const title = `${p.name}: ${p.left} de ${p.total} consulta(s) disponível(is)${p.expired ? ' · vencido' : ''}`;
    return `<span class="plan-chip ${p.cls}" title="${esc(title)}">${PLAN_ICON}${p.left}/${p.total}</span>`;
  }
  const daysUntil = (d) => Math.ceil((new Date(d) - Date.now()) / 86400e3);
  function planExpiryText(c) {
    if (!c.plan_expires_at) return 'Sem vencimento';
    const n = daysUntil(c.plan_expires_at);
    const date = new Date(c.plan_expires_at).toLocaleDateString('pt-BR');
    if (n < 0) return `Venceu em ${date}`;
    if (n === 0) return 'Vence hoje';
    return `Vence em ${n} dia${n > 1 ? 's' : ''} (${date})`;
  }
  function agoText(d) {
    const s = Math.max(0, (Date.now() - new Date(d)) / 1000);
    if (s < 60) return 'agora mesmo';
    const m = Math.floor(s / 60); if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60); if (h < 24) return `há ${h} hora${h > 1 ? 's' : ''}`;
    const days = Math.floor(h / 24); if (days < 30) return `há ${days} dia${days > 1 ? 's' : ''}`;
    const mo = Math.floor(days / 30); if (mo < 12) return `há ${mo} m${mo > 1 ? 'eses' : 'ês'}`;
    return new Date(d).toLocaleDateString('pt-BR');
  }
  const fmtCpf = (v) => v.length === 11 ? v.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : v.length === 14 ? v.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : v;

  let contactCardId = null;
  const dOpen = { 'd-notes': false, 'd-purchases': false, 'd-consults': false, 'd-log': false };
  let autoOpenedNotesFor = null;

  async function loadContactCard(c) {
    if (!c) return;
    contactCardId = c.contact_id;
    try {
      const { contact, conversations } = await api('GET', `/api/contacts/${c.contact_id}`);
      if (contactCardId !== c.contact_id) return;
      state.contact = contact;
      if (contact.notes_count > 0) loadContactNotes(contact.id); else { state.contactNotes = []; renderObsStrip(); }
      renderContactCard(contact);
      if (contact.notes_count > 0 && !dOpen['d-notes'] && autoOpenedNotesFor !== contact.id) { autoOpenedNotesFor = contact.id; document.querySelector('[data-dtoggle="d-notes"]').click(); }
      const others = conversations.filter((x) => x.id !== c.id);
      $('d-history').innerHTML = others.length ? others.map((x) => `
        <div class="h-item" data-open="${x.id}">
          <div class="h-top"><span>${x.status === 'resolved' ? 'Finalizada' : 'Aberta'} · ${esc(x.account_name || '')}</span><span class="muted">${esc(new Date(x.created_at).toLocaleDateString('pt-BR'))}</span></div>
          <div class="h-prev">${esc(stripWa(x.last_message_preview || ''))}</div>
          <div class="muted">${x.messages_count} msg · ${esc(x.assigned_user_name || 'sem responsável')}</div>
        </div>`).join('') : '<div class="muted small">Primeira conversa deste contato</div>';
      for (const k of Object.keys(dOpen)) if (dOpen[k]) loadSub(k);
    } catch { /* ignora */ }
  }
  $('d-history').addEventListener('click', (e) => { const it = e.target.closest('[data-open]'); if (it) openConversation(Number(it.dataset.open)); });

  function renderContactCard(ct) {
    $('d-notes-count').textContent = ct.notes_count ? `(${ct.notes_count})` : '';
    $('d-consults-count').textContent = ct.consultations_count ? `(${ct.consultations_count})` : '';
    renderPlanCard(ct);
    renderHistory(ct);
    renderKinds(ct);
    $('d-purchases-count').textContent = ct.purchases_count ? `(${ct.purchases_count})` : '';
    renderBlockButton(ct.blocked);
  }
  function renderBlockButton(blocked) {
    $('d-block').innerHTML = `${BLOCK_ICON}<span>${blocked ? 'Desbloquear contato' : 'Bloquear contato'}</span>`;
    $('d-block').classList.toggle('on', Boolean(blocked));
  }

  // ---- Plano ----
  function renderPlanCard(ct) {
    const p = planState(ct);
    const box = $('d-plan');
    if (!p) {
      box.innerHTML = `<div class="plan-card none">
        <div class="plan-top"><span class="plan-name">${PLAN_ICON}Plano de consultas</span><span class="plan-status">Sem plano</span></div>
        <p class="muted small" style="margin:6px 0 10px">Este cliente não tem plano ativo. Consultas registradas ficam como avulsas.</p>
        <div class="plan-actions"><button type="button" class="btn btn-sm btn-primary" data-plan="assign">Atribuir plano</button><button type="button" class="btn btn-sm" data-plan="consult">Registrar consulta</button></div>
      </div>`;
      return;
    }
    const pct = p.total ? Math.round((p.left / p.total) * 100) : 0;
    const status = p.expired ? 'Vencido' : p.left === 0 ? 'Sem saldo' : p.left <= 1 ? 'Última consulta' : 'Ativo';
    box.innerHTML = `<div class="plan-card ${p.cls}">
      <div class="plan-top"><span class="plan-name">${PLAN_ICON}${esc(p.name)}</span><span class="plan-status">${status}</span></div>
      <div class="plan-count"><b>${p.left}</b><span>/${p.total}</span><small>consulta${p.left === 1 ? '' : 's'} disponíve${p.left === 1 ? 'l' : 'is'}</small></div>
      <div class="plan-bar"><i style="width:${pct}%"></i></div>
      <div class="plan-meta">${esc(planExpiryText(ct))}${ct.plan_started_at ? ` · desde ${new Date(ct.plan_started_at).toLocaleDateString('pt-BR')}` : ''}</div>
      <div class="plan-actions">
        <button type="button" class="btn btn-sm btn-primary" data-plan="consult">Registrar consulta</button>
        <button type="button" class="btn btn-sm" data-plan="renew">Renovar</button>
        <button type="button" class="icon-btn sm" data-plan="menu" title="Mais opções do plano">${DOTS_ICON}</button>
      </div>
    </div>`;
  }
  $('d-plan').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-plan]');
    if (!b || !state.contact) return;
    const act = b.dataset.plan;
    if (act === 'assign' || act === 'change') openPlanModal('assign');
    else if (act === 'consult') openConsultModal(guessReference());
    else if (act === 'renew') renewPlan(state.contact);
    else if (act === 'menu') { e.stopPropagation(); placeMenu($('plan-menu'), b); }
  });
  $('plan-menu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-plan]');
    $('plan-menu').hidden = true;
    if (!b || !state.contact) return;
    if (b.dataset.plan === 'adjust') openPlanModal('adjust');
    else if (b.dataset.plan === 'change') openPlanModal('assign');
    else if (b.dataset.plan === 'remove') removePlan(state.contact);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#plan-menu') && !e.target.closest('[data-plan="menu"]')) $('plan-menu').hidden = true; });
  async function renewPlan(ct) {
    if (!ct || ct.plan_credits == null) return;
    if (!confirm(`Renovar o plano ${ct.plan_name}? O saldo volta para ${ct.plan_credits} consulta(s) e o vencimento é recalculado a partir de hoje.`)) return;
    try { await api('POST', `/api/contacts/${ct.id}/plan/renew`); toast('Plano renovado'); } catch (err) { toast(err.message, true); }
  }
  async function removePlan(ct) {
    if (!confirm(`Remover o plano ${ct.plan_name} deste cliente? O histórico de consultas fica guardado.`)) return;
    try { await api('DELETE', `/api/contacts/${ct.id}/plan`); toast('Plano removido'); } catch (err) { toast(err.message, true); }
  }

  const planModal = { mode: 'assign', selected: null };
  async function loadPlans() { try { ({ plans: state.plans } = await api('GET', '/api/plans')); } catch { state.plans = []; } }
  function openPlanModal(mode) {
    const ct = state.contact;
    if (!ct) return;
    planModal.mode = mode;
    $('plan-title').textContent = mode === 'adjust' ? 'Ajustar plano' : (ct.plan_credits != null ? 'Trocar de plano' : 'Atribuir plano');
    $('plan-sub').textContent = (ct.name || ct.profile_name || formatPhone(ct.wa_id)) + (mode === 'assign' && ct.plan_credits != null ? ` · o saldo atual (${ct.plan_left}/${ct.plan_credits}) será substituído` : '');
    $('plan-assign').hidden = mode !== 'assign';
    $('plan-adjust').hidden = mode !== 'adjust';
    if (mode === 'assign') {
      const active = state.plans.filter((x) => x.active);
      planModal.selected = active.length ? active[0].id : 'custom';
      $('plan-c-name').value = ''; $('plan-c-credits').value = ''; $('plan-c-days').value = '';
      renderPlanOptions();
    } else {
      $('plan-a-credits').value = ct.plan_credits;
      $('plan-a-used').value = ct.plan_used;
      $('plan-a-expires').value = ct.plan_expires_at ? new Date(ct.plan_expires_at).toISOString().slice(0, 10) : '';
    }
    $('plan-modal').hidden = false;
  }
  function renderPlanOptions() {
    const active = state.plans.filter((x) => x.active);
    const price = (c) => (c == null ? '' : ` · R$ ${(c / 100).toFixed(2).replace('.', ',')}`);
    $('plan-options').innerHTML = active.map((x) => `<button type="button" class="plan-opt ${planModal.selected === x.id ? 'on' : ''}" data-plan-id="${x.id}"><b>${esc(x.name)}</b><span>${x.credits} consulta${x.credits === 1 ? '' : 's'}${x.validity_days ? ` · ${x.validity_days} dias` : ' · sem vencimento'}${price(x.price_cents)}</span></button>`).join('')
      + `<button type="button" class="plan-opt ${planModal.selected === 'custom' ? 'on' : ''}" data-plan-id="custom"><b>Personalizado</b><span>Defina nome, quantidade e validade</span></button>`;
    $('plan-custom').hidden = planModal.selected !== 'custom';
  }
  $('plan-options').addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan-id]');
    if (!b) return;
    planModal.selected = b.dataset.planId === 'custom' ? 'custom' : Number(b.dataset.planId);
    renderPlanOptions();
    if (planModal.selected === 'custom') $('plan-c-name').focus();
  });
  function closePlanModal() { $('plan-modal').hidden = true; }
  ['plan-cancel', 'plan-cancel-2'].forEach((id) => $(id).addEventListener('click', closePlanModal));
  $('plan-modal').addEventListener('click', (e) => { if (e.target === $('plan-modal')) closePlanModal(); });
  $('plan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ct = state.contact;
    if (!ct) return;
    $('plan-submit').disabled = true;
    try {
      if (planModal.mode === 'assign') {
        const body = planModal.selected === 'custom'
          ? { name: $('plan-c-name').value, credits: Number($('plan-c-credits').value), validity_days: $('plan-c-days').value ? Number($('plan-c-days').value) : null }
          : { plan_id: planModal.selected };
        const r = await api('PUT', `/api/contacts/${ct.id}/plan`, body);
        toast(`Plano ${r.contact.plan_name} atribuído`);
      } else {
        const exp = $('plan-a-expires').value;
        await api('PATCH', `/api/contacts/${ct.id}/plan`, { credits: Number($('plan-a-credits').value), used: Number($('plan-a-used').value), expires_at: exp ? new Date(exp + 'T23:59:59').toISOString() : null });
        toast('Plano ajustado');
      }
      closePlanModal();
    } catch (err) { toast(err.message, true); }
    finally { $('plan-submit').disabled = false; }
  });

  // ---- Consultas ----
  const consult = { kind: 'placa', contactId: null, conversationId: null };
  const DEFAULT_KINDS = ['Placa', 'Chassi', 'Motor', 'CRLV', 'CPF', 'CNPJ', 'Telefone', 'Nome completo'];
  function consultKinds() {
    const list = state.settings.consultation_kinds;
    return Array.isArray(list) && list.length ? list : DEFAULT_KINDS;
  }
  /** Escolhe o tipo configurado que corresponde ao nome (sem diferenciar maiúsculas); senão o primeiro da lista. */
  function matchKind(name) {
    const list = consultKinds();
    return list.find((k) => k.toLowerCase() === String(name || '').toLowerCase()) || list[0];
  }
  /**
   * Procura nas últimas mensagens do cliente algo consultável: placa, chassi, CNPJ, CPF, telefone ou motor.
   * Devolve { kind, ref } com o tipo já casado com a lista configurada.
   */
  function guessReference() {
    const has = (name) => consultKinds().some((k) => k.toLowerCase() === name.toLowerCase());
    for (let i = state.messages.length - 1, n = 0; i >= 0 && n < 30; i--, n++) {
      const m = state.messages[i];
      if (m.direction !== 'in' || !m.body || m.type === 'note') continue;
      const text = m.body;
      const up = text.toUpperCase();
      let x;
      if ((x = up.match(/\b([A-Z]{3})[\s-]?(\d[A-Z0-9]\d{2})\b/)) && has('Placa')) return { kind: matchKind('Placa'), ref: x[1] + x[2] };
      if ((x = up.match(/\b[A-HJ-NPR-Z0-9]{17}\b/)) && /\d/.test(x[0]) && /[A-Z]/.test(x[0]) && has('Chassi')) return { kind: matchKind('Chassi'), ref: x[0] };
      if ((x = up.match(/MOTOR\s*[:\-]?\s*([A-Z0-9][A-Z0-9-]{5,15})/)) && has('Motor')) return { kind: matchKind('Motor'), ref: x[1] };
      if ((x = text.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/)) && has('CNPJ')) return { kind: matchKind('CNPJ'), ref: x[0].replace(/\D/g, '') };
      if ((x = text.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/)) && has('CPF')) return { kind: matchKind('CPF'), ref: x[0].replace(/\D/g, '') };
      if ((x = text.match(/(?:\+?55\s*)?\(?\d{2}\)?\s*9?\s*\d{4}[\s-]\d{4}\b/)) && has('Telefone')) return { kind: matchKind('Telefone'), ref: x[0].replace(/\D/g, '') };
      if ((x = text.match(/\b\d{11}\b/))) {
        // 11 dígitos soltos: DDD válido + 9 na frente parece celular; senão trata como CPF
        const phone = /^[1-9]\d9/.test(x[0]);
        if (phone && has('Telefone')) return { kind: matchKind('Telefone'), ref: x[0] };
        if (!phone && has('CPF')) return { kind: matchKind('CPF'), ref: x[0] };
      }
      if ((x = text.match(/\b\d{10}\b/)) && has('Telefone')) return { kind: matchKind('Telefone'), ref: x[0] };
    }
    return { kind: consultKinds()[0], ref: '' };
  }
  function renderKindChips(selected) {
    $('consult-kinds').innerHTML = consultKinds().map((k) => `<button type="button" class="chip ${k === selected ? 'active' : ''}" data-kind="${esc(k)}">${esc(k)}</button>`).join('');
  }
  function openConsultModal(guess) {
    const c = current();
    if (!c) return;
    const kind = matchKind(guess && guess.kind);
    const prefillRef = (guess && guess.ref) || '';
    const ct = state.contact && state.contact.id === c.contact_id ? state.contact : c;
    consult.contactId = c.contact_id; consult.conversationId = c.id; consult.kind = kind;
    renderKindChips(kind);
    $('consult-ref').value = prefillRef;
    $('consult-note').value = '';
    const p = planState(ct);
    const cb = $('consult-charge');
    if (!p) { cb.checked = false; cb.disabled = true; $('consult-charge-label').textContent = 'Cliente sem plano: fica como consulta avulsa'; }
    else if (p.expired) { cb.checked = false; cb.disabled = true; $('consult-charge-label').textContent = 'Plano vencido: fica como consulta avulsa'; }
    else if (p.left === 0) { cb.checked = false; cb.disabled = true; $('consult-charge-label').textContent = 'Plano sem saldo: fica como consulta avulsa'; }
    else { cb.checked = true; cb.disabled = false; $('consult-charge-label').textContent = `Debitar 1 consulta do plano (saldo ${p.left}/${p.total})`; }
    $('consult-sub').textContent = `${contactName(c)} · ${p ? p.name : 'sem plano'}`;
    $('consult-price').value = '';
    $('consult-price-wrap').hidden = cb.checked;
    $('consult-modal').hidden = false;
    renderConsultRefStatus();
    $('consult-ref').focus();
  }
  function closeConsultModal() { $('consult-modal').hidden = true; }
  $('consult-charge').addEventListener('change', () => { $('consult-price-wrap').hidden = $('consult-charge').checked; });
  $('consult-kinds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    consult.kind = b.dataset.kind;
    document.querySelectorAll('#consult-kinds .chip').forEach((x) => x.classList.toggle('active', x === b));
    renderConsultRefStatus();
  });
  ['consult-cancel', 'consult-cancel-2'].forEach((id) => $(id).addEventListener('click', closeConsultModal));
  $('consult-modal').addEventListener('click', (e) => { if (e.target === $('consult-modal')) closeConsultModal(); });
  $('consult-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('consult-submit').disabled = true;
    try {
      const r = await api('POST', `/api/contacts/${consult.contactId}/consultations`, {
        conversation_id: consult.conversationId, kind: consult.kind, reference: $('consult-ref').value,
        charge: $('consult-charge').checked, note: $('consult-note').value,
        price_cents: !$('consult-charge').checked && $('consult-price').value ? Math.round(Number($('consult-price').value) * 100) : null,
      });
      const p = planState(r.contact);
      toast(p && r.consultation.charged ? `Consulta registrada · saldo ${p.left}/${p.total}` : 'Consulta avulsa registrada');
      closeConsultModal();
    } catch (err) { toast(err.message, true); }
    finally { $('consult-submit').disabled = false; }
  });
  $('btn-consult').addEventListener('click', () => openConsultModal(guessReference()));

  // Depois de enviar um PDF para cliente com plano, oferece o débito com um clique
  let debitTimer = null;
  function offerDebit(file) {
    const c = current();
    if (!c || !file) return;
    const isDoc = /pdf/i.test(file.type || '') || /\.pdf$/i.test(file.name || '');
    const p = planState(state.contact && state.contact.id === c.contact_id ? state.contact : c);
    if (!isDoc || !p || p.expired || p.left === 0) return;
    $('debit-text').innerHTML = `Documento enviado. Debitar 1 consulta do plano de <b>${esc(contactName(c))}</b>? <span class="muted">(saldo ${p.left}/${p.total})</span>`;
    const guess = guessReference();
    $('debit-kinds').innerHTML = consultKinds().map((k) => `<button type="button" class="btn btn-sm ${k === guess.kind ? 'btn-primary' : ''}" data-kind="${esc(k)}">${esc(k)}</button>`).join('') + '<button type="button" class="btn btn-sm btn-ghost" id="debit-no">Não debitar</button>';
    $('debit-prompt').dataset.ref = guess.ref || '';
    $('debit-prompt').dataset.conv = c.id;
    $('debit-prompt').hidden = false;
    clearTimeout(debitTimer);
    debitTimer = setTimeout(() => { $('debit-prompt').hidden = true; }, 120000);
  }
  $('debit-prompt').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const convId = Number($('debit-prompt').dataset.conv);
    $('debit-prompt').hidden = true;
    if (b.id === 'debit-no') return;
    const c = state.conversations.find((x) => x.id === convId) || (state.currentConv && state.currentConv.id === convId ? state.currentConv : null);
    if (!c) return;
    try {
      const r = await api('POST', `/api/contacts/${c.contact_id}/consultations`, { conversation_id: convId, kind: b.dataset.kind, reference: $('debit-prompt').dataset.ref || '', charge: true });
      const p = planState(r.contact);
      toast(`Consulta debitada · saldo ${p.left}/${p.total}`);
    } catch (err) { toast(err.message, true); }
  });

  // Aviso no chat quando o plano zerou ou venceu
  function renderPlanHint() {
    const c = current();
    const box = $('plan-hint');
    const p = planState(c);
    if (!c || !p || c.status !== 'open' || (p.left > 0 && !p.expired)) { box.hidden = true; return; }
    const why = p.expired ? 'O plano deste cliente venceu' : 'O plano deste cliente não tem mais consultas';
    const hasReply = state.quickReplies.some((q) => q.shortcut === 'renovar');
    box.innerHTML = `${PLAN_ICON}<span>${esc(why)} (${esc(p.name)}).</span><span class="spacer"></span>${hasReply ? '<button type="button" class="btn btn-sm" data-hint="reply">Sugerir renovação</button>' : ''}<button type="button" class="btn btn-sm btn-primary" data-hint="renew">Renovar plano</button>`;
    box.hidden = false;
  }
  $('plan-hint').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hint]');
    const c = current();
    if (!b || !c) return;
    if (b.dataset.hint === 'reply') { const q = state.quickReplies.find((x) => x.shortcut === 'renovar'); if (q) { setComposeMode('message'); applyQuick(q.id); } }
    else renewPlan({ id: c.contact_id, plan_name: c.plan_name, plan_credits: c.plan_credits });
  });

  // ---- Observações, consultas e log (carregados ao abrir) ----
  els.details.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dtoggle]');
    if (!b) return;
    const key = b.dataset.dtoggle;
    dOpen[key] = !dOpen[key];
    b.classList.toggle('open', dOpen[key]);
    $(key).hidden = !dOpen[key];
    if (dOpen[key]) loadSub(key);
  });
  async function loadSub(key) {
    const ct = state.contact;
    if (!ct) return;
    const box = $(key);
    try {
      if (key === 'd-notes') {
        const { notes } = await api('GET', `/api/contacts/${ct.id}/notes`);
        const mine = (n) => n.user_id === state.me.id || state.me.role === 'admin';
        box.innerHTML = `<form class="d-note-form" id="d-note-form"><textarea class="textarea" id="d-note-body" rows="2" maxlength="2000" placeholder="Fixar uma observação sobre este cliente (todos os atendentes veem)"></textarea><button type="submit" class="btn btn-sm btn-primary">Fixar observação</button></form>`
          + (notes.length ? notes.map((n) => `<div class="d-item obs" data-note="${n.id}">
              <div class="d-item-top"><b>${esc(n.user_name || 'Sistema')}</b><span>${esc(fmtTime(n.created_at))}${n.updated_at && n.updated_at !== n.created_at ? ' · editada' : ''}</span></div>
              <div class="d-item-body">${esc(n.body)}</div>
              ${mine(n) ? `<div class="d-item-acts"><button type="button" class="d-item-act" data-note-edit="${n.id}">Editar</button><button type="button" class="d-item-act" data-note-del="${n.id}">Remover</button></div>` : ''}
            </div>`).join('') : '<div class="d-empty">Nenhuma observação fixada. Use o campo acima ou o alfinete de uma nota interna.</div>');
      } else if (key === 'd-purchases') {
        const { purchases } = await api('GET', `/api/contacts/${ct.id}/purchases`);
        const admin = state.me.role === 'admin';
        box.innerHTML = `<form class="d-note-form" id="d-purchase-form"><div class="grid-2" style="gap:6px;margin:0"><input class="input" id="d-pur-desc" placeholder="Compra (ex.: Plano 5 consultas)" maxlength="120" required><input class="input" id="d-pur-credits" type="number" min="0" max="10000" placeholder="Consultas" required></div><div class="grid-2" style="gap:6px;margin:0"><input class="input" id="d-pur-price" type="number" min="0" step="0.01" placeholder="Valor R$ (opcional)"><input class="input" id="d-pur-date" type="date" title="Data da compra (vazio = hoje)"></div><button type="submit" class="btn btn-sm">Registrar compra antiga (não mexe no saldo)</button></form>`
          + (purchases.length ? purchases.map((p) => `<div class="d-item obs buy" data-purchase="${p.id}">
              <div class="d-item-top"><b>${esc(p.description)}</b><span>${esc(new Date(p.created_at).toLocaleDateString('pt-BR'))}</span></div>
              <div class="d-item-body">${p.credits} consulta${p.credits === 1 ? '' : 's'}${p.price_cents != null ? ' · ' + money(p.price_cents) : ' · <i>sem valor</i>'}${p.user_name ? ' · ' + esc(p.user_name) : ''}${p.note ? ' · ' + esc(p.note) : ''}</div>
              <div class="d-item-acts"><button type="button" class="d-item-act" data-pur-price="${p.id}">${p.price_cents != null ? 'Alterar valor' : 'Informar valor'}</button>${admin ? `<button type="button" class="d-item-act" data-pur-del="${p.id}">Remover</button>` : ''}</div>
            </div>`).join('') : '<div class="d-empty">Nenhuma compra. Planos atribuídos ou renovados entram aqui automaticamente.</div>');
      } else if (key === 'd-consults') {
        const { consultations } = await api('GET', `/api/contacts/${ct.id}/consultations`);
        box.innerHTML = consultations.length ? consultations.map((k) => `<div class="d-item ${k.reversed_at ? 'reversed' : ''}">
            <div class="d-item-top"><b>${esc(k.kind_label)}${k.reference ? ' ' + esc(k.reference) : ''}</b><span>${esc(fmtTime(k.created_at))}</span></div>
            <div class="d-item-body">${esc(k.user_name || '')} · ${k.charged ? 'debitada do plano' : 'avulsa'}${k.note ? ' · ' + esc(k.note) : ''}${k.reversed_at ? ` · estornada por ${esc(k.reversed_by_name || '')}` : ''}</div>
            ${k.reversed_at ? '' : `<button type="button" class="d-item-act" data-reverse="${k.id}">Estornar</button>`}
          </div>`).join('') : '<div class="d-empty">Nenhuma consulta registrada.</div>';
      } else if (key === 'd-log') {
        const { events } = await api('GET', `/api/contacts/${ct.id}/events`);
        box.innerHTML = events.length ? events.map((ev) => `<div class="d-item log ${esc(ev.type)}"><div class="d-item-body">${esc(ev.description)}</div><div class="d-item-top"><span>${esc(fmtTime(ev.created_at))}</span></div></div>`).join('')
          : '<div class="d-empty">Nada registrado ainda.</div>';
      }
    } catch (err) { box.innerHTML = `<div class="d-empty">${esc(err.message)}</div>`; }
  }
  $('d-consults').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-reverse]');
    if (!b || !state.contact) return;
    if (!confirm('Estornar esta consulta? Se foi debitada do plano, o crédito volta.')) return;
    try { await api('DELETE', `/api/contacts/${state.contact.id}/consultations/${b.dataset.reverse}`); toast('Consulta estornada'); }
    catch (err) { toast(err.message, true); }
  });
  $('d-notes').addEventListener('submit', async (e) => {
    if (e.target.id !== 'd-note-form' || !state.contact) return;
    e.preventDefault();
    const body = $('d-note-body').value.trim();
    if (!body) return;
    try { await api('POST', `/api/contacts/${state.contact.id}/notes`, { body }); toast('Observação fixada'); }
    catch (err) { toast(err.message, true); }
  });
  $('d-notes').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-note-del]');
    const ed = e.target.closest('[data-note-edit]');
    if (!state.contact || (!del && !ed)) return;
    try {
      if (del) {
        if (!confirm('Remover esta observação da ficha?')) return;
        await api('DELETE', `/api/contacts/${state.contact.id}/notes/${del.dataset.noteDel}`);
        toast('Observação removida');
      } else {
        const item = ed.closest('.d-item');
        const body = prompt('Editar observação:', item.querySelector('.d-item-body').textContent);
        if (body === null) return;
        await api('PATCH', `/api/contacts/${state.contact.id}/notes/${ed.dataset.noteEdit}`, { body });
        toast('Observação atualizada');
      }
    } catch (err) { toast(err.message, true); }
  });
  async function pinNoteToContact(m) {
    const c = current();
    if (!c || !m.body) return;
    try {
      await api('POST', `/api/contacts/${c.contact_id}/notes`, { body: m.body });
      toast('Nota fixada na ficha do contato');
      if (!dOpen['d-notes']) document.querySelector('[data-dtoggle="d-notes"]').click();
    } catch (err) { toast(err.message, true); }
  }
  $('d-purchases').addEventListener('submit', async (e) => {
    if (e.target.id !== 'd-purchase-form' || !state.contact) return;
    e.preventDefault();
    const price = $('d-pur-price').value;
    const date = $('d-pur-date').value;
    try {
      await api('POST', `/api/contacts/${state.contact.id}/purchases`, { description: $('d-pur-desc').value, credits: Number($('d-pur-credits').value), price_cents: price ? Math.round(Number(price) * 100) : null, created_at: date ? new Date(date + 'T12:00:00').toISOString() : null });
      toast('Compra registrada');
    } catch (err) { toast(err.message, true); }
  });
  $('d-purchases').addEventListener('click', async (e) => {
    const pr = e.target.closest('[data-pur-price]');
    const del = e.target.closest('[data-pur-del]');
    if (!state.contact || (!pr && !del)) return;
    try {
      if (del) {
        if (!confirm('Remover esta compra do histórico?')) return;
        await api('DELETE', `/api/contacts/${state.contact.id}/purchases/${del.dataset.purDel}`);
        toast('Compra removida');
      } else {
        const v = prompt('Valor da compra (R$):', '');
        if (v === null) return;
        const n = Number(String(v).replace(',', '.'));
        if (!Number.isFinite(n) || n < 0) return toast('Valor inválido', true);
        await api('PATCH', `/api/contacts/${state.contact.id}/purchases/${pr.dataset.purPrice}`, { price_cents: Math.round(n * 100) });
        toast('Valor salvo');
      }
    } catch (err) { toast(err.message, true); }
  });
  function refreshContactSubs() { for (const k of Object.keys(dOpen)) if (dOpen[k]) loadSub(k); }

  // ---------- Visualizador de mídia (lightbox) ----------
  const lb = { items: [], idx: -1, zoom: 1, rot: 0, flip: false }; // rot em graus (0/90/180/270), flip = espelhado
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
    lb.zoom = 1; lb.rot = 0; lb.flip = false;
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
    $('lb-rotate-left').hidden = isVideo || isDoc;
    $('lb-rotate-right').hidden = isVideo || isDoc;
    $('lb-flip').hidden = isVideo || isDoc;
    applyImageTransform(); // zera giro/espelho/zoom da imagem anterior
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
    lb.zoom = Math.min(4, Math.max(1, z));
    applyImageTransform();
  }
  /** Gira em passos de 90° (foto de chassi/motor costuma vir de lado). */
  function rotateImage(dir) {
    lb.rot = (lb.rot + dir * 90 + 360) % 360;
    applyImageTransform();
  }
  function flipImage() {
    lb.flip = !lb.flip;
    applyImageTransform();
  }
  /** Zoom, giro e espelho no mesmo transform; deitada (90/270), a imagem passa a caber pela altura do palco. */
  function applyImageTransform() {
    const img = $('lb-img');
    if (!img) return;
    const stage = $('lb-stage');
    const sideways = lb.rot === 90 || lb.rot === 270;
    img.classList.toggle('zoomed', lb.zoom > 1);
    img.classList.toggle('sideways', sideways);
    if (sideways && lb.zoom <= 1) {
      img.style.maxWidth = `${stage.clientHeight - 16}px`;
      img.style.maxHeight = `${stage.clientWidth - 160}px`;
    } else { img.style.maxWidth = ''; img.style.maxHeight = ''; }
    const parts = [];
    if (lb.zoom > 1) parts.push(`scale(${lb.zoom})`);
    if (lb.rot) parts.push(`rotate(${lb.rot}deg)`);
    if (lb.flip) parts.push('scaleX(-1)');
    img.style.transform = parts.join(' ');
    img.style.transformOrigin = 'center';
    img.dataset.rot = lb.rot;
    img.dataset.flip = lb.flip ? '1' : '0';
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
  $('lb-rotate-left').addEventListener('click', () => rotateImage(-1));
  $('lb-rotate-right').addEventListener('click', () => rotateImage(1));
  $('lb-flip').addEventListener('click', flipImage);
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
    else if (e.key === 'r' || e.key === 'R') rotateImage(e.shiftKey ? -1 : 1);
    else if (e.key === 'f' || e.key === 'F') flipImage();
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
    SOS.sound.applyOutputTo(a);
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
  // Vários anexos de uma vez: cada um vira uma mensagem; a legenda vai só no primeiro
  const attach = { files: [] }; // [{ file, url }]
  const ATTACH_MAX = 10;
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
  Object.values(attachInputs).forEach((inp) => inp.addEventListener('change', () => { if (inp.files.length) addAttachments([...inp.files]); }));

  const sendLabel = () => (attach.files.length > 1 ? `Enviar ${attach.files.length} arquivos` : 'Enviar arquivo');
  /** Acrescenta arquivos à lista de anexos (não substitui os que já estão lá). */
  function addAttachments(files) {
    if (state.composeMode === 'note') { toast('Anexos só em mensagens, não em notas', true); return; }
    let added = 0;
    for (const file of files) {
      if (file.size > MEDIA_MAX) { toast(`${file.name}: acima de 25 MB`, true); continue; }
      if (attach.files.length >= ATTACH_MAX) { toast(`No máximo ${ATTACH_MAX} anexos por vez`, true); break; }
      attach.files.push({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
      added++;
    }
    if (!added) return;
    renderAttachments();
    els.composeText.focus();
  }
  function setAttachment(file) { addAttachments([file]); }
  function removeAttachment(i) {
    const it = attach.files[i];
    if (!it) return;
    if (it.url) URL.revokeObjectURL(it.url);
    attach.files.splice(i, 1);
    renderAttachments();
  }
  function renderAttachments() {
    const p = $('attach-preview');
    if (!attach.files.length) {
      p.hidden = true; p.innerHTML = '';
      if (state.composeMode !== 'note') { els.composeText.placeholder = 'Digite sua mensagem ou arraste um arquivo…'; els.composeSend.textContent = 'Enviar'; }
      return;
    }
    const total = attach.files.reduce((n, a) => n + a.file.size, 0);
    p.innerHTML = `<div class="att-list">${attach.files.map((a, i) => `<div class="att-item" title="${esc(a.file.name)} · ${esc(SOS.fmtBytes(a.file.size))}">
        ${a.url ? `<img src="${a.url}" alt="">` : `<span class="ic">${a.file.type.startsWith('video/') ? '🎬' : a.file.type.startsWith('audio/') ? '🎵' : '📎'}</span>`}
        <span class="att-name">${esc(a.file.name)}</span>
        <button type="button" class="att-remove" data-att-remove="${i}" title="Remover">✕</button></div>`).join('')}</div>
      <div class="att-foot"><span class="size">${attach.files.length === 1 ? '1 anexo' : attach.files.length + ' anexos'} · ${esc(SOS.fmtBytes(total))}${attach.files.length > 1 ? ' · a legenda vai com o primeiro' : ''}</span>
        <button type="button" class="btn btn-sm btn-ghost" data-att-add>+ Adicionar</button>
        <button type="button" class="btn btn-sm btn-ghost" data-att-clear>Limpar</button></div>`;
    p.hidden = false;
    els.composeText.placeholder = 'Legenda (opcional)…';
    els.composeSend.textContent = sendLabel();
  }
  $('attach-preview').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-att-remove]');
    if (rm) { removeAttachment(Number(rm.dataset.attRemove)); return; }
    if (e.target.closest('[data-att-clear]')) { clearAttachment(); return; }
    if (e.target.closest('[data-att-add]')) { attachInputs.doc.value = ''; attachInputs.doc.click(); }
  });
  function clearAttachment() {
    for (const a of attach.files) if (a.url) URL.revokeObjectURL(a.url);
    attach.files = [];
    renderAttachments();
  }
  /** Envia os anexos em ordem, um por mensagem; legenda e citação só no primeiro. Se um falhar, os restantes ficam na lista. */
  async function sendAttachment(id, caption) {
    const list = [...attach.files];
    const total = list.length;
    els.composeSend.disabled = true;
    let sent = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        els.composeSend.textContent = total > 1 ? `Enviando ${i + 1}/${total}…` : 'Enviando…';
        const fd = new FormData();
        fd.append('file', list[i].file, list[i].file.name);
        const cap = i === 0 ? caption : '';
        fd.append('caption', els.signToggle.checked && cap ? `*${signText()}:*\n${cap}` : cap);
        if (i === 0 && state.reply) fd.append('quoted_message_id', state.reply.id);
        await SOS.upload(`/api/conversations/${id}/media`, fd);
        sent++;
        removeAttachment(attach.files.indexOf(list[i]));
        if (i === 0) { clearReply(); els.composeText.value = ''; autosize(); }
      }
      offerDebit(list[0].file);
    } catch (err) {
      toast(total > 1 ? `${err.message} (${sent} de ${total} enviados; os outros continuam na lista)` : err.message, true);
      renderAttachments();
    } finally {
      els.composeSend.disabled = false;
      if (!attach.files.length && state.composeMode !== 'note') els.composeSend.textContent = 'Enviar';
      els.composeText.focus();
    }
  }
  // Arrastar para o compositor e colar imagem (Ctrl+V)
  ['dragenter', 'dragover'].forEach((ev) => els.composer.addEventListener(ev, (e) => {
    if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); els.composer.classList.add('dragover'); }
  }));
  ['dragleave', 'drop'].forEach((ev) => els.composer.addEventListener(ev, () => els.composer.classList.remove('dragover')));
  els.composer.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { e.preventDefault(); addAttachments(files); }
  });
  els.composeText.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addAttachments(files); }
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
  // ---------- Conferência de chassi, placa, Renavam, CPF e CNPJ ----------
  state.readings = new Map(); // message id -> leitura da foto
  const refDismissed = new Map(); // conversa -> id da última mensagem cujo aviso o atendente fechou (esconde tudo até ali)
  const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const WARN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  /** Cartão de um veículo encontrado. `ref` é o dado a enviar; `original` é o dado errado que o cliente mandou (correção). */
  function foundCardHtml(v, ref, kind, { original = null, reload = null, sent = false } = {}) {
    const f = v.data.fields || {};
    const bits = [
      f.ano ? `Ano ${f.ano}${f.ano_modelo && f.ano_modelo !== f.ano ? '/' + f.ano_modelo : ''}` : '',
      f.cor, f.combustivel, f.potencia, f.municipio ? `${f.municipio}/${f.uf || ''}` : f.uf,
      kind === 'chassi' ? (f.placa ? `placa ${f.placa}` : '') : (f.chassi ? `chassi ${f.chassi}` : ''),
    ].filter(Boolean);
    const fix = original ? `<div class="veh-fix">Chassi <code>${diffHtml(original, ref)}</code> <button type="button" class="btn btn-xs btn-ghost" data-ref-copy="${esc(ref)}" title="Copiar ${esc(ref)}">Copiar</button></div>` : '';
    return `<div class="veh-card${original ? ' alt' : ''}">
      <span class="veh-ic">🚗</span>
      <div class="veh-info"><div class="veh-title">${esc(f.marca || '')} ${esc(f.modelo || '')}</div><div class="veh-meta">${esc(bits.join(' · '))}</div>${fix}
        ${sent ? `<div class="veh-sent">Confirmação enviada ao cliente ${esc(sinceText(v.sent_at))}${v.mode === 'auto' ? ' (automático)' : ''}</div>` : ''}</div>
      <button type="button" class="btn btn-sm ${sent ? '' : 'btn-primary'}" data-veh-send="${esc(ref)}" data-veh-kind="${kind}" data-veh-original="${esc(original || '')}" data-veh-reload="${esc(reload || ref)}" title="${original ? 'Manda a mensagem dizendo que o dado enviado não existe e mostrando o veículo da correção' : 'Manda a mensagem com os dados do veículo pedindo confirmação'}">${sent ? 'Enviar de novo' : 'Enviar para o cliente confirmar'}</button>
    </div>`;
  }
  /** Marca em destaque os caracteres que mudaram entre o dado enviado e a correção. */
  function diffHtml(from, to) {
    if (from.length !== to.length) return esc(to);
    return [...to].map((ch, i) => (ch === from[i] ? esc(ch) : `<b class="diff">${esc(ch)}</b>`)).join('');
  }
  /** Cartão com os dados básicos do veículo pela placa (busca no site quando ainda não tem). */
  function vehicleCardHtml(plate, kind = 'placa') {
    const c = current();
    const v = state.vehicles.get(kind + ':' + plate);
    if (!v) { loadVehicle(plate, false, kind); return '<div class="veh-card loading">Buscando dados do veículo…</div>'; }
    if (v === 'loading') return '<div class="veh-card loading">Buscando dados do veículo…</div>';
    if (v.status === 'not_found') return `<div class="veh-card none">Placa ${esc(plate)} não encontrada na base de consulta. Confira com o cliente ou siga direto para a consulta completa.</div>`;
    if (v.status !== 'found') return `<div class="veh-card none">${esc(v.error || 'Não foi possível buscar o veículo agora.')} <button type="button" class="btn btn-sm btn-ghost" data-veh-retry="${esc(plate)}" data-veh-kind="${kind}">Tentar de novo</button></div>`;
    return foundCardHtml(v, plate, kind, { sent: v.sent_at && c && v.conversation_id === c.id });
  }
  /**
   * Chassi: conferência e busca no mesmo cartão. Se o chassi não existir, mostra as correções
   * prováveis que existem na base, cada uma com o botão de enviar ao cliente.
   */
  function chassiCardHtml(r, i) {
    const c = current();
    const key = 'chassi:' + r.value;
    const v = state.vehicles.get(key);
    if (!v) { loadVehicle(r.value, false, 'chassi', true, r.alternativas || []); return '<div class="veh-card loading">Conferindo o chassi…</div>'; }
    if (v === 'loading') return '<div class="veh-card loading">Conferindo o chassi…</div>';
    const mine = (x) => Boolean(x && x.sent_at && c && v.conversation_id === c.id);
    if (v.lookup && v.lookup.status === 'found') return foundCardHtml(v.lookup, r.value, 'chassi', { sent: mine(v.lookup) });
    if (v.alternatives && v.alternatives.length) {
      return `<div class="veh-alts"><div class="veh-head">Chassi <b>${esc(r.value)}</b> não existe na base. ${v.alternatives.length === 1 ? 'Provavelmente é este veículo:' : 'Pode ser um destes:'}</div>
        ${v.alternatives.map((a) => foundCardHtml(a, a.ref, 'chassi', { original: r.value, reload: r.value, sent: mine(a) })).join('')}</div>`;
    }
    if (v.status === 'error' || (v.lookup && v.lookup.status === 'error')) {
      return `<div class="veh-card none">${esc(v.error || (v.lookup && v.lookup.error) || 'Não foi possível buscar o veículo agora.')} <button type="button" class="btn btn-sm btn-ghost" data-veh-retry="${esc(r.value)}" data-veh-kind="chassi">Tentar de novo</button></div>`;
    }
    const tested = v.tested && v.tested.length ? ` Também testei ${v.tested.map((t) => `<code>${esc(t)}</code>`).join(', ')}: nada.` : '';
    return `<div class="veh-card none">Chassi ${esc(r.value)} não encontrado na base de consulta.${tested} O melhor é pedir para o cliente conferir no documento.
      <button type="button" class="btn btn-sm btn-primary" data-ref-ask="${i}" title="Preenche a mensagem pedindo para o cliente conferir">Pedir para conferir</button></div>`;
  }
  /** Resultado da conferência do chassi na base, para decidir a cor do aviso. */
  function chassiOutcome(r) {
    const v = state.vehicles.get('chassi:' + r.value);
    if (!v || v === 'loading') return 'pending';
    if (v.lookup && v.lookup.status === 'found') return 'found';
    if (v.alternatives && v.alternatives.length) return 'fixed';
    if (v.status === 'error' || (v.lookup && v.lookup.status === 'error')) return 'error';
    return 'missing';
  }
  async function loadVehicle(plate, force = false, kind = 'placa', resolve = false, extra = []) {
    const c = current();
    const key = kind + ':' + plate;
    state.vehicles.set(key, 'loading');
    try {
      const v = await api('GET', `/api/vehicles/${encodeURIComponent(plate)}${resolve ? '/resolve' : ''}?kind=${kind}&conversation=${c ? c.id : ''}${force ? '&force=1' : ''}${extra.length ? '&extra=' + encodeURIComponent(extra.join(',')) : ''}`);
      state.vehicles.set(key, { ...v, conversation_id: c ? c.id : null });
    } catch (err) {
      state.vehicles.set(key, { status: 'error', error: err.message });
    }
    renderRefHint();
  }
  async function sendVehiclePreview(ref, kind = 'placa', original = '', reload = '') {
    const c = current();
    if (!c) return;
    const v = state.vehicles.get(kind + ':' + (reload || ref));
    const already = v && (v.sent_at || (v.lookup && v.lookup.sent_at) || (v.alternatives || []).some((a) => a.ref === ref && a.sent_at));
    if (already && !confirm('A confirmação já foi enviada para este cliente. Enviar de novo?')) return;
    try {
      await api('POST', `/api/vehicles/${encodeURIComponent(ref)}/send`, { conversation_id: c.id, kind, original: original || null });
      toast(original ? 'Correção do chassi enviada para o cliente confirmar' : 'Dados do veículo enviados para o cliente confirmar');
      await loadVehicle(reload || ref, false, kind, kind === 'chassi');
    } catch (err) { toast(err.message, true); }
  }
  /** Copia o dado para a área de transferência (a pré-consulta é feita fora do chat). */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* sem suporte */ }
      ta.remove();
    }
    toast(`Copiado: ${text}`);
  }
  /** Última mensagem do cliente que contém algo consultável (chassi, placa...), já validado. */
  function latestReferences() {
    if (!window.RefCheck) return null;
    const imgMode = state.settings.image_read_mode || 'auto';
    const inbound = state.messages.filter((m) => m.direction === 'in' && !m.deleted_at && ((m.type === 'text' && m.body) || (m.type === 'image' && m.media_id && imgMode !== 'off')) && m.id > (refDismissed.get(m.conversation_id) || 0)).slice(-8).reverse();
    for (const m of inbound) {
      if (m.type === 'image') {
        const rd = state.readings.get(m.id);
        if (!rd) { if (imgMode === 'manual') return { message: m, image: 'unread', list: [] }; continue; }
        if (rd.status === 'pending') return { message: m, image: 'pending', list: [] };
        if (rd.status === 'error') return { message: m, image: 'error', error: rd.error, list: [] };
        const list = readingRefs(rd);
        if (list.length) return { message: m, image: 'done', list: list.slice(0, 3) };
        continue; // foto sem numeração: olha a mensagem anterior
      }
      const list = RefCheck.detect(m.body);
      if (list.length) return { message: m, list: list.slice(0, 2) };
    }
    return null;
  }
  /** Itens lidos de uma foto viram referências como as digitadas (validadas), marcadas como vindas da foto. */
  function readingRefs(rd) {
    return (rd.items || []).map((it) => {
      const fn = it.kind === 'motor' ? null : RefCheck.validatorFor(it.kind);
      const base = fn ? fn(it.value) : { kind: 'motor', label: 'Motor', value: String(it.value || '').toUpperCase(), ok: !/\?/.test(it.value), errors: /\?/.test(it.value) ? ['parte ilegível na foto'] : [], warnings: [], suggestions: [] };
      const suggestions = [...new Set([...(base.suggestions || []), ...(it.alternativas || [])])].slice(0, 4);
      return { ...base, raw: it.value, suggestions, fromImage: true, confidence: it.confidence, alternativas: it.alternativas || [], observacao: it.observacao || '' };
    }).filter((r) => r.value);
  }
  const CONF_LABEL = { alta: 'confiança alta', media: 'confiança média', baixa: 'confiança baixa' };
  /** Prefixo dos avisos de dado lido de foto. */
  function fromImageHtml(r) {
    if (!r.fromImage) return '';
    return `<span class="ref-photo" title="Numeração lida automaticamente da foto enviada pelo cliente">📷 lido da foto · ${CONF_LABEL[r.confidence] || 'confiança média'}${r.observacao ? ' · ' + esc(r.observacao) : ''}</span> `;
  }
  async function readImage(messageId) {
    const c = current();
    state.readings.set(messageId, { message_id: messageId, status: 'pending', items: [] });
    renderRefHint();
    try {
      const { reading } = await api('POST', `/api/readings/${messageId}`);
      state.readings.set(messageId, reading);
    } catch (err) {
      state.readings.set(messageId, { message_id: messageId, status: 'error', items: [], error: err.message });
      toast(err.message, true);
    }
    if (current() === c) renderRefHint();
  }
  function renderRefHint() {
    const c = current();
    const box = $('ref-hint');
    const found = c ? latestReferences() : null;
    if (!found) { box.hidden = true; return; }
    box.dataset.msg = found.message.id;
    if (found.image && found.image !== 'done') {
      const mid = found.message.id;
      box.className = `ref-hint ${found.image === 'error' ? 'bad' : 'good'}`;
      box.innerHTML = (found.image === 'pending'
        ? `<div class="ref-row"><span class="ref-ic ok">📷</span><span class="ref-text">Lendo a numeração da foto…</span></div>`
        : found.image === 'error'
          ? `<div class="ref-row"><span class="ref-ic bad">${WARN_ICON}</span><span class="ref-text">${esc(found.error || 'Não consegui ler a foto')}</span><button type="button" class="btn btn-sm" data-read-image="${mid}">Tentar de novo</button></div>`
          : `<div class="ref-row"><span class="ref-ic ok">📷</span><span class="ref-text">Foto recebida do cliente</span><button type="button" class="btn btn-sm btn-primary" data-read-image="${mid}" title="Lê placa, chassi ou motor na foto">Ler numeração</button></div>`)
        + '<button type="button" class="icon-btn ref-close" id="ref-close" title="Fechar aviso">✕</button>';
      box.hidden = false;
      return;
    }
    const lookupOn = state.settings.vehicle_lookup_mode !== 'off';
    const anyBad = found.list.some((r) => !r.ok || (lookupOn && r.kind === 'chassi' && ['missing', 'fixed'].includes(chassiOutcome(r))));
    box.className = `ref-hint ${anyBad ? 'bad' : 'good'}`;
    box.innerHTML = found.list.map((r, i) => {
      const shown = r.display || r.value;
      const photo = fromImageHtml(r);
      // chassi com pré-consulta ligada: conferência e busca no mesmo bloco
      if (lookupOn && r.kind === 'chassi') {
        const outcome = chassiOutcome(r);
        const card = chassiCardHtml(r, i);
        let head;
        if (!r.ok) head = `<span class="ref-ic bad">${WARN_ICON}</span><span class="ref-text">${photo}<b>Chassi ${esc(r.raw || shown)}</b> parece errado: ${esc(r.errors.join('; '))}</span>`;
        else if (outcome === 'missing') head = `<span class="ref-ic bad">${WARN_ICON}</span><span class="ref-text">${photo}<b>Chassi ${esc(shown)}</b> tem o formato certo, mas não existe na base de consulta</span>`;
        else head = `<span class="ref-ic ok">${CHECK_ICON}</span><span class="ref-text">${photo}<b>Chassi ${esc(shown)}</b> ${outcome === 'found' ? 'confere: veículo encontrado' : 'parece correto'}${r.warnings[0] && outcome !== 'found' ? ` <span class="muted">(${esc(r.warnings[0])})</span>` : ''}</span>`;
        const actions = r.ok
          ? `<button type="button" class="btn btn-sm ${outcome === 'fixed' || outcome === 'missing' ? '' : 'btn-primary'}" data-ref-copy="${esc(shown)}" title="Copia para você fazer a pré-consulta">Copiar</button>
             <button type="button" class="btn btn-sm btn-ghost" data-ref-use="${i}" title="Só depois do pagamento, na hora de entregar a consulta">Registrar consulta</button>`
          : (outcome === 'fixed' || outcome === 'missing' ? '' : `<button type="button" class="btn btn-sm" data-ref-ask="${i}" title="Preenche a mensagem pedindo para o cliente conferir">Pedir para conferir</button>`);
        const reread = r.fromImage && i === 0 ? `<button type="button" class="btn btn-sm btn-ghost" data-read-image="${found.message.id}" title="Lê a foto de novo">Ler de novo</button>` : '';
        return `<div class="ref-row">${head}${actions}${reread}</div>${card}`;
      }
      const reread = r.fromImage && i === 0 ? `<button type="button" class="btn btn-sm btn-ghost" data-read-image="${found.message.id}" title="Lê a foto de novo">Ler de novo</button>` : '';
      if (r.ok) {
        const warn = r.warnings[0] ? ` <span class="muted">(${esc(r.warnings[0])})</span>` : '';
        const vehicle = r.kind === 'placa' && lookupOn ? vehicleCardHtml(r.value, r.kind) : '';
        return `<div class="ref-row"><span class="ref-ic ok">${CHECK_ICON}</span><span class="ref-text">${photo}<b>${esc(r.label)} ${esc(shown)}</b> parece correto${warn}</span>
          <button type="button" class="btn btn-sm btn-primary" data-ref-copy="${esc(shown)}" title="Copia para você fazer a pré-consulta">Copiar</button>
          <button type="button" class="btn btn-sm btn-ghost" data-ref-use="${i}" title="Só depois do pagamento, na hora de entregar a consulta">Registrar consulta</button>${reread}</div>${vehicle}`;
      }
      const sug = r.suggestions.length
        ? `<span class="ref-sug">Tentar: ${r.suggestions.map((v) => `<button type="button" class="chip" data-ref-copy="${esc(v)}" title="Copiar ${esc(v)} para a pré-consulta">${esc(v)}</button>`).join('')}</span>`
        : '';
      return `<div class="ref-row"><span class="ref-ic bad">${WARN_ICON}</span><span class="ref-text">${photo}<b>${esc(r.label)} ${esc(r.raw || shown)}</b> parece errado: ${esc(r.errors.join('; '))}</span>
        ${sug}<button type="button" class="btn btn-sm" data-ref-ask="${i}" title="Preenche a mensagem pedindo para o cliente conferir">Pedir para conferir</button>${reread}</div>`;
    }).join('') + '<button type="button" class="icon-btn ref-close" id="ref-close" title="Fechar aviso">✕</button>';
    box.hidden = false;
  }
  $('ref-hint').addEventListener('click', (e) => {
    const found = latestReferences();
    if (!found) return;
    const close = e.target.closest('#ref-close');
    if (close) { refDismissed.set(found.message.conversation_id, found.message.id); renderRefHint(); return; }
    const readBtn = e.target.closest('[data-read-image]');
    if (readBtn) { readImage(Number(readBtn.dataset.readImage)); return; }
    const copy = e.target.closest('[data-ref-copy]');
    const vehSend = e.target.closest('[data-veh-send]');
    const vehRetry = e.target.closest('[data-veh-retry]');
    if (vehSend) { sendVehiclePreview(vehSend.dataset.vehSend, vehSend.dataset.vehKind || 'placa', vehSend.dataset.vehOriginal || '', vehSend.dataset.vehReload || ''); return; }
    if (vehRetry) { loadVehicle(vehRetry.dataset.vehRetry, true, vehRetry.dataset.vehKind || 'placa', vehRetry.dataset.vehKind === 'chassi'); return; }
    const use = e.target.closest('[data-ref-use]');
    const ask = e.target.closest('[data-ref-ask]');
    if (copy) { copyText(copy.dataset.refCopy); return; }
    if (use) {
      const r = found.list[Number(use.dataset.refUse)];
      openConsultModal({ kind: matchKind(r.label), ref: r.display || r.value });
      return;
    }
    if (ask) {
      const r = found.list[Number(ask.dataset.refAsk)];
      setComposeMode('message');
      els.composeText.value = RefCheck.askMessage(r);
      autosize();
      els.composeText.focus();
    }
  });

  /** Validação ao vivo do campo de referência no modal de consulta, conforme o tipo escolhido. */
  function renderConsultRefStatus() {
    const box = $('consult-ref-status');
    const value = $('consult-ref').value.trim();
    const validator = window.RefCheck ? RefCheck.validatorFor(consult.kind) : null;
    if (!value || !validator) { box.hidden = true; return; }
    const r = validator(value);
    if (r.ok) {
      box.className = 'ref-status ok';
      box.innerHTML = `${CHECK_ICON}<span>${esc(r.label)} válido${r.warnings[0] ? ` <span class="muted">(${esc(r.warnings[0])})</span>` : ''}</span>`;
    } else {
      box.className = 'ref-status bad';
      box.innerHTML = `${WARN_ICON}<span>${esc(r.errors.join('; '))}</span>${r.suggestions.length ? `<span class="ref-sug">Tentar: ${r.suggestions.map((v) => `<button type="button" class="chip" data-fix="${esc(v)}">${esc(v)}</button>`).join('')}</span>` : ''}`;
    }
    box.hidden = false;
  }
  $('consult-ref').addEventListener('input', renderConsultRefStatus);
  $('consult-ref-status').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fix]');
    if (!b) return;
    $('consult-ref').value = b.dataset.fix;
    renderConsultRefStatus();
    $('consult-ref').focus();
  });

  /** Faixa acima do compositor: avisa que outro atendente está digitando ou vendo a mesma conversa. */
  function renderActivityBar() {
    const c = current();
    const box = $('activity-bar');
    if (!c) { box.hidden = true; return; }
    const typing = typingNames(c.id);
    const viewing = viewerNames(c.id).filter((n) => !typing.includes(n));
    if (!typing.length && !viewing.length) { box.hidden = true; return; }
    const parts = [];
    if (typing.length) parts.push(`<span class="act typing">${TYPE_ICON}<b>${esc(typing.join(', '))}</b> está digitando…</span>`);
    if (viewing.length) parts.push(`<span class="act viewing">${EYE_ICON}<b>${esc(viewing.join(', '))}</b> está com esta conversa aberta</span>`);
    box.className = `activity-bar ${typing.length ? 'is-typing' : ''}`;
    box.innerHTML = parts.join('') + (typing.length ? '<span class="act-warn">cuidado para não responder junto</span>' : '');
    box.hidden = false;
  }

  /** Faixa fixa no topo da conversa com as observações da ficha, para ninguém precisar abrir o painel. */
  function renderObsStrip() {
    const c = current();
    const box = $('obs-strip');
    if (!c || !(c.notes_count > 0)) { box.hidden = true; return; }
    const notes = state.contact && state.contact.id === c.contact_id ? state.contactNotes : [];
    const shown = notes.slice(0, 2);
    const more = Math.max(0, (notes.length || c.notes_count) - shown.length);
    box.innerHTML = `${PIN_ICON}<div class="obs-text">${shown.length
      ? shown.map((n) => `<span><b>${esc(n.body)}</b><small> · ${esc(n.user_name || 'Sistema')}</small></span>`).join('')
      : `<span>${c.notes_count} observação${c.notes_count > 1 ? 'ões' : ''} fixada${c.notes_count > 1 ? 's' : ''} na ficha</span>`}${more ? `<span class="muted">+${more} observação${more > 1 ? 'ões' : ''}</span>` : ''}</div><span class="obs-open">Ver ficha</span>`;
    box.hidden = false;
  }
  $('obs-strip').addEventListener('click', () => {
    setDetailsOpen(true);
    document.querySelector('#d-tabs button[data-dtab="contact"]').click();
    if (!dOpen['d-notes']) document.querySelector('[data-dtoggle="d-notes"]').click();
    document.getElementById('d-notes').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  async function loadContactNotes(contactId) {
    try {
      const { notes } = await api('GET', `/api/contacts/${contactId}/notes`);
      if (state.currentConv && state.currentConv.contact_id === contactId) { state.contactNotes = notes; renderObsStrip(); }
    } catch { /* ignora */ }
  }

  /** Oculta a janela do chat (volta para a tela vazia) sem mudar nada na conversa. */
  function closeChat() {
    if (!state.currentId) return;
    if (typingSocket && state.composeMode !== 'note') typingSocket.emit('typing', { conversation_id: state.currentId, active: false });
    if (state.search.open) closeSearch();
    clearReply();
    cancelEdit();
    clearAttachment();
    emitViewing(null);
    state.currentId = null;
    state.currentConv = null;
    state.contact = null;
    state.messages = [];
    els.messages.innerHTML = '';
    els.chatPanel.hidden = true;
    els.chatEmpty.hidden = false;
    els.details.hidden = true;
    $('debit-prompt').hidden = true;
    $('plan-hint').hidden = true;
    $('obs-strip').hidden = true;
    $('ref-hint').hidden = true;
    state.contactNotes = [];
    $('tag-popup').hidden = true;
    $('sector-popup').hidden = true;
    $('plan-menu').hidden = true;
    history.replaceState(null, '', location.pathname);
    renderList();
  }
  $('btn-close-chat').addEventListener('click', closeChat);

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
  // ---- Seletor de data e hora (calendário próprio) ----
  const dtp = { view: new Date(), sel: new Date() };
  const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  function dtpLabel(d) {
    return `${WEEKDAYS[d.getDay()]}, ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} às ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function dtpRender() {
    const v = dtp.view, s = dtp.sel, today = new Date();
    $('dtp-month').textContent = `${MONTHS[v.getMonth()]} ${v.getFullYear()}`;
    const first = new Date(v.getFullYear(), v.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    let html = WEEKDAYS.map((w) => `<div class="wd">${w[0].toUpperCase()}</div>`).join('');
    const todayKey = today.toDateString();
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const other = d.getMonth() !== v.getMonth();
      const past = d < new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const cls = [other ? 'other' : '', d.toDateString() === todayKey ? 'today' : '', d.toDateString() === s.toDateString() ? 'sel' : '', past ? 'past' : ''].filter(Boolean).join(' ');
      html += `<button type="button" class="${cls}" data-day="${d.getFullYear()}-${d.getMonth()}-${d.getDate()}" ${past ? 'disabled' : ''}>${d.getDate()}</button>`;
    }
    $('dtp-grid').innerHTML = html;
    $('dtp-hours').innerHTML = Array.from({ length: 24 }, (_, h) => `<button type="button" data-h="${h}" class="${h === s.getHours() ? 'sel' : ''}">${pad2(h)}</button>`).join('');
    $('dtp-minutes').innerHTML = Array.from({ length: 12 }, (_, i) => i * 5).map((m) => `<button type="button" data-m="${m}" class="${m === Math.floor(s.getMinutes() / 5) * 5 ? 'sel' : ''}">${pad2(m)}</button>`).join('');
    $('dtp-chosen').textContent = `${pad2(s.getHours())}:${pad2(s.getMinutes())}`;
    $('dtp-label').textContent = dtpLabel(s);
    $('dtp-hours').querySelector('.sel')?.scrollIntoView({ block: 'center' });
    $('dtp-minutes').querySelector('.sel')?.scrollIntoView({ block: 'center' });
  }
  function dtpCommit() {
    $('sched-when').value = toLocalInput(dtp.sel);
    $('dtp-label').textContent = dtpLabel(dtp.sel);
    updateRelative();
  }
  function setWhen(d) {
    dtp.sel = new Date(d);
    dtp.sel.setSeconds(0, 0);
    dtp.view = new Date(dtp.sel.getFullYear(), dtp.sel.getMonth(), 1);
    dtpCommit();
    if (!$('dtp-pop').hidden) dtpRender();
  }
  $('dtp-open').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('dtp-pop');
    if (!pop.hidden) { pop.hidden = true; return; }
    dtp.view = new Date(dtp.sel.getFullYear(), dtp.sel.getMonth(), 1);
    pop.hidden = false;
    dtpRender();
  });
  $('dtp-prev').addEventListener('click', () => { dtp.view = new Date(dtp.view.getFullYear(), dtp.view.getMonth() - 1, 1); dtpRender(); });
  $('dtp-next').addEventListener('click', () => { dtp.view = new Date(dtp.view.getFullYear(), dtp.view.getMonth() + 1, 1); dtpRender(); });
  $('dtp-grid').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-day]');
    if (!b || b.disabled) return;
    const [y, m, d] = b.dataset.day.split('-').map(Number);
    dtp.sel = new Date(y, m, d, dtp.sel.getHours(), dtp.sel.getMinutes());
    dtp.view = new Date(y, m, 1);
    dtpRender(); dtpCommit();
  });
  $('dtp-hours').addEventListener('click', (e) => { const b = e.target.closest('button[data-h]'); if (!b) return; dtp.sel.setHours(Number(b.dataset.h)); dtpRender(); dtpCommit(); });
  $('dtp-minutes').addEventListener('click', (e) => { const b = e.target.closest('button[data-m]'); if (!b) return; dtp.sel.setMinutes(Number(b.dataset.m)); dtpRender(); dtpCommit(); });
  $('dtp-today').addEventListener('click', () => { const n = new Date(); dtp.sel = new Date(n.getFullYear(), n.getMonth(), n.getDate(), dtp.sel.getHours(), dtp.sel.getMinutes()); dtp.view = new Date(n.getFullYear(), n.getMonth(), 1); dtpRender(); dtpCommit(); });
  $('dtp-tomorrow').addEventListener('click', () => { const n = new Date(); n.setDate(n.getDate() + 1); dtp.sel = new Date(n.getFullYear(), n.getMonth(), n.getDate(), dtp.sel.getHours(), dtp.sel.getMinutes()); dtp.view = new Date(n.getFullYear(), n.getMonth(), 1); dtpRender(); dtpCommit(); });
  $('dtp-done').addEventListener('click', () => { $('dtp-pop').hidden = true; });
  document.addEventListener('click', (e) => { if (!e.target.closest('#sched-dtp')) $('dtp-pop').hidden = true; });
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
    refreshSignatureLabels();
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

  $('sched-kind').addEventListener('click', (e) => { const b = e.target.closest('button[data-kind]'); if (b) setSchedKind(b.dataset.kind); });
  $('sched-cancel-edit').addEventListener('click', resetSchedForm);
  $('schedule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = current();
    if (!c) return;
    const when = new Date($('sched-when').value);
    const text = $('sched-body').value.trim();
    const body = sched.kind === 'message' && $('sched-sign').checked && text ? `*${signText()}:*\n${text}` : text;
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
    els.composeSend.textContent = mode === 'note' ? 'Salvar nota' : (attach.files.length ? sendLabel() : 'Enviar');
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
    if (state.editing) { await saveEdit(text); return; }
    if (attach.files.length && state.composeMode !== 'note') { await sendAttachment(id, text); return; }
    if (!text) return;
    els.composeSend.disabled = true;
    els.composeText.value = '';
    autosize();
    try {
      if (state.composeMode === 'note') {
        await api('POST', `/api/conversations/${id}/notes`, { body: text });
      } else {
        const body = els.signToggle.checked ? `*${signText()}:*\n${text}` : text;
        await api('POST', `/api/conversations/${id}/messages`, { body, quoted_message_id: state.reply?.id || null });
        clearReply();
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
    if (e.key === 'Escape' && state.editing) { e.preventDefault(); cancelEdit(); }
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
    $('d-avatar').outerHTML = avatarHtml(c, 'xl', false).replace('<div class="avatar ', '<div id="d-avatar" class="avatar ');
    els.dName.textContent = contactName(c);
    els.dPhone.textContent = formatPhone(c.wa_id);
    $('d-lid').innerHTML = [
      c.profile_name && c.profile_name !== contactName(c) ? `perfil: ${esc(c.profile_name)}` : '',
      c.contact_blocked ? '<span class="tag new">Bloqueado</span>' : '',
    ].filter(Boolean).join(' · ');
    if (document.activeElement !== els.dNameInput) els.dNameInput.value = c.contact_name || '';
    $('d-tags-view').innerHTML = c.tags.map((t) => `<span class="tag" style="color:${esc(t.color)}"><i class="dot"></i>${esc(t.name)}</span>`).join('')
      + `<button type="button" class="tag-quick" id="d-tag-add" title="Adicionar ou remover etiquetas">${TAG_ICON}</button>`;
    // Enquanto a ficha completa não chega, o cartão do plano usa os dados que a conversa já traz
    if (!state.contact || state.contact.id !== c.contact_id) {
      renderPlanCard({ ...c, id: c.contact_id, plan_used: c.plan_credits != null ? c.plan_credits - c.plan_left : 0, plan_started_at: null });
      renderBlockButton(c.contact_blocked);
    }
    els.dStatus.innerHTML = `<span class="status-pill ${c.status}">${c.status === 'open' ? 'Aberta' : 'Finalizada'}</span>`;
    const times = [`Iniciada ${new Date(c.created_at).toLocaleString('pt-BR')}`];
    if (c.first_response_at) times.push(`1ª resposta em ${fmtDuration((new Date(c.first_response_at) - new Date(c.created_at)) / 1000)}`);
    if (c.resolved_at) times.push(`Resolvida em ${fmtDuration((new Date(c.resolved_at) - new Date(c.created_at)) / 1000)}`);
    els.dTimes.innerHTML = times.map(esc).join('<br>');
    els.dAssignee.value = c.assigned_user_id || '';
    $('d-route').innerHTML = `${sectorChip(c)}${c.account_name ? `<span class="chip-soft ${accountOffline(c.account_id) ? 'off' : ''}">via ${esc(c.account_name)}</span>` : ''}<button type="button" class="btn btn-sm btn-ghost" id="d-sector-change">Mudar setor</button>`;
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
  $('d-tags-view').addEventListener('click', (e) => {
    const b = e.target.closest('#d-tag-add');
    const c = current();
    if (!b || !c) return;
    e.stopPropagation();
    openTagPopup(c, b);
  });
  $('d-route').addEventListener('click', (e) => {
    const b = e.target.closest('#d-sector-change');
    const c = current();
    if (!b || !c) return;
    e.stopPropagation();
    openSectorPopup(c, b);
  });
  $('d-close').addEventListener('click', () => setDetailsOpen(false));
  $('d-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dtab]');
    if (!b) return;
    document.querySelectorAll('#d-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.d-tab').forEach((x) => { x.hidden = x.dataset.dtab !== b.dataset.dtab; });
  });
  $('d-edit-name').addEventListener('click', () => {
    els.dNameInput.hidden = false;
    els.dNameInput.focus();
    els.dNameInput.select();
  });
  async function saveContactName() {
    const c = current();
    els.dNameInput.hidden = true;
    if (!c || els.dNameInput.value.trim() === (c.contact_name || '')) return;
    try { await api('PATCH', `/api/conversations/${c.id}/contact`, { name: els.dNameInput.value }); toast('Nome salvo'); }
    catch (err) { toast(err.message, true); }
  }
  els.dNameInput.addEventListener('blur', saveContactName);
  els.dNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); els.dNameInput.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); els.dNameInput.value = current()?.contact_name || ''; els.dNameInput.blur(); }
  });
  $('d-block').addEventListener('click', async () => {
    const c = current();
    if (!c) return;
    const blocked = !c.contact_blocked;
    if (!confirm(blocked ? `Bloquear ${contactName(c)} no WhatsApp? Ele não conseguirá mais enviar mensagens.` : `Desbloquear ${contactName(c)}?`)) return;
    try { await api('PATCH', `/api/conversations/${c.id}/contact`, { blocked }); toast(blocked ? 'Contato bloqueado' : 'Contato desbloqueado'); }
    catch (err) { toast(err.message, true); }
  });
  $('d-delete').addEventListener('click', async () => {
    const c = current();
    if (!c) return;
    if (!confirm(`Excluir o contato ${contactName(c)}? Todas as conversas, mensagens, consultas e o plano dele serão apagados para todos os atendentes. Isso não pode ser desfeito.`)) return;
    try { await api('DELETE', `/api/contacts/${c.contact_id}`); toast('Contato excluído'); }
    catch (err) { toast(err.message, true); }
  });

  // ---------- Tempo real ----------
  function matchesFilters(c) {
    const f = state.filters;
    if (f.status === 'inbox' && c.status !== 'open') return false;
    if (f.status === 'waiting' && !(c.status === 'open' && c.last_message_direction !== 'out')) return false;
    if (f.status === 'resolved' && c.status !== 'resolved') return false;
    if (f.status === 'open' && c.status !== 'open') return false;
    if (f.assigned === 'me' && c.assigned_user_id !== state.me.id) return false;
    if (f.assigned === 'unassigned' && c.assigned_user_id) return false;
    if (f.tag && !c.tags.some((t) => String(t.id) === String(f.tag))) return false;
    if (f.account && String(c.account_id) !== String(f.account)) return false;
    if (f.sector && String(c.sector_id) !== String(f.sector)) return false;
    if (f.plan === 'with' && c.plan_credits == null) return false;
    if (f.plan === 'without' && c.plan_credits != null) return false;
    if (f.plan === 'empty' && !(c.plan_credits != null && c.plan_left === 0)) return false;
    if (f.plan === 'expired' && !(c.plan_credits != null && c.plan_expires_at && new Date(c.plan_expires_at) < new Date())) return false;
    if (f.recurrence) {
      const t = tierOf(c);
      if (f.recurrence === 'inactive' ? !t.inactive : t.tier !== f.recurrence) return false;
    }
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
      state.conversations.sort((a, b) => state.filters.status === 'waiting'
        ? (b.pinned - a.pinned) || (new Date(a.last_message_at) - new Date(b.last_message_at)) // esperando: quem espera há mais tempo primeiro
        : (b.pinned - a.pinned) || (new Date(b.last_message_at) - new Date(a.last_message_at))); // entrada: atividade mais recente primeiro
    } else if (idx >= 0) {
      state.conversations.splice(idx, 1);
    }
    if (conv.id === state.currentId) state.currentConv = conv;
    renderList();
    loadCounts();
  }

  function connectSocket() {
    const socket = io({ withCredentials: true });
    typingSocket = socket;
    socket.on('connect', () => { if (state.currentId) emitViewing(state.currentId); });
    socket.on('presence:all', (ids) => { for (const id of ids) setPresence(id, { online: true }); renderList(); if (current()) renderChat(); });
    socket.on('presence', ({ user_id, online, availability, last_online_at }) => {
      const t = (state.team || []).find((u) => u.id === user_id);
      if (t) {
        t.online = online;
        if (availability) t.availability = availability;
        if (last_online_at) t.last_online_at = last_online_at;
        t.status = online ? (t.availability === 'away' ? 'away' : 'available') : 'offline';
        const on = state.team.filter((u) => u.status === 'available').length;
        $('team-online').hidden = !on;
        $('team-online').textContent = on;
        if (!$('team-modal').hidden) renderTeam();
      } else loadTeam();
      setPresence(user_id, availability ? { online, availability } : { online });
      if (user_id === state.me.id) renderMyPresence();
      renderList();
      if (current()) renderChat();
    });
    socket.on('typing', ({ conversation_id, user_id, name, active }) => {
      if (user_id === state.me.id) return;
      const map = state.typing.get(conversation_id) || new Map();
      if (active) map.set(user_id, { name, until: Date.now() + 4000 }); else map.delete(user_id);
      state.typing.set(conversation_id, map);
      renderList();
      if (conversation_id === state.currentId) { renderChat(); setTimeout(() => { if (conversation_id === state.currentId) { renderChat(); renderList(); } }, 4200); }
    });
    socket.on('viewers', ({ conversation_id, users }) => {
      state.viewers.set(conversation_id, users || []);
      renderList();
      if (conversation_id === state.currentId) renderActivityBar();
    });
    socket.on('viewers:all', (all) => {
      state.viewers = new Map(Object.entries(all || {}).map(([k, v]) => [Number(k), v]));
      renderList();
      renderActivityBar();
    });
    socket.on('settings:updated', (s) => { Object.assign(state.settings, s); renderList(); });
    socket.on('sectors:updated', () => loadSectors());
    socket.on('quick-replies:updated', async () => {
      try { const { quick_replies: qr } = await api('GET', '/api/quick-replies'); state.quickReplies = qr || []; if (!$('qr-popup').hidden) renderQuickPopup($('qr-popup').dataset.term || ''); } catch { /* ignora */ }
    });
    socket.on('user:avatar', ({ user_id, avatar_media_id, version }) => {
      if (avatar_media_id && version) avatarVersion.set(avatar_media_id, version);
      for (const u of state.users) if (u.id === user_id) u.avatar_media_id = avatar_media_id;
      for (const c of state.conversations) if (c.assigned_user_id === user_id) c.assigned_user_avatar = avatar_media_id;
      for (const m of state.messages) if (m.sender_user_id === user_id) m.sender_avatar = avatar_media_id;
      if (user_id === state.me.id) { state.me.avatar_media_id = avatar_media_id; renderRailAvatar(); }
      renderList();
      if (state.currentId) renderMessages(false);
    });
    socket.on('contact:updated', (contact) => {
      let touched = false;
      const apply = (c) => {
        c.contact_name = contact.name; c.contact_blocked = contact.blocked;
        c.plan_name = contact.plan_name; c.plan_credits = contact.plan_credits; c.plan_left = contact.plan_left; c.plan_expires_at = contact.plan_expires_at;
        c.interactions = contact.interactions; c.active_months = contact.active_months; c.first_contact_at = contact.first_contact_at; c.last_seen_at = contact.last_seen_at;
        c.credits_bought = contact.credits_bought; c.purchases_count = contact.purchases_count; c.first_purchase_at = contact.first_purchase_at; c.last_purchase_at = contact.last_purchase_at;
        c.notes_count = contact.notes_count;
      };
      for (const c of state.conversations) if (c.contact_id === contact.id) { apply(c); touched = true; }
      if (state.currentConv && state.currentConv.contact_id === contact.id) {
        apply(state.currentConv);
        if (contact.plan_left !== undefined) { state.contact = contact; renderContactCard(contact); refreshContactSubs(); if (contact.notes_count > 0) loadContactNotes(contact.id); else { state.contactNotes = []; } }
        renderChat();
        renderDetails();
      }
      if (touched) renderList();
    });
    socket.on('plans:updated', loadPlans);
    socket.on('reading:updated', (rd) => {
      if (!state.readings) state.readings = new Map();
      state.readings.set(rd.message_id, rd);
      const c = current();
      if (c && rd.conversation_id === c.id) renderRefHint();
    });
    socket.on('conversation:transferred', ({ conversation, from, note }) => {
      toast(`${from} transferiu ${contactName(conversation)} para você${note ? ': ' + note : ''}`);
      if ('Notification' in window && Notification.permission === 'granted' && !document.hasFocus()) {
        const n = new Notification('Conversa transferida para você', { body: `${from}: ${contactName(conversation)}${note ? ' · ' + note : ''}`, icon: '/img/logo.svg' });
        n.onclick = () => { window.focus(); openConversation(conversation.id); n.close(); };
      }
    });
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
        if (message.direction === 'in') renderRefHint();
        if (message.direction === 'in' && document.hasFocus() && !document.hidden) api('POST', `/api/conversations/${state.currentId}/read`).catch(() => {});
        else if (message.direction === 'in') notify(applyPrefs(conversation), message, { sameConversation: true });
      } else if (message.direction === 'in') {
        notify(applyPrefs(conversation), message);
      }
    });
    socket.on('message:status', ({ id, conversation_id, status, error }) => {
      const m = state.messages.find((x) => x.id === id);
      if (m) { m.status = status; m.error = error; renderMessages(false); }
      // ✓✓ da lista: só se for a última mensagem enviada daquela conversa
      const c = state.conversations.find((x) => x.id === conversation_id && x.last_out_id === id);
      if (c) { c.last_out_status = status; renderList(); }
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

  // ---------- Notificações: som, aviso do sistema e título piscando ----------
  const notifyState = { unseen: 0, flashTimer: null, baseTitle: document.title };
  function notify(conv, message, { sameConversation = false } = {}) {
    if (conv.muted) return;
    const prefs = SOS.sound.load();
    const away = document.hidden || !document.hasFocus();
    // Som: fora da aba conforme preferência; dentro da aba só para outras conversas, se o atendente quiser
    if ((away && prefs.whenBackground) || (!away && !sameConversation && prefs.whenFocused)) SOS.sound.play(prefs.sound, prefs.volume);
    if (!away) return;
    if (prefs.flashTitle) { notifyState.unseen += 1; startTitleFlash(); }
    if (prefs.desktop && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(contactName(conv), { body: stripWa(message.body) || 'Nova mensagem', icon: '/img/logo.svg', tag: `conv-${conv.id}` });
      n.onclick = () => { window.focus(); openConversation(conv.id); n.close(); };
    }
  }
  function startTitleFlash() {
    if (notifyState.flashTimer) return;
    let on = false;
    notifyState.flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? `(${notifyState.unseen}) Nova mensagem` : notifyState.baseTitle;
    }, 1200);
  }
  function stopTitleFlash() {
    clearInterval(notifyState.flashTimer);
    notifyState.flashTimer = null;
    notifyState.unseen = 0;
    document.title = notifyState.baseTitle;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) stopTitleFlash(); });
  window.addEventListener('focus', stopTitleFlash);

  // Foto de perfil e dispositivos de áudio (dentro do modal de preferências)
  function renderRailAvatar() {
    const el = $('me-avatar');
    el.querySelector('.av-img')?.remove();
    if (state.me.avatar_media_id) el.insertAdjacentHTML('afterbegin', `<img class="av-img" src="/api/media/${esc(state.me.avatar_media_id)}?v=${Date.now()}" alt="">`);
  }
  function renderPrefsAvatar() {
    $('prefs-avatar').innerHTML = esc(initials(state.me.name)) + (state.me.avatar_media_id ? `<img src="/api/media/${esc(state.me.avatar_media_id)}?v=${Date.now()}" alt="">` : '');
    $('prefs-avatar-remove').hidden = !state.me.avatar_media_id;
  }
  $('prefs-avatar-pick').addEventListener('click', () => { $('prefs-avatar-file').value = ''; $('prefs-avatar-file').click(); });
  $('prefs-avatar-file').addEventListener('change', async () => {
    const f = $('prefs-avatar-file').files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f, f.name);
    try {
      const { user } = await SOS.upload('/api/users/me/avatar', fd);
      state.me.avatar_media_id = user.avatar_media_id;
      avatarVersion.set(user.avatar_media_id, Date.now());
      renderPrefsAvatar(); renderRailAvatar(); renderList();
      toast('Foto atualizada');
    } catch (err) { toast(err.message, true); }
  });
  $('prefs-avatar-remove').addEventListener('click', async () => {
    try {
      await api('DELETE', '/api/users/me/avatar');
      state.me.avatar_media_id = null;
      renderPrefsAvatar(); renderRailAvatar(); renderList();
      toast('Foto removida');
    } catch (err) { toast(err.message, true); }
  });

  let micTest = null;
  async function renderDevices() {
    const prefs = SOS.sound.load();
    const { inputs, outputs, labeled } = await SOS.sound.listDevices().catch(() => ({ inputs: [], outputs: [], labeled: false }));
    const opt = (d, i, kind) => `<option value="${esc(d.deviceId)}">${esc(d.label || `${kind} ${i + 1}`)}</option>`;
    $('pref-output').innerHTML = '<option value="">Padrão do sistema</option>' + outputs.filter((d) => d.deviceId !== 'default').map((d, i) => opt(d, i, 'Saída')).join('');
    $('pref-input').innerHTML = '<option value="">Padrão do sistema</option>' + inputs.filter((d) => d.deviceId !== 'default').map((d, i) => opt(d, i, 'Microfone')).join('');
    $('pref-output').value = [...$('pref-output').options].some((o) => o.value === prefs.outputId) ? prefs.outputId : '';
    $('pref-input').value = [...$('pref-input').options].some((o) => o.value === prefs.inputId) ? prefs.inputId : '';
    $('pref-output').disabled = !SOS.sound.supportsOutputSelect();
    const help = [];
    if (!SOS.sound.supportsOutputSelect()) help.push('Este navegador não permite escolher a saída (funciona no Chrome e no Edge).');
    if (!labeled) help.push('<a href="#" id="pref-device-allow">Permitir o microfone</a> para mostrar os nomes dos dispositivos.');
    $('pref-device-help').innerHTML = help.join(' ');
    $('pref-device-allow')?.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await SOS.sound.requestDeviceAccess(); await renderDevices(); } catch { toast('Permissão do microfone negada', true); }
    });
  }
  $('pref-output-test').addEventListener('click', () => {
    const prefs = SOS.sound.load();
    SOS.sound.save({ ...prefs, outputId: $('pref-output').value });
    SOS.sound.play(document.querySelector('#sound-list input:checked')?.value || prefs.sound, Number($('pref-volume').value));
  });
  $('pref-input-test').addEventListener('click', async () => {
    if (micTest) { stopMicTest(); return; }
    try {
      const id = $('pref-input').value;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      $('mic-meter').hidden = false;
      $('pref-input-test').textContent = 'Parar';
      micTest = { stream, ctx, timer: setInterval(() => { an.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128)); $('mic-fill').style.width = `${Math.min(100, (peak / 128) * 160)}%`; }, 80) };
      setTimeout(() => micTest && stopMicTest(), 10000);
    } catch { toast('Não foi possível acessar esse microfone', true); }
  });
  function stopMicTest() {
    if (!micTest) return;
    clearInterval(micTest.timer);
    micTest.stream.getTracks().forEach((t) => t.stop());
    micTest.ctx.close().catch(() => {});
    micTest = null;
    $('mic-meter').hidden = true;
    $('mic-fill').style.width = '0';
    $('pref-input-test').textContent = 'Testar';
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (!$('prefs-modal').hidden) renderDevices(); });

  // Preferências (modal)
  function openPrefs(tab = 'profile') {
    const prefs = SOS.sound.load();
    renderPrefsAvatar();
    renderDevices();
    showPrefsTab(tab);
    $('pref-signature').value = state.me.signature || '';
    $('pref-signature-name').textContent = state.me.name;
    $('pref-signature-preview').textContent = `${signText()}:`;
    const av = state.presence.get(state.me.id)?.availability || 'available';
    document.querySelectorAll('#pref-availability .chip').forEach((c) => c.classList.toggle('active', c.dataset.availability === av));
    $('sound-list').innerHTML = Object.entries(SOS.sound.SOUNDS).map(([id, s]) => `
      <label class="${prefs.sound === id ? 'on' : ''}"><input type="radio" name="sound" value="${id}" ${prefs.sound === id ? 'checked' : ''}><span class="name">${esc(s.name)}</span>
        ${id !== 'none' ? `<button type="button" class="play" data-play="${id}" title="Ouvir"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>` : ''}</label>`).join('');
    $('pref-volume').value = prefs.volume;
    $('pref-background').checked = prefs.whenBackground;
    $('pref-focused').checked = prefs.whenFocused;
    $('pref-desktop').checked = prefs.desktop;
    $('pref-flash').checked = prefs.flashTitle;
    $('prefs-modal').hidden = false;
  }
  // Texto da assinatura: o que o atendente definiu, ou o nome
  const signText = () => (state.me.signature || state.me.name).trim();
  function refreshSignatureLabels() {
    els.signName.textContent = signText();
    $('sched-sign-name').textContent = signText();
  }
  function showPrefsTab(tab) {
    document.querySelectorAll('#prefs-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.ptab === tab));
    document.querySelectorAll('.prefs-section').forEach((s) => { s.hidden = s.dataset.ptab !== tab; });
  }
  $('prefs-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-ptab]'); if (b) showPrefsTab(b.dataset.ptab); });
  $('presence-menu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-prefs]');
    if (!b) return;
    $('presence-menu').hidden = true;
    openPrefs(b.dataset.prefs);
  });
  // Edição da assinatura direto no interruptor do compositor (lápis)
  function openSignEdit() {
    $('sign-input').value = state.me.signature || '';
    $('sign-input').hidden = false;
    $('sign-edit').hidden = true;
    $('sign-input').focus();
    $('sign-input').select();
  }
  async function saveSignEdit(cancel = false) {
    const input = $('sign-input');
    if (input.hidden) return;
    input.hidden = true;
    $('sign-edit').hidden = false;
    if (cancel) return;
    const sig = input.value.trim();
    if (sig === (state.me.signature || '')) return;
    try {
      const { user } = await api('PATCH', '/api/users/me/profile', { signature: sig });
      state.me.signature = user.signature;
      refreshSignatureLabels();
      toast(user.signature ? `Assinatura: ${user.signature}` : 'Assinatura voltou a ser seu nome');
    } catch (err) { toast(err.message, true); }
  }
  $('sign-edit').addEventListener('click', openSignEdit);
  $('sign-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveSignEdit(); }
    if (e.key === 'Escape') saveSignEdit(true);
  });
  $('sign-input').addEventListener('blur', () => saveSignEdit());
  $('pref-availability').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-availability]');
    if (!b) return;
    try {
      await api('PATCH', '/api/users/me/availability', { availability: b.dataset.availability });
      setPresence(state.me.id, { availability: b.dataset.availability, online: true });
      renderMyPresence(); renderList();
      document.querySelectorAll('#pref-availability .chip').forEach((c) => c.classList.toggle('active', c === b));
    } catch (err) { toast(err.message, true); }
  });
  $('prefs-cancel').addEventListener('click', () => { stopMicTest(); $('prefs-modal').hidden = true; });
  $('sound-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-play]');
    if (b) { e.preventDefault(); SOS.sound.play(b.dataset.play, Number($('pref-volume').value)); return; }
    const lab = e.target.closest('label');
    if (lab) document.querySelectorAll('#sound-list label').forEach((l) => l.classList.toggle('on', l === lab));
  });
  $('pref-signature').addEventListener('input', () => {
    $('pref-signature-preview').textContent = `${($('pref-signature').value.trim() || state.me.name)}:`;
  });
  $('prefs-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Assinatura (mesma do lápis no compositor) fica na conta
    const sig = $('pref-signature').value.trim();
    if (sig !== (state.me.signature || '')) {
      try {
        const { user } = await api('PATCH', '/api/users/me/profile', { signature: sig });
        state.me.signature = user.signature;
        refreshSignatureLabels();
      } catch (err) { toast(err.message, true); return; }
    }
    const prefs = {
      sound: document.querySelector('#sound-list input:checked')?.value || 'ding',
      volume: Number($('pref-volume').value),
      whenBackground: $('pref-background').checked,
      whenFocused: $('pref-focused').checked,
      desktop: $('pref-desktop').checked,
      flashTitle: $('pref-flash').checked,
      outputId: $('pref-output').value,
      inputId: $('pref-input').value,
    };
    stopMicTest();
    SOS.sound.save(prefs);
    for (const a of players.values()) SOS.sound.applyOutputTo(a);
    if (prefs.desktop && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    $('prefs-modal').hidden = true;
    toast('Preferências salvas');
  });

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
    return !els.composeText.value.trim() && !attach.files.length
      && ($('schedule-drawer').hidden || !$('sched-body').value.trim());
  }

  // ---------- Init ----------
  async function init() {
    state.me = await SOS.loadMe();
    refreshSignatureLabels();
    $('me-avatar').title = `${state.me.name} · ${state.me.role === 'admin' ? 'Administrador' : 'Atendente'}`;
    const [{ tags }, { users }, qr, st] = await Promise.all([
      api('GET', '/api/tags'), api('GET', '/api/users'),
      api('GET', '/api/quick-replies').catch(() => ({ quick_replies: [] })),
      api('GET', '/api/settings').catch(() => ({ settings: {} })),
    ]);
    state.tags = tags;
    state.users = users;
    state.quickReplies = qr.quick_replies || [];
    Object.assign(state.settings, st.settings || {});
    for (const u of users) setPresence(u.id, { online: Boolean(u.online), availability: u.availability || 'available' });
    setPresence(state.me.id, { online: true });
    renderMyPresence();
    await loadSectors();
    loadPlans();
    loadTeam();
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
    const wantId = Number(new URLSearchParams(location.search).get('c'));
    if (wantId) { history.replaceState(null, '', location.pathname); openConversation(wantId).catch(() => toast('Conversa não encontrada', true)); }
    setupSimulator();
    SOS.initUpdater(canReloadNow);
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }

  init().catch((err) => toast(err.message, true));
})();
