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
    filters: { status: 'inbox', assigned: 'all', tag: '', account: '', q: '' },
    accounts: new Map(), // id -> status do número (só provedor baileys)
    multiAccount: false,
    composeMode: 'message', // message | note
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
    const { conversations } = await api('GET', `/api/conversations?${qs}`);
    state.conversations = conversations;
    renderList();
  }

  function tickHtml(c) {
    if (c.last_message_direction !== 'out') return '';
    return '<span class="tick">✓✓</span>';
  }

  function renderList() {
    const list = state.conversations;
    if (!list.length) {
      els.items.innerHTML = '<div class="empty"><div>Nenhuma conversa aqui</div></div>';
    } else {
      els.items.innerHTML = list.map((c) => `
        <div class="conv-item ${c.id === state.currentId ? 'active' : ''} ${c.unread_count > 0 ? 'unread' : ''}" data-id="${c.id}">
          ${avatarHtml(c, 'lg')}
          <div class="body">
            <div class="top">
              <span class="name">${esc(contactName(c))}</span>
              <span class="time">${esc(fmtTime(c.last_message_at))}</span>
            </div>
            <div class="mid">
              <span class="preview">${tickHtml(c)}<span>${esc(c.last_message_preview || '')}</span></span>
              ${c.unread_count > 0 ? `<span class="badge">${c.unread_count}</span>` : ''}
              ${c.assigned_user_name
                ? `<span class="agent" title="Responsável: ${esc(c.assigned_user_name)}">${esc(initials(c.assigned_user_name))}</span>`
                : '<span class="agent none" title="Sem responsável">?</span>'}
            </div>
            <div class="meta">
              ${c.tags.map((t) => `<span class="tag" style="color:${esc(t.color)}"><i class="dot"></i>${esc(t.name)}</span>`).join('')}
              ${c.status === 'resolved' ? '<span class="tag">Finalizada</span>' : ''}
              <span class="spacer"></span>
              ${c.account_name && state.multiAccount ? `<span class="chip-soft ${accountOffline(c.account_id) ? 'off' : ''}">${esc(c.account_name)}</span>` : ''}
            </div>
          </div>
        </div>`).join('');
    }
    els.cntActive.textContent = list.length ? list.length : '';
    const unread = list.reduce((n, c) => n + (c.status === 'open' && c.unread_count > 0 ? 1 : 0), 0);
    els.railUnread.hidden = unread === 0;
    els.railUnread.textContent = unread > 99 ? '99+' : unread;
  }

  els.items.addEventListener('click', (e) => {
    const item = e.target.closest('.conv-item');
    if (item) openConversation(Number(item.dataset.id));
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
    state.currentConv = conversation;
    state.messages = messages;
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
      return `<a href="${src}" target="_blank" rel="noopener"><img class="media-img" src="${src}" alt="" loading="lazy"></a>`;
    }
    if (m.type === 'audio') return `<audio class="media-audio" controls preload="none" src="${src}"></audio>`;
    if (m.type === 'video') return `<video class="media-video" controls preload="metadata" src="${src}"></video>`;
    const name = m.body && !isPlaceholder(m.body) ? m.body : 'Documento';
    return `<a class="media-doc" href="${src}" target="_blank" rel="noopener">📎 <span class="name">${esc(name)}</span></a>`;
  }

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
      return `${sep}<div class="msg-row ${rowCls} ${m.deleted_at ? 'deleted' : ''}" data-id="${m.id}">
        <div class="msg">${sender}${mediaHtml(m)}${showBody ? `<span class="body">${esc(m.body)}</span>` : ''}
          <span class="foot">${m.edited_at && !m.deleted_at ? '<span class="edited">editada</span>' : ''}<span>${esc(fmtClock(m.created_at))}</span>${statusIcon(m)}</span>
        </div>${agent}
      </div>`;
    }).join('');
    if (scroll) els.messages.scrollTop = els.messages.scrollHeight;
  }

  // ---------- Compositor ----------
  function setComposeMode(mode) {
    state.composeMode = mode;
    document.querySelectorAll('#compose-mode button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
      b.classList.toggle('note', b.dataset.mode === 'note' && mode === 'note');
    });
    els.composer.classList.toggle('note-mode', mode === 'note');
    els.composeText.placeholder = mode === 'note' ? 'Escreva uma nota interna (o cliente não vê)…' : 'Digite sua mensagem…';
    els.composeSend.textContent = mode === 'note' ? 'Salvar nota' : 'Enviar';
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
    if (!text || !id) return;
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
    if (f.q) {
      const q = f.q.toLowerCase();
      if (![c.wa_id, c.contact_name, c.profile_name].some((v) => (v || '').toLowerCase().includes(q))) return false;
    }
    return true;
  }

  function upsertConversation(conv) {
    const idx = state.conversations.findIndex((c) => c.id === conv.id);
    if (matchesFilters(conv)) {
      if (idx >= 0) state.conversations[idx] = conv; else state.conversations.push(conv);
      state.conversations.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
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
        notify(conversation, message);
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
    socket.on('contact:avatar', ({ contact_id, avatar_media_id }) => {
      let touched = false;
      for (const c of state.conversations) if (c.contact_id === contact_id) { c.avatar_media_id = avatar_media_id; touched = true; }
      if (state.currentConv?.contact_id === contact_id) { state.currentConv.avatar_media_id = avatar_media_id; renderChat(); renderDetails(); }
      if (touched) renderList();
    });
    socket.on('connect_error', () => toast('Conexão em tempo real perdida, tentando reconectar…', true));
  }

  function notify(conv, message) {
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
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }

  init().catch((err) => toast(err.message, true));
})();
