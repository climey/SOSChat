/* Caixa de entrada compartilhada */
(function () {
  const { api, esc, initials, formatPhone, fmtTime, fmtClock, fmtDay, fmtDuration, toast } = SOS;

  const state = {
    me: null,
    tags: [],
    users: [],
    conversations: [],
    currentId: null,
    messages: [],
    filters: { status: 'open', assigned: 'all', tag: '', account: '', q: '' },
    accounts: new Map(), // id -> status do número (só provedor baileys)
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    items: $('conv-items'), openCount: $('open-count'), search: $('search'), tagFilter: $('tag-filter'),
    chatEmpty: $('chat-empty'), chatPanel: $('chat-panel'), chatAvatar: $('chat-avatar'),
    chatTitle: $('chat-title'), chatSub: $('chat-sub'), messages: $('chat-messages'),
    compose: $('compose'), composeText: $('compose-text'), composeSend: $('compose-send'),
    btnResolve: $('btn-resolve'), btnDetails: $('btn-details'), details: $('details'),
    dAvatar: $('d-avatar'), dName: $('d-name'), dPhone: $('d-phone'), dNameInput: $('d-name-input'),
    dStatus: $('d-status'), dTimes: $('d-times'), dAssignee: $('d-assignee'), dTags: $('d-tags'),
  };

  const contactName = (c) => c.contact_name || c.profile_name || formatPhone(c.wa_id);
  const current = () => state.conversations.find((c) => c.id === state.currentId) || state.currentConv || null;

  // ---------- Lista de conversas ----------
  let listTimer;
  function scheduleReload() {
    clearTimeout(listTimer);
    listTimer = setTimeout(loadConversations, 150);
  }

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

  function renderList() {
    const list = state.conversations;
    if (!list.length) {
      els.items.innerHTML = '<div class="empty"><div>Nenhuma conversa encontrada</div></div>';
    } else {
      els.items.innerHTML = list.map((c) => `
        <div class="conv-item ${c.id === state.currentId ? 'active' : ''} ${c.unread_count > 0 ? 'unread' : ''}" data-id="${c.id}">
          ${avatarHtml(c)}
          <div class="body">
            <div class="top">
              <span class="name">${esc(contactName(c))}</span>
              <span class="time">${esc(fmtTime(c.last_message_at))}</span>
            </div>
            <div class="preview">${esc(c.last_message_preview || '')}</div>
            <div class="meta">
              ${c.unread_count > 0 ? `<span class="badge">${c.unread_count}</span>` : ''}
              ${c.status === 'resolved' ? '<span class="tag">Finalizada</span>' : ''}
              ${c.account_name && state.multiAccount ? `<span class="via ${accountOffline(c.account_id) ? 'off' : ''}">via ${esc(c.account_name)}</span>` : ''}
              ${c.tags.map((t) => `<span class="tag" style="color:${esc(t.color)}"><i class="dot"></i>${esc(t.name)}</span>`).join('')}
              <span class="assignee">${c.assigned_user_name ? esc(c.assigned_user_name) : 'Sem responsável'}</span>
            </div>
          </div>
        </div>`).join('');
    }
    const unread = list.filter((c) => c.status === 'open').reduce((n, c) => n + (c.unread_count > 0 ? 1 : 0), 0);
    els.openCount.hidden = unread === 0;
    els.openCount.textContent = unread;
  }

  els.items.addEventListener('click', (e) => {
    const item = e.target.closest('.conv-item');
    if (item) openConversation(Number(item.dataset.id));
  });

  // Filtros
  document.querySelectorAll('#status-filters .chip').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#status-filters .chip').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.filters.status = b.dataset.status;
    loadConversations();
  }));
  document.querySelectorAll('#assigned-filters .chip').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#assigned-filters .chip').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.filters.assigned = b.dataset.assigned;
    loadConversations();
  }));
  els.tagFilter.addEventListener('change', () => { state.filters.tag = els.tagFilter.value; loadConversations(); });
  $('account-filter').addEventListener('change', () => { state.filters.account = $('account-filter').value; loadConversations(); });
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

  // ---------- Estado dos números ----------
  const ACCOUNT_LABELS = {
    qr: 'aguardando leitura do QR code',
    connecting: 'conectando…',
    reconnecting: 'reconectando…',
    disconnected: 'desconectado',
    off: 'desligado',
  };
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
    const banner = $('wa-banner');
    const c = current();
    if (!c || !state.multiAccount) { banner.hidden = true; return; }
    const a = c.account_id ? state.accounts.get(Number(c.account_id)) : null;
    let text = null;
    let warn = false;
    if (c.account_id && !a) {
      text = 'O número desta conversa foi removido. Respostas sairão pelo primeiro número conectado.';
      warn = true;
    } else if (a && a.status !== 'connected') {
      const label = ACCOUNT_LABELS[a.status] || a.status;
      warn = a.status === 'connecting' || a.status === 'reconnecting';
      text = `Número "${a.name}" ${label}. Mensagens deste cliente não estão chegando e envios vão falhar até reconectar.`
        + (a.lastError ? ` (${a.lastError})` : '');
    } else if (!c.account_id && !anyAccountConnected()) {
      text = 'Nenhum número de WhatsApp conectado.';
    }
    if (!text) { banner.hidden = true; return; }
    banner.className = `wa-banner ${warn ? 'warn' : ''}`;
    banner.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>${state.me.role === 'admin' ? '<a href="/settings.html">Abrir Configurações</a>' : ''}`;
    banner.hidden = false;
  }

  function renderChat() {
    const c = current();
    if (!c) return;
    els.chatEmpty.hidden = true;
    els.chatPanel.hidden = false;
    renderBanner();
    els.chatAvatar.outerHTML = avatarHtml(c).replace('<div class="avatar ', '<div id="chat-avatar" class="avatar ');
    els.chatAvatar = $('chat-avatar');
    els.chatTitle.textContent = contactName(c);
    els.chatSub.textContent = `${formatPhone(c.wa_id)} · ${c.assigned_user_name ? 'Responsável: ' + c.assigned_user_name : 'Sem responsável'}`
      + (c.account_name && state.multiAccount ? ` · via ${c.account_name}` : '');
    els.btnResolve.textContent = c.status === 'resolved' ? 'Reabrir' : 'Finalizar';
    els.btnResolve.classList.toggle('btn-primary', c.status !== 'resolved');
  }

  function statusIcon(m) {
    if (m.direction !== 'out') return '';
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

  function avatarHtml(c, cls = '') {
    const img = c.avatar_media_id ? `<img src="/api/media/${esc(c.avatar_media_id)}" alt="" loading="lazy">` : '';
    return `<div class="avatar ${cls}">${esc(initials(contactName(c)))}${img}</div>`;
  }

  function renderMessages(scroll) {
    let lastDay = null;
    els.messages.innerHTML = state.messages.map((m) => {
      const day = fmtDay(m.created_at);
      const sep = day !== lastDay ? `<div class="day-sep">${esc(day)}</div>` : '';
      lastDay = day;
      // Esconde o texto quando ele é só um marcador de mídia ("[Áudio]") ou o nome do arquivo já mostrado no link
      const showBody = m.deleted_at || !m.media_id || !(isPlaceholder(m.body) || m.type === 'document');
      return `${sep}<div class="msg ${m.direction} ${m.deleted_at ? 'deleted' : ''}" data-id="${m.id}">
        ${m.direction === 'out' && m.sender_name ? `<div class="sender">${esc(m.sender_name)}</div>` : ''}
        ${mediaHtml(m)}${showBody ? `<div class="body">${esc(m.body)}</div>` : ''}
        <div class="foot">${m.edited_at && !m.deleted_at ? '<span class="edited">editada</span>' : ''}<span>${esc(fmtClock(m.created_at))}</span>${statusIcon(m)}</div>
      </div>`;
    }).join('');
    if (scroll) els.messages.scrollTop = els.messages.scrollHeight;
  }

  // Envio
  els.compose.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = els.composeText.value.trim();
    const id = state.currentId;
    if (!body || !id) return;
    els.composeSend.disabled = true;
    els.composeText.value = '';
    autosize();
    try {
      await api('POST', `/api/conversations/${id}/messages`, { body });
    } catch (err) {
      toast(err.message, true);
      els.composeText.value = body;
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
    els.composeText.style.height = Math.min(els.composeText.scrollHeight, 160) + 'px';
  }
  els.composeText.addEventListener('input', autosize);

  // Finalizar / reabrir
  els.btnResolve.addEventListener('click', async () => {
    const c = current();
    if (!c) return;
    try {
      await api('PATCH', `/api/conversations/${c.id}`, { status: c.status === 'resolved' ? 'open' : 'resolved' });
      toast(c.status === 'resolved' ? 'Conversa reaberta' : 'Conversa finalizada');
    } catch (err) { toast(err.message, true); }
  });
  els.btnDetails.addEventListener('click', () => els.details.classList.toggle('open'));

  // ---------- Painel de detalhes ----------
  function renderDetails() {
    const c = current();
    if (!c) { els.details.hidden = true; return; }
    els.details.hidden = false;
    els.dAvatar.outerHTML = avatarHtml(c).replace('<div class="avatar ', '<div id="d-avatar" class="avatar ');
    els.dAvatar = $('d-avatar');
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
    if (f.status !== 'all' && c.status !== f.status) return false;
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
        $('account-filter').innerHTML = '<option value="">Todos os números</option>' +
          wa.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}${a.phone ? ' · ' + esc(a.phone) : ''}</option>`).join('');
        $('account-filter-wrap').hidden = false;
      }
    } catch { /* sem status, segue sem filtro */ }
    await loadConversations();
    connectSocket();
    setupSimulator();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }

  init().catch((err) => toast(err.message, true));
})();
