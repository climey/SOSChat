/* Configurações: tags, atendentes e status da integração */
(function () {
  const { api, esc, toast } = SOS;
  const $ = (id) => document.getElementById(id);
  let me = null;

  // ---------- Tags ----------
  let allTags = [];
  async function loadTags() {
    const { tags } = await api('GET', '/api/tags');
    allTags = tags;
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
  let sectorOptions = [];
  async function loadUsers() {
    const admin = me.role === 'admin';
    const [{ users }, sec] = await Promise.all([api('GET', `/api/users${admin ? '?all=1' : ''}`), api('GET', '/api/sectors').catch(() => ({ sectors: [] }))]);
    sectorOptions = sec.sectors || [];
    const sectorSel = (u) => `<select class="select select-sm" data-field="sector_id" ${admin ? '' : 'disabled'}><option value="">Qualquer setor</option>${sectorOptions.map((s) => `<option value="${s.id}" ${u.sector_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
    $('users-table').innerHTML = `
      <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Status</th><th title="Entra na distribuição automática de conversas novas">Recebe novas</th><th title="Setor do atendente (distribuição por setor e transferências)">Setor</th>${admin ? '<th></th>' : ''}</tr></thead>
      <tbody>${users.map((u) => `<tr data-id="${u.id}" data-name="${esc(u.name)}">
        <td>${esc(u.name)}</td><td class="muted">${esc(u.email)}</td>
        <td>${u.role === 'admin' ? 'Admin' : 'Atendente'}</td>
        <td>${u.active ? '<span class="status-pill open">Ativo</span>' : '<span class="status-pill resolved">Inativo</span>'}</td>
        <td><input type="checkbox" data-field="receives_new" ${u.receives_new !== false ? 'checked' : ''} ${admin ? '' : 'disabled'} title="Desmarque para quem só recebe por transferência (ex.: pós-venda)"></td>
        <td>${sectorSel(u)}</td>
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

  $('users-table').addEventListener('change', async (e) => {
    const el = e.target.closest('[data-field]');
    if (!el) return;
    const id = el.closest('tr').dataset.id;
    const body = el.dataset.field === 'receives_new' ? { receives_new: el.checked } : { sector_id: el.value ? Number(el.value) : null };
    try { await api('PATCH', `/api/users/${id}`, body); toast('Atualizado'); } catch (err) { toast(err.message, true); loadUsers(); }
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
          ${multi && a.id ? (isAdmin
            ? `<label class="wa-autotag">Etiqueta automática nas conversas novas <select class="select" data-autotag="${a.id}"><option value="">Nenhuma</option>${allTags.map((t) => `<option value="${t.id}" ${a.auto_tag_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>`
            : (a.auto_tag_id ? `<div class="wa-autotag">Etiqueta automática: <b>${esc((allTags.find((t) => t.id === a.auto_tag_id) || {}).name || '')}</b></div>` : '')) : ''}
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

  $('wa-accounts').addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-autotag]');
    if (!sel) return;
    try {
      await api('PATCH', `/api/whatsapp/accounts/${sel.dataset.autotag}`, { auto_tag_id: sel.value ? Number(sel.value) : null });
      toast(sel.value ? 'Etiqueta automática definida' : 'Etiqueta automática desligada');
    } catch (err) { toast(err.message, true); loadIntegration(); }
  });

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

  // ---------- Respostas rápidas ----------
  let qrEditing = null;
  let quickReplies = [];
  let qrFilter = 'all';
  let qrPendingFile = null;
  const qrKindLabel = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', document: 'Documento' };
  function qrMediaCell(r) {
    if (!r.media_id) return '<span class="muted small">-</span>';
    if (r.media_kind === 'image') return `<img class="qr-thumb" src="/api/media/${esc(r.media_id)}" alt="" loading="lazy" title="${esc(r.media_name || '')}">`;
    return `<span class="qr-file" title="${esc(r.media_name || '')}">${esc(qrKindLabel[r.media_kind] || 'Arquivo')}</span>`;
  }
  async function loadQuickReplies() {
    ({ quick_replies: quickReplies } = await api('GET', '/api/quick-replies'));
    const canEdit = (r) => (r.visibility === 'personal' ? r.created_by === me.id : me.role === 'admin' || r.created_by === me.id);
    const shown = quickReplies.filter((r) => qrFilter === 'all' || (qrFilter === 'mine' ? r.visibility === 'personal' : r.visibility === 'team'));
    document.querySelectorAll('#qr-filter .chip').forEach((b) => b.classList.toggle('active', b.dataset.qrfilter === qrFilter));
    $('qr-table').innerHTML = `
      <thead><tr><th>Atalho</th><th>Título</th><th>Mídia</th><th>Texto</th><th>Visível para</th><th>Criada por</th><th></th></tr></thead>
      <tbody>${shown.map((r) => `<tr data-id="${r.id}">
        <td><code>/${esc(r.shortcut)}</code></td><td>${esc(r.title)}</td>
        <td>${qrMediaCell(r)}</td>
        <td class="muted" style="max-width:280px;white-space:pre-wrap">${esc(r.body || '')}</td>
        <td>${r.visibility === 'personal' ? '<span class="tag new">Só eu</span>' : '<span class="tag">Equipe</span>'}</td>
        <td class="muted small">${esc(r.created_by_name || 'sistema')}</td>
        <td class="row-actions">${canEdit(r) ? '<button class="btn btn-sm" data-act="edit">Editar</button><button class="btn btn-sm btn-ghost" data-act="del">Excluir</button>' : ''}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">Nenhuma resposta rápida</td></tr>'}</tbody>`;
  }
  $('qr-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-qrfilter]');
    if (!b) return;
    qrFilter = b.dataset.qrfilter;
    loadQuickReplies();
  });
  // ---------- Setores ----------
  let sectors = [];
  async function loadSectors() {
    ({ sectors } = await api('GET', '/api/sectors'));
    const admin = me.role === 'admin';
    $('sectors-table').innerHTML = `
      <thead><tr><th>Setor</th><th class="num">Abertas</th>${admin ? '<th></th>' : ''}</tr></thead>
      <tbody>${sectors.map((s) => `<tr data-id="${s.id}">
        <td><span class="sector-chip" style="--sector-color:${esc(s.color)}"><span class="dot"></span>${esc(s.name)}</span>${s.is_default ? ' <span class="muted small">padrão</span>' : ''}</td>
        <td class="num">${s.open_count}</td>
        ${admin ? `<td class="row-actions">
          ${s.is_default ? '' : '<button class="btn btn-sm" data-act="default">Tornar padrão</button>'}
          <button class="btn btn-sm" data-act="edit" data-name="${esc(s.name)}" data-color="${esc(s.color)}">Editar</button>
          ${s.is_default ? '' : '<button class="btn btn-sm btn-ghost" data-act="del">Excluir</button>'}</td>` : ''}
      </tr>`).join('')}</tbody>`;
  }
  $('sector-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/sectors', { name: $('sector-name').value, color: $('sector-color').value });
      $('sector-name').value = '';
      toast('Setor criado');
      loadSectors();
    } catch (err) { toast(err.message, true); }
  });
  $('sectors-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    try {
      if (btn.dataset.act === 'del') {
        if (!confirm('Excluir este setor? As conversas dele voltam para o setor padrão.')) return;
        await api('DELETE', `/api/sectors/${id}`);
        toast('Setor excluído');
      } else if (btn.dataset.act === 'default') {
        await api('PATCH', `/api/sectors/${id}`, { is_default: true });
        toast('Setor padrão alterado');
      } else {
        const name = prompt('Nome do setor:', btn.dataset.name);
        if (name === null) return;
        const color = prompt('Cor (#RRGGBB):', btn.dataset.color);
        if (color === null) return;
        await api('PATCH', `/api/sectors/${id}`, { name, color });
        toast('Setor atualizado');
      }
      loadSectors();
    } catch (err) { toast(err.message, true); }
  });
  function qrShowMedia(r) {
    const has = Boolean(r && r.media_id);
    $('qr-media-info').textContent = qrPendingFile ? `${qrPendingFile.name} (será enviada ao salvar)` : (has ? `${r.media_name || 'Mídia'} · ${qrKindLabel[r.media_kind] || ''}` : 'Nenhuma mídia anexada');
    $('qr-media-remove').hidden = !has && !qrPendingFile;
  }
  function resetQrForm() {
    qrEditing = null;
    qrPendingFile = null;
    $('qr-form').reset();
    $('qr-file').value = '';
    $('qr-submit').textContent = 'Adicionar';
    $('qr-cancel').hidden = true;
    qrShowMedia(null);
  }
  $('qr-pick').addEventListener('click', () => $('qr-file').click());
  $('qr-file').addEventListener('change', () => {
    const f = $('qr-file').files[0];
    if (!f) return;
    if (f.size > 16 * 1024 * 1024) { toast('Arquivo acima de 16 MB', true); $('qr-file').value = ''; return; }
    qrPendingFile = f;
    qrShowMedia(quickReplies.find((x) => x.id === qrEditing) || null);
  });
  $('qr-media-remove').addEventListener('click', async () => {
    if (qrPendingFile) { qrPendingFile = null; $('qr-file').value = ''; qrShowMedia(quickReplies.find((x) => x.id === qrEditing) || null); return; }
    if (!qrEditing) return;
    if (!confirm('Remover a mídia desta resposta?')) return;
    try { await api('DELETE', `/api/quick-replies/${qrEditing}/media`); toast('Mídia removida'); await loadQuickReplies(); qrShowMedia(quickReplies.find((x) => x.id === qrEditing) || null); }
    catch (err) { toast(err.message, true); }
  });
  $('qr-cancel').addEventListener('click', resetQrForm);
  $('qr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = { shortcut: $('qr-shortcut').value, title: $('qr-title').value, body: $('qr-body').value, visibility: $('qr-visibility').value };
    if (!payload.body.trim() && !qrPendingFile && !(qrEditing && quickReplies.find((x) => x.id === qrEditing)?.media_id)) { toast('Escreva o texto ou anexe uma mídia', true); return; }
    try {
      let saved;
      if (qrEditing) ({ quick_reply: saved } = await api('PATCH', `/api/quick-replies/${qrEditing}`, payload));
      else ({ quick_reply: saved } = await api('POST', '/api/quick-replies', payload));
      if (qrPendingFile) {
        const fd = new FormData();
        fd.append('file', qrPendingFile, qrPendingFile.name);
        await SOS.upload(`/api/quick-replies/${saved.id}/media`, fd);
      }
      toast(qrEditing ? 'Resposta atualizada' : 'Resposta criada');
      resetQrForm();
      loadQuickReplies();
    } catch (err) { toast(err.message, true); }
  });
  $('qr-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('tr').dataset.id);
    const r = quickReplies.find((x) => x.id === id);
    try {
      if (btn.dataset.act === 'edit') {
        qrEditing = id;
        qrPendingFile = null;
        $('qr-file').value = '';
        $('qr-shortcut').value = r.shortcut; $('qr-title').value = r.title; $('qr-body').value = r.body || ''; $('qr-visibility').value = r.visibility || 'team';
        $('qr-submit').textContent = 'Salvar'; $('qr-cancel').hidden = false; $('qr-body').focus();
        qrShowMedia(r);
        return;
      }
      if (!confirm(`Excluir a resposta /${r.shortcut}?`)) return;
      await api('DELETE', `/api/quick-replies/${id}`);
      toast('Resposta excluída');
      loadQuickReplies();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Distribuição ----------
  async function loadDistribution() {
    const { settings } = await api('GET', '/api/settings');
    $('dist-enabled').checked = Boolean(settings.distribution_enabled);
    $('dist-limit').value = settings.distribution_waiting_limit ?? 5;
    $('dist-affinity').checked = settings.distribution_affinity !== false;
    $('dist-handoff').checked = settings.distribution_handoff !== false;
    $('dist-grace').value = settings.distribution_offline_grace_seconds ?? 120;
    const ro = me.role !== 'admin';
    for (const id of ['dist-enabled', 'dist-limit', 'dist-affinity', 'dist-handoff', 'dist-grace']) $(id).disabled = ro;
    try {
      const st = await api('GET', '/api/settings/distribution');
      $('dist-status').innerHTML = st.enabled
        ? `<b>Ligada.</b> ${st.queued} conversa(s) na fila · elegíveis agora: ${st.eligible.length ? st.eligible.map((u) => `${esc(u.name)} (${u.waiting} esperando)`).join(', ') : 'ninguém (todos offline, ausentes ou no limite)'}`
        : `<b>Desligada.</b> ${st.queued} conversa(s) sem responsável no momento.`;
    } catch { $('dist-status').textContent = ''; }
  }
  $('dist-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', { distribution_enabled: $('dist-enabled').checked, distribution_waiting_limit: Number($('dist-limit').value), distribution_affinity: $('dist-affinity').checked, distribution_handoff: $('dist-handoff').checked, distribution_offline_grace_seconds: Number($('dist-grace').value) });
      toast('Distribuição salva');
      loadDistribution();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Alerta de conversa parada ----------
  async function loadSla() {
    const { settings } = await api('GET', '/api/settings');
    $('sla-warn').value = settings.sla_warn_minutes ?? 5;
    $('sla-alert').value = settings.sla_alert_minutes ?? 15;
    const ro = me.role !== 'admin';
    $('sla-warn').disabled = ro; $('sla-alert').disabled = ro;
  }
  $('sla-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const warn = Number($('sla-warn').value), alert = Number($('sla-alert').value);
    if (alert <= warn) return toast('O limite vermelho deve ser maior que o amarelo', true);
    try { await api('PUT', '/api/settings', { sla_warn_minutes: warn, sla_alert_minutes: alert }); toast('Limites salvos'); }
    catch (err) { toast(err.message, true); }
  });

  // ---------- Navegação por seção ----------
  const SECTIONS = ['numeros', 'atendentes', 'setores', 'etiquetas', 'respostas', 'planos', 'recorrencia', 'preconsulta', 'distribuicao', 'alertas'];
  // ---------- Planos de consultas ----------
  let plans = [];
  let planEditing = null;
  const money = (c) => (c == null ? '' : 'R$ ' + (c / 100).toFixed(2).replace('.', ','));
  async function loadPlans() {
    ({ plans } = await api('GET', '/api/plans'));
    const admin = me.role === 'admin';
    $('plans-table').innerHTML = `
      <thead><tr><th>Plano</th><th class="num">Consultas</th><th class="num">Validade</th><th class="num">Preço</th><th class="num">Clientes</th><th>Situação</th>${admin ? '<th></th>' : ''}</tr></thead>
      <tbody>${plans.map((p) => `<tr data-id="${p.id}" class="${p.active ? '' : 'muted'}">
        <td><b>${esc(p.name)}</b></td>
        <td class="num">${p.credits}</td>
        <td class="num">${p.validity_days ? p.validity_days + ' dias' : 'sem vencimento'}</td>
        <td class="num">${esc(money(p.price_cents)) || '-'}</td>
        <td class="num">${p.contacts_count}</td>
        <td>${p.active ? '<span class="status-pill open">Ativo</span>' : '<span class="status-pill resolved">Inativo</span>'}</td>
        ${admin ? `<td class="row-actions">
          <button class="btn btn-sm" data-act="edit">Editar</button>
          <button class="btn btn-sm" data-act="toggle">${p.active ? 'Desativar' : 'Ativar'}</button>
          <button class="btn btn-sm btn-ghost" data-act="del">Excluir</button></td>` : ''}
      </tr>`).join('') || '<tr><td colspan="7" class="muted">Nenhum plano cadastrado</td></tr>'}</tbody>`;
  }
  let kinds = [];
  function renderKinds() {
    const admin = me.role === 'admin';
    $('kinds-list').innerHTML = kinds.map((k) => `<span class="chip kind-chip">${esc(k)}${admin ? `<button type="button" class="kind-x" data-kind="${esc(k)}" title="Remover tipo">&times;</button>` : ''}</span>`).join('') || '<span class="muted small">Nenhum tipo cadastrado</span>';
  }
  async function loadKinds() {
    const { settings } = await api('GET', '/api/settings');
    kinds = Array.isArray(settings.consultation_kinds) ? settings.consultation_kinds : [];
    renderKinds();
  }
  async function saveKinds(next) {
    const { settings } = await api('PUT', '/api/settings', { consultation_kinds: next });
    kinds = settings.consultation_kinds;
    renderKinds();
  }
  $('kind-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('kind-name').value.trim();
    if (!name) return;
    if (kinds.some((k) => k.toLowerCase() === name.toLowerCase())) return toast('Esse tipo já existe', true);
    try { await saveKinds([...kinds, name]); $('kind-name').value = ''; toast('Tipo adicionado'); }
    catch (err) { toast(err.message, true); }
  });
  $('kinds-list').addEventListener('click', async (e) => {
    const b = e.target.closest('.kind-x');
    if (!b) return;
    if (kinds.length <= 1) return toast('Deixe pelo menos um tipo', true);
    if (!confirm(`Remover o tipo "${b.dataset.kind}"?`)) return;
    try { await saveKinds(kinds.filter((k) => k !== b.dataset.kind)); toast('Tipo removido'); }
    catch (err) { toast(err.message, true); }
  });
  const REC_FIELDS = {
    'rec-occasional': 'recurrence_occasional_credits',
    'rec-rec-credits': 'recurrence_recurrent_credits',
    'rec-rec-purchases': 'recurrence_recurrent_purchases',
    'rec-rec-span': 'recurrence_recurrent_span_days',
    'rec-loyal-credits': 'recurrence_loyal_credits',
    'rec-loyal-purchases': 'recurrence_loyal_purchases',
    'rec-loyal': 'recurrence_loyal_months',
    'rec-inactive': 'recurrence_inactive_days',
  };
  async function loadRecurrence() {
    const { settings } = await api('GET', '/api/settings');
    const ro = me.role !== 'admin';
    for (const [id, key] of Object.entries(REC_FIELDS)) { $(id).value = settings[key]; $(id).disabled = ro; }
  }
  $('rec-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const [id, key] of Object.entries(REC_FIELDS)) body[key] = Number($(id).value);
    if (body.recurrence_loyal_credits < body.recurrence_recurrent_credits) return toast('Fiel precisa exigir pelo menos tantas consultas quanto Recorrente', true);
    if (body.recurrence_loyal_purchases < body.recurrence_recurrent_purchases) return toast('Fiel precisa exigir pelo menos tantas compras quanto Recorrente', true);
    if (body.recurrence_recurrent_credits < body.recurrence_occasional_credits) return toast('Recorrente precisa exigir mais consultas que Ocasional', true);
    try { await api('PUT', '/api/settings', body); toast('Regras salvas'); }
    catch (err) { toast(err.message, true); }
  });
  // ---------- Pré-consulta de placa ----------
  let vehDefaultTemplate = '';
  async function loadVehicle() {
    const { settings } = await api('GET', '/api/settings');
    $('veh-mode').value = settings.vehicle_lookup_mode || 'suggest';
    if (settings.image_read_available === false) $('img-mode-note').textContent = 'A leitura de fotos ainda não está configurada no servidor (chave da API). Até lá, o botão "Ler imagem" avisa que não está disponível.';
    $('veh-template').value = settings.vehicle_preview_template || '';
    $('veh-fix-template').value = settings.vehicle_fix_template || '';
    vehDefaultTemplate = settings.vehicle_preview_template_default || vehDefaultTemplate;
    const ro = me.role !== 'admin';
    $('veh-mode').disabled = ro; $('veh-template').disabled = ro; $('veh-fix-template').disabled = ro; $('veh-reset').hidden = ro;
  }
  $('veh-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/settings', { vehicle_lookup_mode: $('veh-mode').value, vehicle_preview_template: $('veh-template').value, vehicle_fix_template: $('veh-fix-template').value }); toast('Pré-consulta salva'); }
    catch (err) { toast(err.message, true); }
  });
  $('veh-reset').addEventListener('click', async () => {
    try {
      const { settings } = await api('GET', '/api/settings?defaults=1');
      $('veh-template').value = settings.vehicle_preview_template_default || $('veh-template').value;
      $('veh-fix-template').value = settings.vehicle_fix_template_default || $('veh-fix-template').value;
    } catch (err) { toast(err.message, true); }
  });
  $('veh-test-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('veh-test-out');
    out.hidden = false; out.textContent = 'Buscando…';
    try {
      const v = await api('GET', `/api/vehicles/${encodeURIComponent($('veh-test-plate').value)}/resolve`);
      const lk = v.lookup;
      if (lk && lk.status === 'found') out.textContent = `${lk.cached ? '(do cache) ' : ''}${JSON.stringify(lk.data.fields, null, 2)}\n\n--- mensagem que o cliente receberia ---\n${lk.message}`;
      else if (v.alternatives && v.alternatives.length) out.textContent = `${v.valid ? 'Formato certo, mas não existe na base.' : 'Formato errado: ' + v.errors.join('; ')}\nCorreções que existem na base:\n` + v.alternatives.map((a) => `  ${a.ref} → ${a.data.fields.marca} ${a.data.fields.modelo} ${a.data.fields.ano || ''}`).join('\n') + `\n\n--- mensagem que o cliente receberia ---\n${v.alternatives[0].message}`;
      else if (lk && lk.status === 'error') out.textContent = `Erro: ${lk.error || 'não foi possível buscar'}`;
      else out.textContent = (v.valid ? 'Veículo não encontrado na base.' : 'Formato errado: ' + v.errors.join('; ')) + (v.tested && v.tested.length ? ` Também testei ${v.tested.join(', ')}: nada.` : '');
    } catch (err) { out.textContent = 'Erro: ' + err.message; }
  });
  function resetPlanForm() {
    planEditing = null;
    $('plan-form').reset();
    $('plan-submit').textContent = 'Adicionar';
    $('plan-cancel').hidden = true;
  }
  $('plan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('plan-name').value, credits: Number($('plan-credits').value),
      validity_days: $('plan-days').value ? Number($('plan-days').value) : null,
      price_cents: $('plan-price').value ? Math.round(Number($('plan-price').value) * 100) : null,
    };
    try {
      if (planEditing) { await api('PATCH', `/api/plans/${planEditing}`, body); toast('Plano atualizado'); }
      else { await api('POST', '/api/plans', body); toast('Plano criado'); }
      resetPlanForm();
      loadPlans();
    } catch (err) { toast(err.message, true); }
  });
  $('plan-cancel').addEventListener('click', resetPlanForm);
  $('plans-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('tr').dataset.id);
    const p = plans.find((x) => x.id === id);
    try {
      if (btn.dataset.act === 'edit') {
        planEditing = id;
        $('plan-name').value = p.name; $('plan-credits').value = p.credits;
        $('plan-days').value = p.validity_days || ''; $('plan-price').value = p.price_cents != null ? (p.price_cents / 100).toFixed(2) : '';
        $('plan-submit').textContent = 'Salvar'; $('plan-cancel').hidden = false; $('plan-name').focus();
        return;
      }
      if (btn.dataset.act === 'toggle') { await api('PATCH', `/api/plans/${id}`, { active: !p.active }); toast(p.active ? 'Plano desativado' : 'Plano ativado'); }
      else if (btn.dataset.act === 'del') {
        if (!confirm(`Excluir o plano "${p.name}" do catálogo? Clientes que já têm esse plano continuam com o saldo deles.`)) return;
        await api('DELETE', `/api/plans/${id}`); toast('Plano excluído');
      }
      loadPlans();
    } catch (err) { toast(err.message, true); }
  });

  function showSection(name) {
    const s = SECTIONS.includes(name) ? name : 'numeros';
    document.querySelectorAll('.settings-section').forEach((el) => { el.hidden = el.dataset.section !== s; });
    document.querySelectorAll('#settings-nav a').forEach((a) => a.classList.toggle('active', a.dataset.section === s));
    if (location.hash !== `#${s}`) history.replaceState(null, '', `#${s}`);
  }
  window.addEventListener('hashchange', () => showSection(location.hash.slice(1)));
  showSection(location.hash.slice(1));

  async function init() {
    me = await SOS.loadMe();
    await loadTags();
    await Promise.all([loadUsers(), loadIntegration(), loadQuickReplies(), loadSla(), loadSectors(), loadPlans(), loadKinds(), loadRecurrence(), loadVehicle(), loadDistribution()]);
  }
  init().catch((err) => toast(err.message, true));
})();
