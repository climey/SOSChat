/* Configurações: tags, atendentes e status da integração */
(function () {
  const { api, esc, toast } = SOS;
  const $ = (id) => document.getElementById(id);
  let me = null;

  // ---------- Tags ----------
  async function loadTags() {
    const { tags } = await api('GET', '/api/tags');
    const admin = me.role === 'admin';
    $('tags-table').innerHTML = `
      <thead><tr><th>Tag</th><th class="num">Em uso</th>${admin ? '<th></th>' : ''}</tr></thead>
      <tbody>${tags.map((t) => `<tr data-id="${t.id}">
        <td><span class="tag" style="color:${esc(t.color)}"><i class="dot"></i>${esc(t.name)}</span></td>
        <td class="num">${t.usage_count}</td>
        ${admin ? `<td class="row-actions">
          <button class="btn btn-sm" data-act="edit" data-name="${esc(t.name)}" data-color="${esc(t.color)}">Editar</button>
          <button class="btn btn-sm btn-ghost" data-act="del">Excluir</button></td>` : ''}
      </tr>`).join('') || '<tr><td colspan="3" class="muted">Nenhuma tag</td></tr>'}</tbody>`;
  }

  $('tag-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/tags', { name: $('tag-name').value, color: $('tag-color').value });
      $('tag-name').value = '';
      toast('Tag criada');
      loadTags();
    } catch (err) { toast(err.message, true); }
  });

  $('tags-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    try {
      if (btn.dataset.act === 'del') {
        if (!confirm('Excluir esta tag? Ela será removida de todas as conversas.')) return;
        await api('DELETE', `/api/tags/${id}`);
        toast('Tag excluída');
      } else {
        const name = prompt('Nome da tag:', btn.dataset.name);
        if (name === null) return;
        const color = prompt('Cor (#RRGGBB):', btn.dataset.color);
        if (color === null) return;
        await api('PATCH', `/api/tags/${id}`, { name, color });
        toast('Tag atualizada');
      }
      loadTags();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Usuários ----------
  async function loadUsers() {
    const admin = me.role === 'admin';
    const { users } = await api('GET', `/api/users${admin ? '?all=1' : ''}`);
    $('users-table').innerHTML = `
      <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Status</th>${admin ? '<th></th>' : ''}</tr></thead>
      <tbody>${users.map((u) => `<tr data-id="${u.id}" data-name="${esc(u.name)}">
        <td>${esc(u.name)}</td><td class="muted">${esc(u.email)}</td>
        <td>${u.role === 'admin' ? 'Admin' : 'Atendente'}</td>
        <td>${u.active ? '<span class="status-pill open">Ativo</span>' : '<span class="status-pill resolved">Inativo</span>'}</td>
        ${admin ? `<td class="row-actions">
          <button class="btn btn-sm" data-act="pw">Senha</button>
          <button class="btn btn-sm" data-act="role" data-role="${u.role}">${u.role === 'admin' ? 'Tornar atendente' : 'Tornar admin'}</button>
          <button class="btn btn-sm btn-ghost" data-act="toggle" data-active="${u.active}">${u.active ? 'Desativar' : 'Ativar'}</button></td>` : ''}
      </tr>`).join('')}</tbody>`;
  }

  $('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/users', {
        name: $('user-name').value, email: $('user-email').value,
        password: $('user-password').value, role: $('user-role').value,
      });
      $('user-form').reset();
      toast('Atendente criado');
      loadUsers();
    } catch (err) { toast(err.message, true); }
  });

  let pwUserId = null;
  $('users-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    try {
      if (btn.dataset.act === 'pw') {
        pwUserId = id;
        $('pw-user').textContent = tr.dataset.name;
        $('pw-value').value = '';
        $('pw-modal').hidden = false;
        $('pw-value').focus();
        return;
      }
      if (btn.dataset.act === 'role') {
        await api('PATCH', `/api/users/${id}`, { role: btn.dataset.role === 'admin' ? 'agent' : 'admin' });
      } else if (btn.dataset.act === 'toggle') {
        await api('PATCH', `/api/users/${id}`, { active: btn.dataset.active !== 'true' });
      }
      toast('Atualizado');
      loadUsers();
    } catch (err) { toast(err.message, true); }
  });
  $('pw-cancel').addEventListener('click', () => { $('pw-modal').hidden = true; });
  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/api/users/${pwUserId}`, { password: $('pw-value').value });
      $('pw-modal').hidden = true;
      toast('Senha redefinida');
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Integração WhatsApp ----------
  const WA_LABELS = {
    connected: ['open', 'Conectado'],
    qr: ['resolved', 'Aguardando leitura do QR code'],
    connecting: ['resolved', 'Conectando…'],
    reconnecting: ['resolved', 'Reconectando…'],
    disconnected: ['resolved', 'Desconectado'],
    off: ['resolved', 'Desligado'],
    mock: ['resolved', 'Modo simulado'],
  };
  let waTimer = null;
  let waAccounts = [];

  function accountCard(a, isAdmin, multi) {
    const [cls, label] = WA_LABELS[a.status] || ['resolved', a.status];
    return `
      <div class="wa-account" data-id="${a.id ?? ''}">
        <div class="info">
          <div class="title">${esc(a.name)} <span class="status-pill ${cls}">${esc(label)}</span></div>
          <div class="phone">${a.phone ? esc(a.phone) : 'Número aparece após conectar'}</div>
          ${a.lastError ? `<div class="err">${esc(a.lastError)}</div>` : ''}
          ${isAdmin && multi ? `<div class="actions">
            <button class="btn btn-sm" data-act="rename">Renomear</button>
            <button class="btn btn-sm" data-act="reconnect">Reconectar</button>
            <button class="btn btn-sm btn-ghost" data-act="logout">Desconectar</button>
            <button class="btn btn-sm btn-ghost" data-act="remove">Remover</button>
          </div>` : ''}
        </div>
        ${a.hasQr && isAdmin ? `<div class="qr"><img data-qr="${a.id}" alt="QR code"><div class="hint">Celular: WhatsApp → Dispositivos conectados → Conectar dispositivo</div></div>` : ''}
      </div>`;
  }

  async function loadIntegration() {
    let st;
    try {
      st = await api('GET', '/api/whatsapp/status');
    } catch {
      $('wa-help').textContent = 'Não foi possível verificar o status.';
      return;
    }
    const isAdmin = me.role === 'admin';
    const multi = st.provider === 'baileys';
    waAccounts = st.accounts || [];

    $('wa-help').innerHTML = multi
      ? 'Cada número tem sua própria sessão. Todos os atendentes veem as conversas de todos os números, e a resposta sai pelo número por onde o cliente falou.'
      : `Provedor oficial (Cloud API da Meta). Para usar vários números por QR code, defina <code>WA_PROVIDER=baileys</code>. Webhook: <code>${esc(location.origin)}/webhook/whatsapp</code>`;
    $('wa-add-form').hidden = !(isAdmin && multi);

    $('wa-accounts').innerHTML = waAccounts.length
      ? waAccounts.map((a) => accountCard(a, isAdmin, multi)).join('')
      : '<div class="muted small">Nenhum número cadastrado. Adicione um acima para gerar o QR code.</div>';
    if (isAdmin) loadOrphans();

    // Carrega as imagens de QR dos números aguardando leitura
    await Promise.all([...document.querySelectorAll('img[data-qr]')].map(async (img) => {
      try {
        const { qr } = await api('GET', `/api/whatsapp/accounts/${img.dataset.qr}/qr`);
        img.src = qr;
      } catch { img.closest('.qr')?.remove(); }
    }));

    clearTimeout(waTimer);
    if (multi && waAccounts.some((a) => a.status !== 'connected')) waTimer = setTimeout(loadIntegration, 3000);
  }

  async function loadOrphans() {
    try {
      const { count } = await api('GET', '/api/whatsapp/orphans');
      const box = $('wa-orphans');
      box.hidden = count === 0;
      $('wa-orphans-count').textContent = count;
    } catch { /* ignora */ }
  }
  $('wa-orphans-delete').addEventListener('click', async () => {
    const n = $('wa-orphans-count').textContent;
    if (!confirm(`Apagar ${n} conversa(s) de números removidos, com todo o histórico de mensagens e arquivos? Isso não pode ser desfeito.`)) return;
    try {
      const { deleted } = await api('DELETE', '/api/whatsapp/orphans');
      toast(`${deleted} conversa(s) apagada(s)`);
      loadOrphans();
    } catch (err) { toast(err.message, true); }
  });

  $('wa-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/whatsapp/accounts', { name: $('wa-add-name').value });
      $('wa-add-name').value = '';
      toast('Número adicionado, gerando QR code…');
      setTimeout(loadIntegration, 800);
    } catch (err) { toast(err.message, true); }
  });

  $('wa-accounts').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.wa-account');
    const id = card.dataset.id;
    const acc = waAccounts.find((a) => String(a.id) === id);
    try {
      if (btn.dataset.act === 'rename') {
        const name = prompt('Nome do número:', acc?.name || '');
        if (name === null || !name.trim()) return;
        await api('PATCH', `/api/whatsapp/accounts/${id}`, { name });
        toast('Renomeado');
      } else if (btn.dataset.act === 'reconnect') {
        await api('POST', `/api/whatsapp/accounts/${id}/reconnect`);
        toast('Reconectando…');
      } else if (btn.dataset.act === 'logout') {
        if (!confirm(`Desconectar "${acc?.name}"? Será preciso ler o QR code de novo.`)) return;
        await api('POST', `/api/whatsapp/accounts/${id}/logout`);
        toast('Sessão encerrada');
      } else if (btn.dataset.act === 'remove') {
        if (!confirm(`Remover o número "${acc?.name}"?`)) return;
        const wipe = confirm('Apagar também todas as conversas e mensagens desse número?\n\nOK = apagar tudo · Cancelar = manter o histórico (fica marcado como "sem número")');
        const r = await api('DELETE', `/api/whatsapp/accounts/${id}${wipe ? '?delete_conversations=1' : ''}`);
        toast(wipe ? `Número removido e ${r.deleted_conversations} conversa(s) apagada(s)` : 'Número removido');
      }
      setTimeout(loadIntegration, 1000);
    } catch (err) { toast(err.message, true); }
  });

  async function init() {
    me = await SOS.loadMe();
    await Promise.all([loadTags(), loadUsers(), loadIntegration()]);
  }
  init().catch((err) => toast(err.message, true));
})();
