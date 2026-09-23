/* Aba Contatos: lista de todos que já falaram com a empresa, busca, cadastro manual e "Conversar". */
(function () {
  const { api, esc, initials, formatPhone, toast } = SOS;
  const $ = (id) => document.getElementById(id);
  const state = { q: '', page: 1, limit: 50, total: 0, rows: [] };

  const name = (c) => c.name || c.profile_name || formatPhone(c.wa_id);
  function ago(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `há ${s} s`;
    if (s < 3600) return `há ${Math.floor(s / 60)} min`;
    if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
    if (s < 86400 * 30) return `há ${Math.floor(s / 86400)} d`;
    if (s < 86400 * 365) return `há ${Math.floor(s / (86400 * 30))} meses`;
    return `há ${Math.floor(s / (86400 * 365))} ano(s)`;
  }
  const avatar = (c) => `<div class="avatar sm">${esc(initials(name(c)))}${c.avatar_media_id ? `<img src="/api/media/${esc(c.avatar_media_id)}" alt="" loading="lazy">` : ''}</div>`;

  async function load() {
    const p = new URLSearchParams({ page: state.page, limit: state.limit });
    if (state.q) p.set('q', state.q);
    const data = await api('GET', `/api/contacts?${p}`);
    state.rows = data.contacts; state.total = data.total;
    render();
  }
  function render() {
    $('ct-total').textContent = state.total ? state.total.toLocaleString('pt-BR') : '';
    $('ct-count').textContent = state.q ? `${state.total} resultado(s) para "${state.q}"` : '';
    const t = $('ct-table');
    if (!state.rows.length) {
      t.innerHTML = `<tr><td class="muted" style="padding:24px">${state.q ? 'Nenhum contato encontrado.' : 'Ainda não há contatos: eles entram aqui sozinhos quando alguém escreve para a empresa.'}</td></tr>`;
    } else {
      t.innerHTML = `<tr><th>Contato</th><th>Telefone</th><th>Etiquetas</th><th>Criado em</th><th>Última atividade</th><th>Conversas</th><th></th></tr>` + state.rows.map((c) => `
        <tr data-id="${c.id}">
          <td><div class="ct-name">${avatar(c)}<div><div class="ct-title">${esc(name(c))}${c.blocked ? ' <span class="tag" style="color:#ff6b6b">bloqueado</span>' : ''}</div>${c.company ? `<div class="small muted">${esc(c.company)}</div>` : (c.name && c.profile_name && c.profile_name !== c.name ? `<div class="small muted">no WhatsApp: ${esc(c.profile_name)}</div>` : '')}</div></div></td>
          <td class="mono">${esc(formatPhone(c.wa_id))}</td>
          <td>${(c.tags || []).map((tg) => `<span class="tag" style="color:${esc(tg.color)}"><i class="dot"></i>${esc(tg.name)}</span>`).join(' ')}</td>
          <td title="${esc(new Date(c.created_at).toLocaleString('pt-BR'))}">${ago(c.created_at)}</td>
          <td title="${esc(c.last_message_at ? new Date(c.last_message_at).toLocaleString('pt-BR') : '')}">${ago(c.last_message_at || c.last_seen_at)}${c.assigned_user_name ? `<div class="small muted">com ${esc(c.assigned_user_name)}</div>` : ''}</td>
          <td>${c.conversations_count || 0}${c.last_conversation_status === 'open' ? ' <span class="small muted">(1 aberta)</span>' : ''}</td>
          <td class="ct-actions">
            ${c.last_conversation_id ? `<a class="btn btn-sm btn-ghost" href="/?c=${c.last_conversation_id}" title="Abrir a última conversa">Ver</a>` : ''}
            <button type="button" class="btn btn-sm btn-primary" data-chat="${c.id}" title="Abrir (ou criar) a conversa com este contato">Conversar</button>
          </td>
        </tr>`).join('');
    }
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    $('ct-pager').innerHTML = pages > 1 ? `<button class="btn btn-sm" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>‹ Anterior</button><span class="small muted">Página ${state.page} de ${pages}</span><button class="btn btn-sm" data-page="${state.page + 1}" ${state.page >= pages ? 'disabled' : ''}>Próxima ›</button>` : '';
  }

  async function startChat(waId, name) {
    try {
      const { conversation } = await api('POST', '/api/conversations/start', { wa_id: waId, name: name || null });
      location.href = `/?c=${conversation.id}`;
    } catch (err) { toast(err.message, true); }
  }

  let timer = null;
  $('ct-search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = $('ct-search').value.trim(); state.page = 1; load().catch((e) => toast(e.message, true)); }, 250); });
  $('ct-table').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chat]');
    if (!b) return;
    const c = state.rows.find((x) => x.id === Number(b.dataset.chat));
    if (c) startChat(c.wa_id, c.name);
  });
  $('ct-pager').addEventListener('click', (e) => { const b = e.target.closest('[data-page]'); if (b && !b.disabled) { state.page = Number(b.dataset.page); load().catch((er) => toast(er.message, true)); } });

  // cadastro manual
  $('btn-add-contact').addEventListener('click', () => { $('add-form').reset(); $('add-modal').hidden = false; $('add-name').focus(); });
  $('add-cancel').addEventListener('click', () => { $('add-modal').hidden = true; });
  async function saveContact() {
    const { contact } = await api('POST', '/api/contacts', { name: $('add-name').value, phone: $('add-phone').value });
    $('add-modal').hidden = true;
    toast(contact.created ? 'Contato cadastrado' : 'Este número já estava cadastrado');
    return contact;
  }
  $('add-form').addEventListener('submit', async (e) => { e.preventDefault(); try { await saveContact(); state.q = ''; $('ct-search').value = ''; state.page = 1; await load(); } catch (err) { toast(err.message, true); } });
  $('add-and-chat').addEventListener('click', async () => {
    if (!$('add-form').reportValidity()) return;
    try { const c = await saveContact(); await startChat(c.wa_id, c.name); } catch (err) { toast(err.message, true); }
  });

  (async () => {
    await SOS.loadMe(); // já liga a barra lateral e a atualização automática
    const q = new URLSearchParams(location.search).get('q');
    if (q) { state.q = q; $('ct-search').value = q; }
    await load();
  })().catch((err) => toast(err.message, true));
})();
