/* Sons de notificação sintetizados (Web Audio, sem arquivos) e preferências pessoais do atendente. */
(function () {
  const SOUNDS = {
    ding: { name: 'Ding', play: (ctx, t, vol) => tone(ctx, t, vol, 'sine', [[880, 0, 0.35]]) },
    pop: { name: 'Pop', play: (ctx, t, vol) => slide(ctx, t, vol, 'triangle', 640, 320, 0.12) },
    bells: { name: 'Sino duplo', play: (ctx, t, vol) => tone(ctx, t, vol, 'sine', [[1046, 0, 0.3], [1318, 0.16, 0.4]]) },
    soft: { name: 'Nota suave', play: (ctx, t, vol) => tone(ctx, t, vol * 0.8, 'sine', [[523, 0, 0.7]], 0.08) },
    alert: { name: 'Alerta curto', play: (ctx, t, vol) => tone(ctx, t, vol * 0.7, 'square', [[700, 0, 0.09], [700, 0.14, 0.09]]) },
    marimba: { name: 'Marimba', play: (ctx, t, vol) => tone(ctx, t, vol, 'triangle', [[659, 0, 0.18], [784, 0.12, 0.18], [988, 0.24, 0.3]]) },
    none: { name: 'Nenhum (silencioso)', play: () => {} },
  };
  const DEFAULTS = { sound: 'ding', volume: 0.6, whenFocused: false, whenBackground: true, desktop: true, flashTitle: true };

  let ctx = null;
  function audio() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(c, t, vol, type, notes, attack = 0.005) {
    for (const [freq, delay, dur] of notes) {
      const o = c.createOscillator(); const g = c.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(vol, t + delay + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      o.connect(g).connect(c.destination);
      o.start(t + delay); o.stop(t + delay + dur + 0.05);
    }
  }
  function slide(c, t, vol, type, from, to, dur) {
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  }

  function load() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sos.notify') || '{}') }; } catch { return { ...DEFAULTS }; }
  }
  function save(prefs) {
    try { localStorage.setItem('sos.notify', JSON.stringify(prefs)); } catch { /* ignora */ }
  }
  function play(id, volume) {
    const s = SOUNDS[id || load().sound];
    const c = s && audio();
    if (!s || !c) return;
    try { s.play(c, c.currentTime + 0.01, volume ?? load().volume); } catch { /* ignora */ }
  }
  // O navegador só libera áudio depois de uma interação; "aquece" o contexto no primeiro clique
  document.addEventListener('click', () => audio(), { once: true, capture: true });

  window.SOS = window.SOS || {};
  window.SOS.sound = { SOUNDS, DEFAULTS, load, save, play };
})();
