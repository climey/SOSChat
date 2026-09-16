/* Relatórios de atendimento */
(function () {
  const { api, esc, fmtDuration, initials, formatPhone, toast } = SOS;
  const $ = (id) => document.getElementById(id);
  const RED = '#E03131', BLUE = '#339af0';
  const state = { tab: 'overview', data: {}, nowTimer: null, sectors: [], accounts: [], agents: [] };

  // ---------- Utilidades ----------
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fmtN = (n) => Number(n || 0).toLocaleString('pt-BR');
  const fmtBucket = (iso, group) => {
    const d = new Date(iso);
    if (group === 'month') return d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
    if (group === 'week') return 'sem. ' + d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  };
  function params() {
    const p = new URLSearchParams({ from: $('from').value, to: $('to').value, group: $('group').value });
    for (const [k, id] of [['account', 'f-account'], ['sector', 'f-sector'], ['agent', 'f-agent']]) if ($(id).value) p.set(k, $(id).value);
    return p.toString();
  }
  function delta(cur, prev, { invert = false } = {}) {
    if (prev == null || cur == null || Number(prev) === 0) return '';
    const pct = ((Number(cur) - Number(prev)) / Number(prev)) * 100;
    if (!Number.isFinite(pct) || Math.abs(pct) < 0.5) return '<span class="delta flat">= igual ao período anterior</span>';
    const up = pct > 0;
    const good = invert ? !up : up;
    return `<span class="delta ${good ? 'good' : 'bad'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% vs. período anterior</span>`;
  }
  const tile = (k, v, sub, extra = '') => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="s">${sub || ''}</div>${extra}</div>`;

  // ---------- Gráficos (SVG puro) ----------
  function tipOn(container, svg, getHtml) {
    let tip = null;
    svg.addEventListener('mousemove', (e) => {
      const t = e.target.closest('[data-i]');
      if (!t) { tip?.remove(); tip = null; svg.querySelectorAll('.dim').forEach((b) => b.classList.remove('dim')); return; }
      const html = getHtml(Number(t.dataset.i));
      if (!html) return;
      if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; container.appendChild(tip); }
      tip.innerHTML = html;
      const box = container.getBoundingClientRect();
      tip.style.left = Math.min(e.clientX - box.left + 12, box.width - 170) + 'px';
      tip.style.top = (e.clientY - box.top - 10) + 'px';
      svg.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('dim', b.dataset.i !== t.dataset.i));
    });
    svg.addEventListener('mouseleave', () => { tip?.remove(); tip = null; svg.querySelectorAll('.dim').forEach((b) => b.classList.remove('dim')); });
  }
  function empty(container, msg = 'Sem dados no período') { container.innerHTML = `<div class="empty" style="height:200px">${esc(msg)}</div>`; }

  /** Barras verticais agrupadas. series: [{key,color,label}] */
  function barChart(container, rows, series, labelFn, valueFmt = fmtN) {
    if (!rows.length) return empty(container);
    const W = 600, H = 240, padL = 40, padB = 26, padT = 8, padR = 4, innerW = W - padL - padR, innerH = H - padT - padB;
    const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0)));
    const nice = Math.ceil(max / 4) * 4, slot = innerW / rows.length, gap = 2;
    const barW = Math.max(2, (slot * 0.7 - gap * (series.length - 1)) / series.length);
    const y = (v) => padT + innerH - (v / nice) * innerH;
    let grid = '', axisY = '';
    for (let i = 0; i <= 4; i++) { const v = (nice / 4) * i; grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`; axisY += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${valueFmt(v)}</text>`; }
    const every = Math.ceil(rows.length / 10);
    let bars = '', axisX = '';
    rows.forEach((r, i) => {
      const x0 = padL + i * slot + slot * 0.15;
      series.forEach((s, j) => { const v = Number(r[s.key]) || 0; const h = Math.max(v ? 2 : 0, innerH - (y(v) - padT)); bars += `<rect class="bar" data-i="${i}" x="${x0 + j * (barW + gap)}" y="${padT + innerH - h}" width="${barW}" height="${h}" fill="${s.color}"/>`; });
      if (i % every === 0) axisX += `<text x="${x0 + (slot * 0.7) / 2}" y="${H - 8}" text-anchor="middle">${esc(labelFn(r))}</text>`;
    });
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="grid">${grid}</g><g class="axis">${axisY}${axisX}</g><g>${bars}</g></svg>`;
    tipOn(container, container.querySelector('svg'), (i) => `<strong>${esc(labelFn(rows[i]))}</strong><br>` + series.map((s) => `${esc(s.label)}: <strong>${valueFmt(Number(rows[i][s.key]) || 0)}</strong>`).join('<br>'));
  }

  /** Linhas (uma ou mais séries). Valores nulos quebram a linha. */
  function lineChart(container, rows, series, labelFn, valueFmt = fmtN) {
    if (!rows.length || !rows.some((r) => series.some((s) => r[s.key] != null))) return empty(container);
    const W = 600, H = 240, padL = 48, padB = 26, padT = 10, padR = 10, innerW = W - padL - padR, innerH = H - padT - padB;
    const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0)));
    const nice = Math.ceil(max / 4) * 4;
    const x = (i) => padL + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
    const y = (v) => padT + innerH - (v / nice) * innerH;
    let grid = '', axisY = '';
    for (let i = 0; i <= 4; i++) { const v = (nice / 4) * i; grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`; axisY += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${valueFmt(v)}</text>`; }
    const every = Math.ceil(rows.length / 8);
    let axisX = '';
    rows.forEach((r, i) => { if (i % every === 0) axisX += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(labelFn(r))}</text>`; });
    let paths = '', dots = '';
    series.forEach((s) => {
      let d = '', pen = false;
      rows.forEach((r, i) => { const v = r[s.key]; if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i)},${y(Number(v))} `; pen = true; dots += `<circle data-i="${i}" cx="${x(i)}" cy="${y(Number(v))}" r="3.5" fill="${s.color}"/>`; });
      paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    });
    const hits = rows.map((_, i) => `<rect data-i="${i}" x="${x(i) - (innerW / Math.max(rows.length - 1, 1)) / 2}" y="${padT}" width="${innerW / Math.max(rows.length - 1, 1)}" height="${innerH}" fill="transparent"/>`).join('');
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="grid">${grid}</g><g class="axis">${axisY}${axisX}</g>${paths}${dots}${hits}</svg>`;
    tipOn(container, container.querySelector('svg'), (i) => `<strong>${esc(labelFn(rows[i]))}</strong><br>` + series.map((s) => `${esc(s.label)}: <strong>${rows[i][s.key] == null ? '—' : valueFmt(Number(rows[i][s.key]))}</strong>`).join('<br>'));
  }

  /** Barras horizontais com rótulo à esquerda. rows: [{label, value, color?, sub?}] */
  function hbarChart(container, rows, { color = RED, valueFmt = fmtN, max: maxIn } = {}) {
    if (!rows.length || !rows.some((r) => r.value > 0)) return empty(container);
    const max = maxIn || Math.max(1, ...rows.map((r) => Number(r.value) || 0));
    container.innerHTML = `<div class="hbars">${rows.map((r) => `
      <div class="hbar" title="${esc(r.label)}: ${esc(valueFmt(r.value))}">
        <div class="hlabel">${r.pre || ''}${esc(r.label)}</div>
        <div class="htrack"><div class="hfill" style="width:${Math.max(1, (Number(r.value) / max) * 100).toFixed(1)}%;background:${r.color || color}"></div></div>
        <div class="hval">${esc(valueFmt(r.value))}${r.sub ? ` <span class="muted">${esc(r.sub)}</span>` : ''}</div>
      </div>`).join('')}</div>`;
  }

  /** Mapa de calor 7 dias × 24 horas. cells: [{dow, hour, conversations}] */
  function heatmap(container, cells) {
    if (!cells.length) return empty(container);
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const c of cells) grid[c.dow][c.hour] = c.conversations;
    const max = Math.max(1, ...grid.flat());
    const peak = cells.reduce((a, b) => (b.conversations > (a?.conversations || 0) ? b : a), null);
    const W = 600, H = 200, padL = 34, padT = 18, cw = (W - padL) / 24, ch = (H - padT) / 7;
    let out = '';
    for (let h = 0; h < 24; h += 2) out += `<text class="axis-t" x="${padL + h * cw + cw / 2}" y="12" text-anchor="middle">${h}h</text>`;
    grid.forEach((row, d) => {
      out += `<text class="axis-t" x="${padL - 6}" y="${padT + d * ch + ch / 2 + 4}" text-anchor="end">${days[d]}</text>`;
      row.forEach((v, h) => { const a = v ? 0.15 + 0.85 * (v / max) : 0; out += `<rect data-i="${d * 24 + h}" x="${padL + h * cw + 1}" y="${padT + d * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="2" fill="${v ? RED : 'rgba(255,255,255,0.05)'}" fill-opacity="${v ? a.toFixed(2) : 1}"/>`; });
    });
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:200px">${out}</svg>` +
      (peak ? `<div class="small muted" style="margin-top:6px">Pico: ${days[peak.dow]} às ${peak.hour}h, com ${peak.conversations} conversa(s).</div>` : '');
    tipOn(container, container.querySelector('svg'), (i) => { const d = Math.floor(i / 24), h = i % 24; return `<strong>${days[d]} ${h}h–${h + 1}h</strong><br>${grid[d][h]} conversa(s)`; });
  }

  // ---------- Filtros ----------
  function setPreset(p) {
    const to = new Date(); const from = new Date();
    if (p === 'today') { /* mesmo dia */ } else from.setDate(to.getDate() - (Number(p) - 1));
    $('from').value = isoDate(from); $('to').value = isoDate(to);
    document.querySelectorAll('#period-presets .chip').forEach((b) => b.classList.toggle('active', b.dataset.preset === String(p)));
    if (p === 'today') $('group').value = 'day';
  }
  $('period-presets').addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) { setPreset(b.dataset.preset); load(); } });
  ['from', 'to'].forEach((id) => $(id).addEventListener('change', () => document.querySelectorAll('#period-presets .chip').forEach((b) => b.classList.remove('active'))));
  $('filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });

  async function loadFilterOptions() {
    const [wa, sec, us] = await Promise.all([
      api('GET', '/api/whatsapp/status').catch(() => ({ accounts: [] })),
      api('GET', '/api/sectors').catch(() => ({ sectors: [] })),
      api('GET', '/api/users').catch(() => ({ users: [] })),
    ]);
    state.accounts = (wa.accounts || []).filter((a) => a.id);
    state.sectors = sec.sectors || [];
    state.agents = us.users || [];
    if (state.accounts.length > 1) {
      $('f-account').innerHTML = '<option value="">Todos</option>' + state.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
      $('f-account-wrap').hidden = false;
    }
    $('f-sector').innerHTML = '<option value="">Todos</option>' + state.sectors.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    $('f-agent').innerHTML = '<option value="">Todos</option>' + state.agents.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  }

  // ---------- Abas ----------
  $('report-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#report-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.report-tab').forEach((s) => { s.hidden = s.dataset.tab !== tab; });
    $('filters').hidden = tab === 'now';
    history.replaceState(null, '', `#${tab}`);
    clearInterval(state.nowTimer);
    if (tab === 'now') { loadNow(); state.nowTimer = setInterval(loadNow, 30000); }
    else load();
  }

  // ---------- Visão geral ----------
  async function loadOverview(q) {
    const group = $('group').value;
    const [sum, vol, trend, br, hours] = await Promise.all([
      api('GET', `/api/reports/summary?${q}`), api('GET', `/api/reports/volume?${q}`),
      api('GET', `/api/reports/trend?${q}`), api('GET', `/api/reports/breakdown?${q}`), api('GET', `/api/reports/hours?${q}`),
    ]);
    Object.assign(state.data, { sum, vol, trend, br, hours });
    const c = sum.current, p = sum.previous;
    const answeredPct = c.conversations_total ? Math.round((c.answered_total / c.conversations_total) * 100) : 0;
    $('ov-stats').innerHTML = [
      tile('Conversas iniciadas', fmtN(c.conversations_total), `${fmtN(c.contacts_total)} clientes diferentes`, delta(c.conversations_total, p.conversations_total)),
      tile('Finalizadas', fmtN(c.resolved_total), `${fmtN(c.open_now)} abertas agora`, delta(c.resolved_total, p.resolved_total)),
      tile('Respondidas', `${answeredPct}%`, 'das conversas iniciadas tiveram resposta', ''),
      tile('Primeira resposta', fmtDuration(c.median_first_response_seconds), `mediana · média ${fmtDuration(c.avg_first_response_seconds)}`, delta(c.median_first_response_seconds, p.median_first_response_seconds, { invert: true })),
      tile('Tempo de resposta', fmtDuration(c.median_response_seconds), `mediana · média ${fmtDuration(c.avg_response_seconds)}`, delta(c.median_response_seconds, p.median_response_seconds, { invert: true })),
      tile('Tempo até finalizar', fmtDuration(c.median_resolution_seconds), `mediana · média ${fmtDuration(c.avg_resolution_seconds)}`, delta(c.median_resolution_seconds, p.median_resolution_seconds, { invert: true })),
    ].join('');
    const lbl = (r) => fmtBucket(r.bucket, group);
    barChart($('ov-volume'), vol.series, [{ key: 'conversations', color: RED, label: 'Iniciadas' }, { key: 'resolved', color: BLUE, label: 'Finalizadas' }], lbl);
    lineChart($('ov-first'), trend.series, [{ key: 'avg_first', color: RED, label: 'Média' }, { key: 'median_first', color: BLUE, label: 'Mediana' }], (r) => fmtBucket(r.bucket, 'day'), fmtDuration);
    lineChart($('ov-res'), trend.series, [{ key: 'avg_res', color: RED, label: 'Média' }, { key: 'median_res', color: BLUE, label: 'Mediana' }], (r) => fmtBucket(r.bucket, 'day'), fmtDuration);
    heatmap($('ov-heat'), hours.cells);
    hbarChart($('ov-tags'), br.tags.map((t) => ({ label: t.name, value: t.conversations, color: t.color })));
    hbarChart($('ov-sectors'), br.sectors.map((s) => ({ label: s.name, value: s.conversations, color: s.color })));
    hbarChart($('ov-accounts'), br.accounts.map((a) => ({ label: a.name, value: a.conversations, sub: a.phone || '' })));
  }

  // ---------- Agora ----------
  async function loadNow() {
    const p = new URLSearchParams();
    for (const [k, id] of [['account', 'f-account'], ['sector', 'f-sector']]) if ($(id).value) p.set(k, $(id).value);
    let n;
    try { n = await api('GET', `/api/reports/now?${p}`); } catch (err) { toast(err.message, true); return; }
    state.data.now = n;
    const online = n.agents.filter((a) => a.online);
    $('now-stats').innerHTML = [
      tile('Na fila (Esperando)', fmtN(n.queued), 'ninguém assumiu nem respondeu ainda'),
      tile('Aguardando resposta', fmtN(n.waiting), 'clientes esperando um atendente', n.overdue ? `<span class="delta bad">▲ ${n.overdue} acima de ${n.sla.sla_alert_minutes} min</span>` : '<span class="delta good">nenhuma estourada</span>'),
      tile('Aguardando o cliente', fmtN(n.in_progress), 'já respondidas, esperando retorno'),
      tile('Atendentes online', `${online.length}<span class="muted" style="font-size:16px">/${n.agents.length}</span>`, online.map((a) => `<span class="mini-av" title="${esc(a.name)}">${esc(initials(a.name))}</span>`).join('') || 'ninguém conectado'),
      tile('Resposta na última hora', fmtDuration(n.last_hour.median_response_seconds), `${fmtN(n.last_hour.replies)} respostas · média ${fmtDuration(n.last_hour.avg_response_seconds)}`),
      tile('Recebidas na última hora', fmtN(n.last_hour.messages_in), 'mensagens de clientes'),
    ].join('');
    $('now-oldest').innerHTML = n.oldest_waiting.length ? `<div class="oldest">${n.oldest_waiting.map((c) => {
      const min = Math.floor(c.waiting_seconds / 60);
      const cls = min >= n.sla.sla_alert_minutes ? 'alert' : min >= n.sla.sla_warn_minutes ? 'warn' : '';
      return `<a class="oldest-item" href="/#conv=${c.id}"><span class="mini-av">${esc(initials(c.contact_name || c.profile_name || '?'))}</span><span class="name">${esc(c.contact_name || c.profile_name || formatPhone(c.wa_id))}</span><span class="muted small">${esc(c.assigned_user_name || 'sem responsável')}</span><span class="wait ${cls}">⏱ ${fmtDuration(c.waiting_seconds)}</span></a>`;
    }).join('')}</div>` : '<div class="empty" style="height:auto;padding:20px">Ninguém esperando resposta agora 🎉</div>';
    // últimos 60 min em blocos de 5
    const buckets = [];
    const start = new Date(Math.floor(Date.now() / 300000) * 300000 - 55 * 60000);
    for (let i = 0; i < 12; i++) { const t = new Date(start.getTime() + i * 300000); buckets.push({ t, label: t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), conversations: 0 }); }
    for (const o of n.last_hour.opened) { const t = new Date(o.bucket).getTime(); const b = buckets.find((x) => Math.abs(x.t.getTime() - t) < 60000); if (b) b.conversations += o.conversations; }
    barChart($('now-opened'), buckets, [{ key: 'conversations', color: RED, label: 'Conversas' }], (r) => r.label);
    $('now-agents').innerHTML = n.agents.map((a) => `<div class="agent-card ${a.online ? 'on' : ''}"><span class="mini-av">${esc(initials(a.name))}<span class="pdot ${a.online ? (a.availability === 'away' ? 'away' : 'online') : ''}"></span></span><div><div>${esc(a.name)}</div><div class="small muted">${a.online ? (a.availability === 'away' ? 'Ausente' : 'Online') : 'Offline'}</div></div></div>`).join('');
  }

  // ---------- Atendentes ----------
  async function loadAgents(q) {
    const { agents } = await api('GET', `/api/reports/agents?${q}`);
    state.data.agents = agents;
    const withData = agents.filter((a) => a.conversations || a.messages_sent || a.resolved);
    hbarChart($('ag-conv'), withData.map((a) => ({ label: a.name, value: a.conversations, sub: a.open_now ? `${a.open_now} abertas` : '' })));
    hbarChart($('ag-msgs'), withData.map((a) => ({ label: a.name, value: a.messages_sent })), { color: BLUE });
    $('ag-table').innerHTML = `
      <thead><tr><th>Atendente</th><th class="num">Conversas</th><th class="num">Abertas</th><th class="num">Finalizadas</th><th class="num">Msgs</th><th class="num">Resposta (mediana)</th><th class="num">Resposta (média)</th><th class="num">Finalizar (mediana)</th></tr></thead>
      <tbody>${agents.map((a) => `<tr>
        <td><span class="pdot ${a.online ? (a.availability === 'away' ? 'away' : 'online') : ''}"></span> ${esc(a.name)}${a.active ? '' : ' <span class="muted small">(inativo)</span>'}</td>
        <td class="num">${fmtN(a.conversations)}</td><td class="num">${fmtN(a.open_now)}</td><td class="num">${fmtN(a.resolved)}</td><td class="num">${fmtN(a.messages_sent)}</td>
        <td class="num">${esc(fmtDuration(a.median_response_seconds))}</td><td class="num">${esc(fmtDuration(a.avg_response_seconds))}</td><td class="num">${esc(fmtDuration(a.median_resolution_seconds))}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">Sem dados</td></tr>'}</tbody>`;
  }

  // ---------- Mensagens ----------
  async function loadMessages(q) {
    const group = $('group').value;
    const [sum, vol, br] = await Promise.all([api('GET', `/api/reports/summary?${q}`), api('GET', `/api/reports/volume?${q}`), api('GET', `/api/reports/breakdown?${q}`)]);
    Object.assign(state.data, { sum, vol, br });
    const c = sum.current, p = sum.previous;
    const total = c.messages_in + c.messages_out;
    $('msg-stats').innerHTML = [
      tile('Total de mensagens', fmtN(total), 'recebidas e enviadas', delta(total, p.messages_in + p.messages_out)),
      tile('Recebidas', fmtN(c.messages_in), 'de clientes', delta(c.messages_in, p.messages_in)),
      tile('Enviadas', fmtN(c.messages_out), 'pela equipe (notas não contam)', delta(c.messages_out, p.messages_out)),
      tile('Mensagens por conversa', c.conversations_total ? (total / c.conversations_total).toFixed(1) : '0', 'média no período'),
    ].join('');
    barChart($('msg-volume'), vol.series, [{ key: 'messages_in', color: BLUE, label: 'Recebidas' }, { key: 'messages_out', color: RED, label: 'Enviadas' }], (r) => fmtBucket(r.bucket, group));
    hbarChart($('msg-accounts'), br.accounts.map((a) => ({ label: a.name, value: a.conversations, sub: 'conversas' })));
    $('msg-table').innerHTML = `<thead><tr><th>Período</th><th class="num">Conversas</th><th class="num">Finalizadas</th><th class="num">Recebidas</th><th class="num">Enviadas</th></tr></thead>
      <tbody>${vol.series.map((r) => `<tr><td>${esc(fmtBucket(r.bucket, group))}</td><td class="num">${fmtN(r.conversations)}</td><td class="num">${fmtN(r.resolved)}</td><td class="num">${fmtN(r.messages_in)}</td><td class="num">${fmtN(r.messages_out)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Sem dados</td></tr>'}</tbody>`;
  }

  // ---------- Origem ----------
  const DDD_UF = { 11: 'SP', 12: 'SP', 13: 'SP', 14: 'SP', 15: 'SP', 16: 'SP', 17: 'SP', 18: 'SP', 19: 'SP', 21: 'RJ', 22: 'RJ', 24: 'RJ', 27: 'ES', 28: 'ES', 31: 'MG', 32: 'MG', 33: 'MG', 34: 'MG', 35: 'MG', 37: 'MG', 38: 'MG', 41: 'PR', 42: 'PR', 43: 'PR', 44: 'PR', 45: 'PR', 46: 'PR', 47: 'SC', 48: 'SC', 49: 'SC', 51: 'RS', 53: 'RS', 54: 'RS', 55: 'RS', 61: 'DF', 62: 'GO', 64: 'GO', 63: 'TO', 65: 'MT', 66: 'MT', 67: 'MS', 68: 'AC', 69: 'RO', 71: 'BA', 73: 'BA', 74: 'BA', 75: 'BA', 77: 'BA', 79: 'SE', 81: 'PE', 87: 'PE', 82: 'AL', 83: 'PB', 84: 'RN', 85: 'CE', 88: 'CE', 86: 'PI', 89: 'PI', 91: 'PA', 93: 'PA', 94: 'PA', 92: 'AM', 97: 'AM', 95: 'RR', 96: 'AP', 98: 'MA', 99: 'MA' };
  const UF_NAME = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };
  const UF_REGION = { AC: 'Norte', AP: 'Norte', AM: 'Norte', PA: 'Norte', RO: 'Norte', RR: 'Norte', TO: 'Norte', AL: 'Nordeste', BA: 'Nordeste', CE: 'Nordeste', MA: 'Nordeste', PB: 'Nordeste', PE: 'Nordeste', PI: 'Nordeste', RN: 'Nordeste', SE: 'Nordeste', DF: 'Centro-Oeste', GO: 'Centro-Oeste', MT: 'Centro-Oeste', MS: 'Centro-Oeste', ES: 'Sudeste', MG: 'Sudeste', RJ: 'Sudeste', SP: 'Sudeste', PR: 'Sul', RS: 'Sul', SC: 'Sul' };
  async function loadOrigin(q) {
    const { ddd } = await api('GET', `/api/reports/origin?${q}`);
    state.data.origin = ddd;
    const byState = {}, byRegion = {};
    for (const r of ddd) {
      const uf = DDD_UF[r.ddd] || (r.ddd === 'intl' ? 'Internacional' : 'Outro');
      const region = UF_REGION[uf] || (uf === 'Internacional' ? 'Internacional' : 'Outro');
      byState[uf] = (byState[uf] || 0) + r.conversations;
      byRegion[region] = (byRegion[region] || 0) + r.conversations;
    }
    const total = ddd.reduce((n, r) => n + r.conversations, 0) || 1;
    const pct = (v) => `${fmtN(v)} (${Math.round((v / total) * 100)}%)`;
    const regionOrder = ['Sudeste', 'Nordeste', 'Sul', 'Centro-Oeste', 'Norte', 'Internacional', 'Outro'];
    hbarChart($('or-region'), regionOrder.filter((r) => byRegion[r]).map((r) => ({ label: r, value: byRegion[r] })), { valueFmt: pct });
    hbarChart($('or-state'), Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([uf, v]) => ({ label: UF_NAME[uf] || uf, value: v })), { valueFmt: pct, color: BLUE });
    hbarChart($('or-ddd'), ddd.slice(0, 15).map((r) => ({ label: r.ddd === 'intl' ? 'Internacional' : `DDD ${r.ddd} · ${DDD_UF[r.ddd] || '?'}`, value: r.conversations })), { valueFmt: pct });
    $('or-table').innerHTML = `<thead><tr><th>DDD</th><th>Estado</th><th>Região</th><th class="num">Conversas</th><th class="num">Clientes</th><th class="num">%</th></tr></thead>
      <tbody>${ddd.map((r) => { const uf = DDD_UF[r.ddd]; return `<tr><td>${r.ddd === 'intl' ? 'Internacional' : r.ddd}</td><td>${esc(UF_NAME[uf] || (r.ddd === 'intl' ? '—' : 'Desconhecido'))}</td><td>${esc(UF_REGION[uf] || '—')}</td><td class="num">${fmtN(r.conversations)}</td><td class="num">${fmtN(r.contacts)}</td><td class="num">${Math.round((r.conversations / total) * 100)}%</td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">Sem dados</td></tr>'}</tbody>`;
  }

  // ---------- Exportar CSV ----------
  function toCsv(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\n');
  }
  $('btn-export').addEventListener('click', () => {
    const d = state.data;
    let rows = [], name = state.tab;
    if (state.tab === 'overview' && d.vol) rows = d.vol.series.map((r) => ({ periodo: fmtBucket(r.bucket, $('group').value), conversas: r.conversations, finalizadas: r.resolved, recebidas: r.messages_in, enviadas: r.messages_out }));
    else if (state.tab === 'agents' && d.agents) rows = d.agents.map((a) => ({ atendente: a.name, conversas: a.conversations, abertas: a.open_now, finalizadas: a.resolved, mensagens: a.messages_sent, resposta_mediana_s: a.median_response_seconds, resposta_media_s: a.avg_response_seconds, finalizar_mediana_s: a.median_resolution_seconds }));
    else if (state.tab === 'messages' && d.vol) rows = d.vol.series.map((r) => ({ periodo: fmtBucket(r.bucket, $('group').value), recebidas: r.messages_in, enviadas: r.messages_out }));
    else if (state.tab === 'origin' && d.origin) rows = d.origin.map((r) => ({ ddd: r.ddd, estado: UF_NAME[DDD_UF[r.ddd]] || '', regiao: UF_REGION[DDD_UF[r.ddd]] || '', conversas: r.conversations, clientes: r.contacts }));
    else if (state.tab === 'consultations' && d.cs) rows = d.cs.clients_by_kind.map((x) => ({ cliente: x.name, telefone: x.wa_id, ...x.kinds, total_consultas: x.total, ...(d.cs.purchases.buyers.find((b) => b.id === x.id) ? { compras: d.cs.purchases.buyers.find((b) => b.id === x.id).purchases, consultas_compradas: d.cs.purchases.buyers.find((b) => b.id === x.id).credits, valor_reais: d.cs.purchases.buyers.find((b) => b.id === x.id).revenue_cents / 100 } : {}) }));
    else if (state.tab === 'clients' && d.clients) rows = d.clients.top.map((x) => ({ cliente: x.name, telefone: x.wa_id, faixa: REC_LABEL[x.tier] || x.tier, dias_com_contato: x.interactions, meses_ativos: x.active_months, consultas: x.consultations, cliente_desde: x.first_contact_at, ultimo_contato: x.last_seen_at }));
    else if (state.tab === 'now' && d.now) rows = d.now.oldest_waiting.map((c) => ({ cliente: c.contact_name || c.profile_name || c.wa_id, responsavel: c.assigned_user_name || '', esperando_s: c.waiting_seconds }));
    if (!rows.length) return toast('Nada para exportar nesta aba', true);
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `relatorio-${name}-${$('from').value || 'agora'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------- Consultas e planos ----------
  const KIND_PALETTE = [RED, '#f08c00', BLUE, '#2f9e44', '#7048e8', '#e8590c', '#0ca678', '#868e96', '#c2255c', '#1098ad'];
  const money = (c) => 'R$ ' + (Number(c || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  async function loadConsultations(q) {
    const cs = await api('GET', `/api/reports/consultations?${q}`);
    state.data.cs = cs;
    const c = cs.current, p = cs.previous, pl = cs.plans, pu = cs.purchases;
    $('cs-stats').innerHTML = [
      tile('Consultas no período', fmtN(c.total), `${fmtN(c.contacts)} clientes diferentes`, delta(c.total, p.total)),
      tile('Debitadas de plano', fmtN(c.charged), `${fmtN(c.loose)} avulsas (sem plano ou sem debitar)`, ''),
      tile('Clientes com plano', fmtN(pl.with_plan), `${fmtN(pl.credits_left)} consultas ainda disponíveis no total`, ''),
      tile('Sem saldo', fmtN(pl.empty), `${fmtN(pl.low)} com a última consulta`, ''),
      tile('Vencidos', fmtN(pl.expired), `${fmtN(pl.expiring)} vencem nos próximos 7 dias`, ''),
      tile('Receita', money(pu.revenue_cents), `${fmtN(pu.purchases)} compras · ${fmtN(pu.credits)} consultas vendidas · ${fmtN(pu.buyer_count)} clientes`, delta(pu.revenue_cents, pu.previous.revenue_cents)),
    ].join('');
    barChart($('cs-series'), cs.series, [{ key: 'charged', color: RED, label: 'Debitadas' }, { key: 'loose', color: BLUE, label: 'Avulsas' }], (r) => fmtBucket(r.bucket, 'day'));
    hbarChart($('cs-kinds'), cs.kinds.map((k, i) => ({ label: k.kind, value: k.total, color: KIND_PALETTE[i % KIND_PALETTE.length] })));
    hbarChart($('cs-agents'), cs.agents.map((a) => ({ label: a.name, value: a.total, sub: a.charged ? `${a.charged} de plano` : '' })));
    hbarChart($('cs-contacts'), cs.contacts.map((x) => ({ label: x.name, value: x.total, sub: x.plan_name ? `${x.plan_name} · ${Math.max(0, x.plan_credits - x.plan_used)}/${x.plan_credits}` : 'sem plano' })), { color: BLUE });
    hbarChart($('cs-plans'), pl.by_plan.map((x) => ({ label: x.name, value: x.contacts, sub: x.empty ? `${x.empty} sem saldo` : '' })));
    barChart($('cs-revenue'), pu.series.map((r) => ({ ...r, revenue: r.revenue_cents / 100 })), [{ key: 'revenue', color: '#40c057', label: 'Receita' }], (r) => fmtBucket(r.bucket, 'day'), (v) => money(Math.round(v * 100)));
    $('cs-buyers').innerHTML = `<thead><tr><th>Cliente</th><th class="num">Compras</th><th class="num">Planos</th><th class="num">Consultas</th><th class="num">Valor</th><th>Última</th></tr></thead>
      <tbody>${pu.buyers.map((b) => `<tr><td><a href="/?c=${b.conversation_id || ''}">${esc(b.name)}</a><div class="muted small">${esc(formatPhone(b.wa_id))}</div></td><td class="num">${fmtN(b.purchases)}</td><td class="num">${fmtN(b.plans)}</td><td class="num">${fmtN(b.credits)}</td><td class="num">${money(b.revenue_cents)}</td><td>${new Date(b.last_purchase_at).toLocaleDateString('pt-BR')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nenhuma compra no período</td></tr>'}</tbody>`;
    const kindsAll = [...new Set(cs.clients_by_kind.flatMap((x) => Object.keys(x.kinds)))];
    $('cs-matrix').innerHTML = `<thead><tr><th>Cliente</th>${kindsAll.map((k) => `<th class="num">${esc(k)}</th>`).join('')}<th class="num">Total</th></tr></thead>
      <tbody>${cs.clients_by_kind.map((x) => `<tr><td>${esc(x.name)}<div class="muted small">${esc(formatPhone(x.wa_id))}</div></td>${kindsAll.map((k) => `<td class="num ${x.kinds[k] ? 'hot' : ''}">${x.kinds[k] || '·'}</td>`).join('')}<td class="num"><b>${x.total}</b></td></tr>`).join('') || `<tr><td colspan="${kindsAll.length + 2}" class="muted">Nenhuma consulta registrada no período</td></tr>`}</tbody>`;
    const att = pl.attention || [];
    $('cs-attention').innerHTML = att.length ? att.map((x) => {
      const left = Math.max(0, x.plan_credits - x.plan_used);
      const expired = x.plan_expires_at && new Date(x.plan_expires_at) < new Date();
      const why = left === 0 ? 'sem saldo' : expired ? 'vencido' : `vence ${new Date(x.plan_expires_at).toLocaleDateString('pt-BR')}`;
      const cls = left === 0 || expired ? 'is-empty' : 'is-low';
      return `<a class="row" href="/?c=${x.conversation_id || ''}" title="Abrir conversa">
        <span class="who">${esc(x.name)}<small>${esc(formatPhone(x.wa_id))} · ${esc(x.plan_name || 'plano')}</small></span>
        <span class="plan-chip ${cls}">${left}/${x.plan_credits}</span><span class="muted small">${esc(why)}</span></a>`;
    }).join('') : '<div class="empty" style="height:120px">Nenhum cliente precisa de atenção</div>';
  }

  // ---------- Clientes (recorrência) ----------
  const REC_LABEL = { new: 'Novo', occasional: 'Ocasional', recurrent: 'Recorrente', loyal: 'Fiel' };
  const REC_COLOR = { new: '#868e96', occasional: '#74c0fc', recurrent: '#40c057', loyal: '#da77f2', inactive: '#f59f00' };
  const since = (d) => { if (!d) return ''; const days = Math.floor((Date.now() - new Date(d)) / 86400e3); if (days < 1) return 'hoje'; if (days < 30) return `há ${days} d`; const m = Math.floor(days / 30.44); return m < 12 ? `há ${m} m` : `há ${Math.floor(m / 12)} a`; };
  async function loadClients(q) {
    const r = await api('GET', `/api/reports/recurrence?${q}`);
    state.data.clients = r;
    const t = r.tiers;
    $('cl-stats').innerHTML = [
      tile('Clientes novos', fmtN(r.new_clients.current), 'primeiro contato no período', delta(r.new_clients.current, r.new_clients.previous)),
      tile('Clientes ativos', fmtN(r.active_clients), 'falaram com a SOS no período', ''),
      tile('Taxa de retorno', r.return_rate.pct === null ? '-' : `${r.return_rate.pct}%`, `${fmtN(r.return_rate.returned)} de ${fmtN(r.return_rate.base)} novos do período anterior voltaram`, ''),
      tile('Recorrentes', fmtN(t.recurrent + t.loyal), `${fmtN(t.loyal)} fiéis · ${fmtN(t.occasional)} ocasionais`, ''),
      tile('Recorrentes inativos', fmtN(t.inactive), `sem contato há mais de ${r.thresholds.inactive_days} dias`, ''),
    ].join('');
    hbarChart($('cl-tiers'), [
      { label: 'Fiéis', value: t.loyal, color: REC_COLOR.loyal }, { label: 'Recorrentes', value: t.recurrent, color: REC_COLOR.recurrent },
      { label: 'Ocasionais', value: t.occasional, color: REC_COLOR.occasional }, { label: 'Novos', value: t.new, color: REC_COLOR.new },
    ]);
    $('cl-inactive').innerHTML = r.inactive.length ? r.inactive.map((x) => `<a class="row" href="/?c=${x.conversation_id || ''}" title="Abrir conversa">
        <span class="who">${esc(x.name)}<small>${esc(formatPhone(x.wa_id))} · ${x.interactions} dias com contato${x.plan_name ? ' · ' + esc(x.plan_name) : ''}</small></span>
        <span class="rec-chip inactive">${esc(REC_LABEL[x.tier] || x.tier)}</span><span class="muted small">último ${esc(since(x.last_seen_at))}</span></a>`).join('')
      : '<div class="empty" style="height:120px">Nenhum recorrente inativo</div>';
    $('cl-top').innerHTML = `<thead><tr><th>Cliente</th><th>Faixa</th><th class="num">Dias com contato</th><th class="num">Meses ativos</th><th class="num">Consultas</th><th>Cliente desde</th><th>Último contato</th></tr></thead>
      <tbody>${r.top.map((x) => `<tr>
        <td><a href="/?c=${x.conversation_id || ''}">${esc(x.name)}</a><div class="muted small">${esc(formatPhone(x.wa_id))}</div></td>
        <td><span class="rec-chip ${x.tier}">${esc(REC_LABEL[x.tier] || x.tier)}</span></td>
        <td class="num">${fmtN(x.interactions)}</td><td class="num">${fmtN(x.active_months)}</td><td class="num">${fmtN(x.consultations)}</td>
        <td>${x.first_contact_at ? new Date(x.first_contact_at).toLocaleDateString('pt-BR') : '-'}</td><td>${esc(since(x.last_seen_at))}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">Ainda não há clientes com mais de um dia de contato</td></tr>'}</tbody>`;
  }

  // ---------- Carga ----------
  async function load() {
    const q = params();
    try {
      if (state.tab === 'overview') await loadOverview(q);
      else if (state.tab === 'agents') await loadAgents(q);
      else if (state.tab === 'messages') await loadMessages(q);
      else if (state.tab === 'origin') await loadOrigin(q);
      else if (state.tab === 'consultations') await loadConsultations(q);
      else if (state.tab === 'clients') await loadClients(q);
    } catch (err) { toast(err.message, true); }
  }
  async function init() {
    await SOS.loadMe();
    setPreset('7');
    await loadFilterOptions();
    const tab = location.hash.slice(1);
    showTab(['overview', 'now', 'agents', 'messages', 'origin', 'consultations', 'clients'].includes(tab) ? tab : 'overview');
  }
  window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (['overview', 'now', 'agents', 'messages', 'origin', 'consultations', 'clients'].includes(t) && t !== state.tab) showTab(t); });
  init().catch((err) => toast(err.message, true));
})();
