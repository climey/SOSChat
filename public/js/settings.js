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

  // ---------- Integração ----------
  async function loadIntegration() {
    try {
      const h = await api('GET', '/health');
      $('wa-status').textContent = h.whatsapp === 'configured'
        ? 'WhatsApp Cloud API configurada. Mensagens enviadas vão para o número oficial.'
        : 'Modo simulado: credenciais do WhatsApp não configuradas. Envios são apenas registrados no log.';
      $('webhook-url').textContent = `${location.origin}/webhook/whatsapp`;
    } catch { $('wa-status').textContent = 'Não foi possível verificar.'; }
  }

  async function init() {
    me = await SOS.loadMe();
    await Promise.all([loadTags(), loadUsers(), loadIntegration()]);
  }
  init().catch((err) => toast(err.message, true));
})();
