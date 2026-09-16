/* Utilitários compartilhados: chamadas à API, formatação e escape de HTML. */
(function () {
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !location.pathname.endsWith('/login.html')) {
      location.href = '/login.html';
      throw new Error('Sessão expirada');
    }
    let data = null;
    try { data = await res.json(); } catch { /* sem corpo */ }
    if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
    return data;
  }

  /** Envio multipart (arquivos). */
  async function upload(path, formData) {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body: formData,
    });
    if (res.status === 401) { location.href = '/login.html'; throw new Error('Sessão expirada'); }
    let data = null;
    try { data = await res.json(); } catch { /* sem corpo */ }
    if (!res.ok) throw new Error(data?.error || data?.message?.error || `Erro ${res.status}`);
    return data;
  }

  /** Barra lateral: recolhida (só ícones) ou expandida (com nomes), lembrada no navegador. */
  function initRail() {
    const rail = document.querySelector('.rail');
    const toggle = document.getElementById('rail-toggle');
    if (!rail || !toggle) return;
    let expanded = false;
    try { expanded = localStorage.getItem('sos.rail') === '1'; } catch { /* sem storage */ }
    const apply = () => {
      rail.classList.toggle('expanded', expanded);
      toggle.title = expanded ? 'Recolher menu' : 'Expandir menu';
    };
    apply();
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      try { localStorage.setItem('sos.rail', expanded ? '1' : '0'); } catch { /* ignora */ }
      apply();
    });
  }

  const escDiv = document.createElement('div');
  function esc(value) {
    escDiv.textContent = value == null ? '' : String(value);
    return escDiv.innerHTML;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
  }

  function formatPhone(waId) {
    const d = String(waId || '').replace(/\D/g, '');
    if (d.startsWith('55') && d.length >= 12) {
      const ddd = d.slice(2, 4), rest = d.slice(4);
      return `+55 (${ddd}) ${rest.length === 9 ? rest.slice(0, 5) + '-' + rest.slice(5) : rest.slice(0, 4) + '-' + rest.slice(4)}`;
    }
    return d ? `+${d}` : '';
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Ontem';
    if (now - d < 6 * 24 * 3600 * 1000) return d.toLocaleDateString('pt-BR', { weekday: 'short' });
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function fmtClock(iso) {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDay(iso) {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Hoje';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Ontem';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  function fmtDuration(seconds) {
    if (seconds == null || Number.isNaN(Number(seconds))) return '—';
    const s = Math.max(0, Math.round(Number(seconds)));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}min ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}min`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  let toastTimer;
  function toast(msg, isError) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('error', Boolean(isError));
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  async function loadMe() {
    const { user } = await api('GET', '/api/auth/me');
    window.ME = user;
    const nameEl = document.getElementById('me-name');
    const roleEl = document.getElementById('me-role');
    const avEl = document.getElementById('me-avatar');
    if (nameEl) nameEl.textContent = user.name;
    if (roleEl) roleEl.textContent = user.role === 'admin' ? 'Administrador' : 'Atendente';
    if (avEl) {
      avEl.textContent = initials(user.name);
      if (user.avatar_media_id) avEl.insertAdjacentHTML('beforeend', `<img class="av-img" src="/api/media/${esc(user.avatar_media_id)}?v=${Date.now()}" alt="">`);
    }
    document.querySelectorAll('[data-admin-only]').forEach((el) => { el.hidden = user.role !== 'admin'; });
    const logout = document.getElementById('logout');
    if (logout) logout.addEventListener('click', async () => { await api('POST', '/api/auth/logout'); location.href = '/login.html'; });
    const railName = document.getElementById('rail-user-name');
    if (railName) railName.textContent = user.name;
    initRail();
    // Páginas sem campo de texto podem recarregar a qualquer momento; a inbox passa a própria regra depois
    if (!document.getElementById('compose-text')) initUpdater(() => true);
    return user;
  }

  /**
   * Atualização automática após deploy: compara a versão do servidor com a carregada.
   * `canReloadNow()` diz se é seguro recarregar sozinho (nada sendo digitado); senão mostra uma faixa com botão.
   */
  const updater = { version: null, timer: null, banner: null, pending: false };
  async function checkVersion(canReloadNow) {
    try {
      const res = await fetch('/health', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      const { version } = await res.json();
      if (!version) return;
      if (!updater.version) { updater.version = version; return; }
      if (version === updater.version || updater.pending) return;
      updater.pending = true;
      if (!canReloadNow || canReloadNow()) {
        toast('Nova versão do SOS Chat, atualizando…');
        setTimeout(() => location.reload(), 1200);
      } else {
        showUpdateBanner();
      }
    } catch { /* offline ou deploy em andamento: tenta na próxima */ }
  }
  function showUpdateBanner() {
    if (updater.banner) return;
    const el = document.createElement('div');
    el.className = 'update-banner';
    el.innerHTML = '<span>Nova versão do SOS Chat disponível.</span><button type="button">Atualizar agora</button>';
    el.querySelector('button').addEventListener('click', () => location.reload());
    document.body.appendChild(el);
    updater.banner = el;
  }
  function initUpdater(canReloadNow) {
    checkVersion(canReloadNow);
    clearInterval(updater.timer);
    updater.timer = setInterval(() => checkVersion(canReloadNow), 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(canReloadNow); });
    window.addEventListener('focus', () => checkVersion(canReloadNow));
  }

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // Botao "mostrar senha" em qualquer campo .pw-wrap (login, novo atendente, trocar senha)
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const EYE_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.pw-toggle');
    if (!btn) return;
    const input = btn.parentElement.querySelector('input');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.classList.toggle('on', show);
    btn.innerHTML = show ? EYE_OFF : EYE_ON;
    btn.title = show ? 'Ocultar senha' : 'Mostrar senha';
    input.focus();
  });

  window.SOS = { api, upload, esc, initials, formatPhone, fmtTime, fmtClock, fmtDay, fmtDuration, fmtBytes, toast, loadMe, initRail, initUpdater, checkVersion };
})();
