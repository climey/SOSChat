/* Relatórios de atendimento */
(function () {
  const { api, esc, fmtDuration, toast } = SOS;
  const $ = (id) => document.getElementById(id);
  const COLORS = { primary: '#E03131', blue: '#339af0' };

  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function fmtBucket(iso, group) {
    const d = new Date(iso);
    if (group === 'month') return d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
    if (group === 'week') return 'sem. ' + d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function params() {
    return new URLSearchParams({ from: $('from').value, to: $('to').value, group: $('group').value }).toString();
  }

  function renderStats(s) {
    const items = [
      ['Conversas no período', s.conversations_total, `${s.contacts_total} contatos`],
      ['Abertas agora', s.open_now, 'aguardando atendimento'],
      ['Finalizadas', s.resolved_total, 'no período'],
      ['Tempo médio de resposta', fmtDuration(s.avg_response_seconds), `mediana ${fmtDuration(s.median_response_seconds)}`],
      ['1ª resposta (média)', fmtDuration(s.avg_first_response_seconds), 'da abertura até a 1ª resposta'],
      ['Tempo de resolução (média)', fmtDuration(s.avg_resolution_seconds), 'da abertura até finalizar'],
      ['Mensagens recebidas', s.messages_in, ''],
      ['Mensagens enviadas', s.messages_out, ''],
    ];
    $('stats').innerHTML = items.map(([k, v, sub]) =>
      `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v ?? 0)}</div><div class="s">${esc(sub)}</div></div>`).join('');
  }

  /** Gráfico de barras (SVG puro). series: [{key, color, label}] */
  function barChart(container, rows, series, group) {
    const W = 600, H = 240, padL = 36, padB = 26, padT = 8, padR = 4;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key] || 0)));
    const nice = Math.ceil(max / 4) * 4;
    const n = Math.max(rows.length, 1);
    const slot = innerW / n;
    const gap = 2;
    const barW = Math.max(2, (slot * 0.7 - gap * (series.length - 1)) / series.length);
    const y = (v) => padT + innerH - (v / nice) * innerH;

    let grid = '', axisY = '';
    for (let i = 0; i <= 4; i++) {
      const v = (nice / 4) * i;
      grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`;
      axisY += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    const labelEvery = Math.ceil(rows.length / 10);
    let bars = '', axisX = '';
    rows.forEach((r, i) => {
      const x0 = padL + i * slot + slot * 0.15;
      series.forEach((s, j) => {
        const v = r[s.key] || 0;
        const h = Math.max(v ? 2 : 0, innerH - (y(v) - padT));
        bars += `<rect class="bar" data-i="${i}" x="${x0 + j * (barW + gap)}" y="${padT + innerH - h}" width="${barW}" height="${h}" fill="${s.color}"/>`;
      });
      if (i % labelEvery === 0) axisX += `<text x="${x0 + (slot * 0.7) / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtBucket(r.bucket, group))}</text>`;
    });

    container.innerHTML = rows.length
      ? `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="grid">${grid}</g><g class="axis">${axisY}${axisX}</g><g>${bars}</g></svg>`
      : '<div class="empty" style="height:240px">Sem dados no período</div>';

    // Tooltip por barra
    const svg = container.querySelector('svg');
    if (!svg) return;
    let tip = null;
    svg.addEventListener('mousemove', (e) => {
      const rect = e.target.closest('.bar');
      if (!rect) { if (tip) { tip.remove(); tip = null; } svg.querySelectorAll('.bar.dim').forEach((b) => b.classList.remove('dim')); return; }
      const i = Number(rect.dataset.i);
      const r = rows[i];
      if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; container.appendChild(tip); }
      tip.innerHTML = `<strong>${esc(fmtBucket(r.bucket, group))}</strong><br>` +
        series.map((s) => `${esc(s.label)}: <strong>${r[s.key] || 0}</strong>`).join('<br>');
      const box = container.getBoundingClientRect();
      tip.style.left = Math.min(e.clientX - box.left + 12, box.width - 150) + 'px';
      tip.style.top = (e.clientY - box.top - 10) + 'px';
      svg.querySelectorAll('.bar').forEach((b) => b.classList.toggle('dim', Number(b.dataset.i) !== i));
    });
    svg.addEventListener('mouseleave', () => { if (tip) { tip.remove(); tip = null; } svg.querySelectorAll('.bar.dim').forEach((b) => b.classList.remove('dim')); });
  }

  function renderAgents(agents) {
    $('agents-table').innerHTML = `
      <thead><tr><th>Atendente</th><th class="num">Conversas</th><th class="num">Finalizadas</th><th class="num">Msgs enviadas</th><th class="num">Resposta média</th><th class="num">Resolução média</th></tr></thead>
      <tbody>${agents.map((a) => `<tr>
        <td>${esc(a.name)}${a.active ? '' : ' <span class="muted small">(inativo)</span>'}</td>
        <td class="num">${a.conversations}</td><td class="num">${a.resolved}</td><td class="num">${a.messages_sent}</td>
        <td class="num">${esc(fmtDuration(a.avg_response_seconds))}</td><td class="num">${esc(fmtDuration(a.avg_resolution_seconds))}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">Sem dados</td></tr>'}</tbody>`;
  }

  function renderTags(tags) {
    const total = tags.reduce((n, t) => n + t.conversations, 0) || 1;
    $('tags-table').innerHTML = `
      <thead><tr><th>Tag</th><th class="num">Conversas</th><th class="num">%</th></tr></thead>
      <tbody>${tags.map((t) => `<tr>
        <td><span class="tag" style="color:${esc(t.color)}"><i class="dot"></i>${esc(t.name)}</span></td>
        <td class="num">${t.conversations}</td><td class="num">${Math.round((t.conversations / total) * 100)}%</td>
      </tr>`).join('') || '<tr><td colspan="3" class="muted">Sem tags</td></tr>'}</tbody>`;
  }

  function renderVolumeTable(series, group) {
    $('volume-table').innerHTML = `
      <thead><tr><th>Período</th><th class="num">Conversas</th><th class="num">Recebidas</th><th class="num">Enviadas</th></tr></thead>
      <tbody>${series.map((r) => `<tr><td>${esc(fmtBucket(r.bucket, group))}</td><td class="num">${r.conversations}</td><td class="num">${r.messages_in}</td><td class="num">${r.messages_out}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sem dados no período</td></tr>'}</tbody>`;
  }

  async function load() {
    const q = params();
    const group = $('group').value;
    try {
      const [summary, volume, agents, tags] = await Promise.all([
        api('GET', `/api/reports/summary?${q}`),
        api('GET', `/api/reports/volume?${q}`),
        api('GET', `/api/reports/agents?${q}`),
        api('GET', `/api/reports/tags?${q}`),
      ]);
      renderStats(summary);
      barChart($('chart-conv'), volume.series, [{ key: 'conversations', color: COLORS.primary, label: 'Conversas' }], group);
      barChart($('chart-msg'), volume.series, [
        { key: 'messages_in', color: COLORS.blue, label: 'Recebidas' },
        { key: 'messages_out', color: COLORS.primary, label: 'Enviadas' },
      ], group);
      renderAgents(agents.agents);
      renderTags(tags.tags);
      renderVolumeTable(volume.series, group);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function init() {
    await SOS.loadMe();
    const to = new Date();
    const from = new Date(to.getTime() - 29 * 24 * 3600 * 1000);
    $('from').value = isoDate(from);
    $('to').value = isoDate(to);
    $('filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });
    await load();
  }
  init().catch((err) => toast(err.message, true));
})();
