/*
 * Validação de referências de consulta (chassi, placa, Renavam, CPF, CNPJ) com sugestão de correção.
 * Roda no navegador (window.RefCheck) e no Node (module.exports), para os testes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RefCheck = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const digits = (s) => String(s || '').replace(/\D/g, '');

  // ---------- Chassi (VIN, ISO 3779) ----------
  const VIN_FORBIDDEN = /[IOQ]/g;
  const VIN_YEAR = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  const VIN_TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
  const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  // Fabricantes da América do Norte usam o dígito verificador obrigatoriamente; no Brasil ele é opcional
  const CHECK_DIGIT_REQUIRED = /^[1-5]/;

  function vinCheckDigit(vin) {
    let sum = 0;
    for (let i = 0; i < 17; i++) {
      const ch = vin[i];
      const v = /\d/.test(ch) ? Number(ch) : VIN_TRANSLIT[ch];
      if (v === undefined) return null;
      sum += v * VIN_WEIGHTS[i];
    }
    const r = sum % 11;
    return r === 10 ? 'X' : String(r);
  }

  function validateChassi(raw) {
    const value = norm(raw);
    const errors = [];
    const warnings = [];
    if (value.length !== 17) errors.push(`tem ${value.length} caracteres e o chassi tem 17`);
    const bad = [...new Set(value.match(VIN_FORBIDDEN) || [])];
    if (bad.length) errors.push(`tem a letra ${bad.join(' e ')} (proibida em chassi; costuma ser ${bad.map((b) => (b === 'I' ? '1' : '0')).join(' ou ')})`);
    if (value.length === 17) {
      if (!/^\d{4}$/.test(value.slice(13))) errors.push('os 4 últimos caracteres precisam ser números');
      else if (!/^\d{6}$/.test(value.slice(11))) warnings.push('os 6 últimos caracteres normalmente são números');
      if (!VIN_YEAR.includes(value[9])) errors.push(`o 10º caractere (${value[9]}) não é um código de ano válido`);
      if (!bad.length) {
        const cd = vinCheckDigit(value);
        if (cd !== null && cd !== value[8]) {
          if (CHECK_DIGIT_REQUIRED.test(value)) errors.push(`o dígito verificador (9º caractere) não confere: deveria ser ${cd}`);
          else warnings.push('dígito verificador não confere, o que é comum em veículos brasileiros');
        }
      }
    }
    const suggestions = errors.length ? chassiSuggestions(value) : [];
    return { kind: 'chassi', label: 'Chassi', value, ok: !errors.length, errors, warnings, suggestions };
  }

  /** Correções prováveis: letras proibidas, letras parecidas com números na parte numérica, caractere sobrando. */
  function chassiSuggestions(value) {
    const seen = new Set();
    const out = [];
    const consider = (cand, bonus = 0, pos = -1) => {
      if (!cand || cand === value || seen.has(cand)) return;
      seen.add(cand);
      const r = validateChassi(cand);
      if (!r.ok) return;
      let edits = 0;
      if (cand.length === value.length) for (let i = 0; i < cand.length; i++) if (cand[i] !== value[i]) edits++;
      else edits = Math.abs(cand.length - value.length) + 1;
      out.push({ value: cand, edits: edits - bonus, pos, checkOk: !r.warnings.some((w) => /dígito verificador/.test(w)) });
    };
    const swapForbidden = (s) => s.replace(/O/g, '0').replace(/I/g, '1').replace(/Q/g, '0');
    const tailMap = { S: '5', B: '8', Z: '2', G: '6', T: '7', D: '0', A: '4', L: '1', E: '3' };
    const fixTail = (s) => (s.length === 17 ? s.slice(0, 11) + s.slice(11).replace(/[A-Z]/g, (ch) => tailMap[ch] || ch) : s);

    const bases = [value, swapForbidden(value)];
    for (const b of bases) { consider(b); consider(fixTail(b)); }
    if (value.length === 18) {
      for (let i = 0; i < 18; i++) {
        const removed = value.slice(0, i) + value.slice(i + 1);
        // tecla repetida (ex.: ...2511) ou caractere sobrando na ponta são os enganos mais comuns
        const bonus = (value[i] === value[i - 1] || value[i] === value[i + 1]) ? 1 : (i === 0 || i === 17 ? 0.5 : 0);
        consider(removed, bonus, i); consider(swapForbidden(removed), bonus, i); consider(fixTail(swapForbidden(removed)), bonus, i);
      }
    }
    // Só a troca de letras proibidas já resolve? Mostra mesmo que o dígito verificador não bata.
    // empate: caractere sobrando mais perto do fim é o engano mais comum de digitação
    out.sort((a, b) => (a.edits - b.edits) || (Number(b.checkOk) - Number(a.checkOk)) || (b.pos - a.pos));
    return out.slice(0, 3).map((x) => x.value);
  }

  // ---------- Placa (antiga AAA-9999 e Mercosul AAA9A99) ----------
  function validatePlaca(raw) {
    const value = norm(raw);
    const errors = [];
    let format = null;
    if (/^[A-Z]{3}\d{4}$/.test(value)) format = 'antiga';
    else if (/^[A-Z]{3}\d[A-Z]\d{2}$/.test(value)) format = 'mercosul';
    else if (value.length !== 7) errors.push(`tem ${value.length} caracteres e a placa tem 7`);
    else errors.push('não está no formato AAA-9999 nem AAA9A99');
    const suggestions = errors.length ? placaSuggestions(value) : [];
    return { kind: 'placa', label: 'Placa', value, ok: !errors.length, format, errors, warnings: [], suggestions };
  }
  const toDigit = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', E: '3', A: '4', S: '5', G: '6', T: '7', B: '8' };
  const toLetter = { 0: 'O', 1: 'I', 2: 'Z', 3: 'E', 4: 'A', 5: 'S', 6: 'G', 7: 'T', 8: 'B' };
  function placaSuggestions(value) {
    if (value.length !== 7) return [];
    const letter = (ch) => (/[A-Z]/.test(ch) ? ch : toLetter[ch]);
    const digit = (ch) => (/\d/.test(ch) ? ch : toDigit[ch]);
    const build = (shape) => {
      let s = '';
      for (let i = 0; i < 7; i++) {
        const want = shape[i];
        const ch = want === 'L' ? letter(value[i]) : digit(value[i]);
        if (!ch) return null;
        s += ch;
      }
      return s;
    };
    const out = [];
    for (const shape of ['LLLDDDD', 'LLLDLDD']) {
      const s = build(shape);
      if (s && s !== value && !out.includes(s) && validatePlaca(s).ok) out.push(s);
    }
    return out;
  }

  // ---------- Renavam (9 ou 11 dígitos, com dígito verificador) ----------
  function renavamCheckDigit(base10) {
    const weights = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += Number(base10[i]) * weights[i];
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  }
  function validateRenavam(raw) {
    let value = digits(raw);
    const errors = [];
    if (value.length === 9) value = '00' + value;
    if (value.length !== 11) errors.push(`tem ${value.length} dígitos e o Renavam tem 11 (ou 9 nos antigos)`);
    else if (renavamCheckDigit(value.slice(0, 10)) !== Number(value[10])) errors.push('o dígito verificador não confere');
    return { kind: 'renavam', label: 'Renavam', value, ok: !errors.length, errors, warnings: [], suggestions: [] };
  }

  // ---------- CPF e CNPJ ----------
  function cpfCheck(base, weightStart) {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (weightStart - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  }
  function validateCpf(raw) {
    const value = digits(raw);
    const errors = [];
    if (value.length !== 11) errors.push(`tem ${value.length} dígitos e o CPF tem 11`);
    else if (/^(\d)\1{10}$/.test(value)) errors.push('todos os dígitos iguais não é um CPF válido');
    else if (cpfCheck(value.slice(0, 9), 10) !== Number(value[9]) || cpfCheck(value.slice(0, 10), 11) !== Number(value[10])) errors.push('os dígitos verificadores não conferem');
    const fmt = value.length === 11 ? value.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : value;
    return { kind: 'cpf', label: 'CPF', value, display: fmt, ok: !errors.length, errors, warnings: [], suggestions: [] };
  }
  function cnpjCheck(base) {
    const weights = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  }
  function validateCnpj(raw) {
    const value = digits(raw);
    const errors = [];
    if (value.length !== 14) errors.push(`tem ${value.length} dígitos e o CNPJ tem 14`);
    else if (/^(\d)\1{13}$/.test(value)) errors.push('todos os dígitos iguais não é um CNPJ válido');
    else if (cnpjCheck(value.slice(0, 12)) !== Number(value[12]) || cnpjCheck(value.slice(0, 13)) !== Number(value[13])) errors.push('os dígitos verificadores não conferem');
    const fmt = value.length === 14 ? value.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : value;
    return { kind: 'cnpj', label: 'CNPJ', value, display: fmt, ok: !errors.length, errors, warnings: [], suggestions: [] };
  }

  const VALIDATORS = { chassi: validateChassi, placa: validatePlaca, renavam: validateRenavam, cpf: validateCpf, cnpj: validateCnpj };

  /** Escolhe o validador pelo nome do tipo de consulta (configurável): "Chassi", "Placa", "CPF"... */
  function validatorFor(kindName) {
    const k = String(kindName || '').toLowerCase();
    for (const key of Object.keys(VALIDATORS)) if (k.includes(key)) return VALIDATORS[key];
    return null;
  }

  /**
   * Procura no texto do cliente coisas que parecem referência de consulta, inclusive erradas
   * (chassi com 16 ou 18 caracteres, placa com O no lugar de 0), e valida cada uma.
   */
  function detect(text) {
    const src = String(text || '');
    const found = [];
    const seen = new Set();
    const add = (r, raw) => {
      const key = r.kind + ':' + r.value;
      if (seen.has(key) || !r.value) return;
      seen.add(key);
      found.push({ ...r, raw });
    };
    // CNPJ e CPF formatados
    for (const m of src.match(/\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g) || []) add(validateCnpj(m), m);
    for (const m of src.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g) || []) add(validateCpf(m), m);
    // Palavras-chave ajudam a decidir o que é o quê
    const labeled = [
      [/\bchassi\w*\s*[:\-]?\s*([A-Z0-9][A-Z0-9 \-]{12,22})/gi, validateChassi],
      [/\bplaca\s*[:\-]?\s*([A-Z0-9]{3}[\s\-]?[A-Z0-9]{4})/gi, validatePlaca],
      [/\brenavam\s*[:\-]?\s*(\d[\d \.]{8,14})/gi, validateRenavam],
      [/\bcpf\s*[:\-]?\s*(\d[\d\.\- ]{9,16})/gi, validateCpf],
      [/\bcnpj\s*[:\-]?\s*(\d[\d\.\/\- ]{12,20})/gi, validateCnpj],
    ];
    for (const [re, fn] of labeled) {
      let m;
      while ((m = re.exec(src))) {
        let raw = m[1].trim();
        if (fn === validateChassi) {
          // junta pedaços separados por espaço/traço só até formar algo do tamanho de um chassi
          const parts = raw.split(/[\s-]+/);
          const acc = [];
          let len = 0;
          for (const p of parts) {
            if (len >= 15 && len + p.length > 19) break;
            acc.push(p); len += p.length;
            if (len >= 17) break;
          }
          raw = acc.join(' ');
        }
        add(fn(raw), raw);
      }
    }
    // Sem rótulo: sequências que lembram chassi (15 a 19 caracteres, letras e números misturados)
    const tokens = src.toUpperCase().match(/\b[A-Z0-9]{15,19}\b/g) || [];
    for (const t of tokens) if (/[A-Z]/.test(t) && /\d/.test(t)) add(validateChassi(t), t);
    // Placas soltas
    for (const t of src.toUpperCase().match(/\b[A-Z]{3}[\s\-]?\d[A-Z0-9]\d{2}\b/g) || []) add(validatePlaca(t), t);
    // Placa com O/I no lugar de número: 3 letras + 4 "quase números"
    for (const t of src.toUpperCase().match(/\b[A-Z]{3}[\s\-]?[0-9OIQ][A-Z0-9][0-9OI]{2}\b/g) || []) { const r = validatePlaca(t); if (!r.ok) add(r, t); }
    // Números soltos de 11 dígitos: CPF ou Renavam, mas nunca telefone (DDD + 9)
    for (const t of src.match(/\b\d{11}\b/g) || []) {
      if (/^[1-9]\d9/.test(t)) continue;
      const cpf = validateCpf(t);
      if (cpf.ok) { add(cpf, t); continue; }
      const ren = validateRenavam(t);
      if (ren.ok) add(ren, t);
    }
    for (const t of src.match(/\b\d{14}\b/g) || []) { const r = validateCnpj(t); if (r.ok) add(r, t); }
    return found;
  }

  /** Mensagem pronta para pedir ao cliente que confira o dado. */
  function askMessage(r) {
    const why = r.errors[0] ? r.errors[0] : 'não confere';
    switch (r.kind) {
      case 'chassi': return `O chassi que você enviou (${r.raw || r.value}) ${why}. O chassi correto tem 17 caracteres, sem as letras I, O e Q. Pode conferir no documento do veículo (CRLV) ou mandar uma foto dele?`;
      case 'placa': return `A placa ${r.raw || r.value} ${why}. Pode conferir e enviar de novo? O formato é AAA-9999 ou AAA9A99.`;
      case 'renavam': return `O Renavam ${r.raw || r.value} ${why}. Pode conferir no CRLV e reenviar?`;
      case 'cpf': return `O CPF ${r.raw || r.display} ${why}. Pode conferir e enviar de novo?`;
      case 'cnpj': return `O CNPJ ${r.raw || r.display} ${why}. Pode conferir e enviar de novo?`;
      default: return `O dado ${r.raw || r.value} ${why}. Pode conferir e enviar de novo?`;
    }
  }

  return { validateChassi, validatePlaca, validateRenavam, validateCpf, validateCnpj, validatorFor, detect, askMessage, vinCheckDigit, renavamCheckDigit };
});
