/* Sistema de Acompanhamento de Demanda — núcleo local (MVP)
   SIATE = LISTA OS (.xls) | LIST = Gerenciador de Obras (.csv)
   Chave: NUMOS exato | Sanitiza SIATE | Filtros antes de gravar no banco */
(function () {
  'use strict';

  var DB_KEY = 'sad_db_v1';
  var PAGE_SIZE = 50;
  var REGIONAL_NOME = { 1: 'LESTE', 2: 'CENTRO', 3: 'OESTE' };
  var STATUS_LIST = ['A INICIAR', 'EM ANDAMENTO', 'PENDENTE', 'ENCERRADO'];

  var state = {
    siateRaw: [], siateClean: [], listRaw: [], listClean: [],
    result: null, // {cong, soSiate, soList, log}
    view: 'caixa', search: '', statusFilter: 'TODOS',
    cf: { reg: '', codserv: '', cidade: '', dini: '', dfim: '', resp: '' }, // filtros da caixa
    metrics: { preset: 'hoje', dini: '', dfim: '', user: '' }, // métricas do admin
    scope: 'mine', // usuário: 'mine' (minha caixa) | 'pool' (disponíveis); admin vê tudo
    sort: { key: 'data-desc' }, // data-desc | data-asc | os-desc | os-asc (clicável no th + select)
    qf: { origem: '', codserv: '' }, // filtros da quarentena
    pagePrincipal: 1, pageQuar: 1,
    isAdmin: false, user: null,
    codservOptions: [],
  };

  var VIEW_TITLES = {
    caixa: ['Caixa principal', 'Demandas congruentes (nas duas bases) prontas para a equipe assumir.'],
    quarentena: ['Quarentena', 'Divergências: tem em uma base e não tem na outra. O admin aprova ou reprova.'],
    importar: ['Importar bases', 'Suba as duas bases (admin), ajuste os filtros e jogue no banco.'],
    distribuir: ['Distribuição', 'Cota automática de OS por usuário: quem zera recebe sozinho.'],
    resumo: ['Resumo', 'Totais da última comparação e do banco local.'],
    acompanhar: ['Acompanhar usuários', 'Quais OS estão com quais pessoas e em qual status.'],
    metricas: ['Métricas', 'Encerradas por usuário e por dia: hoje, 7/30 dias, mês ou período personalizado.'],
  };
  var ADMIN_VIEWS = ['quarentena', 'importar', 'acompanhar', 'metricas', 'distribuir'];

  function showView(v) {
    if (ADMIN_VIEWS.indexOf(v) !== -1 && !state.isAdmin) v = 'caixa';
    state.view = v;
    var map = { caixa: 'view-principal', quarentena: 'view-quarentena', importar: 'view-importar', resumo: 'view-resumo', acompanhar: 'view-acompanhar', metricas: 'view-metricas', distribuir: 'view-distribuir' };
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]);
      if (el) el.style.display = (k === v) ? '' : 'none';
    });
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-nav') === v);
    });
    var t = VIEW_TITLES[v] || VIEW_TITLES.caixa;
    if ($('crumb')) $('crumb').textContent = t[0];
    if ($('page-title')) $('page-title').textContent = t[0];
    if ($('page-desc')) $('page-desc').textContent = t[1];
    if (v === 'acompanhar') renderAcompanhar();
    if (v === 'metricas') renderMetricas();
    if (v === 'distribuir') renderDistribuicao();
  }

  // ---------- utils ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function onlyDigits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function normOS(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') { try { return String(Math.trunc(v)); } catch (e) { return String(v).trim(); } }
    var s = String(v).trim();
    if (/^\d+\.0+$/.test(s)) s = s.split('.')[0];
    else if (/^\d+\.\d+$/.test(s) && s.length > 12) s = s.split('.')[0];
    s = s.replace(/\s+/g, '');
    if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, '');
    var d = onlyDigits(s);
    return d || s;
  }
  function normInt(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return String(Math.trunc(v));
    var d = onlyDigits(String(v));
    return d ? String(parseInt(d, 10)) : '';
  }
  function excelSerialToISO(n) {
    try {
      var ms = Math.round((Number(n) - 25569) * 86400 * 1000);
      var d = new Date(ms);
      if (isNaN(d.getTime())) return '';
      return d.toISOString().slice(0, 10);
    } catch (e) { return ''; }
  }
  function parseDataSol(v) {
    if (v == null || v === '') return { iso: '', raw: '' };
    if (typeof v === 'number') return { iso: excelSerialToISO(v), raw: String(v) };
    var s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 20000 && Number(s) < 80000) {
      return { iso: excelSerialToISO(Number(s)), raw: s };
    }
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      var dd = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0'), yy = m[3];
      if (yy.length === 2) yy = '20' + yy;
      return { iso: yy + '-' + mm + '-' + dd, raw: s };
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return { iso: m[1] + '-' + m[2] + '-' + m[3], raw: s };
    return { iso: '', raw: s };
  }
  function normText(v, upper) {
    var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return upper === false ? s : s.toUpperCase();
  }
  function normPhone(v) { return onlyDigits(v).slice(0, 13); }
  function meEmail() { return String((state.user && state.user.email) || '').toLowerCase(); }
  function isMine(p) {
    return !!(p.responsavel && String(p.responsavel).toLowerCase() === meEmail());
  }
  // Dia local YYYY-MM-DD (métrica "encerradas hoje")
  function dayKey(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      var m = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + m(d.getMonth() + 1) + '-' + m(d.getDate());
    } catch (e) { return ''; }
  }
  function todayKey() { return dayKey(new Date().toISOString()); }

  // ---------- DB ----------
  function loadDB() {
    try {
      var d = JSON.parse(localStorage.getItem(DB_KEY) || 'null');
      if (d && d.principal && d.quarentena) return d;
    } catch (e) {}
    return { principal: [], quarentena: [], imports: [], reproved: [] };
  }
  function saveDB(db) {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); return true; }
    catch (e) { return false; } // quota excedida (~5MB) — pushToDB avisa
  }

  // ---------- quarentena compacta (cabe na quota do localStorage) ----------
  // SO_SIATE: {n,c,d,r,cid,cli,t} | SO_LIST: {n,c,desc,loc,t}
  // SO_SIATE e JA_NA_CAIXA carregam campos SIATE; SO_LIST carrega campos LIST.
  function compactQ(dados, origem) {
    var d = dados || {};
    if (origem === 'SO_LIST') {
      return {
        n: d.numos || '', c: d.codserv || '', desc: String(d.descricao || '').slice(0, 60),
        loc: String(d.local || '').slice(0, 40), t: d.telefone || '',
      };
    }
    return {
      n: d.numos || '', c: d.codserv || '', d: d.dataISO || '',
      r: d.codreg || '', cid: String(d.cidade || '').slice(0, 40),
      cli: String(d.cliente || '').slice(0, 50), t: d.tel1 || '',
    };
  }
  function qmotivo(x) {
    if (x.motivo) return x.motivo;
    if (x.origem === 'SO_SIATE') return 'Tem na SIATE e não tem na LIST';
    if (x.origem === 'SO_LIST') return 'Tem na LIST e não tem na SIATE';
    if (x.origem === 'DIVERGENTE') return 'Serviço/dados divergem entre SIATE e LIST';
    return 'OS já existe na caixa principal (repetida na importação)';
  }
  // Lê campo da quarentena nos 2 formatos (compacto novo + legado 'dados')
  function qget(x, k) {
    if (x.d && x.d[k] !== undefined) return x.d[k];
    var legacy = x.dados || {};
    var map = { n: 'numos', c: 'codserv', d: 'dataISO', r: 'codreg', cid: 'cidade', cli: 'cliente', t: 'tel1', desc: 'descricao', loc: 'local' };
    return legacy[map[k] || k] || '';
  }

  // ---------- SheetJS parse ----------
  function parseFile(file) {
    return file.arrayBuffer().then(function (buf) {
      var wb = XLSX.read(buf, { type: 'array', cellDates: false });
      var wsName = wb.SheetNames[0];
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[wsName], { defval: '', raw: true });
      var headers = rows.length ? Object.keys(rows[0]) : [];
      return { rows: rows, headers: headers, sheet: wsName };
    });
  }
  function headerKey(h) {
    return String(h || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '');
  }
  function findCol(headers, candidates) {
    var map = {};
    headers.forEach(function (h) { map[headerKey(h)] = h; });
    for (var i = 0; i < candidates.length; i++) {
      if (map[candidates[i]]) return map[candidates[i]];
    }
    // contém
    for (var j = 0; j < headers.length; j++) {
      var k = headerKey(headers[j]);
      for (var c = 0; c < candidates.length; c++) {
        if (k.indexOf(candidates[c]) !== -1) return headers[j];
      }
    }
    return null;
  }

  // ---------- sanitização SIATE ----------
  function sanitizeSiate(rows, headers) {
    var cNumos = findCol(headers, ['numos', 'numosorig', 'os']);
    var cCod = findCol(headers, ['codserv', 'codigoservico']);
    var cData = findCol(headers, ['datasol', 'dtsolicitacao', 'solicitacao']);
    var cReg = findCol(headers, ['codreg', 'regional']);
    var cObs = findCol(headers, ['obsos', 'observ']);
    var cCid = findCol(headers, ['nomelcd', 'localidade', 'cidade', 'local']);
    var cCli = findCol(headers, ['nomecli', 'cliente', 'nome']);
    var cTel = findCol(headers, ['numtel']);
    var cDsc = findCol(headers, ['dscsvc', 'descricaoservico', 'descricao']);
    var cTel2 = null;
    headers.forEach(function (h) { if (headerKey(h) === 'numtel2') cTel2 = h; });

    var log = [];
    if (!cNumos) log.push('AVISO: coluna NUMOS não encontrada. Headers: ' + headers.slice(0, 12).join(' | '));
    var clean = [], seen = {}, dups = 0, empty = 0;
    rows.forEach(function (r, i) {
      var numos = normOS(cNumos ? r[cNumos] : '');
      if (!numos) { empty++; return; }
      if (seen[numos]) { dups++; return; }
      seen[numos] = 1;
      var codserv = normInt(cCod ? r[cCod] : '');
      var dt = parseDataSol(cData ? r[cData] : '');
      var regN = parseInt(normInt(cReg ? r[cReg] : '') || '0', 10) || 0;
      clean.push({
        numos: numos,
        codserv: codserv,
        datasol: dt.raw, dataISO: dt.iso,
        codreg: regN || '',
        regional: REGIONAL_NOME[regN] || (regN ? String(regN) : ''),
        obs: normText(cObs ? r[cObs] : '', false).slice(0, 500),
        cidade: normText(cCid ? r[cCid] : ''),
        cliente: normText(cCli ? r[cCli] : '', false).slice(0, 120),
        tel1: normPhone(cTel ? r[cTel] : ''),
        tel2: normPhone(cTel2 ? r[cTel2] : ''),
        dscsvc: normText(cDsc ? r[cDsc] : '', false).slice(0, 200),
      });
    });
    log.push('SIATE: ' + rows.length + ' linhas lidas → ' + clean.length + ' válidas (' + empty + ' sem NUMOS, ' + dups + ' duplicadas removidas).');
    return { clean: clean, log: log };
  }

  // ---------- sanitização LIST ----------
  function sanitizeList(rows, headers) {
    var cOS = findCol(headers, ['os', 'numos', 'numeroos']);
    if (!cOS && headers.length) cOS = headers[0];
    var cCod = findCol(headers, ['codigodeservico', 'codserv']);
    var cDesc = findCol(headers, ['descricaodoservico', 'descricao']);
    var cLocal = findCol(headers, ['local']);
    var cReg = findCol(headers, ['regional']);
    var cSol = findCol(headers, ['solicitacao']);
    var cStatus = findCol(headers, ['status']);
    var cTel = findCol(headers, ['telefonecliente', 'telefone']);
    var clean = [], seen = {}, dups = 0, empty = 0;
    rows.forEach(function (r) {
      var os = normOS(cOS ? r[cOS] : '');
      if (!os) { empty++; return; }
      if (seen[os]) { dups++; return; }
      seen[os] = 1;
      clean.push({
        numos: os,
        codserv: normInt(cCod ? r[cCod] : ''),
        descricao: normText(cDesc ? r[cDesc] : '', false).slice(0, 200),
        local: normText(cLocal ? r[cLocal] : ''),
        regional: normText(cReg ? r[cReg] : ''),
        solicitacao: normText(cSol ? r[cSol] : '', false).slice(0, 60),
        statusOrigem: normText(cStatus ? r[cStatus] : '', false).slice(0, 60),
        telefone: normPhone(cTel ? r[cTel] : ''),
      });
    });
    return { clean: clean, log: ['LIST: ' + rows.length + ' linhas lidas → ' + clean.length + ' válidas (' + empty + ' sem OS, ' + dups + ' duplicadas removidas).'] };
  }

  // ---------- comparação ----------
  function compare(siate, list) {
    var mapS = {}, mapL = {};
    siate.forEach(function (s) { mapS[s.numos] = s; });
    list.forEach(function (l) { mapL[l.numos] = l; });
    var cong = [], soSiate = [], soList = [];
    Object.keys(mapS).forEach(function (k) {
      if (mapL[k]) cong.push(mapS[k]);
      else soSiate.push(mapS[k]);
    });
    Object.keys(mapL).forEach(function (k) { if (!mapS[k]) soList.push(mapL[k]); });
    return { cong: cong, soSiate: soSiate, soList: soList };
  }

  // Separa congruentes "puras" (vão p/ caixa) de conflitos (mesmo NUMOS nas
  // duas bases, mas codserv diferente → quarentena DIVERGENTE p/ revisar lado a lado).
  function splitConflicts(siateCong, list) {
    var mapL = {};
    list.forEach(function (l) { mapL[l.numos] = l; });
    var pure = [], confl = [];
    siateCong.forEach(function (s) {
      var l = mapL[s.numos];
      if (l && String(s.codserv || '') !== String(l.codserv || '')) confl.push({ s: s, l: l });
      else pure.push(s);
    });
    return { pure: pure, confl: confl };
  }
  function compactDiv(pair) {
    var s = pair.s || {}, l = pair.l || {};
    return {
      n: s.numos || '', cs: s.codserv || '', cl: l.codserv || '',
      ds: s.dataISO || '', dl: (typeof rowISO === 'function' ? rowISO(l) : (l.dataISO || '')),
      rs: s.codreg || '', cid: String(s.cidade || '').slice(0, 40),
      loc: String(l.local || '').slice(0, 40),
      cli: String(s.cliente || '').slice(0, 50),
      ts: s.tel1 || '', tl: l.telefone || '',
      desc: String(l.descricao || '').slice(0, 60),
    };
  }
  function divMotivo(d) {
    var m = 'Serviço diverge: SIATE ' + (d.cs || '—') + ' × LIST ' + (d.cl || '—');
    if ((d.ds || '') !== (d.dl || '')) m += ' • data SIATE ' + (d.ds || '—') + ' × LIST ' + (d.dl || '—');
    return m;
  }

  // ---------- filtros pré-banco (recortam AS DUAS BASES antes de comparar) ----------
  // Modelo: como se filtrasse as planilhas e apagasse o resto — só o
  // universo filtrado é comparado e vai para o banco (caixa + quarentena).
  function currentFilters() {
    var regs = [];
    document.querySelectorAll('.check-pill input:checked').forEach(function (i) { regs.push(i.value); });
    return {
      regs: regs, // 3 marcadas (ou nenhuma) = todas
      codserv: ($('f-codserv') || {}).value || '',
      cidade: ((($('f-cidade') || {}).value) || '').toUpperCase().trim(),
      dIni: (($('f-dini') || {}).value) || '',
      dFim: (($('f-dfim') || {}).value) || '',
    };
  }
  function brToISO(s) {
    s = String(s || '').trim();
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      var dd = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0'), yy = m[3];
      if (yy.length === 2) yy = '20' + yy;
      return yy + '-' + mm + '-' + dd;
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return '';
  }
  function rowReg(r) {
    var v = (r.codreg !== undefined && r.codreg !== '' && r.codreg !== null) ? r.codreg : (r.regional || '');
    v = String(v).trim().toUpperCase();
    if (v === 'LESTE') return '1'; // LIST mistura 1/2/3 com nomes
    if (v === 'CENTRO') return '2';
    if (v === 'OESTE') return '3';
    return v;
  }
  function rowCid(r) {
    var v = (r.cidade !== undefined) ? r.cidade : (r.local || '');
    return String(v || '').toUpperCase();
  }
  function rowISO(r) { return r.dataISO || brToISO(r.solicitacao); }
  function applyFilters(rows, f) {
    var regAll = f.regs.length === 0 || f.regs.length >= 3; // tudo marcado = sem filtro
    return rows.filter(function (r) {
      if (!regAll && f.regs.indexOf(rowReg(r)) === -1) return false;
      if (f.codserv && String(r.codserv || '') !== String(f.codserv)) return false;
      if (f.cidade && rowCid(r).indexOf(f.cidade) === -1) return false;
      var iso = rowISO(r);
      if ((f.dIni || f.dFim) && iso) {
        if (f.dIni && iso < f.dIni) return false;
        if (f.dFim && iso > f.dFim) return false;
      }
      return true;
    });
  }
  function filteredUniverse() {
    var f = currentFilters();
    return { f: f, siate: applyFilters(state.siateClean, f), list: applyFilters(state.listClean, f) };
  }

  // ---------- jogar no banco (INCREMENTAL: soma, nunca apaga) ----------
  // Regras p/ importação frequente (quase todo dia):
  // 1) O que já está na caixa é PRESERVADO (status/responsável intocados);
  // 2) Quarentena existente é preservada; reprovada NÃO volta;
  // 3) OS que estava na quarentena e agora virou congruente é PROMOVIDA p/ caixa.
  function pushToDB() {
    if (!state.siateClean.length || !state.listClean.length) { alert('Suba as duas bases e compare primeiro.'); return; }
    var u = filteredUniverse();
    var cmp = compare(u.siate, u.list);
    var sp0 = splitConflicts(cmp.cong, u.list);
    cmp.cong = sp0.pure;
    cmp.confl = sp0.confl;
    state.result = cmp;
    var f = u.f;
    var db = loadDB();
    var haveP = {}, haveQ = {}, reprovedSet = {};
    db.principal.forEach(function (p) { haveP[p.numos] = 1; });
    db.quarentena.forEach(function (q) { haveQ[q.numos + '|' + q.origem] = 1; });
    (db.reproved || []).forEach(function (r) {
      if (r.numos && r.origem) reprovedSet[r.numos + '|' + r.origem] = 1;
    });

    var dupToQ = !$('f-dup-quar') || $('f-dup-quar').checked; // repetida → quarentena p/ revisar
    var newP = 0, keptP = 0, dupQ = 0;
    var dupKeys = {}; // NUMOS da importação que já estavam na caixa
    cmp.cong.forEach(function (s) {
      if (haveP[s.numos]) {
        keptP++;
        dupKeys[s.numos] = s; // preserva status/responsável; decide abaixo se vai p/ quarentena
        return;
      }
      db.principal.push({
        numos: s.numos, codserv: s.codserv, datasol: s.datasol, dataISO: s.dataISO,
        codreg: s.codreg, regional: s.regional, cidade: s.cidade, cliente: s.cliente,
        tel1: s.tel1, tel2: s.tel2, obs: s.obs, dscsvc: s.dscsvc,
        statusDemanda: 'A INICIAR', responsavel: null, origem: 'CONGRUENTE',
        createdAt: new Date().toISOString(),
      });
      newP++;
    });
    // Promove da quarentena quem agora é congruente (limpa SO_SIATE/SO_LIST do
    // mesmo NUMOS; flags JA_NA_CAIXA são mantidas — elas são o histórico de repetidas)
    var promoted = 0;
    if (newP > 0 || keptP > 0) {
      var congSet = {};
      cmp.cong.forEach(function (s) { congSet[s.numos] = 1; });
      var qBefore = db.quarentena.length;
      db.quarentena = db.quarentena.filter(function (x) {
        return x.origem === 'JA_NA_CAIXA' || !congSet[x.numos];
      });
      promoted = qBefore - db.quarentena.length;
      // reindex haveQ após promoção
      haveQ = {};
      db.quarentena.forEach(function (q) { haveQ[q.numos + '|' + q.origem] = 1; });
    }
    // Repetidas: já estavam na caixa → quarentena como JA_NA_CAIXA p/ o admin revisar
    if (dupToQ) {
      Object.keys(dupKeys).forEach(function (numos) {
        var key = numos + '|JA_NA_CAIXA';
        if (haveQ[key]) return;
        if (reprovedSet[key]) return; // já revisada e descartada antes
        var s = dupKeys[numos];
        db.quarentena.push({ numos: numos, origem: 'JA_NA_CAIXA', motivo: qmotivo({ origem: 'JA_NA_CAIXA' }), d: compactQ(s, 'JA_NA_CAIXA'), createdAt: new Date().toISOString() });
        haveQ[key] = 1;
        dupQ++;
      });
    }
    // Conflitos: mesmo NUMOS, codserv diferente → quarentena DIVERGENTE (revisar lado a lado)
    var newDiv = 0, skipDivRep = 0;
    (cmp.confl || []).forEach(function (pair) {
      var numos = pair.s.numos;
      if (haveP[numos]) { keptP++; return; } // já na caixa: preserva, sem duplicar
      var key = numos + '|DIVERGENTE';
      if (haveQ[key]) return;
      if (reprovedSet[key]) { skipDivRep++; return; }
      var dd = compactDiv(pair);
      db.quarentena.push({ numos: numos, origem: 'DIVERGENTE', motivo: divMotivo(dd), d: dd, createdAt: new Date().toISOString() });
      haveQ[key] = 1;
      newDiv++;
    });
    var newQ = 0, skipReproved = 0;
    cmp.soSiate.forEach(function (s) {
      var key = s.numos + '|SO_SIATE';
      if (haveQ[key]) return;
      if (haveP[s.numos]) return; // já está na caixa → não duplica na quarentena
      if (reprovedSet[key]) { skipReproved++; return; } // reprovada não volta
      db.quarentena.push({ numos: s.numos, origem: 'SO_SIATE', d: compactQ(s, 'SO_SIATE'), createdAt: new Date().toISOString() });
      newQ++;
    });
    cmp.soList.forEach(function (l) {
      var key = l.numos + '|SO_LIST';
      if (haveQ[key]) return;
      if (haveP[l.numos]) return;
      if (reprovedSet[key]) { skipReproved++; return; }
      db.quarentena.push({ numos: l.numos, origem: 'SO_LIST', d: compactQ(l, 'SO_LIST'), createdAt: new Date().toISOString() });
      newQ++;
    });
    db.imports.push({ ts: new Date().toISOString(), filtros: f, siateFiltrada: u.siate.length, listFiltrada: u.list.length, congTotal: cmp.cong.length, novasPrincipal: newP, novasQuarentena: newQ, promovidas: promoted, ignoradasReprovadas: skipReproved + skipDivRep, preservadasCaixa: keptP, duplicadasQuarentena: dupQ, dupParaQuarentena: dupToQ, conflitos: (cmp.confl || []).length, novasDivergentes: newDiv });
    if (!saveDB(db)) {
      var kb = 0;
      try { kb = Math.round(JSON.stringify(db).length / 1024); } catch (e) {}
      renderAll();
      alert('NÃO SALVOU: banco local cheio (quota ~5MB; tentativa com aprox. ' + kb + 'KB). Nada foi gravado.\n\nSaídas:\n1) Jogue em partes usando filtros (ex: 1 regional por vez);\n2) Migre para o Supabase (docs/SUPABASE_SCHEMA.sql).');
      return;
    }
    // Distribuição automática pós-importação (quem zerou, recebe a cota)
    var distMsg = '';
    try {
      var dd = autoDistribute(db, null);
      if (dd.n > 0 && saveDB(db)) {
        distMsg = ' • 🚚 distribuição automática: ' + distSummary(dd);
        var dl = $('dist-log');
        if (dl) dl.textContent = new Date().toLocaleString('pt-BR') + ' — pós-importação: ' + distSummary(dd) + '.';
      }
    } catch (e5) {}
    renderAll('Banco atualizado (incremental, nada apagado): +' + newP + ' na caixa, +' + newQ + ' na quarentena, +' + newDiv + ' conflito(s) p/ revisar, ' + keptP + ' da caixa preservadas' + (dupToQ ? ', ' + dupQ + ' repetida(s) → quarentena (JÁ NA CAIXA)' : ', repetidas só ignoradas') + ', ' + promoted + ' promovidas da quarentena' + ((skipReproved + skipDivRep) ? ', ' + (skipReproved + skipDivRep) + ' reprovadas ignoradas' : '') + distMsg + '.');
  }

  // ---------- render ----------
  function statusBadge(st) {
    var cls = 'badge-gray';
    if (st === 'A INICIAR') cls = 'badge-blue';
    else if (st === 'EM ANDAMENTO') cls = 'badge-yellow';
    else if (st === 'PENDENTE') cls = 'badge-red';
    else if (st === 'ENCERRADO') cls = 'badge-green';
    return '<span class="badge ' + cls + '">' + esc(st) + '</span>';
  }
  function regionalBadge(r) {
    return '<span class="badge badge-gray">' + esc(r || '—') + '</span>';
  }

  function filteredPrincipal(db) {
    var q = state.search.trim().toUpperCase();
    var cf = state.cf;
    // Privacidade: usuário comum só enxerga a própria caixa + disponíveis.
    // (Admin vê tudo; quarentena/acompanhar já são só-admin.)
    var scope = state.isAdmin ? 'all' : (state.scope || 'mine');
    var out = db.principal.filter(function (p) {
      if (scope === 'mine' && !isMine(p)) return false;
      if (scope === 'pool' && p.responsavel) return false;
      if (state.statusFilter !== 'TODOS' && p.statusDemanda !== state.statusFilter) return false;
      if (cf.reg && String(p.codreg || '') !== cf.reg) return false;
      if (cf.codserv && String(p.codserv || '') !== cf.codserv) return false;
      if (cf.cidade && String(p.cidade || '').toUpperCase().indexOf(cf.cidade) === -1) return false;
      if ((cf.dini || cf.dfim) && p.dataISO) {
        if (cf.dini && p.dataISO < cf.dini) return false;
        if (cf.dfim && p.dataISO > cf.dfim) return false;
      }
      if (cf.resp === '__NONE__' && p.responsavel) return false;
      if (cf.resp && cf.resp !== '__NONE__' && p.responsavel !== cf.resp) return false;
      if (!q) return true;
      return String(p.numos).indexOf(q) !== -1 ||
        String(p.cliente || '').toUpperCase().indexOf(q) !== -1 ||
        String(p.cidade || '').toUpperCase().indexOf(q) !== -1 ||
        String(p.codserv || '').indexOf(q) !== -1;
    });
    return sortPrincipal(out, state.sort.key);
  }
  // Ordenação da caixa: data SOL (mais antigas ↔ mais novas) ou NUM OS.
  // Sem data vai para o fim, independente da direção.
  function sortPrincipal(list, key) {
    var arr = list.slice();
    var dir = (key === 'data-asc' || key === 'os-asc') ? 1 : -1;
    var byOS = key && key.indexOf('os-') === 0;
    arr.sort(function (a, b) {
      if (byOS) {
        var na = Number(a.numos), nb = Number(b.numos);
        var va = isFinite(na) ? na : String(a.numos || '');
        var vb = isFinite(nb) ? nb : String(b.numos || '');
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      }
      var da = a.dataISO || '', db2 = b.dataISO || '';
      if (!da && !db2) {
        var ca = a.createdAt || '', cb = b.createdAt || '';
        if (ca < cb) return -1 * dir;
        if (ca > cb) return 1 * dir;
        return String(a.numos) < String(b.numos) ? -1 : 1;
      }
      if (!da) return 1;
      if (!db2) return -1;
      if (da < db2) return -1 * dir;
      if (da > db2) return 1 * dir;
      return String(a.numos) < String(b.numos) ? -1 : 1;
    });
    return arr;
  }
  function sortArrow(col) {
    var k = state.sort.key;
    if (col === 'data' && (k === 'data-asc' || k === 'data-desc')) return k === 'data-asc' ? ' ▲' : ' ▼';
    if (col === 'os' && (k === 'os-asc' || k === 'os-desc')) return k === 'os-asc' ? ' ▲' : ' ▼';
    return ' <span style="opacity:.35">⇅</span>';
  }
  function filteredQuar(db) {
    var q = state.search.trim().toUpperCase();
    var qf = state.qf;
    return db.quarentena.filter(function (x) {
      if (qf.origem && x.origem !== qf.origem) return false;
      if (qf.codserv) {
        var okC = String(qget(x, 'c') || '') === qf.codserv;
        if (!okC && x.origem === 'DIVERGENTE' && x.d) {
          okC = String(x.d.cs || '') === qf.codserv || String(x.d.cl || '') === qf.codserv;
        }
        if (!okC) return false;
      }
      if (!q) return true;
      return String(x.numos).indexOf(q) !== -1 ||
        String(qget(x, 'cli') || qget(x, 'cid') || qget(x, 'loc') || '').toUpperCase().indexOf(q) !== -1;
    });
  }

  // ---------- exportar quarentena (sempre o FILTRADO) ----------
  var QEXP_COLS = ['NUMOS', 'ORIGEM', 'CODSERV', 'DATA_SOL', 'REGIONAL', 'CIDADE_LOCAL', 'CLIENTE', 'TELEFONE', 'DETALHE', 'MOTIVO'];
  function quarToRows(list) {
    return list.map(function (x) {
      var legacy = x.dados || {};
      if (x.origem === 'DIVERGENTE') {
        var dd = x.d || {};
        return {
          NUMOS: x.numos,
          ORIGEM: x.origem,
          CODSERV: 'SIATE ' + (dd.cs || '—') + ' | LIST ' + (dd.cl || '—'),
          DATA_SOL: (dd.ds || '—') + ' | ' + (dd.dl || '—'),
          REGIONAL: dd.rs || '',
          CIDADE_LOCAL: dd.cid || dd.loc || '',
          CLIENTE: dd.cli || '',
          TELEFONE: dd.ts || dd.tl || '',
          DETALHE: dd.desc || '',
          MOTIVO: qmotivo(x),
        };
      }
      return {
        NUMOS: x.numos,
        ORIGEM: x.origem,
        CODSERV: qget(x, 'c'),
        DATA_SOL: qget(x, 'd'),
        REGIONAL: qget(x, 'r'),
        CIDADE_LOCAL: qget(x, 'cid') || qget(x, 'loc'),
        CLIENTE: qget(x, 'cli'),
        TELEFONE: qget(x, 't') || legacy.telefone || '',
        DETALHE: qget(x, 'desc'),
        MOTIVO: qmotivo(x),
      };
    });
  }
  function qexpName(ext) {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    var suf = [];
    if (state.qf.origem) suf.push(state.qf.origem === 'SO_SIATE' ? 'so-siate' : state.qf.origem === 'SO_LIST' ? 'so-list' : state.qf.origem === 'DIVERGENTE' ? 'conflitos' : 'ja-na-caixa');
    if (state.qf.codserv) suf.push('serv' + state.qf.codserv);
    if (state.search.trim()) suf.push('busca');
    return 'quarentena_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      (suf.length ? '_' + suf.join('_') : '') + '.' + ext;
  }
  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportQuarCSV() {
    var rows = quarToRows(filteredQuar(loadDB()));
    if (!rows.length) { alert('Nada para exportar com os filtros atuais.'); return; }
    function cell(v) {
      v = String(v == null ? '' : v);
      return (/[";\n\r]/.test(v)) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    var txt = '\uFEFF' + QEXP_COLS.join(';') + '\r\n' +      rows.map(function (r) { return QEXP_COLS.map(function (c) { return cell(r[c]); }).join(';'); }).join('\r\n');
    downloadBlob(new Blob([txt], { type: 'text/csv;charset=utf-8' }), qexpName('csv'));
  }
  function exportQuarXLSX() {
    var rows = quarToRows(filteredQuar(loadDB()));
    if (!rows.length) { alert('Nada para exportar com os filtros atuais.'); return; }
    try {
      var ws = XLSX.utils.json_to_sheet(rows, { header: QEXP_COLS });
      ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 9 }, { wch: 12 }, { wch: 9 }, { wch: 22 }, { wch: 28 }, { wch: 14 }, { wch: 30 }, { wch: 34 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Quarentena');
      XLSX.writeFile(wb, qexpName('xlsx'));
    } catch (e) {
      console.error(e);
      alert('Falha ao gerar XLSX. Tente o CSV.');
    }
  }

  function renderStats() {
    var db = loadDB();
    var r = state.result;
    $('st-si').textContent = state.siateClean.length || (r ? r.cong.length + r.soSiate.length : db.principal.length ? '—' : '0');
    $('st-li').textContent = state.listClean.length || (r ? r.cong.length + r.soList.length : '0');
    $('st-ok').textContent = r ? r.cong.length : db.principal.length;
    $('st-ssi').textContent = r ? r.soSiate.length : db.quarentena.filter(function (x) { return x.origem === 'SO_SIATE'; }).length;
    $('st-sli').textContent = r ? r.soList.length : db.quarentena.filter(function (x) { return x.origem === 'SO_LIST'; }).length;
    $('st-p').textContent = db.principal.length;
    $('st-q').textContent = db.quarentena.length;
    if (state.isAdmin) {
      $('count-badge').textContent = db.principal.length + ' na caixa • ' + db.quarentena.length + ' quarentena';
      $('tab-n-p').textContent = db.principal.length;
    } else {
      // Usuário não vê nem a quantidade dos outros: só minhas + disponíveis.
      var mine0 = 0, pool0 = 0;
      db.principal.forEach(function (p) { if (isMine(p)) mine0++; else if (!p.responsavel) pool0++; });
      $('count-badge').textContent = mine0 + ' minhas • ' + pool0 + ' disponíveis';
      $('tab-n-p').textContent = mine0 + pool0;
    }
    $('tab-n-q').textContent = db.quarentena.length;
  }

  // ---------- minha caixa: contadores + métrica do dia (usuário) ----------
  function renderMyStats() {
    var panel = $('my-stats-panel'), el = $('my-stats');
    if (!panel || !el) return;
    if (state.isAdmin) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    var db = loadDB();
    var mine = 0, pool = 0, hoje = 0, tk = todayKey();
    db.principal.forEach(function (p) {
      if (!p.responsavel) { pool++; return; }
      if (!isMine(p)) return;
      mine++;
      if (p.encerradoEm && dayKey(p.encerradoEm) === tk) hoje++;
    });
    el.innerHTML = '🙋 <b>' + mine + '</b> na minha caixa &nbsp;•&nbsp; ✅ <b>' + hoje + '</b> encerrada(s) hoje &nbsp;•&nbsp; 📦 <b>' + pool + '</b> disponível(is)';
    var nm = $('scope-n-mine'), np = $('scope-n-pool');
    if (nm) nm.textContent = mine;
    if (np) np.textContent = pool;
    document.querySelectorAll('[data-scope]').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-scope') === (state.scope || 'mine'));
    });
    var sr = $('scope-row');
    if (sr) sr.style.display = '';
  }

  function renderTables(msg) {
    var db = loadDB();
    // principal
    var lp = filteredPrincipal(db);
    var totalP = Math.max(1, Math.ceil(lp.length / PAGE_SIZE));
    if (state.pagePrincipal > totalP) state.pagePrincipal = totalP;
    var sliceP = lp.slice((state.pagePrincipal - 1) * PAGE_SIZE, state.pagePrincipal * PAGE_SIZE);
    var html = '';
    if (!sliceP.length) {
      html = '<div class="no-results"><div class="big">📭</div>Nenhuma demanda na caixa principal.<br>Importe as bases acima (admin) para começar.</div>';
    } else {
      html = '<div class="table-wrap"><table><thead><tr>' +
        '<th data-sort="os" title="Clique para ordenar por NUM OS" style="cursor:pointer;user-select:none">NUM OS' + sortArrow('os') + '</th><th>CODSERV</th><th data-sort="data" title="Clique para ordenar por DATA SOL (antigas ↔ novas)" style="cursor:pointer;user-select:none">DATA SOL' + sortArrow('data') + '</th><th>REGIONAL</th><th>CIDADE</th><th>CLIENTE</th><th>TELEFONE</th><th>STATUS</th><th>RESPONSÁVEL</th><th>AÇÕES</th>' +
        '</tr></thead><tbody>';
      sliceP.forEach(function (p) {
        html += '<tr>' +
          '<td><span class="os-id">' + esc(p.numos) + '</span></td>' +
          '<td class="mono">' + esc(p.codserv || '—') + '</td>' +
          '<td class="mono">' + esc(p.dataISO || p.datasol || '—') + '</td>' +
          '<td>' + regionalBadge(p.codreg ? p.codreg + '·' + p.regional : p.regional) + '</td>' +
          '<td>' + esc(p.cidade || '—') + '</td>' +
          '<td>' + esc(p.cliente || '—') + '</td>' +
          '<td class="mono">' + esc(p.tel1 || p.telefone || '—') + '</td>' +
          '<td>' + statusBadge(p.statusDemanda) + '<br><select class="status-select" data-act="status" data-os="' + esc(p.numos) + '" style="margin-top:6px">' +
          STATUS_LIST.map(function (s) { return '<option value="' + s + '"' + (s === p.statusDemanda ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
          '</select></td>' +
          '<td class="mono">' + esc(p.responsavel || '—') + '</td>' +
          '<td style="white-space:nowrap">' +
          (p.responsavel ? '' : '<button class="btn-small" data-act="pegar" data-os="' + esc(p.numos) + '">Pegar</button> ') +
          '<button class="btn-small danger" data-act="liberar" data-os="' + esc(p.numos) + '">Liberar</button>' +
          '</td></tr>';
      });
      html += '</tbody></table></div>';
      html += '<div class="pagination"><button class="page-btn" data-pg="p-prev">‹</button>' +
        '<span class="page-info">Pág ' + state.pagePrincipal + '/' + totalP + ' • ' + lp.length + ' itens</span>' +
        '<button class="page-btn" data-pg="p-next">›</button></div>';
    }
    $('tbl-principal').innerHTML = html;

    // quarentena
    var lq = filteredQuar(db);
    var totalQ = Math.max(1, Math.ceil(lq.length / PAGE_SIZE));
    if (state.pageQuar > totalQ) state.pageQuar = totalQ;
    var sliceQ = lq.slice((state.pageQuar - 1) * PAGE_SIZE, state.pageQuar * PAGE_SIZE);
    var hq = '';
    if (!sliceQ.length) {
      hq = '<div class="no-results"><div class="big">🛡️</div>Quarentena vazia.<br>Divergências (só em uma base) aparecem aqui após a importação.</div>';
    } else {
      hq = '<div class="table-wrap"><table><thead><tr>' +
        '<th>NUM OS</th><th>ORIGEM</th><th>MOTIVO</th><th>DETALHE</th><th>AÇÕES (admin)</th>' +
        '</tr></thead><tbody>';
      sliceQ.forEach(function (x) {
        var det = '';
        var isDiv = x.origem === 'DIVERGENTE';
        var dd = (isDiv && x.d) ? x.d : null;
        if (x.origem === 'SO_LIST') {
          det = 'CODSERV ' + esc(qget(x, 'c') || '—') + ' • ' + esc(qget(x, 'loc')) + ' • ' + esc(qget(x, 'desc'));
        } else if (isDiv && dd) {
          det = 'SIATE serv <b>' + esc(dd.cs || '—') + '</b> × LIST serv <b>' + esc(dd.cl || '—') + '</b>' +
            '<br><span class="mono" style="font-size:11px">data ' + esc(dd.ds || '—') + ' × ' + esc(dd.dl || '—') +
            ' • ' + esc(dd.cid || dd.loc || '—') + ' • ' + esc(dd.cli || dd.desc || '') + '</span>';
        } else {
          det = 'CODSERV ' + esc(qget(x, 'c') || '—') + ' • ' + esc(qget(x, 'cid') || qget(x, 'loc')) + ' • ' + esc(qget(x, 'cli')) + ' • REG ' + esc(qget(x, 'r') || '—');
        }
        var dis = state.isAdmin ? '' : ' disabled title="Somente admin"';
        var motivo = qmotivo(x);
        var badge = x.origem === 'SO_SIATE' ? '<span class="badge badge-yellow">SÓ SIATE</span>'
          : x.origem === 'SO_LIST' ? '<span class="badge badge-red">SÓ LIST</span>'
          : isDiv ? '<span class="badge badge-yellow">⚔️ CONFLITO</span>'
          : '<span class="badge badge-blue">JÁ NA CAIXA</span>';
        var acts;
        if (isDiv) {
          acts = '<button class="btn-small ok" data-act="aprovar-siate" data-os="' + esc(x.numos) + '"' + dis + '>P/ caixa (SIATE ' + esc((dd && dd.cs) || '') + ')</button> ' +
            '<button class="btn-small ok" data-act="aprovar-list" data-os="' + esc(x.numos) + '"' + dis + '>P/ caixa (LIST ' + esc((dd && dd.cl) || '') + ')</button> ' +
            '<button class="btn-small danger" data-act="reprovar" data-os="' + esc(x.numos) + '" data-org="' + esc(x.origem) + '"' + dis + '>Reprovar</button>';
        } else {
          acts = '<button class="btn-small ok" data-act="aprovar" data-os="' + esc(x.numos) + '" data-org="' + esc(x.origem) + '"' + dis + '>Aprovar</button> ' +
            '<button class="btn-small danger" data-act="reprovar" data-os="' + esc(x.numos) + '" data-org="' + esc(x.origem) + '"' + dis + '>Reprovar</button>';
        }
        hq += '<tr>' +
          '<td><span class="os-id">' + esc(x.numos) + '</span></td>' +
          '<td>' + badge + '</td>' +
          '<td class="mono" style="font-size:11px">' + esc(motivo) + '</td>' +
          '<td style="font-size:12px">' + det + '</td>' +
          '<td style="white-space:nowrap">' + acts + '</td></tr>';
      });
      hq += '</tbody></table></div>';
      hq += '<div class="pagination"><button class="page-btn" data-pg="q-prev">‹</button>' +
        '<span class="page-info">Pág ' + state.pageQuar + '/' + totalQ + ' • ' + lq.length + ' itens</span>' +
        '<button class="page-btn" data-pg="q-next">›</button></div>';
    }
    $('tbl-quarentena').innerHTML = hq;
    var qc = $('q-count');
    if (qc) qc.textContent = lq.length + ' item(ns)' + (lq.length !== db.quarentena.length ? ' (filtrados de ' + db.quarentena.length + ')' : '');
    // Abas da quarentena (telas separadas por tipo) com contadores
    try {
      var qn = { all: db.quarentena.length, div: 0, ssi: 0, sli: 0, ja: 0 };
      db.quarentena.forEach(function (x) {
        if (x.origem === 'DIVERGENTE') qn.div++;
        else if (x.origem === 'SO_SIATE') qn.ssi++;
        else if (x.origem === 'SO_LIST') qn.sli++;
        else qn.ja++;
      });
      var qmap = { 'q-n-all': qn.all, 'q-n-div': qn.div, 'q-n-ssi': qn.ssi, 'q-n-sli': qn.sli, 'q-n-ja': qn.ja };
      Object.keys(qmap).forEach(function (id) { var e = $(id); if (e) e.textContent = qmap[id]; });
      document.querySelectorAll('[data-qtab]').forEach(function (c) {
        c.classList.toggle('active', (c.getAttribute('data-qtab') || '') === (state.qf.origem || ''));
      });
    } catch (e4) {}

    if (msg) $('result-msg').textContent = msg;
    renderStats();
    renderMyStats();
    if (state.isAdmin) renderUsuarios();
  }

  // ---------- quarentena em massa (admin) ----------
  function quarFilteredKeys() {
    var lq = filteredQuar(loadDB());
    var s = {};
    lq.forEach(function (x) { s[x.numos + '|' + x.origem] = 1; });
    return { list: lq, set: s };
  }
  function approveQuarList(list) {
    var db = loadDB();
    var added = 0, skipped = 0;
    list.forEach(function (x) {
      // Conflitos exigem revisão lado a lado (um a um) — bulk não decide o lado.
      if (x.origem === 'DIVERGENTE') { skipped++; return; }
      var ix = -1;
      for (var i = 0; i < db.quarentena.length; i++) {
        if (db.quarentena[i].numos === x.numos && db.quarentena[i].origem === x.origem) { ix = i; break; }
      }
      if (ix === -1) return;
      var item = db.quarentena.splice(ix, 1)[0];
      if (!db.principal.find(function (p) { return p.numos === x.numos; })) {
        db.principal.push({
          numos: x.numos, codserv: qget(item, 'c'), datasol: '', dataISO: qget(item, 'd'),
          codreg: qget(item, 'r'), regional: REGIONAL_NOME[qget(item, 'r')] || '',
          cidade: qget(item, 'cid') || qget(item, 'loc'),
          cliente: qget(item, 'cli'), tel1: qget(item, 't'),
          tel2: '', obs: '', dscsvc: qget(item, 'desc'),
          statusDemanda: 'A INICIAR', responsavel: null, origem: 'QUARENTENA_APROVADA',
          createdAt: new Date().toISOString(),
        });
        added++;
      }
    });
    if (!saveDB(db)) { alert('NÃO SALVOU: banco local cheio (quota ~5MB).'); return { added: 0, skipped: skipped }; }
    return { added: added, skipped: skipped };
  }
  // Aprova um conflito escolhendo o lado (SIATE ou LIST) como dado da caixa.
  function approveDivergente(os, side) {
    var db = loadDB();
    var ix = -1;
    for (var i = 0; i < db.quarentena.length; i++) {
      if (db.quarentena[i].numos === os && db.quarentena[i].origem === 'DIVERGENTE') { ix = i; break; }
    }
    if (ix === -1) return;
    var item = db.quarentena.splice(ix, 1)[0];
    var d = item.d || {};
    if (!db.principal.find(function (p) { return p.numos === os; })) {
      var useS = side === 'SIATE';
      db.principal.push({
        numos: os,
        codserv: useS ? (d.cs || '') : (d.cl || ''),
        datasol: '', dataISO: useS ? (d.ds || '') : (d.dl || ''),
        codreg: useS ? (d.rs || '') : '', regional: '',
        cidade: d.cid || d.loc || '',
        cliente: d.cli || '', tel1: useS ? (d.ts || '') : (d.tl || ''),
        tel2: '', obs: '', dscsvc: useS ? '' : (d.desc || ''),
        statusDemanda: 'A INICIAR', responsavel: null, origem: 'CONFLITO_' + side,
        createdAt: new Date().toISOString(),
      });
    }
    if (!saveDB(db)) { alert('NÃO SALVOU: banco local cheio (quota ~5MB).'); return; }
    renderAll('OS ' + os + ' liberada p/ caixa com dados da ' + side + '.');
  }
  function removeQuarList(list, archive) {
    var db = loadDB();
    var keys = {};
    list.forEach(function (x) { keys[x.numos + '|' + x.origem] = 1; });
    var removed = [];
    db.quarentena = db.quarentena.filter(function (x) {
      if (keys[x.numos + '|' + x.origem]) { removed.push(x); return false; }
      return true;
    });
    if (archive !== false) {
      db.reproved = db.reproved || [];
      var have = {};
      db.reproved.forEach(function (r) { have[r.numos + '|' + r.origem] = 1; });
      removed.forEach(function (x) {
        var k = x.numos + '|' + x.origem;
        if (!have[k]) {
          db.reproved.push({ numos: x.numos, origem: x.origem, ts: new Date().toISOString(), por: (state.user && state.user.email) || '' });
          have[k] = 1;
        }
      });
    }
    if (!saveDB(db)) { alert('NÃO SALVOU: banco local cheio (quota ~5MB).'); return 0; }
    return removed.length;
  }

  // ---------- acompanhar usuários (admin) ----------
  function renderAcompanhar() {
    if (state.isAdmin && typeof renderUsuarios === 'function') { try { renderUsuarios(); } catch (e) {} }
    var el = $('tbl-acompanhar');
    if (!el) return;
    var db = loadDB();
    var tk = todayKey();
    var groups = {}, order = [];
    db.principal.forEach(function (p) {
      var k = p.responsavel || '';
      if (!groups[k]) { groups[k] = { total: 0, ini: 0, and: 0, pen: 0, enc: 0, hoje: 0, maos: 0, oss: [] }; order.push(k); }
      var g = groups[k];
      g.total++;
      if (p.statusDemanda === 'A INICIAR') g.ini++;
      else if (p.statusDemanda === 'EM ANDAMENTO') g.and++;
      else if (p.statusDemanda === 'PENDENTE') g.pen++;
      else if (p.statusDemanda === 'ENCERRADO') g.enc++;
      else g.maos++;
      // Métrica do dia: encerrada hoje por essa pessoa (crédito = quem encerrou).
      if (p.encerradoEm && dayKey(p.encerradoEm) === tk) {
        var dono = String(p.encerradoPor || p.responsavel || '').toLowerCase();
        if (dono === String(k).toLowerCase() || (!dono && !k)) g.hoje++;
      }
      if (g.oss.length < 30) g.oss.push(p.numos);
    });
    order.sort(function (a, b) {
      if (!a) return 1; if (!b) return -1;
      return groups[b].total - groups[a].total;
    });
    if (!order.length) {
      el.innerHTML = '<div class="no-results"><div class="big">👥</div>Ninguém com OS ainda.<br>A caixa principal está vazia ou sem responsáveis.</div>';
      return;
    }
    var h = '<div class="table-wrap"><table><thead><tr>' +
      '<th>Pessoa</th><th>Total</th><th>Hoje ✅</th><th>Em mãos</th><th>A iniciar</th><th>Em andamento</th><th>Pendente</th><th>Encerrado</th><th>OS (amostra)</th><th></th>' +
      '</tr></thead><tbody>';
    order.forEach(function (k) {
      var g = groups[k];
      h += '<tr>' +
        '<td><b>' + esc(k || '— Sem responsável —') + '</b></td>' +
        '<td class="mono"><b>' + g.total + '</b></td>' +
        '<td><span class="badge badge-green">' + g.hoje + '</span></td>' +
        '<td class="mono"><b>' + g.maos + '</b></td>' +
        '<td><span class="badge badge-blue">' + g.ini + '</span></td>' +
        '<td><span class="badge badge-yellow">' + g.and + '</span></td>' +
        '<td><span class="badge badge-red">' + g.pen + '</span></td>' +
        '<td><span class="badge badge-green">' + g.enc + '</span></td>' +
        '<td class="mono" style="font-size:11px;max-width:280px">' + esc(g.oss.join(', ')) + (g.total > g.oss.length ? ' …' : '') + '</td>' +
        '<td><button class="btn-small" data-act="ver-caixa" data-resp="' + esc(k) + '">Ver na caixa</button></td></tr>';
    });
    el.innerHTML = h + '</tbody></table></div>' +
      '<div class="panel-hint">“Hoje ✅” = OS com status ENCERRADO registrado hoje para essa pessoa. Só aparecem pessoas com OS; contas sem OS não listam.</div>';
  }

  // ---------- métricas do admin (encerradas por usuário/período) ----------
  // Fonte: status ENCERRADO com encerradoEm/encerradoPor (gravados na troca de
  // status). Itens antigos sem data entram no total da caixa, mas não no período.
  function fmtDay(d) {
    var m = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + m(d.getMonth() + 1) + '-' + m(d.getDate());
  }
  function parseDay(s) {
    var a = String(s || '').split('-');
    return new Date(+a[0], (+a[1] || 1) - 1, +a[2] || 1);
  }
  function addDaysStr(ds, n) {
    var d = parseDay(ds);
    d.setDate(d.getDate() + n);
    return fmtDay(d);
  }
  function mRange() {
    var tk = todayKey(), p = state.metrics.preset || 'hoje', ini, fim;
    if (p === '7d') { ini = addDaysStr(tk, -6); fim = tk; }
    else if (p === '30d') { ini = addDaysStr(tk, -29); fim = tk; }
    else if (p === 'mes') { ini = tk.slice(0, 7) + '-01'; fim = tk; }
    else if (p === 'custom') {
      ini = state.metrics.dini || tk; fim = state.metrics.dfim || tk;
      if (ini > fim) { var t = ini; ini = fim; fim = t; }
    }
    else { ini = tk; fim = tk; }
    return { ini: ini, fim: fim };
  }
  function mEncerradas(db, ini, fim, user) {
    var out = [];
    db.principal.forEach(function (x) {
      if (!x.encerradoEm) return;
      var dk = dayKey(x.encerradoEm);
      if (!dk || dk < ini || dk > fim) return;
      var dono = x.encerradoPor || x.responsavel || '';
      if (user && String(dono).toLowerCase() !== String(user).toLowerCase()) return;
      out.push({ numos: x.numos, dia: dk, por: dono });
    });
    return out;
  }
  function mUserRole(email) {
    try {
      if (typeof getUsers !== 'function') return isAdminEmail(email) ? 'admin' : 'usuario';
      var us = getUsers(), em = String(email).toLowerCase();
      for (var i = 0; i < us.length; i++) {
        if (String(us[i].email).toLowerCase() === em) return us[i].role;
      }
    } catch (e) {}
    return isAdminEmail(email) ? 'admin' : 'usuario';
  }
  function populateMUser(db) {
    var sel = $('m-user');
    if (!sel) return;
    var seen = {}, order = [];
    function add(e) {
      e = String(e || '').trim();
      if (!e) return;
      var k = e.toLowerCase();
      if (!seen[k]) { seen[k] = e; order.push(e); }
    }
    try {
      if (typeof getUsers === 'function') getUsers().forEach(function (u) { add(u.email); });
    } catch (e) {}
    db.principal.forEach(function (p) { add(p.encerradoPor); add(p.responsavel); });
    order.sort();
    var cur = state.metrics.user || '';
    sel.innerHTML = '<option value="">Todos</option>' + order.map(function (e) {
      return '<option value="' + esc(e) + '">' + esc(e) + '</option>';
    }).join('');
    sel.value = cur;
  }
  function renderMetricas() {
    if (!state.isAdmin) return;
    var db = loadDB();
    populateMUser(db);
    var r = mRange();
    var list = mEncerradas(db, r.ini, r.fim, '');
    // KPIs
    var ativos = {}, maos = 0;
    list.forEach(function (e) {
      var k = String(e.por || '').toLowerCase();
      if (k) ativos[k] = 1;
    });
    db.principal.forEach(function (p) { if (p.statusDemanda !== 'ENCERRADO') maos++; });
    if ($('m-k-total')) $('m-k-total').textContent = list.length;
    if ($('m-k-range')) $('m-k-range').textContent = r.ini === r.fim ? r.ini : r.ini + ' → ' + r.fim;
    if ($('m-k-ativos')) $('m-k-ativos').textContent = Object.keys(ativos).length;
    if ($('m-k-maos')) $('m-k-maos').textContent = maos;
    if ($('m-range-label')) $('m-range-label').textContent = 'Período: ' + r.ini + ' → ' + r.fim + ' • fonte: OS com ENCERRADO datado (itens antigos sem data não entram no período).';
    // Por usuário: todas as contas + quem tem produção fora do cadastro
    var agg = {};
    function row(email, role) {
      var k = String(email).toLowerCase();
      if (!agg[k]) agg[k] = { email: email, role: role, enc: 0, maos: 0, total: 0 };
      return agg[k];
    }
    try {
      if (typeof getUsers === 'function') getUsers().forEach(function (u) { row(u.email, u.role); });
    } catch (e) {}
    list.forEach(function (e) {
      if (!e.por) return;
      row(e.por, mUserRole(e.por)).enc++;
    });
    db.principal.forEach(function (p) {
      if (!p.responsavel) return;
      var g = row(p.responsavel, mUserRole(p.responsavel));
      g.total++;
      if (p.statusDemanda !== 'ENCERRADO') g.maos++;
    });
    var rows = Object.keys(agg).map(function (k) { return agg[k]; });
    rows.sort(function (a, b) { return b.enc - a.enc || b.total - a.total || (a.email < b.email ? -1 : 1); });
    var hu = $('m-tbl-user');
    if (hu) {
      if (!rows.length) {
        hu.innerHTML = '<div class="no-results"><div class="big">📈</div>Sem dados.<br>Cadastre usuários e importe OS para ver as métricas.</div>';
      } else {
        var h = '<div class="table-wrap"><table><thead><tr>' +
          '<th>Usuário</th><th>Perfil</th><th>Encerradas (período)</th><th>Em mãos</th><th>Total na caixa</th>' +
          '</tr></thead><tbody>';
        rows.forEach(function (g) {
          h += '<tr><td class="mono">' + esc(g.email) + '</td>' +
            '<td>' + (g.role === 'admin' ? '<span class="badge badge-yellow">ADMIN</span>' : '<span class="badge badge-gray">USUÁRIO</span>') + '</td>' +
            '<td><span class="badge badge-green">' + g.enc + '</span></td>' +
            '<td class="mono"><b>' + g.maos + '</b></td>' +
            '<td class="mono">' + g.total + '</td></tr>';
        });
        hu.innerHTML = h + '</tbody></table></div>';
      }
    }
    // Por dia (respeita o filtro de usuário)
    var mu = state.metrics.user || '';
    var dayList = mu ? mEncerradas(db, r.ini, r.fim, mu) : list;
    var perDay = {}, d = r.ini, guard = 0;
    while (d <= r.fim && guard < 366) { perDay[d] = 0; d = addDaysStr(d, 1); guard++; }
    dayList.forEach(function (e) { if (perDay[e.dia] !== undefined) perDay[e.dia]++; });
    var days = Object.keys(perDay).sort().reverse();
    var hd = $('m-tbl-day');
    if (hd) {
      var hh = '<div class="table-wrap"><table style="min-width:320px"><thead><tr><th>Dia</th><th>Encerradas</th></tr></thead><tbody>';
      days.forEach(function (dd) {
        hh += '<tr><td class="mono">' + esc(dd) + '</td><td><span class="badge ' + (perDay[dd] ? 'badge-green' : 'badge-gray') + '">' + perDay[dd] + '</span></td></tr>';
      });
      hd.innerHTML = hh + '</tbody></table></div>' +
        (guard >= 366 ? '<div class="panel-hint">Período limitado a 366 dias na tabela.</div>' : '');
    }
    var ds = $('m-day-sub');
    if (ds) ds.textContent = 'Encerradas por dia no período' + (mu ? ' · ' + mu : ' · todos');
    state.metrics._rows = rows;
    state.metrics._range = r;
  }
  function exportMetricasCSV() {
    var rows = state.metrics._rows || [], r = state.metrics._range || mRange();
    if (!rows.length) { alert('Nada para exportar.'); return; }
    function cell(v) {
      v = String(v == null ? '' : v);
      return (/[";\n\r]/.test(v)) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    var cols = ['USUARIO', 'PERFIL', 'ENCERRADAS_PERIODO', 'EM_MAOS', 'TOTAL_CAIXA'];
    var txt = '\uFEFF' + cols.join(';') + '\r\n' + rows.map(function (g) {
      return [g.email, g.role, g.enc, g.maos, g.total].map(cell).join(';');
    }).join('\r\n');
    downloadBlob(new Blob([txt], { type: 'text/csv;charset=utf-8' }), 'metricas_' + r.ini + '_' + r.fim + '.csv');
  }

  // ---------- distribuição automática (admin configura, sistema entrega) ----------
  var CFG_KEY = 'sad_cfg_v1';
  function loadCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (c && c.distrib) return c;
    } catch (e) {}
    return { distrib: { enabled: false, qty: 10, per: {} } };
  }
  function saveCfg(c) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); return true; }
    catch (e) { return false; }
  }
  function distQtyFor(email, cfg) {
    cfg = cfg || (loadCfg().distrib || {});
    var per = (cfg.per || {})[String(email).toLowerCase()];
    var q = (per === undefined || per === null || per === '') ? cfg.qty : per;
    q = parseInt(q, 10);
    if (isNaN(q)) q = 0;
    return Math.max(0, q);
  }
  function openCount(db, email) {
    var em = String(email).toLowerCase(), n = 0;
    db.principal.forEach(function (p) {
      if (String(p.responsavel || '').toLowerCase() === em && p.statusDemanda !== 'ENCERRADO') n++;
    });
    return n;
  }
  // Devolve {assigned:{email:n}, n:total}. Não salva — quem chama salva.
  function autoDistribute(db, onlyEmails) {
    var cfg = loadCfg().distrib || {};
    if (!cfg.enabled) return { assigned: {}, n: 0, off: true };
    var want = null;
    if (onlyEmails && onlyEmails.length) {
      want = {};
      onlyEmails.forEach(function (e) { want[String(e).toLowerCase()] = 1; });
    }
    var targets = [];
    try {
      if (typeof getUsers === 'function') {
        getUsers().forEach(function (u) {
          if (u.role !== 'usuario') return; // admins não recebem
          var em = String(u.email).toLowerCase();
          if (want && !want[em]) return;
          targets.push(u.email);
        });
      }
    } catch (e) {}
    // e-mails explícitos fora do cadastro (legado): atende se não for admin
    if (want) {
      Object.keys(want).forEach(function (em) {
        var known = targets.some(function (t) { return String(t).toLowerCase() === em; });
        if (!known && !isAdminEmail(em)) targets.push(em);
      });
    }
    var pool = db.principal.filter(function (p) { return !p.responsavel; });
    pool.sort(function (a, b) {
      var da = a.dataISO || '', db2 = b.dataISO || '';
      if (!da && !db2) return String(a.numos) < String(b.numos) ? -1 : 1;
      if (!da) return 1;
      if (!db2) return -1;
      if (da < db2) return -1;
      if (da > db2) return 1;
      return String(a.numos) < String(b.numos) ? -1 : 1;
    });
    var assigned = {}, total = 0, now = new Date().toISOString();
    targets.forEach(function (email) {
      if (!pool.length) return;
      if (openCount(db, email) > 0) return; // só quem zerou
      var q = distQtyFor(email, cfg);
      if (q <= 0) return;
      var lot = pool.splice(0, q);
      lot.forEach(function (p) {
        p.responsavel = email;
        if (p.statusDemanda === 'A INICIAR') p.statusDemanda = 'EM ANDAMENTO';
        p.encerradoEm = null; p.encerradoPor = null;
        p.distribuidoEm = now; p.distribuidoAuto = true;
      });
      if (lot.length) { assigned[email] = lot.length; total += lot.length; }
    });
    return { assigned: assigned, n: total, short: pool.length === 0 && total > 0 };
  }
  function distSummary(r) {
    var ks = Object.keys(r.assigned || {});
    if (!ks.length) return '';
    var s = ks.slice(0, 3).map(function (k) { return r.assigned[k] + ' → ' + k; }).join(', ');
    if (ks.length > 3) s += ' (+' + (ks.length - 3) + ' pessoas)';
    return s;
  }
  function renderDistribuicao() {
    if (!state.isAdmin) return;
    var cfg = loadCfg();
    cfg.distrib = cfg.distrib || { enabled: false, qty: 10, per: {} };
    var pill = $('pill-dist-enabled'), chk = $('dist-enabled');
    if (chk) chk.checked = !!cfg.distrib.enabled;
    if (pill) pill.classList.toggle('on', !!cfg.distrib.enabled);
    var qi = $('dist-qty');
    if (qi && document.activeElement !== qi) qi.value = (cfg.distrib.qty === undefined ? 10 : cfg.distrib.qty);
    var el = $('dist-tbl');
    if (el) {
      var db = loadDB(), users = [];
      try { if (typeof getUsers === 'function') users = getUsers(); } catch (e) {}
      if (!users.length) {
        el.innerHTML = '<div class="no-results"><div class="big">🚚</div>Sem usuários cadastrados.</div>';
      } else {
        var h = '<div class="table-wrap"><table style="min-width:520px"><thead><tr>' +
          '<th>Usuário</th><th>Perfil</th><th>Abertas</th><th>Qtd individual</th>' +
          '</tr></thead><tbody>';
        users.forEach(function (u) {
          var ov = (cfg.distrib.per || {})[String(u.email).toLowerCase()];
          h += '<tr><td class="mono">' + esc(u.email) + '</td>' +
            '<td>' + (u.role === 'admin' ? '<span class="badge badge-yellow">ADMIN</span>' : '<span class="badge badge-gray">USUÁRIO</span>') + '</td>' +
            '<td class="mono">' + (u.role === 'usuario' ? openCount(db, u.email) : '—') + '</td>' +
            '<td>' + (u.role === 'usuario'
              ? '<input type="number" min="0" max="500" step="1" data-dist-qty="' + esc(u.email) + '" value="' + esc(ov === undefined ? '' : ov) + '" placeholder="' + esc(cfg.distrib.qty) + '" style="width:90px;background:var(--input-bg);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:6px 9px;font-size:12px">'
              : '<span class="mono" style="font-size:11px;color:var(--text3)">não recebe</span>') + '</td></tr>';
        });
        el.innerHTML = h + '</tbody></table></div>';
      }
    }
  }

  // ---------- filtros + export da quarentena ----------
  function populateQuarFilters(db) {
    var sel = $('f3-codserv');
    if (!sel) return;
    var cs = {};
    db.quarentena.forEach(function (x) {
      var c = qget(x, 'c');
      if (c) cs[c] = 1;
      if (x.origem === 'DIVERGENTE' && x.d) {
        if (x.d.cs) cs[x.d.cs] = 1;
        if (x.d.cl) cs[x.d.cl] = 1;
      }
    });
    var cur = state.qf.codserv;
    sel.innerHTML = '<option value="">Todos</option>' + Object.keys(cs).sort().map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
    sel.value = cur;
  }

  // ---------- filtros da caixa ----------
  function f2Count() {
    var n = 0, cf = state.cf;
    if (cf.reg) n++;
    if (cf.codserv) n++;
    if (cf.cidade) n++;
    if (cf.dini || cf.dfim) n++;
    if (cf.resp) n++;
    return n;
  }
  function syncF2Toggle() {
    var body = $('f2-body'), btn = $('btn-f2-toggle'), badge = $('f2-count');
    if (!body || !btn) return;
    var open = true;
    try { open = localStorage.getItem('sad-f2-open') !== '0'; } catch (e) {}
    body.classList.toggle('closed', !open);
    btn.classList.toggle('closed', !open);
    if (badge) {
      var n = f2Count();
      badge.textContent = n;
      badge.classList.toggle('show', n > 0);
    }
  }
  function syncCaixaFilterInputs() {
    if ($('f2-reg')) $('f2-reg').value = state.cf.reg;
    if ($('f2-codserv')) $('f2-codserv').value = state.cf.codserv;
    if ($('f2-cidade')) $('f2-cidade').value = state.cf.cidade;
    if ($('f2-dini')) $('f2-dini').value = state.cf.dini;
    if ($('f2-dfim')) $('f2-dfim').value = state.cf.dfim;
    if ($('f2-resp')) $('f2-resp').value = state.cf.resp;
    if ($('f2-sort')) $('f2-sort').value = state.sort.key;
  }
  function populateCaixaFilters(db) {
    var cs = {}, rs = {};
    db.principal.forEach(function (p) {
      if (p.codserv) cs[p.codserv] = 1;
      if (p.responsavel) rs[p.responsavel] = 1;
    });
    var sel = $('f2-codserv');
    if (sel) {
      var cur = state.cf.codserv;
      sel.innerHTML = '<option value="">Todos</option>' + Object.keys(cs).sort().map(function (c) {
        return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
      }).join('');
      sel.value = cur;
    }
    var selR = $('f2-resp');
    if (selR) {
      var curR = state.cf.resp;
      if (state.isAdmin) {
        selR.innerHTML = '<option value="">Todos</option><option value="__NONE__">Sem responsável</option>' +
          Object.keys(rs).sort().map(function (r) {
            return '<option value="' + esc(r) + '">' + esc(r) + '</option>';
          }).join('');
      } else {
        // Usuário não vê e-mails alheios: só Todos / Sem responsável / Eu.
        var me = (state.user && state.user.email) || '';
        selR.innerHTML = '<option value="">Todos (meu alcance)</option><option value="__NONE__">Sem responsável</option>' +
          (me ? '<option value="' + esc(me) + '">Eu (' + esc(me) + ')</option>' : '');
        if (curR && curR !== '__NONE__' && curR !== me) curR = '';
      }
      selR.value = curR;
    }
  }

  // ---------- usuários locais (10 users + 6 admins; Supabase vira Auth real) ----------
  function renderUsuarios() {
    var el = $('tbl-usuarios');
    if (!el || !state.isAdmin || typeof getUsers !== 'function') return;
    var users = getUsers();
    var h = '<div class="table-wrap"><table style="min-width:560px"><thead><tr>' +
      '<th>E-mail</th><th>Perfil</th><th>Criado em</th><th></th>' +
      '</tr></thead><tbody>';
    users.forEach(function (u) {
      var me = state.user && String(state.user.email || '').toLowerCase() === String(u.email).toLowerCase();
      h += '<tr><td class="mono">' + esc(u.email) + (me ? ' <span class="badge badge-blue">você</span>' : '') + '</td>' +
        '<td>' + (u.role === 'admin' ? '<span class="badge badge-yellow">ADMIN</span>' : '<span class="badge badge-gray">USUÁRIO</span>') + '</td>' +
        '<td class="mono" style="font-size:11px">' + esc((u.createdAt || '').slice(0, 10)) + '</td>' +
        '<td style="white-space:nowrap">' +
        (me ? '<span class="mono" style="font-size:11px;color:var(--text3)">atual</span>'
          : '<button class="btn-small" data-act="user-role" data-email="' + esc(u.email) + '">virar ' + (u.role === 'admin' ? 'usuário' : 'admin') + '</button> ' +
            '<button class="btn-small danger" data-act="user-del" data-email="' + esc(u.email) + '">Excluir</button>') +
        '</td></tr>';
    });
    el.innerHTML = h + '</tbody></table></div>' +
      '<div class="panel-hint">Total: ' + users.length + ' conta(s) neste navegador. Para valer no site p/ todos (multiusuário real), configure o Supabase — ver docs/DEPLOY_SUPABASE.md e js/config.js.</div>';
  }

  function renderAll(msg) {
    var db = loadDB();
    populateCaixaFilters(db);
    populateQuarFilters(db);
    renderTables(msg);
    if (state.isAdmin) {
      var sr = $('scope-row');
      if (sr) sr.style.display = 'none';
    }
    document.querySelectorAll('.chip[data-st]').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-st') === state.statusFilter);
    });
    syncF2Toggle();
    showView(state.view);
  }

  function applySearch() {
    state.search = ($('q') || {}).value || '';
    state.pagePrincipal = 1; state.pageQuar = 1;
    renderAll();
  }

  // ---------- eventos ----------
  function bindEvents() {
    document.querySelectorAll('.chip[data-st]').forEach(function (c) {
      c.addEventListener('click', function () { state.statusFilter = c.getAttribute('data-st'); state.pagePrincipal = 1; renderAll(); });
    });
    document.querySelectorAll('.chip[data-scope]').forEach(function (c) {
      c.addEventListener('click', function () { state.scope = c.getAttribute('data-scope'); state.pagePrincipal = 1; renderAll(); });
    });
    var bs = $('btn-search');
    if (bs) bs.addEventListener('click', applySearch);
    var qi = $('q');
    if (qi) qi.addEventListener('keydown', function (e) { if (e.key === 'Enter') applySearch(); });

    // filtros da caixa
    ['f2-reg', 'f2-codserv', 'f2-cidade', 'f2-dini', 'f2-dfim', 'f2-resp'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        state.cf = {
          reg: ($('f2-reg') || {}).value || '',
          codserv: ($('f2-codserv') || {}).value || '',
          cidade: ((($('f2-cidade') || {}).value) || '').toUpperCase().trim(),
          dini: (($('f2-dini') || {}).value) || '',
          dfim: (($('f2-dfim') || {}).value) || '',
          resp: ($('f2-resp') || {}).value || '',
        };
        state.pagePrincipal = 1;
        renderAll();
      });
    });
    // ordenação da caixa (select + clique no th)
    var fsort = $('f2-sort');
    if (fsort) fsort.addEventListener('change', function () {
      state.sort.key = fsort.value || 'data-desc';
      state.pagePrincipal = 1;
      renderAll();
    });
    document.addEventListener('click', function (e) {
      var th = e.target.closest ? e.target.closest('th[data-sort]') : null;
      if (th) {
        var col = th.getAttribute('data-sort');
        if (col === 'data') state.sort.key = (state.sort.key === 'data-desc') ? 'data-asc' : 'data-desc';
        else if (col === 'os') state.sort.key = (state.sort.key === 'os-desc') ? 'os-asc' : 'os-desc';
        state.pagePrincipal = 1;
        syncCaixaFilterInputs();
        renderAll();
      }
    });
    var f2c = $('btn-f2-clear');
    if (f2c) f2c.addEventListener('click', function () {
      state.cf = { reg: '', codserv: '', cidade: '', dini: '', dfim: '', resp: '' };
      state.search = ''; if ($('q')) $('q').value = '';
      state.statusFilter = 'TODOS'; state.pagePrincipal = 1;
      syncCaixaFilterInputs();
      renderAll();
    });
    var f2t = $('btn-f2-toggle');
    if (f2t) f2t.addEventListener('click', function () {
      var open = true;
      try { open = localStorage.getItem('sad-f2-open') !== '0'; } catch (e) {}
      try { localStorage.setItem('sad-f2-open', open ? '0' : '1'); } catch (e) {}
      syncF2Toggle();
    });

    // filtros da quarentena (origem + serviço)
    ['f3-origem', 'f3-codserv'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        state.qf = {
          origem: ($('f3-origem') || {}).value || '',
          codserv: ($('f3-codserv') || {}).value || '',
        };
        state.pageQuar = 1;
        renderAll();
      });
    });
    // métricas do admin (presets + personalizado + usuário + export)
    document.querySelectorAll('.chip[data-mp]').forEach(function (c) {
      c.addEventListener('click', function () {
        state.metrics.preset = c.getAttribute('data-mp');
        document.querySelectorAll('.chip[data-mp]').forEach(function (x) {
          x.classList.toggle('active', x === c);
        });
        renderMetricas();
      });
    });
    ['m-dini', 'm-dfim'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        state.metrics.dini = ($('m-dini') || {}).value || '';
        state.metrics.dfim = ($('m-dfim') || {}).value || '';
        state.metrics.preset = 'custom';
        document.querySelectorAll('.chip[data-mp]').forEach(function (x) {
          x.classList.toggle('active', x.getAttribute('data-mp') === 'custom');
        });
        renderMetricas();
      });
    });
    var mus = $('m-user');
    if (mus) mus.addEventListener('change', function () {
      state.metrics.user = mus.value || '';
      renderMetricas();
    });
    var mex = $('m-export');
    if (mex) mex.addEventListener('click', exportMetricasCSV);
    // abas da quarentena (telas separadas por tipo) — sincronizam com o select
    document.querySelectorAll('.chip[data-qtab]').forEach(function (c) {
      c.addEventListener('click', function () {
        var tab = c.getAttribute('data-qtab') || '';
        var sel = $('f3-origem');
        if (sel) sel.value = tab;
        state.qf = { origem: tab, codserv: ($('f3-codserv') || {}).value || '' };
        state.pageQuar = 1;
        renderAll();
      });
    });
    // modal de incongruências
    var mbc = $('modal-btn-confl');
    if (mbc) mbc.addEventListener('click', function () { gotoQuarTab('DIVERGENTE'); });
    var mbq = $('modal-btn-quar');
    if (mbq) mbq.addEventListener('click', function () { hideConflModal(); showView('quarentena'); });
    var mbo = $('modal-btn-ok');
    if (mbo) mbo.addEventListener('click', hideConflModal);
    var mov = $('modal-div');
    if (mov) mov.addEventListener('click', function (e) { if (e.target === mov) hideConflModal(); });

    var ex1 = $('btn-exp-csv');
    if (ex1) ex1.addEventListener('click', exportQuarCSV);
    var ex2 = $('btn-exp-xlsx');
    if (ex2) ex2.addEventListener('click', exportQuarXLSX);
    // quarentena em massa (admin)
    var bqa = $('btn-q-aprovar');
    if (bqa) bqa.addEventListener('click', function () {
      if (!state.isAdmin) { alert('Somente admin.'); return; }
      var qf = quarFilteredKeys();
      if (!qf.list.length) { alert('Nada nos filtros atuais.'); return; }
      if (!confirm('Aprovar ' + qf.list.length + ' item(ns) filtrado(s) → caixa principal?')) return;
      var ar = approveQuarList(qf.list);
      renderAll('✅ ' + ar.added + ' OS aprovada(s) → caixa principal.' + (ar.skipped ? ' (' + ar.skipped + ' conflito(s) ignorados — revise um a um na aba Conflitos.)' : ''));
    });
    var bqd = $('btn-q-apagar');
    if (bqd) bqd.addEventListener('click', function () {
      if (!state.isAdmin) { alert('Somente admin.'); return; }
      var qf = quarFilteredKeys();
      if (!qf.list.length) { alert('Nada nos filtros atuais.'); return; }
      if (!confirm('Apagar ' + qf.list.length + ' item(ns) FILTRADO(S) da quarentena? (Arquiva como reprovada p/ não voltar na próxima importação. A caixa NÃO é tocada.)')) return;
      var n = removeQuarList(qf.list, true);
      renderAll('🗑️ ' + n + ' item(ns) apagado(s) da quarentena.');
    });
    var bql = $('btn-q-limpar');
    if (bql) bql.addEventListener('click', function () {
      if (!state.isAdmin) { alert('Somente admin.'); return; }
      var db0 = loadDB();
      if (!db0.quarentena.length) { alert('Quarentena já está vazia.'); return; }
      if (!confirm('Apagar TUDO da quarentena (' + db0.quarentena.length + ' itens)? Arquiva como reprovadas p/ não voltarem. A caixa principal NÃO é tocada.')) return;
      if (!confirm('Confirma mesmo? Essa ação esvazia a quarentena.')) return;
      var n = removeQuarList(db0.quarentena, true);
      renderAll('🧹 Quarentena esvaziada: ' + n + ' item(ns) apagado(s).');
    });
    // gestão de usuários (admin, local; Supabase vira definitivo)
    var bua = $('btn-user-add');
    if (bua) bua.addEventListener('click', function () {
      if (!state.isAdmin || typeof createUser !== 'function') { alert('Somente admin.'); return; }
      var em = (($('new-user-email') || {}).value || '').trim();
      var pw = (($('new-user-pass') || {}).value || '');
      var rl = (($('new-user-role') || {}).value || 'usuario');
      var r = createUser(em, pw, rl);
      if (r.error) { alert(r.error); return; }
      if ($('new-user-email')) $('new-user-email').value = '';
      if ($('new-user-pass')) $('new-user-pass').value = '';
      renderAll('👤 Usuário ' + em + ' criado como ' + rl + '.');
    });

    document.addEventListener('click', function (e) {
      var pg = e.target.getAttribute && e.target.getAttribute('data-pg');
      if (pg === 'p-prev' && state.pagePrincipal > 1) { state.pagePrincipal--; renderAll(); }
      if (pg === 'p-next') { state.pagePrincipal++; renderAll(); }
      if (pg === 'q-prev' && state.pageQuar > 1) { state.pageQuar--; renderAll(); }
      if (pg === 'q-next') { state.pageQuar++; renderAll(); }

      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      var os = btn.getAttribute('data-os');
      var db = loadDB();
      if (act === 'pegar') {
        var p = db.principal.find(function (x) { return x.numos === os; });
        if (p) {
          if (!state.isAdmin && p.responsavel && !isMine(p)) { alert('Essa OS já está com outro usuário.'); return; }
          p.responsavel = (state.user && state.user.email) || 'eu';
          if (p.statusDemanda === 'A INICIAR') p.statusDemanda = 'EM ANDAMENTO';
          p.encerradoEm = null; p.encerradoPor = null;
          saveDB(db); renderAll('OS ' + os + ' na sua caixa. Bom trabalho! 🙋');
        }
      }
      if (act === 'liberar') {
        var p2 = db.principal.find(function (x) { return x.numos === os; });
        if (p2) {
          if (!state.isAdmin && p2.responsavel && !isMine(p2)) { alert('Essa OS já está com outro usuário.'); return; }
          var who = p2.responsavel || ((state.user && state.user.email) || '');
          p2.responsavel = null; p2.statusDemanda = 'A INICIAR';
          p2.encerradoEm = null; p2.encerradoPor = null;
          saveDB(db);
          var refill2 = '';
          if (who) {
            try {
              var rl = autoDistribute(db, [who]);
              if (rl.n > 0 && saveDB(db)) refill2 = ' 🚚 +' + rl.n + ' nova(s) na sua caixa.';
            } catch (e7) {}
          }
          renderAll('OS ' + os + ' devolvida aos disponíveis.' + refill2);
        }
      }
      if (act === 'ver-caixa') {
        var resp = btn.getAttribute('data-resp') || '';
        state.cf.resp = resp ? resp : '__NONE__';
        state.search = ''; if ($('q')) $('q').value = '';
        state.statusFilter = 'TODOS'; state.pagePrincipal = 1;
        syncCaixaFilterInputs();
        renderAll();
        return;
      }
      if ((act === 'aprovar-siate' || act === 'aprovar-list') && !state.isAdmin) { alert('Somente admin pode aprovar/reprovar.'); return; }
      if (act === 'aprovar-siate') { approveDivergente(os, 'SIATE'); return; }
      if (act === 'aprovar-list') { approveDivergente(os, 'LIST'); return; }
      if ((act === 'aprovar' || act === 'reprovar') && !state.isAdmin) { alert('Somente admin pode aprovar/reprovar.'); return; }
      if (act === 'aprovar') {
        var org = btn.getAttribute('data-org');
        var ix = db.quarentena.findIndex(function (x) { return x.numos === os && x.origem === org; });
        if (ix !== -1) {
          var item = db.quarentena.splice(ix, 1)[0];
          var already = !!db.principal.find(function (x) { return x.numos === os; });
          if (!already) {
            db.principal.push({
              numos: os, codserv: qget(item, 'c'), datasol: '', dataISO: qget(item, 'd'),
              codreg: qget(item, 'r'), regional: REGIONAL_NOME[qget(item, 'r')] || '',
              cidade: qget(item, 'cid') || qget(item, 'loc'),
              cliente: qget(item, 'cli'), tel1: qget(item, 't'),
              tel2: '', obs: '', dscsvc: qget(item, 'desc'),
              statusDemanda: 'A INICIAR', responsavel: null, origem: 'QUARENTENA_APROVADA',
              createdAt: new Date().toISOString(),
            });
          }
          if (!saveDB(db)) { alert('NÃO SALVOU: banco local cheio (quota ~5MB).'); return; }
          renderAll(already ? 'OS ' + os + ' retirada da quarentena (já estava na caixa).' : 'OS ' + os + ' aprovada → caixa principal.');
        }
      }
      if (act === 'reprovar') {
        var org2 = btn.getAttribute('data-org');
        var ix2 = db.quarentena.findIndex(function (x) { return x.numos === os && x.origem === org2; });
        if (ix2 !== -1) {
          var r = db.quarentena.splice(ix2, 1)[0];
          db.reproved.push({ numos: r.numos, origem: r.origem, ts: new Date().toISOString(), por: (state.user && state.user.email) || '' });
          saveDB(db); renderAll('OS ' + os + ' reprovada e arquivada.');
        }
      }
      if (act === 'user-del') {
        if (!state.isAdmin || typeof deleteUser !== 'function') { alert('Somente admin.'); return; }
        var em = btn.getAttribute('data-email') || '';
        if (!confirm('Excluir usuário ' + em + '?')) return;
        var rd = deleteUser(em);
        if (rd.error) { alert(rd.error); return; }
        renderAll('Usuário ' + em + ' excluído.');
      }
      if (act === 'user-role') {
        if (!state.isAdmin || typeof setUserRole !== 'function') { alert('Somente admin.'); return; }
        var em2 = btn.getAttribute('data-email') || '';
        var users = (typeof getUsers === 'function') ? getUsers() : [];
        var tgt = null;
        users.forEach(function (uu) { if (String(uu.email).toLowerCase() === String(em2).toLowerCase()) tgt = uu; });
        if (!tgt) return;
        var nr = tgt.role === 'admin' ? 'usuario' : 'admin';
        var rr = setUserRole(em2, nr);
        if (rr.error) { alert(rr.error); return; }
        renderAll(em2 + ' agora é ' + nr + '.');
      }
    });

    document.addEventListener('change', function (e) {
      var s = e.target.closest ? e.target.closest('select[data-act="status"]') : null;
      if (!s) return;
      var os = s.getAttribute('data-os');
      var db = loadDB();
      var p = db.principal.find(function (x) { return x.numos === os; });
      if (p && STATUS_LIST.indexOf(s.value) !== -1) {
        if (!state.isAdmin && p.responsavel && !isMine(p)) { alert('Essa OS está com outro usuário.'); renderAll(); return; }
        p.statusDemanda = s.value;
        var credit = '';
        if (s.value === 'ENCERRADO') {
          p.encerradoEm = new Date().toISOString();
          p.encerradoPor = p.responsavel || ((state.user && state.user.email) || '');
          credit = p.encerradoPor;
        } else {
          p.encerradoEm = null; p.encerradoPor = null;
        }
        saveDB(db);
        // Zerou as abertas? A distribuição automática recarrega a cota.
        var refill = '';
        if (credit) {
          try {
            var rd = autoDistribute(db, [credit]);
            if (rd.n > 0 && saveDB(db)) refill = ' 🚚 +' + rd.n + ' nova(s) na sua caixa.';
          } catch (e6) {}
        }
        renderAll('OS ' + os + ' → ' + s.value + '.' + refill);
      }
    });

    document.querySelectorAll('.check-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        var inp = pill.querySelector('input');
        inp.checked = !inp.checked;
        pill.classList.toggle('on', inp.checked);
      });
    });

    var fSi = $('file-si'), fLi = $('file-li');
    if (fSi) fSi.addEventListener('change', function () { handleFile(fSi.files[0], 'siate'); });
    if (fLi) fLi.addEventListener('change', function () { handleFile(fLi.files[0], 'list'); });
    var bp = $('btn-process');
    if (bp) bp.addEventListener('click', processAndPreview);
    var bb = $('btn-tobank');
    if (bb) bb.addEventListener('click', pushToDB);
    var bf = $('btn-clearfilters');
    if (bf) bf.addEventListener('click', function () {
      document.querySelectorAll('.check-pill').forEach(function (pill) {
        var inp = pill.querySelector('input');
        inp.checked = true; pill.classList.add('on');
      });
      if ($('f-codserv')) $('f-codserv').value = '';
      if ($('f-cidade')) $('f-cidade').value = '';
      if ($('f-dini')) $('f-dini').value = '';
      if ($('f-dfim')) $('f-dfim').value = '';
      if (state.result) processAndPreview();
    });
    // distribuição automática (admin)
    var pde = $('pill-dist-enabled');
    if (pde) pde.addEventListener('click', function () {
      setTimeout(function () {
        if (!state.isAdmin) return;
        var cfg = loadCfg();
        cfg.distrib = cfg.distrib || { enabled: false, qty: 10, per: {} };
        cfg.distrib.enabled = !!($('dist-enabled') || {}).checked;
        saveCfg(cfg);
        renderDistribuicao();
      }, 0);
    });
    var dqi = $('dist-qty');
    if (dqi) dqi.addEventListener('change', function () {
      if (!state.isAdmin) return;
      var cfg = loadCfg();
      cfg.distrib = cfg.distrib || { enabled: false, qty: 10, per: {} };
      var v = parseInt(dqi.value, 10);
      cfg.distrib.qty = isNaN(v) ? 10 : Math.max(0, v);
      saveCfg(cfg);
      renderDistribuicao();
    });
    var bdn = $('btn-dist-now');
    if (bdn) bdn.addEventListener('click', function () {
      if (!state.isAdmin) { alert('Somente admin.'); return; }
      var db = loadDB();
      var r = autoDistribute(db, null);
      if (r.off) { alert('Ative a distribuição automática primeiro.'); return; }
      if (!r.n) { alert('Ninguém zerado ou sem disponíveis no momento.'); renderDistribuicao(); return; }
      if (!saveDB(db)) { alert('NÃO SALVOU: banco local cheio (quota ~5MB).'); return; }
      var dl = $('dist-log');
      if (dl) dl.textContent = new Date().toLocaleString('pt-BR') + ' — manual: ' + distSummary(r) + '.';
      renderAll('🚚 Distribuídas ' + r.n + ' OS: ' + distSummary(r) + '.');
      renderDistribuicao();
    });
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-dist-qty') !== null) {
        if (!state.isAdmin) return;
        var em = String(t.getAttribute('data-dist-qty') || '').toLowerCase();
        var cfg = loadCfg();
        cfg.distrib = cfg.distrib || { enabled: false, qty: 10, per: {} };
        cfg.distrib.per = cfg.distrib.per || {};
        var v = parseInt(t.value, 10);
        if (t.value === '' || isNaN(v)) delete cfg.distrib.per[em];
        else cfg.distrib.per[em] = Math.max(0, v);
        saveCfg(cfg);
        renderDistribuicao();
      }
    });
    var bc = $('btn-clear');
    if (bc) bc.addEventListener('click', function () {
      if (!confirm('Limpar banco local (caixa + quarentena)?')) return;
      localStorage.removeItem(DB_KEY); state.result = null; state.siateClean = []; state.listClean = [];
      $('log').textContent = 'Banco local limpo.';
      renderAll('Banco limpo.');
    });
  }

  function handleFile(file, kind) {
    if (!file) return;
    if (kind === 'siate') state.siateFile = { name: file.name, size: file.size };
    else state.listFile = { name: file.name, size: file.size };
    var el = kind === 'siate' ? $('st-file-si') : $('st-file-li');
    el.textContent = 'Lendo ' + file.name + ' (' + (file.size / 1048576).toFixed(1) + ' MB)...';
    el.className = 'upload-status';
    parseFile(file).then(function (parsed) {
      if (kind === 'siate') {
        state.siateRaw = parsed.rows;
        var r = sanitizeSiate(parsed.rows, parsed.headers);
        state.siateClean = r.clean;
        el.textContent = 'SIATE OK: ' + r.clean.length + ' OS válidas de ' + parsed.rows.length + ' linhas.';
        el.className = 'upload-status ok';
        appendLog(r.log.join('\n'));
        buildCodservOptions();
      } else {
        state.listRaw = parsed.rows;
        var rl = sanitizeList(parsed.rows, parsed.headers);
        state.listClean = rl.clean;
        el.textContent = 'LIST OK: ' + rl.clean.length + ' OS válidas de ' + parsed.rows.length + ' linhas.';
        el.className = 'upload-status ok';
        appendLog(rl.log.join('\n'));
      }
      var bp = $('btn-process');
      if (bp) bp.disabled = !(state.siateClean.length && state.listClean.length);
      renderStats();
    }).catch(function (err) {
      console.error(err);
      el.textContent = 'Erro ao ler arquivo: ' + (err && err.message);
    });
  }

  function buildCodservOptions() {
    var set = {};
    state.siateClean.forEach(function (s) { if (s.codserv) set[s.codserv] = 1; });
    state.codservOptions = Object.keys(set).sort(function (a, b) { return Number(a) - Number(b); });
    var sel = $('f-codserv');
    if (!sel) return;
    sel.innerHTML = '<option value="">Todos</option>' + state.codservOptions.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
  }

  function appendLog(t) {
    var l = $('log');
    if (l) l.textContent += (l.textContent ? '\n' : '') + t;
  }

  function processAndPreview() {
    if (!state.siateClean.length || !state.listClean.length) { alert('Suba as duas bases primeiro.'); return; }
    var u = filteredUniverse();
    var cmp = compare(u.siate, u.list);
    var spp = splitConflicts(cmp.cong, u.list);
    cmp.cong = spp.pure;
    cmp.confl = spp.confl;
    state.result = cmp;
    var f = u.f;
    var lines = [];
    lines.push('FILTROS RECORTARAM AS DUAS BASES (resto descartado):');
    lines.push('- SIATE: ' + u.siate.length + ' de ' + state.siateClean.length + ' | LIST: ' + u.list.length + ' de ' + state.listClean.length);
    lines.push('COMPARAÇÃO POR NUMOS (exato) no universo filtrado:');
    lines.push('- Congruentes: ' + cmp.cong.length + ' → caixa principal');
    lines.push('- Conflitos de dados: ' + (cmp.confl || []).length + ' → quarentena DIVERGENTE (revisar lado a lado)');
    lines.push('- Só SIATE: ' + cmp.soSiate.length + ' → quarentena');
    lines.push('- Só LIST: ' + cmp.soList.length + ' → quarentena');
    try {
      var db0 = loadDB(), have0 = {};
      db0.principal.forEach(function (p) { have0[p.numos] = 1; });
      var dup0 = cmp.cong.filter(function (s) { return have0[s.numos]; }).length;
      var dupOpt = !$('f-dup-quar') || $('f-dup-quar').checked;
      lines.push('- Repetidas (já na caixa): ' + dup0 + (dup0 ? (dupOpt ? ' → quarentena como JÁ NA CAIXA' : ' → só ignoradas (opção desmarcada)') : ''));
    } catch (e) {}
    // Vítimas do filtro: congruentes nas bases CHEIAS que o filtro tirou do
    // universo comparado (iriam p/ quarentena injustamente como SÓ SIATE/SÓ LIST).
    var victims = [];
    try {
      var congF = {};
      cmp.cong.forEach(function (s) { congF[s.numos] = 1; });
      (cmp.confl || []).forEach(function (c) { congF[c.s.numos] = 1; });
      var fS = {}, fL = {};
      u.siate.forEach(function (s) { fS[s.numos] = 1; });
      u.list.forEach(function (l) { fL[l.numos] = 1; });
      var full = compare(state.siateClean, state.listClean);
      var fullSp = splitConflicts(full.cong, state.listClean);
      var fullNums = {};
      full.cong.forEach(function (s) { fullNums[s.numos] = 1; });
      fullSp.confl.forEach(function (c) { fullNums[c.s.numos] = 1; });
      victims = full.cong.filter(function (s) { return !congF[s.numos]; });
      fullSp.confl.forEach(function (c) { if (!congF[c.s.numos]) victims.push(c.s); });
      state.result.victims = victims;
      state.result.fullCong = full.cong.length + fullSp.confl.length;
      state.result.fullConfl = fullSp.confl.length;
      state.result.fullSoSiate = full.soSiate.length;
      state.result.fullSoList = full.soList.length;
    } catch (e2) { victims = []; }
    if (victims.length) {
      lines.push('⚠ VÍTIMAS DO FILTRO (' + victims.length + ' de ' + state.result.fullCong + ' congruentes): estão nas DUAS bases cheias mas o filtro cortou ao menos um lado → iriam p/ quarentena injustamente:');
      victims.slice(0, 20).forEach(function (s) {
        lines.push('  • OS ' + s.numos + ' (' + (fS[s.numos] ? 'SIATE ok' : 'SIATE cortada') + ' | ' + (fL[s.numos] ? 'LIST ok' : 'LIST cortada') + ')');
      });
      if (victims.length > 20) lines.push('  … e mais ' + (victims.length - 20) + ' (alargue o filtro para ver todas).');
    } else {
      lines.push('✓ Filtro limpo: nenhuma congruente das bases cheias ficou de fora.');
    }
    // Quarentena zerada suspeita: mesmo arquivo nos 2 campos ou universos idênticos.
    var warnSame = '';
    try {
      var sf = state.siateFile || {}, lf = state.listFile || {};
      if (sf.name && sf.name === lf.name && sf.size === lf.size) {
        warnSame = 'os uploads da SIATE e da LIST têm o MESMO nome/tamanho (' + sf.name + ') — pode ser o mesmo arquivo nos dois campos';
      } else if (state.result && state.result.fullCong > 0 && state.result.fullSoSiate === 0 && state.result.fullSoList === 0 && !state.result.fullConfl) {
        warnSame = 'as duas bases têm EXATAMENTE as mesmas OS — confira se não subiu o mesmo arquivo (ou a mesma base filtrada) nos dois campos';
      }
      if (warnSame) lines.push('⚠ QUARENTENA ZERADA SUSPEITA: ' + warnSame + '.');
    } catch (e3) {}
    lines.push('Filtros: regional=' + (f.regs.join(',') || 'todas') + ' | codserv=' + (f.codserv || 'todos') + ' | cidade=' + (f.cidade || 'todas') + ' | período=' + (f.dIni || '…') + '→' + (f.dFim || '…'));
    $('log').textContent = lines.join('\n');
    $('alert').style.display = '';
    if (victims.length || warnSame) {
      $('alert').innerHTML = (warnSame ? '⚠ <b>Quarentena zerada suspeita:</b> ' + esc(warnSame) + '.<br>' : '') +
        (victims.length ? '⚠ <b>' + victims.length + '</b> OS estão nas <b>duas bases cheias</b> mas o filtro as jogaria na quarentena (veja “VÍTIMAS DO FILTRO” no log). Alargue o filtro ou prossiga ciente.<br>' : '') +
        '✔ <b>' + cmp.cong.length + '</b> congruentes p/ caixa &nbsp;•&nbsp; ⚠ <b>' + (cmp.soSiate.length + cmp.soList.length) + '</b> divergentes p/ quarentena. Confira e clique em <b>“Jogar no banco”</b>.';
      $('alert').className = 'alert-box';
    } else {
      $('alert').innerHTML = '✔ <b>' + cmp.cong.length + '</b> congruentes p/ caixa principal &nbsp;•&nbsp; ⚠ <b>' + (cmp.soSiate.length + cmp.soList.length) + '</b> divergentes p/ quarentena (tudo do universo filtrado). Filtro limpo, sem vítimas. <br>Confira e clique em <b>“Jogar no banco”</b>.';
      $('alert').className = 'alert-box green';
    }
    showResultModal(cmp, victims, warnSame);
    renderStats();
  }

  // ---------- modal de resultado (abre em TODA comparação) ----------
  function showResultModal(cmp, victims, warnSame) {
    var ov = $('modal-div'), body = $('modal-div-body');
    if (!ov || !body) return;
    var title = $('modal-div-title');
    var confl = cmp.confl || [];
    var div = cmp.soSiate.length + cmp.soList.length;
    if (title) title.textContent = confl.length ? '⚔️ Incongruências entre as bases' : '✔ Comparação pronta';
    var h = '✔ <b>' + cmp.cong.length + '</b> congruentes → caixa &nbsp;•&nbsp; ⚠ <b>' + div + '</b> divergentes → quarentena';
    if (confl.length) h += ' &nbsp;•&nbsp; ⚔️ <b>' + confl.length + '</b> conflitos';
    h += '<br><br>';
    if (confl.length) {
      h += 'OS nas <b>duas bases</b> mas com <b>serviço diferente</b> — revise antes de ir para a caixa:<br>';
      confl.slice(0, 8).forEach(function (c) {
        h += '<div class="modal-row"><span class="os-id">' + esc(c.s.numos) + '</span> &nbsp;SIATE <b>' + esc(c.s.codserv || '—') + '</b> × LIST <b>' + esc(c.l.codserv || '—') + '</b></div>';
      });
      if (confl.length > 8) h += '<div class="modal-row">… e mais ' + (confl.length - 8) + '</div>';
      h += '<br>Vão para a aba <b>Conflitos</b> da quarentena (libera SIATE ou LIST, ou reprova). As que só existem em uma base vão para <b>Só SIATE / Só LIST</b>.<br>';
    } else {
      h += 'Nenhum conflito de serviço neste universo filtrado. (Com filtro de serviço ativo, conflitos nem são possíveis — os dois lados já vêm com o mesmo serviço.)<br>';
    }
    if (victims && victims.length) h += '<br>⚠ <b>' + victims.length + '</b> OS estão nas duas bases cheias mas o filtro as tiraria — veja “VÍTIMAS DO FILTRO” no log.<br>';
    if (warnSame) h += '<br>⚠ <b>Quarentena zerada suspeita:</b> ' + esc(warnSame) + '.<br>';
    h += '<br>Confira e clique em <b>“Jogar no banco”</b>.';
    body.innerHTML = h;
    var mbc = $('modal-btn-confl');
    if (mbc) mbc.style.display = confl.length ? '' : 'none';
    ov.style.display = 'flex';
  }
  function hideConflModal() {
    var ov = $('modal-div');
    if (ov) ov.style.display = 'none';
  }
  function gotoQuarTab(tab) {
    hideConflModal();
    var sel = $('f3-origem');
    if (sel) sel.value = tab;
    state.qf = { origem: tab, codserv: (state.qf || {}).codserv || '' };
    state.pageQuar = 1;
    renderAll();
    showView('quarentena');
  }

  // ---------- init ----------
  async function init() {
    var sess = await requireAuth();
    if (!sess) return;
    state.user = sess;
    state.isAdmin = isAdminEmail(sess.email);
    var role = sess.role || (state.isAdmin ? 'admin' : 'usuario');
    $('me').textContent = sess.email;
    if ($('role')) $('role').textContent = role;
    if ($('avatar')) $('avatar').textContent = String(sess.email || '?').charAt(0).toUpperCase();
    if (!state.isAdmin) {
      // Quarentena, acompanhar e importar: só admin
      document.querySelectorAll('.admin-only').forEach(function (el) { el.style.display = 'none'; });
      var up = $('panel-upload');
      if (up) up.style.display = 'none';
      var nq = $('not-admin');
      if (nq) nq.style.display = '';
    }
    window.SADshow = function (v) { showView(v); };
    bindEvents();
    syncCaixaFilterInputs();
    var welcome = '';
    if (!state.isAdmin && state.user && state.user.email) {
      try {
        var db0 = loadDB();
        var rd0 = autoDistribute(db0, [state.user.email]);
        if (rd0.n > 0 && saveDB(db0)) welcome = ' 🚚 Você recebeu ' + rd0.n + ' OS na sua caixa.';
      } catch (e8) {}
    }
    renderAll(welcome || undefined);
    $('log').textContent = 'Pronto. ' + (state.isAdmin ? 'Suba as duas bases para comparar.' : 'Aguardando importação do admin.');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
