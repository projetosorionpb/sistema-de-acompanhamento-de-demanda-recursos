/* Sistema de Acompanhamento de Demanda — núcleo local (MVP)
   SIATE = LISTA OS (.xls) | LIST = Gerenciador de Obras (.csv)
   Chave: NUMOS exato | Sanitiza SIATE | Filtros antes de gravar no banco */
(function () {
  'use strict';

  var PAGE_SIZE = 50;
  var REGIONAL_NOME = { 1: 'LESTE', 2: 'CENTRO', 3: 'OESTE' };
  var STATUS_LIST = ['A INICIAR', 'EM ANDAMENTO', 'OCORRENCIA', 'ENCERRADO', 'DESPACHADO'];
  // Status terminais: não contam como OS aberta e têm telas próprias.
  function isFinalStatus(st) { return st === 'ENCERRADO' || st === 'DESPACHADO'; }

  var state = {
    siateRaw: [], siateClean: [], listRaw: [], listClean: [],
    result: null, // {cong, soSiate, soList, log}
    view: 'caixa', search: '', statusFilter: 'TODOS',
    cf: { reg: '', codserv: '', cidade: '', dini: '', dfim: '', resp: '' }, // filtros da caixa
    metrics: { preset: 'hoje', dini: '', dfim: '', user: [], status: [], reg: [], serv: [] }, // métricas do admin
    resumo: { preset: 'hoje', dini: '', dfim: '' }, // período do resumo do usuário
    encSearch: '', // busca da tela Encerrados
    ocoSearch: '', // busca da tela Ocorrências
    despSearch: '', // busca geral da tela Despachados
    desp: { numos: '', codserv: '', cliente: '', cidade: '', reg: '', origem: '', resp: '', despPor: '', dini: '', dfim: '', despIni: '', despFim: '', sort: 'desp-desc' }, // filtros por campo da tela Despachados
    scope: 'mine', // usuário: 'mine' (minha caixa) | 'pool' (disponíveis); admin vê tudo
    sort: { key: 'data-desc' }, // data-desc | data-asc | os-desc | os-asc (clicável no th + select)
    qf: { origem: '', codserv: '' }, // filtros da quarentena
    pagePrincipal: 1, pageQuar: 1, pageEnc: 1, pageOco: 1, pageDesp: 1,
    list: { itens: [], meta: null, carregando: false, token: null, page: 1, filtro: { q: '', os: '', reg: '', status: '', dini: '', dfim: '', semData: false, sort: 'pv-asc' } },
    isAdmin: false, user: null,
    codservOptions: [],
  };

  var VIEW_TITLES = {
    caixa: ['Caixa principal', 'Demandas em aberto (a iniciar, em andamento) para a equipe trabalhar.'],
    encerrados: ['Encerrados', 'OS concluídas — saíram da caixa e ficam aqui para consulta.'],
    despachados: ['Despachados', 'OS despachadas — saíram da caixa e ficam aqui para consulta.'],
    ocorrencias: ['Ocorrências', 'OS paradas por ocorrência — voltam à caixa do usuário quando resolvidas.'],
    quarentena: ['Quarentena', 'Divergências: tem em uma base e não tem na outra. O admin aprova ou reprova.'],
    importar: ['Importar bases', 'Suba as duas bases (admin), ajuste os filtros e jogue no banco.'],
    list: ['LIST · SharePoint', 'Itens da lista Gerenciador de Obras com a data da 1ª versão — conexão via Supabase, sem CSV.'],
    distribuir: ['Distribuição', 'Cota automática de OS por usuário: quem zera recebe sozinho.'],
    resumo: ['Resumo', 'Totais da última comparação e do banco local.'],
    acompanhar: ['Acompanhar usuários', 'Quais OS estão com quais pessoas e em qual status.'],
    metricas: ['Métricas', 'Gráficos e tabelas com filtros múltiplos por período, usuário, status da OS, regional e serviço.'],
  };
  var ADMIN_VIEWS = ['quarentena', 'importar', 'list', 'acompanhar', 'metricas', 'distribuir'];

  function showView(v) {
    if (ADMIN_VIEWS.indexOf(v) !== -1 && !state.isAdmin) v = 'caixa';
    state.view = v;
    var map = { caixa: 'view-principal', encerrados: 'view-encerrados', despachados: 'view-despachados', ocorrencias: 'view-ocorrencias', quarentena: 'view-quarentena', importar: 'view-importar', list: 'view-list', resumo: 'view-resumo', acompanhar: 'view-acompanhar', metricas: 'view-metricas', distribuir: 'view-distribuir' };
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
    if (v === 'list') renderList();
    if (v === 'distribuir') renderDistribuicao();
    if (v === 'encerrados') renderEncerrados();
    if (v === 'despachados') renderDespachados();
    if (v === 'ocorrencias') renderOcorrencias();
    if (v === 'resumo') { renderStats(); if (!state.isAdmin && $('page-desc')) $('page-desc').textContent = 'Seu desempenho: OS na sua caixa por status e encerradas.'; }
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
  // Dono efetivo da OS: em OS finalizada vale quem encerrou/despachou (o crédito
  // da ação). Sem isso, uma OS encerrada sem responsável aparecia como "—".
  function ownerOf(p) {
    if (p.statusDemanda === 'ENCERRADO') return p.encerradoPor || p.responsavel || '';
    if (p.statusDemanda === 'DESPACHADO') return p.despachadoPor || p.responsavel || '';
    return p.responsavel || '';
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

  // ---------- DB (somente nuvem: tudo no Supabase via js/db.js) ----------
  function loadDB() {
    if (window.SADDB) {
      try { return SADDB.load(); } catch (e) {}
    }
    return { principal: [], quarentena: [], imports: [], reproved: [] };
  }
  function saveDB(db) {
    if (window.SADDB) {
      try { return SADDB.save(db); } catch (e) {}
    }
    return false;
  }
  // Quando o banco é compartilhado, re-busca o servidor após ações que afetam
  // outros usuários (pegar/liberar/trocar status) para ver a caixa atualizada.
  function refreshIfShared(msg) {
    try {
      if (window.SADDB && SADDB.enabled()) {
        SADDB.refresh().then(function (ok) {
          renderAll(ok ? msg : 'Alteração não confirmada no Supabase; exibindo o estado atual do servidor.');
        });
      }
    } catch (e) {}
  }

  // ---------- quarentena compacta (objeto leve p/ a coluna jsonb `dados`) ----------
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
    var clean = [], seen = {}, dups = 0, empty = 0, bad = 0;
    rows.forEach(function (r, i) {
      if (!r || typeof r !== 'object') { bad++; return; }
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
    log.push('SIATE: ' + rows.length + ' linhas lidas → ' + clean.length + ' válidas (' + empty + ' sem NUMOS, ' + dups + ' duplicadas removidas' + (bad ? ', ' + bad + ' linhas inválidas' : '') + ').');
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
    var cPv = findCol(headers, ['primeiraversao', 'dataprimeiraversao', 'datada1aversao', 'datadaprimeiraversao']);
    var cStatus = findCol(headers, ['status']);
    var cTel = findCol(headers, ['telefonecliente', 'telefone']);
    var clean = [], seen = {}, dups = 0, empty = 0, bad = 0;
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object') { bad++; return; }
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
        dataISO: cSol ? brToISO(r[cSol]) : '',
        primeiraVersao: cPv ? (brToISO(r[cPv]) || String(r[cPv] || '')) : '',
        statusOrigem: normText(cStatus ? r[cStatus] : '', false).slice(0, 60),
        telefone: normPhone(cTel ? r[cTel] : ''),
      });
    });
    return { clean: clean, log: ['LIST: ' + rows.length + ' linhas lidas → ' + clean.length + ' válidas (' + empty + ' sem OS, ' + dups + ' duplicadas removidas' + (bad ? ', ' + bad + ' linhas inválidas' : '') + ').'] };
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
      if (f.dIni || f.dFim) {
        // Com filtro de data ativo, registros sem uma data válida não passam.
        if (!iso) return false;
        if (f.dIni && iso < f.dIni) return false;
        if (f.dFim && iso > f.dFim) return false;
      }
      return true;
    });
  }
  function filteredUniverse() {
    var f = currentFilters();
    // Primeiro filtra cada base. O conjunto de NUMOS elegíveis é a união das
    // duas bases: se uma OS passar o filtro em um lado, incluímos o par do
    // outro lado (mesmo que o CODSERV/data difira) para detectar conflitos.
    // Se não passar em nenhuma base, fica fora de comparação/quarentena/banco.
    var eligibleSiate = applyFilters(state.siateClean, f);
    var eligibleList = applyFilters(state.listClean, f);
    var selected = {}, eligibleS = {}, eligibleL = {};
    eligibleSiate.forEach(function (r) { selected[r.numos] = 1; eligibleS[r.numos] = 1; });
    eligibleList.forEach(function (r) { selected[r.numos] = 1; eligibleL[r.numos] = 1; });
    var siate = state.siateClean.filter(function (r) { return !!selected[r.numos]; });
    var list = state.listClean.filter(function (r) { return !!selected[r.numos]; });
    return {
      f: f,
      siate: siate,
      list: list,
      eligibleSiate: eligibleSiate,
      eligibleList: eligibleList,
      pairedSiate: siate.filter(function (r) { return !eligibleS[r.numos]; }).length,
      pairedList: list.filter(function (r) { return !eligibleL[r.numos]; }).length,
      excludedSiate: state.siateClean.filter(function (r) { return !selected[r.numos]; }).length,
      excludedList: state.listClean.filter(function (r) { return !selected[r.numos]; }).length,
    };
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
    cmp.filteredSiate = u.siate.length;
    cmp.filteredList = u.list.length;
    state.result = cmp;
    var f = u.f;
    var db = loadDB();
    var haveP = {}, haveQ = {}, reprovedSet = {};
    db.principal.forEach(function (p) { haveP[p.numos] = p; });
    db.quarentena.forEach(function (q) { haveQ[q.numos + '|' + q.origem] = 1; });
    (db.reproved || []).forEach(function (r) {
      if (r.numos && r.origem) reprovedSet[r.numos + '|' + r.origem] = 1;
    });

    var dupToQ = !$('f-dup-quar') || $('f-dup-quar').checked; // repetida → quarentena p/ revisar
    var newP = 0, keptP = 0, closedP = 0, dupQ = 0;
    var dupKeys = {}; // NUMOS que já estavam na caixa (em aberto) — candidatos a revisão
    cmp.cong.forEach(function (s) {
      if (haveP[s.numos]) {
        // Já existe no banco: preserva status/responsável. NÃO avança/duplica.
        keptP++;
        if (haveP[s.numos].statusDemanda === 'ENCERRADO') {
          closedP++; // já encerrada: fica como está, sem passar pela quarentena
        } else {
          dupKeys[s.numos] = s; // em aberto na caixa: pode ir p/ revisão (JÁ NA CAIXA)
        }
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
    // Conflitos: mesmo NUMOS, codserv diferente → quarentena DIVERGENTE (revisar lado a lado).
    // Mesmo quando a OS JÁ está na caixa, o conflito vai para a aba Conflitos: antes
    // ele era só ignorado, então o modal/contador anunciavam a divergência mas a
    // aba ficava vazia (e não havia como revisar o serviço daquela OS na caixa).
    // Se o admin já escolheu um lado (origem CONFLITO_SIATE/LIST) e o valor da
    // caixa continua igual a um dos lados, o conflito não é reaberto a cada importação.
    var newDiv = 0, skipDivRep = 0;
    (cmp.confl || []).forEach(function (pair) {
      var numos = pair.s.numos;
      var key = numos + '|DIVERGENTE';
      // O par agora existe nas DUAS bases: limpa um eventual SÓ SIATE/SÓ LIST
      // antigo do mesmo NUMOS (senão a mesma OS apareceria em duas abas).
      for (var qi = db.quarentena.length - 1; qi >= 0; qi--) {
        var qx = db.quarentena[qi];
        if (qx.numos === numos && (qx.origem === 'SO_SIATE' || qx.origem === 'SO_LIST')) {
          db.quarentena.splice(qi, 1);
          delete haveQ[qx.numos + '|' + qx.origem];
        }
      }
      var pBox = haveP[numos];
      if (pBox) {
        keptP++;
        if (pBox.statusDemanda === 'ENCERRADO') closedP++;
        var escolhido = String(pBox.origem || '').indexOf('CONFLITO_') === 0 &&
          (String(pBox.codserv || '') === String(pair.s.codserv || '') ||
            String(pBox.codserv || '') === String(pair.l.codserv || ''));
        if (escolhido) return; // lado já escolhido numa revisão anterior: não reabre
      }
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
    db.imports.push({ ts: new Date().toISOString(), filtros: f, siateFiltrada: u.siate.length, listFiltrada: u.list.length, congTotal: cmp.cong.length, novasPrincipal: newP, novasQuarentena: newQ, promovidas: promoted, ignoradasReprovadas: skipReproved + skipDivRep, preservadasCaixa: keptP, encerradasPreservadas: closedP, duplicadasQuarentena: dupQ, dupParaQuarentena: dupToQ, conflitos: (cmp.confl || []).length, novasDivergentes: newDiv });
    if (!saveDB(db)) {
      var kb = 0;
      try { kb = Math.round(JSON.stringify(db).length / 1024); } catch (e) {}
      renderAll();
      alert('NÃO SALVOU: banco indisponível (Supabase). Nada foi gravado.\n\nVerifique a conexão e a config (js/config.js); recarregue a página.');
      return;
    }
    // Distribuição automática pós-importação (quem zerou, recebe a cota)
    var distMsg = '';
    try {
      var dd = autoDistribute(db, null);
      if (dd.n > 0 && saveDB(db)) {
        distMsg = ' • distribuição automática: ' + distSummary(dd);
        var dl = $('dist-log');
        if (dl) dl.textContent = new Date().toLocaleString('pt-BR') + ' — pós-importação: ' + distSummary(dd) + '.';
      }
    } catch (e5) {}
    renderAll('Banco atualizado (incremental, nada apagado): +' + newP + ' novos na caixa, +' + newQ + ' na quarentena, +' + newDiv + ' conflito(s) p/ revisar · ' + closedP + ' já encerradas mantidas, ' + (keptP - closedP) + ' abertas preservadas' + (dupToQ ? ', ' + dupQ + ' repetida(s) → quarentena (JÁ NA CAIXA)' : '') + ', ' + promoted + ' promovidas da quarentena' + ((skipReproved + skipDivRep) ? ', ' + (skipReproved + skipDivRep) + ' reprovadas ignoradas' : '') + distMsg + '.');
  }

  // ---------- desfazer a última importação ----------
  // Apaga somente o que a última importação criou e que ainda está intocado:
  // OS na caixa com status A INICIAR e itens de quarentena criados depois da
  // importação anterior. Não mexe em OS já trabalhadas, reprovadas, importações
  // anteriores nem no SharePoint.
  async function undoLastImport() {
    if (typeof isSupabaseMode !== 'function' || !isSupabaseMode()) {
      alert('Supabase não configurado.');
      return;
    }
    var client = supa();
    try {
      var res = await client.from('importacoes')
        .select('id,created_at,novas_principal,novas_quarentena,promovidas')
        .order('id', { ascending: false })
        .limit(2);
      if (res.error) throw res.error;
      var rows = res.data || [];
      if (!rows.length) {
        alert('Não há importações registradas para desfazer.');
        return;
      }
      var alvo = rows[0];
      var corte = rows[1] ? rows[1].created_at : '1970-01-01T00:00:00Z';
      var primeira = !rows[1];

      var cDem = await client.from('demandas')
        .select('numos', { count: 'exact', head: true })
        .gt('created_at', corte)
        .eq('status_demanda', 'A INICIAR');
      if (cDem.error) throw cDem.error;
      var cQuar = await client.from('quarentena')
        .select('id', { count: 'exact', head: true })
        .gt('created_at', corte);
      if (cQuar.error) throw cQuar.error;

      var nDem = cDem.count || 0;
      var nQuar = cQuar.count || 0;
      if (!nDem && !nQuar) {
        alert('Nada para desfazer: não há OS A INICIAR nem itens de quarentena criados depois da importação anterior.');
        return;
      }

      var amostra = await client.from('demandas')
        .select('numos')
        .gt('created_at', corte)
        .eq('status_demanda', 'A INICIAR')
        .limit(10);
      var lista = (amostra.data || []).map(function (x) { return x.numos; }).join(', ');

      var msg = 'Desfazer a última importação' +
        (alvo.created_at ? ' (' + dataHoraBr(alvo.created_at) + ')' : '') + '?\n\n' +
        'Vai APAGAR do sistema:\n' +
        '• ' + nDem + ' OS na caixa que ainda estão A INICIAR' +
        (lista ? ' (ex.: ' + lista + (nDem > 10 ? '…' : '') + ')' : '') + ';\n' +
        '• ' + nQuar + ' item(ns) da quarentena criados nessa importação.\n\n' +
        'NÃO apaga: OS já trabalhadas (EM ANDAMENTO, ENCERRADO, DESPACHADO, OCORRÊNCIA), ' +
        'OS de importações anteriores, reprovadas nem a lista do SharePoint.\n' +
        (primeira ? '\nATENÇÃO: é a primeira importação — isso remove TODA a quarentena e todas as OS ainda A INICIAR.\n' : '') +
        '\nOS que estavam na quarentena e foram promovidas para a caixa não voltam sozinhas para a quarentena; ' +
        'a próxima importação com os filtros corretos as recoloca no lugar certo.\n' +
        '\nDepois, suba as duas bases com os filtros corretos e use “Jogar no banco”.\n\nContinuar?';
      if (!confirm(msg)) return;
      if (!(await pedirSenha('Desfazer importação', 'Confirme sua senha para apagar o que a última importação criou (somente OS ainda A INICIAR e quarentena daquela importação).'))) return;

      var d1 = await client.from('demandas').delete().gt('created_at', corte).eq('status_demanda', 'A INICIAR');
      if (d1.error) throw d1.error;
      var d2 = await client.from('quarentena').delete().gt('created_at', corte);
      if (d2.error) throw d2.error;
      var d3 = await client.from('importacoes').delete().gt('created_at', corte);
      if (d3.error) throw d3.error;

      var msgOk = 'Importação desfeita: -' + nDem + ' OS A INICIAR e -' + nQuar + ' item(ns) da quarentena.';
      var recarregou = false;
      try { if (window.SADDB && SADDB.refresh) recarregou = await SADDB.refresh(); } catch (eR) {}
      if (recarregou) renderAll(msgOk);
      else alert(msgOk + '\n\nRecarregue a página (F5) para atualizar a tela.');
    } catch (e) {
      alert('Não consegui desfazer a importação: ' + ((e && e.message) || e));
    }
  }

  // ---------- limpar banco (tudo ou filtrado por serviço) ----------
  var _clearCtx = null;

  function qCodservs(x) {
    var out = [];
    ['c', 'cs', 'cl'].forEach(function (k) {
      var v = qget(x, k);
      if (v) out.push(String(v));
    });
    return out;
  }

  function openClearModal() {
    var db = loadDB();
    var cont = {};
    db.principal.forEach(function (p) {
      var c = String(p.codserv || '');
      if (c) cont[c] = (cont[c] || 0) + 1;
    });
    db.quarentena.forEach(function (x) {
      qCodservs(x).forEach(function (c) { cont[c] = (cont[c] || 0) + 1; });
    });
    var cods = Object.keys(cont).sort(function (a, b) {
      var na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return a.localeCompare(b);
    });

    _clearCtx = { mode: 'filter', cods: cods, cont: cont, sel: {}, del: null };
    cods.forEach(function (c) { _clearCtx.sel[c] = true; });

    var err = $('clr-err');
    if (err) { err.style.display = 'none'; err.textContent = ''; }
    var pw = $('clr-senha'); if (pw) pw.value = '';
    var se = $('clr-search'); if (se) se.value = '';
    renderClearCodList();
    setClearMode('filter');
    var ov = $('modal-clear');
    if (ov) ov.style.display = 'flex';
  }

  function closeClearModal() {
    var ov = $('modal-clear');
    if (ov) ov.style.display = 'none';
    _clearCtx = null;
  }

  function setClearMode(mode) {
    if (!_clearCtx) return;
    _clearCtx.mode = mode;
    var filter = mode === 'filter';
    var bf = $('clr-mode-filter');
    var ba = $('clr-mode-all');
    if (bf) bf.className = 'btn-' + (filter ? 'primary' : 'ghost');
    if (ba) ba.className = 'btn-' + (filter ? 'ghost' : 'primary');
    var ff = $('clr-filter');
    var aa = $('clr-all');
    if (ff) ff.style.display = filter ? '' : 'none';
    if (aa) aa.style.display = filter ? 'none' : '';
    var ok = $('clr-ok');
    if (ok) {
      ok.textContent = filter ? 'Apagar filtrados' : 'Apagar tudo';
      ok.disabled = false;
    }
    var lbl = $('clr-senha-label');
    if (lbl) {
      lbl.textContent = filter
        ? 'Digite sua senha para confirmar a exclusão dos filtrados'
        : 'Digite sua senha para confirmar a exclusão total';
    }
    renderClearPreview();
  }

  function renderClearCodList() {
    var el = $('clr-cods');
    if (!el || !_clearCtx) return;
    var busca = String(((($('clr-search') || {}).value) || '')).trim().toUpperCase();
    var cods = _clearCtx.cods.filter(function (c) {
      return !busca || String(c).toUpperCase().indexOf(busca) !== -1;
    });
    if (!cods.length) {
      el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">Nenhum serviço encontrado.</div>';
      return;
    }
    el.innerHTML = cods.map(function (c) {
      var n = _clearCtx.cont[c] || 0;
      var on = !!_clearCtx.sel[c];
      return '<label><input type="checkbox" data-cod="' + esc(c) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="cod">' + esc(c) + '</span>' +
        '<span class="qtd">(' + n + ' OS)</span></label>';
    }).join('');
  }

  function renderClearPreview() {
    var box = $('clr-preview');
    var ok = $('clr-ok');
    if (!_clearCtx) return;
    if (_clearCtx.mode !== 'filter') {
      if (box) { box.style.display = 'none'; box.innerHTML = ''; }
      _clearCtx.del = null;
      if (ok) ok.disabled = false;
      return;
    }
    var db = loadDB();
    var set = _clearCtx.sel;
    var removed = {};
    var delP = db.principal.filter(function (p) {
      if (set[String(p.codserv || '')]) { removed[p.numos] = 1; return true; }
      return false;
    });
    var delQ = db.quarentena.filter(function (x) {
      var codes = qCodservs(x).filter(Boolean);
      if (codes.length && codes.every(function (c) { return !!set[c]; })) {
        removed[x.numos] = 1;
        return true;
      }
      return false;
    });
    var delR = (db.reproved || []).filter(function (r) { return !!removed[r.numos]; });
    var total = delP.length + delQ.length + delR.length;
    _clearCtx.del = { p: delP, q: delQ, r: delR, total: total };
    if (box) {
      box.style.display = 'block';
      box.innerHTML = total
        ? 'Serão apagadas: <b>' + delP.length + '</b> OS da caixa, <b>' + delQ.length +
          '</b> item(ns) da quarentena e <b>' + delR.length + '</b> reprovada(s). ' +
          'O histórico de importações é mantido.'
        : 'Nenhum item corresponde aos serviços marcados.';
    }
    if (ok) ok.disabled = !total;
  }

  async function verificarSenhaErro(senha) {
    if (typeof isSupabaseMode !== 'function' || !isSupabaseMode() || !state.user) {
      return 'Sessão/Supabase indisponível.';
    }
    if (!senha) return 'Digite sua senha.';
    try {
      var r = await supa().auth.signInWithPassword({ email: state.user.email, password: senha });
      if (!r.error) return null;
      var m = String((r.error && r.error.message) || '');
      if (/rate|limit|too many/i.test(m)) return 'Muitas tentativas. Aguarde um pouco e tente de novo.';
      if (/not confirmed/i.test(m)) return 'E-mail não confirmado. Confirme a conta no Supabase.';
      return 'Senha incorreta. Tente novamente.';
    } catch (e) {
      return 'Falha ao confirmar a senha: ' + ((e && e.message) || e);
    }
  }

  var _senhaCtx = null;
  var _senhaVerificando = false;

  function pedirSenha(titulo, texto) {
    return new Promise(function (resolve) {
      var ov = $('modal-senha');
      if (!ov) { resolve(false); return; }
      _senhaCtx = { resolve: resolve };
      var t = $('senha-title'); if (t) t.textContent = titulo || 'Confirmar com senha';
      var d = $('senha-text'); if (d) d.textContent = texto || '';
      var inp = $('senha-input'); if (inp) inp.value = '';
      var err = $('senha-err'); if (err) { err.style.display = 'none'; err.textContent = ''; }
      var ok = $('senha-ok'); if (ok) ok.disabled = false;
      ov.style.display = 'flex';
      setTimeout(function () { if (inp) inp.focus(); }, 30);
    });
  }

  function fecharSenha(ok) {
    var ov = $('modal-senha'); if (ov) ov.style.display = 'none';
    var ctx = _senhaCtx; _senhaCtx = null;
    if (ctx) ctx.resolve(!!ok);
  }

  async function confirmarSenhaModal() {
    if (!_senhaCtx || _senhaVerificando) return;
    var inp = $('senha-input'), err = $('senha-err'), ok = $('senha-ok');
    var senha = String((inp && inp.value) || '');
    if (!senha) { if (err) { err.textContent = 'Digite sua senha.'; err.style.display = ''; } return; }
    _senhaVerificando = true;
    if (ok) ok.disabled = true;
    var erro = await verificarSenhaErro(senha);
    _senhaVerificando = false;
    if (erro) {
      if (err) { err.textContent = erro; err.style.display = ''; }
      if (ok) ok.disabled = false;
      return;
    }
    fecharSenha(true);
  }

  async function confirmClear() {
    if (!_clearCtx) return;
    var err = $('clr-err');
    var ok = $('clr-ok');
    function falha(m) {
      if (err) { err.textContent = m; err.style.display = ''; }
      if (ok) ok.disabled = false;
    }
    if (err) { err.style.display = 'none'; err.textContent = ''; }
    if (ok) ok.disabled = true;

    try {
      var senha = String((($('clr-senha') || {}).value) || '');
      var senhaErro = await verificarSenhaErro(senha);
      if (senhaErro) { falha(senhaErro); return; }

      if (_clearCtx.mode === 'all') {
        if (!confirm('Confirma apagar TUDO do banco?\n\nCaixa, quarentena, reprovadas e histórico de importações de todos os usuários.')) {
          if (ok) ok.disabled = false; return;
        }
        if (!saveDB({ principal: [], quarentena: [], imports: [], reproved: [] })) {
          falha('Banco indisponível — nada foi apagado.'); return;
        }
        closeClearModal();
        var rec1 = false;
        try { rec1 = await SADDB.refresh(); } catch (e1) {}
        if (rec1) renderAll('Banco limpo para todos (caixa, quarentena, reprovadas e importações).');
        else alert('Banco apagado. Recarregue a página (F5) para atualizar a tela.');
        return;
      }

      renderClearPreview();
      var del = _clearCtx.del;
      if (!del || !del.total) { falha('Marque pelo menos um serviço com itens para apagar.'); return; }
      if (!confirm('Apagar ' + del.p.length + ' OS da caixa, ' + del.q.length +
        ' item(ns) da quarentena e ' + del.r.length + ' reprovada(s)?\n\n' +
        'Os demais serviços e o histórico de importações ficam.')) {
        if (ok) ok.disabled = false; return;
      }

      var set = _clearCtx.sel;
      var codsSel = Object.keys(set).filter(function (c) { return !!set[c]; });
      function uniq(arr) {
        var o = {}, out = [];
        arr.forEach(function (x) { if (x != null && x !== '' && !o[x]) { o[x] = 1; out.push(x); } });
        return out;
      }
      function chunks(arr, n) {
        var out = [];
        for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
        return out;
      }
      var qNumos = uniq(del.q.map(function (x) { return x.numos; }));
      var rNumos = uniq(del.r.map(function (r) { return r.numos; }));
      var client = supa();
      var erroDel = null;
      try {
        var lotesP = chunks(codsSel, 150);
        for (var ip = 0; ip < lotesP.length; ip++) {
          var rp = await client.from('demandas').delete().in('codserv', lotesP[ip]);
          if (rp.error) throw rp.error;
        }
        var lotesQ = chunks(qNumos, 150);
        for (var iq = 0; iq < lotesQ.length; iq++) {
          var rq = await client.from('quarentena').delete().in('numos', lotesQ[iq]);
          if (rq.error) throw rq.error;
        }
        var lotesR = chunks(rNumos, 150);
        for (var ir = 0; ir < lotesR.length; ir++) {
          var rr = await client.from('reprovadas').delete().in('numos', lotesR[ir]);
          if (rr.error) throw rr.error;
        }
      } catch (eD) {
        erroDel = eD;
      }

      closeClearModal();
      var rec2 = false;
      try { rec2 = await SADDB.refresh(); } catch (e2) {}
      if (erroDel) {
        alert('Falha ao limpar (pode ter apagado parte): ' + ((erroDel && erroDel.message) || erroDel));
        if (rec2) renderAll('Limpeza parcial — confira a caixa e a quarentena.');
        return;
      }
      if (rec2) {
        renderAll('Limpeza filtrada: -' + del.p.length + ' OS, -' + del.q.length +
          ' quarentena e -' + del.r.length + ' reprovada(s).');
      } else {
        alert('Itens apagados. Recarregue a página (F5) para atualizar a tela.');
      }
    } catch (e) {
      falha('Falha ao limpar: ' + ((e && e.message) || e));
    }
  }

  // ---------- render ----------
  function statusBadge(st) {
    var cls = 'badge-gray';
    if (st === 'A INICIAR') cls = 'badge-blue';
    else if (st === 'EM ANDAMENTO') cls = 'badge-yellow';
    else if (st === 'OCORRENCIA') cls = 'badge-red';
    else if (st === 'ENCERRADO') cls = 'badge-green';
    else if (st === 'DESPACHADO') cls = 'badge-purple';
    var label = st === 'OCORRENCIA' ? 'OCORRÊNCIA' : st;
    return '<span class="badge ' + cls + '">' + esc(label) + '</span>';
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
      // Encerradas, despachadas e em ocorrência saem da caixa principal (têm telas próprias).
      if (p.statusDemanda === 'ENCERRADO' || p.statusDemanda === 'DESPACHADO' || p.statusDemanda === 'OCORRENCIA') return false;
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
    if (col === 'data' && (k === 'data-asc' || k === 'data-desc')) return ' <span class="sort-ico on">' + SADICON(k === 'data-asc' ? 'arrow-up' : 'arrow-down', 13) + '</span>';
    if (col === 'os' && (k === 'os-asc' || k === 'os-desc')) return ' <span class="sort-ico on">' + SADICON(k === 'os-asc' ? 'arrow-up' : 'arrow-down', 13) + '</span>';
    return ' <span class="sort-ico">' + SADICON('sort', 13) + '</span>';
  }

  // ---------- Encerrados (OS concluídas saem da caixa) ----------
  function filteredEncerrados(db) {
    var q = String(state.encSearch || '').trim().toUpperCase();
    var out = db.principal.filter(function (p) {
      if (p.statusDemanda !== 'ENCERRADO') return false;
      if (!state.isAdmin && String(ownerOf(p)).toLowerCase() !== meEmail()) return false;
      if (!q) return true;
      return String(p.numos).indexOf(q) !== -1 ||
        String(p.cliente || '').toUpperCase().indexOf(q) !== -1 ||
        String(p.cidade || '').toUpperCase().indexOf(q) !== -1 ||
        String(p.codserv || '').indexOf(q) !== -1 ||
        String(p.encerradoPor || '').toUpperCase().indexOf(q) !== -1 ||
        String(p.responsavel || '').toUpperCase().indexOf(q) !== -1;
    });
    return sortPrincipal(out, state.sort.key);
  }
  function renderEncerrados(msg) {
    var el = $('tbl-encerrados');
    if (!el) return;
    var db = loadDB();
    var list = filteredEncerrados(db);
    var totalP = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.pageEnc > totalP) state.pageEnc = totalP;
    var slice = list.slice((state.pageEnc - 1) * PAGE_SIZE, state.pageEnc * PAGE_SIZE);
    var html = '';
    if (!slice.length) {
      html = '<div class="no-results"><div class="big">' + SADICON('check-circle', 38) + '</div>Nenhuma OS encerrada' + (String(state.encSearch || '').trim() ? ' para essa busca.' : '.') + '</div>';
    } else {
      html = '<div class="table-wrap"><table><thead><tr>' +
        '<th data-sort="os" title="Ordenar por NUM OS" style="cursor:pointer;user-select:none">NUM OS' + sortArrow('os') + '</th>' +
        '<th>CODSERV</th>' +
        '<th data-sort="data" title="Ordenar por DATA SOL" style="cursor:pointer;user-select:none">DATA SOL' + sortArrow('data') + '</th>' +
        '<th>CIDADE</th><th>CLIENTE</th>' +
        (state.isAdmin ? '<th>RESPONSÁVEL</th>' : '') +
        '<th>ENCERRADO EM</th></tr></thead><tbody>';
      slice.forEach(function (p) {
        html += '<tr>' +
          '<td><span class="os-id">' + esc(p.numos) + '</span></td>' +
          '<td class="mono">' + esc(p.codserv || '—') + '</td>' +
          '<td class="mono">' + esc(p.dataISO || p.datasol || '—') + '</td>' +
          '<td>' + esc(p.cidade || '—') + '</td>' +
          '<td>' + esc(p.cliente || '—') + '</td>' +
          (state.isAdmin ? '<td class="mono">' + esc(ownerOf(p) || '—') + '</td>' : '') +
          '<td class="mono">' + esc(p.encerradoEm ? String(p.encerradoEm).slice(0, 10) : '—') + '</td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
      html += '<div class="pagination"><button class="page-btn" data-pg="e-prev">‹</button>' +
        '<span class="page-info">Pág ' + state.pageEnc + '/' + totalP + ' • ' + list.length + ' itens</span>' +
        '<button class="page-btn" data-pg="e-next">›</button></div>';
    }
    el.innerHTML = html;
    var enc = $('enc-count');
    if (enc) enc.textContent = list.length + ' encerrada(s)';
  }

  // ---------- Despachados (OS despachadas saem da caixa) ----------
  function despFilterCount() {
    var f = state.desp || {}, n = 0;
    ['numos', 'codserv', 'cliente', 'cidade', 'reg', 'origem', 'resp', 'despPor'].forEach(function (k) { if (f[k]) n++; });
    if (f.dini || f.dfim) n++;
    if (f.despIni || f.despFim) n++;
    return n;
  }
  function syncDespToggle() {
    var body = $('desp-f-body'), btn = $('btn-desp-f-toggle'), badge = $('desp-f-count');
    if (!body || !btn) return;
    var open = true;
    try { open = localStorage.getItem('sad-desp-f-open') !== '0'; } catch (e) {}
    body.classList.toggle('closed', !open);
    btn.classList.toggle('closed', !open);
    if (badge) {
      var n = despFilterCount();
      badge.textContent = n;
      badge.classList.toggle('show', n > 0);
    }
  }
  function readDespFilters() {
    var g = function (id) { return (($(id) || {}).value || ''); };
    return {
      numos: g('d-numos').replace(/\D/g, ''),
      codserv: g('d-codserv'),
      cliente: g('d-cliente').toUpperCase().trim(),
      cidade: g('d-cidade').toUpperCase().trim(),
      reg: g('d-reg'),
      origem: g('d-origem'),
      resp: g('d-resp'),
      despPor: g('d-desppor'),
      dini: g('d-dini'),
      dfim: g('d-dfim'),
      despIni: g('d-despcini'),
      despFim: g('d-despfim'),
      sort: state.desp.sort || g('d-sort') || 'desp-desc',
    };
  }
  function syncDespFilterInputs() {
    var f = state.desp || {};
    if ($('d-numos')) $('d-numos').value = f.numos || '';
    if ($('d-codserv')) $('d-codserv').value = f.codserv || '';
    if ($('d-cliente')) $('d-cliente').value = f.cliente || '';
    if ($('d-cidade')) $('d-cidade').value = f.cidade || '';
    if ($('d-reg')) $('d-reg').value = f.reg || '';
    if ($('d-origem')) $('d-origem').value = f.origem || '';
    if ($('d-resp')) $('d-resp').value = f.resp || '';
    if ($('d-desppor')) $('d-desppor').value = f.despPor || '';
    if ($('d-dini')) $('d-dini').value = f.dini || '';
    if ($('d-dfim')) $('d-dfim').value = f.dfim || '';
    if ($('d-despcini')) $('d-despcini').value = f.despIni || '';
    if ($('d-despfim')) $('d-despfim').value = f.despFim || '';
    if ($('d-sort')) $('d-sort').value = f.sort || 'desp-desc';
  }
  function populateDespFilters(db) {
    var cs = {}, rs = {}, ps = {}, os = {};
    db.principal.forEach(function (p) {
      if (p.statusDemanda !== 'DESPACHADO') return;
      if (!state.isAdmin && !isMine(p)) return;
      if (p.codserv) cs[p.codserv] = 1;
      if (p.responsavel) rs[p.responsavel] = 1;
      if (p.despachadoPor) ps[p.despachadoPor] = 1;
      if (p.origem) os[p.origem] = 1;
    });
    var selC = $('d-codserv');
    if (selC) {
      var curC = state.desp.codserv || '';
      selC.innerHTML = '<option value="">Todos</option>' + Object.keys(cs).sort().map(function (c) {
        return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
      }).join('');
      selC.value = curC;
    }
    var selR = $('d-resp');
    if (selR) {
      var curR = state.desp.resp || '';
      if (state.isAdmin) {
        selR.innerHTML = '<option value="">Todos</option><option value="__NONE__">Sem responsável</option>' +
          Object.keys(rs).sort().map(function (r) { return '<option value="' + esc(r) + '">' + esc(r) + '</option>'; }).join('');
      } else {
        var me = (state.user && state.user.email) || '';
        selR.innerHTML = '<option value="">Todos (meu alcance)</option><option value="__NONE__">Sem responsável</option>' +
          (me ? '<option value="' + esc(me) + '">Eu (' + esc(me) + ')</option>' : '');
        if (curR && curR !== '__NONE__' && curR !== me) curR = '';
      }
      selR.value = curR;
    }
    var selP = $('d-desppor');
    if (selP) {
      var curP = state.desp.despPor || '';
      selP.innerHTML = '<option value="">Todos</option><option value="__NONE__">Sem registro</option>' +
        Object.keys(ps).sort().map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join('');
      selP.value = curP;
    }
    var selO = $('d-origem');
    if (selO) {
      var curO = state.desp.origem || '';
      selO.innerHTML = '<option value="">Todas</option>' + Object.keys(os).sort().map(function (x) {
        return '<option value="' + esc(x) + '">' + esc(x.replace(/_/g, ' ').toLowerCase()) + '</option>';
      }).join('');
      selO.value = curO;
    }
  }
  function despSortArrow(col) {
    var k = state.desp.sort || 'desp-desc';
    var on = (col === 'os' && k.indexOf('os-') === 0) || (col === 'data' && k.indexOf('data-') === 0) || (col === 'desp' && k.indexOf('desp-') === 0);
    if (on) return ' <span class="sort-ico on">' + SADICON(k.indexOf('-asc') !== -1 ? 'arrow-up' : 'arrow-down', 13) + '</span>';
    return ' <span class="sort-ico">' + SADICON('sort', 13) + '</span>';
  }
  function sortDespachados(list, key) {
    var arr = list.slice();
    key = key || 'desp-desc';
    var dir = key.indexOf('-asc') !== -1 ? 1 : -1;
    var byOS = key.indexOf('os-') === 0;
    var byDesp = key.indexOf('desp-') === 0;
    arr.sort(function (a, b) {
      var va, vb;
      if (byOS) {
        var na = Number(a.numos), nb = Number(b.numos);
        va = isFinite(na) ? na : String(a.numos || '');
        vb = isFinite(nb) ? nb : String(b.numos || '');
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      }
      if (byDesp) {
        va = a.despachadoEm ? String(a.despachadoEm) : '';
        vb = b.despachadoEm ? String(b.despachadoEm) : '';
      } else {
        va = a.dataISO || '';
        vb = b.dataISO || '';
      }
      if (!va && !vb) return String(a.numos) < String(b.numos) ? -1 : 1;
      if (!va) return 1; // sem data vai para o fim
      if (!vb) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return arr;
  }
  function filteredDespachados(db) {
    var f = state.desp || {};
    var q = String(state.despSearch || '').trim().toUpperCase();
    var out = db.principal.filter(function (p) {
      if (p.statusDemanda !== 'DESPACHADO') return false;
      if (!state.isAdmin && !isMine(p)) return false;
      if (f.numos && String(p.numos || '').indexOf(f.numos) === -1) return false;
      if (f.codserv && String(p.codserv || '') !== f.codserv) return false;
      if (f.cliente && String(p.cliente || '').toUpperCase().indexOf(f.cliente) === -1) return false;
      if (f.cidade && String(p.cidade || '').toUpperCase().indexOf(f.cidade) === -1) return false;
      if (f.reg && String(p.codreg || '') !== f.reg) return false;
      if (f.origem && String(p.origem || '') !== f.origem) return false;
      if (f.resp === '__NONE__' && p.responsavel) return false;
      if (f.resp && f.resp !== '__NONE__' && String(p.responsavel || '').toLowerCase() !== f.resp.toLowerCase()) return false;
      if (f.despPor === '__NONE__' && p.despachadoPor) return false;
      if (f.despPor && f.despPor !== '__NONE__' && String(p.despachadoPor || '').toLowerCase() !== f.despPor.toLowerCase()) return false;
      if (f.dini || f.dfim) {
        var d = p.dataISO || '';
        if (!d) return false;
        if (f.dini && d < f.dini) return false;
        if (f.dfim && d > f.dfim) return false;
      }
      if (f.despIni || f.despFim) {
        var dd = p.despachadoEm ? String(p.despachadoEm).slice(0, 10) : '';
        if (!dd) return false;
        if (f.despIni && dd < f.despIni) return false;
        if (f.despFim && dd > f.despFim) return false;
      }
      if (!q) return true;
      // Busca geral: cobre todos os campos de texto da OS.
      var hay = [p.numos, p.codserv, p.datasol, p.dataISO, p.codreg, p.regional, p.cidade,
        p.cliente, p.tel1, p.tel2, p.obs, p.dscsvc, p.statusDemanda, p.responsavel,
        p.origem, p.motivoOcorrencia, p.despachadoEm, p.despachadoPor]
        .join(' ').toUpperCase();
      return hay.indexOf(q) !== -1;
    });
    return sortDespachados(out, f.sort || 'desp-desc');
  }
  var DESP_EXP_COLS = ['NUM OS', 'CODSERV', 'DESCRIÇÃO SERVIÇO', 'DATA SOL', 'REGIONAL', 'CIDADE', 'CLIENTE', 'TEL1', 'TEL2', 'OBSERVAÇÃO', 'STATUS', 'RESPONSÁVEL', 'ORIGEM', 'DESPACHADO EM', 'DESPACHADO POR'];
  function despToRows(list) {
    return list.map(function (p) {
      return {
        'NUM OS': p.numos,
        'CODSERV': p.codserv || '',
        'DESCRIÇÃO SERVIÇO': p.dscsvc || '',
        'DATA SOL': p.dataISO || p.datasol || '',
        'REGIONAL': p.regional || REGIONAL_NOME[p.codreg] || p.codreg || '',
        'CIDADE': p.cidade || '',
        'CLIENTE': p.cliente || '',
        'TEL1': p.tel1 || '',
        'TEL2': p.tel2 || '',
        'OBSERVAÇÃO': p.obs || '',
        'STATUS': p.statusDemanda || '',
        'RESPONSÁVEL': p.responsavel || '',
        'ORIGEM': p.origem || '',
        'DESPACHADO EM': p.despachadoEm ? String(p.despachadoEm).slice(0, 10) : '',
        'DESPACHADO POR': p.despachadoPor || '',
      };
    });
  }
  function despExpName(ext) {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return 'despachados_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + '.' + ext;
  }
  function exportDespachadosCSV() {
    var rows = despToRows(filteredDespachados(loadDB()));
    if (!rows.length) { alert('Nada para exportar com os filtros atuais.'); return; }
    function cell(v) {
      v = String(v == null ? '' : v);
      return (/[";\n\r]/.test(v)) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    var txt = '\uFEFF' + DESP_EXP_COLS.join(';') + '\r\n' +
      rows.map(function (r) { return DESP_EXP_COLS.map(function (c) { return cell(r[c]); }).join(';'); }).join('\r\n');
    downloadBlob(new Blob([txt], { type: 'text/csv;charset=utf-8' }), despExpName('csv'));
  }
  function exportDespachadosXLSX() {
    var rows = despToRows(filteredDespachados(loadDB()));
    if (!rows.length) { alert('Nada para exportar com os filtros atuais.'); return; }
    try {
      var ws = XLSX.utils.json_to_sheet(rows, { header: DESP_EXP_COLS });
      ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 34 }, { wch: 11 }, { wch: 11 }, { wch: 20 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 32 }, { wch: 13 }, { wch: 26 }, { wch: 20 }, { wch: 14 }, { wch: 26 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Despachados');
      XLSX.writeFile(wb, despExpName('xlsx'));
    } catch (e) {
      console.error(e);
      alert('Falha ao gerar XLSX. Tente o CSV.');
    }
  }
  function renderDespachados() {
    var el = $('tbl-despachados');
    if (!el) return;
    var db = loadDB();
    populateDespFilters(db);
    syncDespToggle();
    var list = filteredDespachados(db);
    var totalP = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.pageDesp > totalP) state.pageDesp = totalP;
    var slice = list.slice((state.pageDesp - 1) * PAGE_SIZE, state.pageDesp * PAGE_SIZE);
    var html = '';
    if (!slice.length) {
      var temFiltro = String(state.despSearch || '').trim() || despFilterCount() > 0;
      html = '<div class="no-results"><div class="big">' + SADICON('send', 38) + '</div>Nenhuma OS despachada' + (temFiltro ? ' para esses filtros.' : '.') + '</div>';
    } else {
      html = '<div class="table-wrap"><table><thead><tr>' +
        '<th data-dsort="os" title="Ordenar por NUM OS" style="cursor:pointer;user-select:none">NUM OS' + despSortArrow('os') + '</th>' +
        '<th>CODSERV</th>' +
        '<th data-dsort="data" title="Ordenar por DATA SOL" style="cursor:pointer;user-select:none">DATA SOL' + despSortArrow('data') + '</th>' +
        '<th>CIDADE</th><th>CLIENTE</th>' +
        (state.isAdmin ? '<th>RESPONSÁVEL</th>' : '') +
        '<th data-dsort="desp" title="Ordenar por data do despacho" style="cursor:pointer;user-select:none">DESPACHADO EM' + despSortArrow('desp') + '</th><th>AÇÕES</th></tr></thead><tbody>';
      slice.forEach(function (p) {
        html += '<tr>' +
          '<td><span class="os-id">' + esc(p.numos) + '</span></td>' +
          '<td class="mono">' + esc(p.codserv || '—') + '</td>' +
          '<td class="mono">' + esc(p.dataISO || p.datasol || '—') + '</td>' +
          '<td>' + esc(p.cidade || '—') + '</td>' +
          '<td>' + esc(p.cliente || '—') + '</td>' +
          (state.isAdmin ? '<td class="mono">' + esc(p.responsavel || '—') + '</td>' : '') +
          '<td class="mono">' + esc(p.despachadoEm ? String(p.despachadoEm).slice(0, 10) : '—') + '</td>' +
          '<td style="white-space:nowrap"><button class="btn-small" data-act="reabrir" data-os="' + esc(p.numos) + '">Reabrir</button></td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
      html += '<div class="pagination"><button class="page-btn" data-pg="d-prev">‹</button>' +
        '<span class="page-info">Pág ' + state.pageDesp + '/' + totalP + ' • ' + list.length + ' itens</span>' +
        '<button class="page-btn" data-pg="d-next">›</button></div>';
    }
    el.innerHTML = html;
    var desp = $('desp-count');
    if (desp) desp.textContent = list.length + ' despachada(s)';
  }

  // ---------- Ocorrências (fora da caixa até resolver) ----------
  function filteredOcorrencias(db) {
    var q = String(state.ocoSearch || '').trim().toUpperCase();
    var out = db.principal.filter(function (p) {
      if (p.statusDemanda !== 'OCORRENCIA') return false;
      if (!state.isAdmin && !isMine(p)) return false;
      if (!q) return true;
      return String(p.numos).indexOf(q) !== -1 ||
        String(p.cliente || '').toUpperCase().indexOf(q) !== -1 ||
        String(p.cidade || '').toUpperCase().indexOf(q) !== -1 ||
        String(p.codserv || '').indexOf(q) !== -1 ||
        String(p.motivoOcorrencia || '').toUpperCase().indexOf(q) !== -1 ||
        String(p.responsavel || '').toUpperCase().indexOf(q) !== -1;
    });
    return sortPrincipal(out, state.sort.key);
  }
  function renderOcorrencias() {
    var el = $('tbl-ocorrencias');
    if (!el) return;
    var db = loadDB();
    var list = filteredOcorrencias(db);
    var totalP = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.pageOco > totalP) state.pageOco = totalP;
    var slice = list.slice((state.pageOco - 1) * PAGE_SIZE, state.pageOco * PAGE_SIZE);
    var html = '';
    if (!slice.length) {
      html = '<div class="no-results"><div class="big">' + SADICON('alert-circle', 38) + '</div>Nenhuma OS em ocorrência' + (String(state.ocoSearch || '').trim() ? ' para essa busca.' : '.') + '</div>';
    } else {
      html = '<div class="table-wrap"><table><thead><tr>' +
        '<th>NUM OS</th><th>CODSERV</th><th>CIDADE</th><th>CLIENTE</th>' +
        (state.isAdmin ? '<th>RESPONSÁVEL</th>' : '') +
        '<th>MOTIVO</th><th>AÇÕES</th></tr></thead><tbody>';
      slice.forEach(function (p) {
        var mine = isMine(p);
        html += '<tr>' +
          '<td><span class="os-id">' + esc(p.numos) + '</span></td>' +
          '<td class="mono">' + esc(p.codserv || '—') + '</td>' +
          '<td>' + esc(p.cidade || '—') + '</td>' +
          '<td>' + esc(p.cliente || '—') + '</td>' +
          (state.isAdmin ? '<td class="mono">' + esc(p.responsavel || '—') + '</td>' : '') +
          '<td style="font-size:12px;max-width:320px">' + esc(p.motivoOcorrencia || '—') + '</td>' +
          '<td style="white-space:nowrap">' +
          ((state.isAdmin || mine) ? '<button class="btn-small ok" data-act="resolver-ocorrencia" data-os="' + esc(p.numos) + '">Ocorrência resolvida</button>' : '<span class="mono" style="font-size:11px;color:var(--text3)">—</span>') +
          (state.isAdmin ? ' <button class="btn-small danger" data-act="liberar" data-os="' + esc(p.numos) + '">Liberar</button>' : '') +
          '</td></tr>';
      });
      html += '</tbody></table></div>';
      html += '<div class="pagination"><button class="page-btn" data-pg="o-prev">‹</button>' +
        '<span class="page-info">Pág ' + state.pageOco + '/' + totalP + ' • ' + list.length + ' itens</span>' +
        '<button class="page-btn" data-pg="o-next">›</button></div>';
    }
    el.innerHTML = html;
    var oc = $('oco-count');
    if (oc) oc.textContent = list.length + ' em ocorrência';
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
    $('st-si').textContent = r && r.filteredSiate !== undefined ? r.filteredSiate : (state.siateClean.length || (r ? r.cong.length + r.soSiate.length : db.principal.length ? '—' : '0'));
    $('st-li').textContent = r && r.filteredList !== undefined ? r.filteredList : (state.listClean.length || (r ? r.cong.length + r.soList.length : '0'));
    $('st-ok').textContent = r ? r.cong.length : db.principal.length;
    if ($('st-conf')) $('st-conf').textContent = r ? (r.confl || []).length : db.quarentena.filter(function (x) { return x.origem === 'DIVERGENTE'; }).length;
    $('st-ssi').textContent = r ? r.soSiate.length : db.quarentena.filter(function (x) { return x.origem === 'SO_SIATE'; }).length;
    $('st-sli').textContent = r ? r.soList.length : db.quarentena.filter(function (x) { return x.origem === 'SO_LIST'; }).length;
    $('st-p').textContent = db.principal.length;
    $('st-q').textContent = db.quarentena.length;
    if (state.isAdmin) {
      var openT = 0, encT = 0, despT = 0;
      db.principal.forEach(function (p) {
        if (p.statusDemanda === 'ENCERRADO') encT++;
        else if (p.statusDemanda === 'DESPACHADO') despT++;
        else if (p.statusDemanda !== 'OCORRENCIA') openT++;
      });
      $('count-badge').textContent = openT + ' na caixa • ' + encT + ' encerradas • ' + despT + ' despachadas • ' + db.quarentena.length + ' quarentena';
      $('tab-n-p').textContent = openT;
    } else {
      // Usuário não vê nem a quantidade dos outros: só minhas + disponíveis.
      var mine0 = 0, pool0 = 0, oco0 = 0, desp0 = 0;
      db.principal.forEach(function (p) {
        if (p.statusDemanda === 'ENCERRADO') return;
        if (p.statusDemanda === 'DESPACHADO') { if (isMine(p)) desp0++; return; }
        if (isMine(p)) { if (p.statusDemanda === 'OCORRENCIA') oco0++; else mine0++; }
        else if (!p.responsavel) pool0++;
      });
      $('count-badge').textContent = mine0 + ' minhas • ' + oco0 + ' ocorrência • ' + desp0 + ' despachadas • ' + pool0 + ' disponíveis';
      $('tab-n-p').textContent = mine0 + pool0;
    }
    $('tab-n-q').textContent = db.quarentena.length;
    var despN = 0;
    db.principal.forEach(function (p) {
      if (p.statusDemanda !== 'DESPACHADO') return;
      if (state.isAdmin || isMine(p)) despN++;
    });
    if ($('tab-n-d')) $('tab-n-d').textContent = despN;
    var ocoN = 0;
    db.principal.forEach(function (p) {
      if (p.statusDemanda !== 'OCORRENCIA') return;
      if (state.isAdmin || isMine(p)) ocoN++;
    });
    if ($('tab-n-o')) $('tab-n-o').textContent = ocoN;
    renderResumoUser(db);
  }

  // ---------- resumo pessoal do usuário (quantas OS, por status) ----------
  function setTxt(id, v) { var e = $(id); if (e) e.textContent = v; }
  // Período do resumo (mesma lógica das Métricas, mas estado próprio).
  function resumoRange() {
    var tk = todayKey(), p = (state.resumo && state.resumo.preset) || 'hoje', ini, fim;
    if (p === '7d') { ini = addDaysStr(tk, -6); fim = tk; }
    else if (p === '30d') { ini = addDaysStr(tk, -29); fim = tk; }
    else if (p === 'mes') { ini = tk.slice(0, 7) + '-01'; fim = tk; }
    else if (p === 'custom') {
      ini = (state.resumo.dini || tk); fim = (state.resumo.dfim || tk);
      if (ini > fim) { var t = ini; ini = fim; fim = t; }
    }
    else { ini = tk; fim = tk; }
    return { ini: ini, fim: fim };
  }
  function renderResumoUser(db) {
    var adminGrid = $('panel-resumo'), userGrid = $('panel-resumo-user');
    if (!adminGrid || !userGrid) return;
    var filtro = $('resumo-filtro');
    if (state.isAdmin) { adminGrid.style.display = ''; userGrid.style.display = 'none'; if (filtro) filtro.style.display = 'none'; return; }
    adminGrid.style.display = 'none'; userGrid.style.display = ''; if (filtro) filtro.style.display = '';
    var mine = 0, pool = 0, ini = 0, and = 0, pen = 0, enc = 0, desp = 0, encPer = 0;
    var r = resumoRange();
    db.principal.forEach(function (p) {
      if (!p.responsavel) { if (p.statusDemanda !== 'DESPACHADO') pool++; return; }
      if (!isMine(p)) return;
      if (p.statusDemanda === 'ENCERRADO') {
        enc++;
        if (p.encerradoEm) {
          var dk0 = dayKey(p.encerradoEm);
          if (dk0 && dk0 >= r.ini && dk0 <= r.fim) encPer++;
        }
        return;
      }
      if (p.statusDemanda === 'DESPACHADO') { desp++; return; }
      if (p.statusDemanda === 'OCORRENCIA') { pen++; return; }
      mine++;
      if (p.statusDemanda === 'A INICIAR') ini++;
      else if (p.statusDemanda === 'EM ANDAMENTO') and++;
      if (p.encerradoEm) {
        var dk = dayKey(p.encerradoEm);
        if (dk && dk >= r.ini && dk <= r.fim) encPer++;
      }
    });
    setTxt('ur-total', mine); setTxt('ur-ini', ini); setTxt('ur-and', and);
    setTxt('ur-pen', pen); setTxt('ur-enc', enc); setTxt('ur-desp', desp); setTxt('ur-periodo', encPer);
    setTxt('ur-pool', pool);
    // rótulo + controles do período
    var sub = $('ur-periodo-sub');
    if (sub) sub.textContent = (r.ini === r.fim) ? 'em ' + r.ini : r.ini + ' a ' + r.fim;
    var rl = $('r-range-label');
    if (rl) rl.textContent = 'Período: ' + r.ini + ' a ' + r.fim + ' · as demais contagens são o estado atual da sua caixa.';
    var di = $('r-dini'), df = $('r-dfim');
    if (di && document.activeElement !== di) di.value = state.resumo.dini || '';
    if (df && document.activeElement !== df) df.value = state.resumo.dfim || '';
    document.querySelectorAll('#r-presets [data-rp]').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-rp') === state.resumo.preset);
    });
  }

  // ---------- minha caixa: contadores + métrica do dia (usuário) ----------
  function renderMyStats() {
    var panel = $('my-stats-panel'), el = $('my-stats');
    if (!panel || !el) return;
    if (state.isAdmin) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    var db = loadDB();
    var mine = 0, pool = 0, hoje = 0, oco = 0, despHoje = 0, tk = todayKey();
    db.principal.forEach(function (p) {
      if (!p.responsavel) { if (p.statusDemanda !== 'DESPACHADO') pool++; return; }
      if (!isMine(p)) return;
      if (p.statusDemanda === 'ENCERRADO') {
        if (p.encerradoEm && dayKey(p.encerradoEm) === tk) hoje++;
        return;
      }
      if (p.statusDemanda === 'DESPACHADO') {
        if (p.despachadoEm && dayKey(p.despachadoEm) === tk) despHoje++;
        return;
      }
      if (p.statusDemanda === 'OCORRENCIA') { oco++; return; }
      mine++;
    });
    el.innerHTML =
      '<span class="mi">' + SADICON('user', 15) + '<b>' + mine + '</b> na minha caixa</span>' +
      '<span class="mi">' + SADICON('alert-circle', 15) + '<b>' + oco + '</b> em ocorrência</span>' +
      '<span class="mi">' + SADICON('check-circle', 15) + '<b>' + hoje + '</b> encerrada(s) hoje</span>' +
      '<span class="mi">' + SADICON('send', 15) + '<b>' + despHoje + '</b> despachada(s) hoje</span>' +
      '<span class="mi">' + SADICON('package', 15) + '<b>' + pool + '</b> disponível(is)</span>';
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
      html = '<div class="no-results"><div class="big">' + SADICON('inbox', 38) + '</div>Nenhuma demanda na caixa principal.<br>Importe as bases acima (admin) para começar.</div>';
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
          '<td>' + statusBadge(p.statusDemanda) +
          (p.statusDemanda === 'OCORRENCIA' && p.motivoOcorrencia ? '<div class="oc-motivo" title="' + esc(p.motivoOcorrencia) + '">' + esc(p.motivoOcorrencia) + '</div>' : '') +
          '<select class="status-select" data-act="status" data-os="' + esc(p.numos) + '" style="margin-top:6px">' +
          STATUS_LIST.map(function (s) { return '<option value="' + s + '"' + (s === p.statusDemanda ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
          '</select></td>' +
          '<td class="mono">' + esc(p.responsavel || '—') + '</td>' +
          '<td style="white-space:nowrap">' +
          (p.responsavel ? '' : '<button class="btn-small" data-act="pegar" data-os="' + esc(p.numos) + '">Pegar</button> ') +
          (state.isAdmin ? '<button class="btn-small danger" data-act="liberar" data-os="' + esc(p.numos) + '">Liberar</button>' : '') +
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
      hq = '<div class="no-results"><div class="big">' + SADICON('shield', 38) + '</div>Quarentena vazia.<br>Divergências (só em uma base) aparecem aqui após a importação.</div>';
    } else {
      hq = '<div class="table-wrap"><table><thead><tr>' +
        '<th>NUM OS</th><th>ORIGEM</th><th>MOTIVO</th><th>DETALHE</th><th>AÇÕES (admin)</th>' +
        '</tr></thead><tbody>';
      var inBox = {};
      db.principal.forEach(function (pb) { inBox[String(pb.numos)] = pb; });
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
          if (inBox[String(x.numos)]) {
            det += '<br><span style="font-size:11px;color:var(--yellow)">já está na caixa — escolher um lado atualiza os dados da OS (status e responsável são mantidos)</span>';
          }
        } else {
          det = 'CODSERV ' + esc(qget(x, 'c') || '—') + ' • ' + esc(qget(x, 'cid') || qget(x, 'loc')) + ' • ' + esc(qget(x, 'cli')) + ' • REG ' + esc(qget(x, 'r') || '—');
        }
        var dis = state.isAdmin ? '' : ' disabled title="Somente admin"';
        var motivo = qmotivo(x);
        var badge = x.origem === 'SO_SIATE' ? '<span class="badge badge-yellow">SÓ SIATE</span>'
          : x.origem === 'SO_LIST' ? '<span class="badge badge-red">SÓ LIST</span>'
          : isDiv ? '<span class="badge badge-yellow">' + SADICON('alert', 12) + ' CONFLITO</span>'
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
    if (!saveDB(db)) { alert('NÃO SALVOU: banco indisponível (Supabase).'); return { added: 0, skipped: skipped }; }
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
    var useS = side === 'SIATE';
    var p = db.principal.find(function (x) { return x.numos === os; });
    if (!p) {
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
    } else {
      // OS já estava na caixa: aplica o lado escolhido aos DADOS, preservando
      // status, responsável e histórico. A origem CONFLITO_* marca a escolha
      // para não reabrir o mesmo conflito nas próximas importações.
      p.origem = 'CONFLITO_' + side;
      if (useS) {
        if (d.cs !== undefined && String(d.cs) !== '') p.codserv = d.cs;
        if (d.ds) p.dataISO = d.ds;
        if (d.rs) { p.codreg = d.rs; p.regional = REGIONAL_NOME[d.rs] || p.regional; }
        if (d.cid) p.cidade = d.cid;
        if (d.cli) p.cliente = d.cli;
        if (d.ts) p.tel1 = d.ts;
      } else {
        if (d.cl !== undefined && String(d.cl) !== '') p.codserv = d.cl;
        if (d.dl) p.dataISO = d.dl;
        if (d.loc) p.cidade = d.loc;
        if (d.cli) p.cliente = d.cli;
        if (d.desc) p.dscsvc = d.desc;
        if (d.tl) p.tel1 = d.tl;
      }
    }
    if (!saveDB(db)) { alert('NÃO SALVOU: banco indisponível (Supabase).'); return; }
    renderAll(p ? 'OS ' + os + ' — dados da caixa atualizados com a ' + side + ' (status/responsável preservados).'
      : 'OS ' + os + ' liberada p/ caixa com dados da ' + side + '.');
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
    if (!saveDB(db)) { alert('NÃO SALVOU: banco indisponível (Supabase).'); return 0; }
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
      if (!groups[k]) { groups[k] = { total: 0, ini: 0, and: 0, pen: 0, enc: 0, desp: 0, hoje: 0, maos: 0, oss: [] }; order.push(k); }
      var g = groups[k];
      g.total++;
      if (p.statusDemanda === 'A INICIAR') g.ini++;
      else if (p.statusDemanda === 'EM ANDAMENTO') g.and++;
      else if (p.statusDemanda === 'OCORRENCIA') g.pen++;
      else if (p.statusDemanda === 'ENCERRADO') g.enc++;
      else if (p.statusDemanda === 'DESPACHADO') g.desp++;
      if (p.statusDemanda !== 'OCORRENCIA' && !isFinalStatus(p.statusDemanda)) g.maos++;
      // Métrica do dia: encerrada hoje por essa pessoa (crédito = quem encerrou).
      if (p.statusDemanda === 'ENCERRADO' && p.encerradoEm && dayKey(p.encerradoEm) === tk) {
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
      el.innerHTML = '<div class="no-results"><div class="big">' + SADICON('users', 38) + '</div>Ninguém com OS ainda.<br>A caixa principal está vazia ou sem responsáveis.</div>';
      return;
    }
    var h = '<div class="table-wrap"><table><thead><tr>' +
      '<th>Pessoa</th><th>Total</th><th>Hoje</th><th>Em mãos</th><th>A iniciar</th><th>Em andamento</th><th>Ocorrência</th><th>Encerrado</th><th>Despachado</th><th>OS (amostra)</th><th></th>' +
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
        '<td><span class="badge badge-purple">' + g.desp + '</span></td>' +
        '<td class="mono" style="font-size:11px;max-width:280px">' + esc(g.oss.join(', ')) + (g.total > g.oss.length ? ' …' : '') + '</td>' +
        '<td style="white-space:nowrap">' +
        (k ? '<button class="btn-small" data-act="ver-os" data-email="' + esc(k) + '">Ver OS</button> ' : '') +
        '<button class="btn-small" data-act="ver-caixa" data-resp="' + esc(k) + '">Ver na caixa</button></td></tr>';
    });
    el.innerHTML = h + '</tbody></table></div>' +
      '<div class="panel-hint">“Hoje” = OS com status ENCERRADO registrado hoje para essa pessoa. “Em mãos” = abertas na caixa (nem ocorrência, nem encerradas, nem despachadas). Só aparecem pessoas com OS; contas sem OS não listam.</div>';
  }

  // ---------- métricas do admin (encerradas/despachadas por usuário/período) ----------
  // Fontes: ENCERRADO usa encerradoEm/encerradoPor; DESPACHADO usa
  // despachadoEm/despachadoPor (gravados na troca de status). OS em aberto
  // entram como situação atual — o período só recorta encerradas/despachadas.
  var M_STATUS = [
    { key: 'A INICIAR', label: 'A iniciar', color: 'var(--blue)' },
    { key: 'EM ANDAMENTO', label: 'Em andamento', color: 'var(--yellow)' },
    { key: 'OCORRENCIA', label: 'Ocorrência', color: 'var(--red)' },
    { key: 'ENCERRADO', label: 'Encerrado', color: 'var(--green)' },
    { key: 'DESPACHADO', label: 'Despachado', color: 'var(--purple)' }
  ];
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
  function fmtDayShort(ds) { return ds.slice(8, 10) + '/' + ds.slice(5, 7); }
  function fmtDayBR(ds) { return ds.slice(8, 10) + '/' + ds.slice(5, 7) + '/' + ds.slice(0, 4); }
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
  function mOwner(p) { return ownerOf(p); }
  function mEventDay(p) {
    if (p.statusDemanda === 'ENCERRADO') return dayKey(p.encerradoEm);
    if (p.statusDemanda === 'DESPACHADO') return dayKey(p.despachadoEm);
    return '';
  }
  function mInPeriod(p, ini, fim) {
    if (p.statusDemanda === 'ENCERRADO' || p.statusDemanda === 'DESPACHADO') {
      var dk = mEventDay(p);
      return !!dk && dk >= ini && dk <= fim;
    }
    return true; // OS em aberto = situação atual (não depende do período)
  }
  function mIncludes(arr, v) {
    if (!arr || !arr.length) return true;
    v = String(v == null ? '' : v);
    for (var i = 0; i < arr.length; i++) {
      if (String(arr[i]) === v) return true;
    }
    return false;
  }
  function mIncludesCI(arr, v) {
    if (!arr || !arr.length) return true;
    v = String(v == null ? '' : v).toLowerCase();
    for (var i = 0; i < arr.length; i++) {
      if (String(arr[i]).toLowerCase() === v) return true;
    }
    return false;
  }
  function metricsSet(db, f) {
    return db.principal.filter(function (p) {
      if (!mIncludes(f.status, p.statusDemanda || '')) return false;
      if (!mIncludes(f.reg, p.codreg || '')) return false;
      if (!mIncludes(f.serv, p.codserv || '')) return false;
      if (!mIncludesCI(f.user, mOwner(p) || '')) return false;
      if (!mInPeriod(p, f.ini, f.fim)) return false;
      return true;
    });
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
  // ---------- multi-select dos filtros de métricas ----------
  var mselState = {};
  function mselInit(id, cfg) {
    var root = $(id);
    if (!root || mselState[id]) return;
    cfg = cfg || {};
    mselState[id] = {
      options: [], selected: [], query: '',
      search: !!cfg.search,
      placeholder: cfg.placeholder || 'Todos',
      selNoun: cfg.selNoun || 'selecionados',
      onChange: cfg.onChange || function () {}
    };
    root.innerHTML =
      '<button type="button" class="msel-btn" aria-haspopup="true" aria-expanded="false">' +
        '<span class="msel-label is-empty">' + esc(cfg.placeholder || 'Todos') + '</span>' +
        '<span class="msel-chev">' + SADICON('chevron-down', 14) + '</span>' +
      '</button>' +
      '<div class="msel-panel" hidden>' +
        (cfg.search ? '<div class="msel-search"><input type="text" placeholder="Buscar…" autocomplete="off"></div>' : '') +
        '<div class="msel-list" role="listbox" aria-multiselectable="true"></div>' +
        '<div class="msel-foot">' +
          '<button type="button" data-msel-all>Marcar todos</button>' +
          '<button type="button" data-msel-none>Limpar</button>' +
        '</div>' +
      '</div>';
    var btn = root.querySelector('.msel-btn');
    var panel = root.querySelector('.msel-panel');
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      mselToggle(id);
    });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    if (cfg.search) {
      var inp = panel.querySelector('.msel-search input');
      inp.addEventListener('input', function () {
        mselState[id].query = inp.value || '';
        mselRenderList(id);
      });
    }
    panel.querySelector('[data-msel-all]').addEventListener('click', function () {
      var st = mselState[id];
      st.selected = st.options.map(function (o) { return o.value; });
      mselRenderList(id);
      mselRenderLabel(id);
      st.onChange();
    });
    panel.querySelector('[data-msel-none]').addEventListener('click', function () {
      var st = mselState[id];
      st.selected = [];
      mselRenderList(id);
      mselRenderLabel(id);
      st.onChange();
    });
  }
  function mselCloseAll(except) {
    Object.keys(mselState).forEach(function (id) {
      if (id === except) return;
      var root = $(id);
      if (!root) return;
      root.classList.remove('open');
      var panel = root.querySelector('.msel-panel');
      if (panel) panel.hidden = true;
      var btn = root.querySelector('.msel-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }
  function mselToggle(id) {
    var st = mselState[id], root = $(id);
    if (!st || !root) return;
    var panel = root.querySelector('.msel-panel');
    var btn = root.querySelector('.msel-btn');
    var open = panel.hidden;
    mselCloseAll(id);
    panel.hidden = !open;
    root.classList.toggle('open', open);
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      // Vira o dropdown para a esquerda quando não couber à direita.
      var br = btn.getBoundingClientRect();
      var need = Math.max(220, br.width);
      root.classList.toggle('msel-flip', br.left + need > window.innerWidth - 8);
    }
    if (open) {
      mselRenderList(id);
      var inp = root.querySelector('.msel-search input');
      if (inp) { try { inp.focus(); } catch (e) {} }
    }
  }
  function mselRenderList(id) {
    var st = mselState[id], root = $(id);
    if (!st || !root) return;
    var list = root.querySelector('.msel-list');
    if (!list) return;
    var q = String(st.query || '').toLowerCase();
    var rows = st.options.filter(function (o) {
      return !q || String(o.label).toLowerCase().indexOf(q) !== -1;
    });
    if (!rows.length) {
      list.innerHTML = '<div class="msel-empty">' + (st.options.length ? 'Nada encontrado.' : 'Sem opções.') + '</div>';
      return;
    }
    var scroll = list.scrollTop;
    list.innerHTML = rows.map(function (o) {
      var on = st.selected.indexOf(o.value) !== -1;
      return '<button type="button" class="msel-opt' + (on ? ' on' : '') + '" role="option" aria-selected="' + (on ? 'true' : 'false') + '" data-val="' + esc(o.value) + '" title="' + esc(o.label) + '">' +
        '<span class="msel-box"></span><span class="msel-opt-label">' + esc(o.label) + '</span></button>';
    }).join('');
    list.scrollTop = scroll;
    list.querySelectorAll('.msel-opt').forEach(function (opt) {
      opt.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var val = opt.getAttribute('data-val');
        var i = st.selected.indexOf(val);
        if (i === -1) st.selected.push(val); else st.selected.splice(i, 1);
        mselRenderList(id);
        mselRenderLabel(id);
        st.onChange();
      });
    });
  }
  function mselRenderLabel(id) {
    var st = mselState[id], root = $(id);
    if (!st || !root) return;
    var lbl = root.querySelector('.msel-label');
    if (!lbl) return;
    if (!st.selected.length) {
      lbl.textContent = st.placeholder;
      lbl.classList.add('is-empty');
      root.classList.remove('has-sel');
      lbl.title = '';
      return;
    }
    var names = st.selected.map(function (v) {
      for (var i = 0; i < st.options.length; i++) {
        if (String(st.options[i].value) === String(v)) return st.options[i].label;
      }
      return v;
    });
    lbl.textContent = names.length === 1 ? names[0] : names.length + ' ' + st.selNoun;
    lbl.title = names.join(', ');
    lbl.classList.remove('is-empty');
    root.classList.add('has-sel');
  }
  function mselSetOptions(id, options, placeholder) {
    var st = mselState[id];
    if (!st) return;
    st.options = options || [];
    if (placeholder !== undefined) st.placeholder = placeholder;
    var valid = {};
    st.options.forEach(function (o) { valid[o.value] = 1; });
    st.selected = st.selected.filter(function (v) { return valid[v] === 1; });
    mselRenderList(id);
    mselRenderLabel(id);
  }
  function mselGet(id) {
    return (mselState[id] && mselState[id].selected) ? mselState[id].selected.slice() : [];
  }
  function mselSetSelected(id, values) {
    var st = mselState[id];
    if (!st) return;
    st.selected = (values || []).slice();
    mselRenderList(id);
    mselRenderLabel(id);
  }
  function populateMUser(db) {
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
    db.principal.forEach(function (p) {
      add(p.responsavel); add(p.encerradoPor); add(p.despachadoPor);
    });
    order.sort();
    mselSetOptions('m-user', order.map(function (e) { return { value: e, label: e }; }), 'Todos');
  }
  function populateMServ(db) {
    var set = {}, order = [];
    db.principal.forEach(function (p) {
      var c = String(p.codserv || '').trim();
      if (!c) return;
      if (!set[c]) { set[c] = 1; order.push(c); }
    });
    order.sort(function (a, b) { return Number(a) - Number(b); });
    mselSetOptions('m-serv', order.map(function (c) { return { value: c, label: c }; }), 'Todos');
  }
  function syncMDateInputs(r) {
    var di = $('m-dini'), df = $('m-dfim');
    if (state.metrics.preset !== 'custom') {
      if (di) di.value = r.ini;
      if (df) df.value = r.fim;
      return;
    }
    // Personalizado sem datas ainda preenchidas: parte do período atual.
    if (di && !di.value) di.value = r.ini;
    if (df && !df.value) df.value = r.fim;
  }
  function chartEmpty(msg) {
    return '<div class="chart-empty">' + SADICON('chart', 30) + '<span>' + esc(msg) + '</span></div>';
  }
  function chartLegend(series) {
    return '<div class="chart-legend">' + series.map(function (s) {
      return '<span><i style="background:' + s.color + '"></i>' + esc(s.label) + '</span>';
    }).join('') + '</div>';
  }
  function fmtAxis(v) {
    if (Math.abs(v - Math.round(v)) < 0.001) return String(Math.round(v));
    return String(Math.round(v * 10) / 10).replace('.', ',');
  }
  function svgLineChart(buckets, series) {
    var W = 760, H = 250, padL = 42, padR = 14, padT = 16, padB = 36;
    var iw = W - padL - padR, ih = H - padT - padB;
    var n = buckets.length, max = 0;
    series.forEach(function (s) {
      s.values.forEach(function (v) { if (v > max) max = v; });
    });
    if (!n || !max) return '';
    var ticks = 4, step;
    if (max <= 8) {
      step = Math.ceil(max / ticks);
    } else {
      var raw = max / ticks, pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
      var q = raw / pow;
      var mult = q <= 1 ? 1 : q <= 1.5 ? 1.5 : q <= 2 ? 2 : q <= 3 ? 3 : q <= 4 ? 4 : q <= 5 ? 5 : 10;
      step = mult * pow;
    }
    var yMax = step * ticks;
    function X(i) { return n === 1 ? padL + iw / 2 : padL + (iw * i) / (n - 1); }
    function Y(v) { return padT + ih - (v / yMax) * ih; }
    var svg = '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Evolução diária">';
    for (var t = 0; t <= ticks; t++) {
      var yv = step * t, yy = Y(yv);
      svg += '<line class="chart-grid-line" x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '"/>';
      svg += '<text class="chart-axis-text" x="' + (padL - 8) + '" y="' + (yy + 3.5) + '" text-anchor="end">' + fmtAxis(yv) + '</text>';
    }
    var labelIdx = {};
    if (n <= 10) { for (var li = 0; li < n; li++) labelIdx[li] = 1; }
    else {
      var want = 8;
      for (var lk = 0; lk < want; lk++) labelIdx[Math.round((n - 1) * lk / (want - 1))] = 1;
    }
    Object.keys(labelIdx).forEach(function (ki) {
      var i = +ki;
      svg += '<text class="chart-axis-text" x="' + X(i).toFixed(1) + '" y="' + (H - 12) + '" text-anchor="middle">' + esc(buckets[i].label) + '</text>';
    });
    series.forEach(function (s, si) {
      var pts = s.values.map(function (v, i) { return [X(i), Y(v)]; });
      var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
      if (si === 0) {
        var area = 'M' + pts[0][0].toFixed(1) + ' ' + Y(0).toFixed(1) + ' ' +
          pts.map(function (p) { return 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') +
          ' L' + pts[n - 1][0].toFixed(1) + ' ' + Y(0).toFixed(1) + ' Z';
        svg += '<path d="' + area + '" style="fill:' + s.color + ';opacity:.10"/>';
      }
      svg += '<path d="' + d + '" fill="none" style="stroke:' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      if (n <= 40) {
        pts.forEach(function (p, i) {
          svg += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3" style="fill:' + s.color + ';stroke:var(--surface)" stroke-width="1.5"><title>' +
            esc(buckets[i].full + ' · ' + s.label + ': ' + s.values[i]) + '</title></circle>';
        });
      }
    });
    var band = n === 1 ? iw : iw / (n - 1);
    buckets.forEach(function (b, i) {
      var bx = X(i) - band / 2, bw = Math.max(band, 6);
      if (bx < padL) bx = padL;
      if (bx + bw > W - padR) bw = W - padR - bx;
      var tip = b.full + '\n' + series.map(function (s) { return s.label + ': ' + s.values[i]; }).join('\n');
      svg += '<rect x="' + bx.toFixed(1) + '" y="' + padT + '" width="' + bw.toFixed(1) + '" height="' + ih + '" fill="transparent"><title>' + esc(tip) + '</title></rect>';
    });
    return svg + '</svg>';
  }
  function donutChart(parts, total) {
    var R = 68, C = 2 * Math.PI * R, off = 0, segs = '';
    parts.forEach(function (p) {
      if (!p.value || !total) return;
      var len = (p.value / total) * C;
      segs += '<circle cx="100" cy="100" r="' + R + '" fill="none" stroke-width="24" ' +
        'style="stroke:' + p.color + '" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" ' +
        'stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 100 100)">' +
        '<title>' + esc(p.label + ': ' + p.value) + '</title></circle>';
      off += len;
    });
    return '<div class="donut-wrap">' +
      '<svg class="donut-svg" viewBox="0 0 200 200" role="img" aria-label="Distribuição por status">' +
      '<circle cx="100" cy="100" r="' + R + '" fill="none" stroke-width="24" style="stroke:var(--surface2)"/>' +
      segs +
      '<text class="donut-center-num" x="100" y="99" text-anchor="middle">' + total + '</text>' +
      '<text class="donut-center-lbl" x="100" y="117" text-anchor="middle">OS</text>' +
      '</svg><div class="donut-legend">' + parts.map(function (p) {
        var pct = total ? Math.round((p.value / total) * 100) : 0;
        return '<div class="donut-item"><span class="donut-dot" style="background:' + p.color + '"></span>' +
          esc(p.label) + '<span class="pct">' + pct + '%</span><b>' + p.value + '</b></div>';
      }).join('') + '</div></div>';
  }
  function stackedBars(rows, max) {
    if (!rows.length) return '';
    return '<div class="hbar-list">' + rows.map(function (r) {
      var w = max ? (r.total / max) * 100 : 0;
      var segs = r.segs.filter(function (s) { return s.value > 0; }).map(function (s) {
        return '<span class="hbar-seg" style="width:' + ((s.value / r.total) * 100).toFixed(2) + '%;background:' + s.color + '" title="' +
          esc(s.label + ': ' + s.value) + '"></span>';
      }).join('');
      return '<div class="hbar-row"><div class="hbar-label" title="' + esc(r.label) + '">' + esc(r.label) + '</div>' +
        '<div class="hbar-track"><div class="hbar-stack" style="width:' + w.toFixed(1) + '%">' + segs + '</div></div>' +
        '<div class="hbar-value">' + r.total + '</div></div>';
    }).join('') + '</div>';
  }
  function mDayBuckets(ini, fim) {
    var buckets = [], count = 0, t = ini, guard = 0;
    while (t <= fim && guard < 5000) { count++; t = addDaysStr(t, 1); guard++; }
    var weekly = count > 62;
    if (weekly) {
      var start = ini;
      while (start <= fim && buckets.length < 160) {
        var end = addDaysStr(start, 6);
        if (end > fim) end = fim;
        buckets.push({
          start: start, end: end,
          label: fmtDayShort(start) + (end !== start ? '–' + fmtDayShort(end) : ''),
          full: fmtDayBR(start) + (end !== start ? ' → ' + fmtDayBR(end) : '')
        });
        start = addDaysStr(end, 1);
      }
    } else {
      var d = ini;
      while (d <= fim) {
        buckets.push({ start: d, end: d, label: fmtDayShort(d), full: fmtDayBR(d) });
        d = addDaysStr(d, 1);
      }
    }
    return { buckets: buckets, weekly: weekly, days: count };
  }
  function renderMetricas() {
    if (!state.isAdmin) return;
    var db = loadDB();
    populateMUser(db);
    populateMServ(db);
    var r = mRange();
    syncMDateInputs(r);
    var f = {
      ini: r.ini, fim: r.fim,
      user: mselGet('m-user'),
      status: mselGet('m-status'),
      reg: mselGet('m-reg'),
      serv: mselGet('m-serv')
    };
    state.metrics.user = f.user;
    state.metrics.status = f.status;
    state.metrics.reg = f.reg;
    state.metrics.serv = f.serv;
    var set = metricsSet(db, f);
    // Contagens por status
    var byStatus = {};
    M_STATUS.forEach(function (s) { byStatus[s.key] = 0; });
    set.forEach(function (p) {
      if (byStatus[p.statusDemanda] !== undefined) byStatus[p.statusDemanda]++;
    });
    var enc = byStatus['ENCERRADO'], dsp = byStatus['DESPACHADO'];
    var maos = byStatus['A INICIAR'] + byStatus['EM ANDAMENTO'];
    var oco = byStatus['OCORRENCIA'];
    var owners = {};
    set.forEach(function (p) {
      var o = String(mOwner(p) || '').trim();
      if (o) owners[o.toLowerCase()] = 1;
    });
    if ($('m-k-total')) $('m-k-total').textContent = set.length;
    if ($('m-k-enc')) $('m-k-enc').textContent = enc;
    if ($('m-k-dsp')) $('m-k-dsp').textContent = dsp;
    if ($('m-k-maos')) $('m-k-maos').textContent = maos;
    if ($('m-k-oco')) $('m-k-oco').textContent = oco;
    if ($('m-k-users')) $('m-k-users').textContent = Object.keys(owners).length;
    var lbl = 'Período: ' + (r.ini === r.fim ? fmtDayBR(r.ini) : fmtDayBR(r.ini) + ' → ' + fmtDayBR(r.fim)) +
      ' • o período recorta encerradas/despachadas pela data do evento; OS em aberto entram como situação atual.';
    if (f.user.length) lbl += ' • usuário: ' + (f.user.length <= 2 ? f.user.join(', ') : f.user.length + ' selecionados');
    if (f.status.length) {
      var stNames = f.status.map(function (k) {
        for (var si = 0; si < M_STATUS.length; si++) {
          if (M_STATUS[si].key === k) return M_STATUS[si].label;
        }
        return k;
      });
      lbl += ' • status: ' + (stNames.length <= 2 ? stNames.join(', ') : stNames.length + ' selecionados');
    }
    if (f.reg.length) lbl += ' • regional: ' + (f.reg.length <= 2 ? f.reg.join(', ') : f.reg.length + ' selecionadas');
    if (f.serv.length) lbl += ' • serviço: ' + (f.serv.length <= 2 ? f.serv.join(', ') : f.serv.length + ' selecionados');
    if ($('m-range-label')) $('m-range-label').textContent = lbl;
    // ---- Evolução diária (encerradas × despachadas) ----
    var bucketInfo = mDayBuckets(r.ini, r.fim);
    var encArr = [], dspArr = [], bi;
    for (bi = 0; bi < bucketInfo.buckets.length; bi++) { encArr.push(0); dspArr.push(0); }
    var dayIndex = {};
    bucketInfo.buckets.forEach(function (b, i) {
      var d = b.start;
      while (d <= b.end) { dayIndex[d] = i; d = addDaysStr(d, 1); }
    });
    set.forEach(function (p) {
      if (p.statusDemanda !== 'ENCERRADO' && p.statusDemanda !== 'DESPACHADO') return;
      var dk = mEventDay(p), i = dayIndex[dk];
      if (i === undefined) return;
      if (p.statusDemanda === 'ENCERRADO') encArr[i]++; else dspArr[i]++;
    });
    var totalEvents = 0;
    for (bi = 0; bi < encArr.length; bi++) totalEvents += encArr[bi] + dspArr[bi];
    var chartDay = $('m-chart-day');
    if (chartDay) {
      if (!totalEvents) {
        var onlyOpen = f.status.length > 0 && f.status.indexOf('ENCERRADO') === -1 && f.status.indexOf('DESPACHADO') === -1;
        var noEvt = onlyOpen
          ? 'Os status selecionados não têm data de evento (encerramento/despacho) para montar a série diária.'
          : 'Nenhuma OS encerrada ou despachada no período com os filtros atuais.';
        chartDay.innerHTML = chartEmpty(noEvt);
      } else {
        var daySeries = [
          { label: 'Encerradas', color: 'var(--green)', values: encArr },
          { label: 'Despachadas', color: 'var(--purple)', values: dspArr }
        ];
        chartDay.innerHTML = svgLineChart(bucketInfo.buckets, daySeries) + chartLegend(daySeries);
      }
    }
    if ($('m-chart-day-step')) {
      $('m-chart-day-step').textContent = bucketInfo.weekly ? 'agrupado por semana' : (bucketInfo.days === 1 ? '1 dia' : bucketInfo.days + ' dias');
    }
    if ($('m-chart-day-sub')) $('m-chart-day-sub').textContent = 'Encerradas e despachadas por ' + (bucketInfo.weekly ? 'semana' : 'dia');
    // ---- Por status (donut) ----
    var statusParts = M_STATUS.map(function (s) { return { label: s.label, color: s.color, value: byStatus[s.key] || 0 }; });
    var cs = $('m-chart-status');
    if (cs) cs.innerHTML = set.length ? donutChart(statusParts, set.length) : chartEmpty('Sem OS para os filtros atuais.');
    // ---- Agregação por usuário ----
    var agg = {};
    function row(email, role) {
      var k = String(email || '').toLowerCase();
      if (!agg[k]) agg[k] = { email: email, role: role, total: 0, by: {} };
      return agg[k];
    }
    try {
      if (typeof getUsers === 'function') getUsers().forEach(function (u) { row(u.email, u.role); });
    } catch (e) {}
    set.forEach(function (p) {
      var o = String(mOwner(p) || '').trim();
      if (!o) return;
      var g = row(o, mUserRole(o));
      g.total++;
      g.by[p.statusDemanda] = (g.by[p.statusDemanda] || 0) + 1;
    });
    var rows = Object.keys(agg).map(function (k) {
      var g = agg[k];
      g.enc = g.by['ENCERRADO'] || 0;
      g.dsp = g.by['DESPACHADO'] || 0;
      g.oco = g.by['OCORRENCIA'] || 0;
      g.maos = (g.by['A INICIAR'] || 0) + (g.by['EM ANDAMENTO'] || 0);
      g.segs = M_STATUS.map(function (s) { return { label: s.label, color: s.color, value: g.by[s.key] || 0 }; });
      return g;
    });
    rows.sort(function (a, b) {
      return b.total - a.total || b.enc - a.enc || (a.email < b.email ? -1 : 1);
    });
    // ---- Gráfico por usuário (top 12) ----
    var chartUsers = rows.filter(function (g) { return g.total > 0; }).slice(0, 12);
    var maxUser = 0;
    chartUsers.forEach(function (g) { if (g.total > maxUser) maxUser = g.total; });
    var cu = $('m-chart-user');
    if (cu) cu.innerHTML = chartUsers.length
      ? stackedBars(chartUsers.map(function (g) { return { label: g.email, total: g.total, segs: g.segs }; }), maxUser) + chartLegend(M_STATUS)
      : chartEmpty('Sem OS para os filtros atuais.');
    // ---- Por regional ----
    var regMap = { '1': 0, '2': 0, '3': 0, '': 0 };
    set.forEach(function (p) { var k = String(p.codreg || ''); regMap[k] = (regMap[k] || 0) + 1; });
    var regRows = [
      { label: '1 · Leste', total: regMap['1'], segs: [{ label: 'OS', color: 'var(--blue)', value: regMap['1'] }] },
      { label: '2 · Centro', total: regMap['2'], segs: [{ label: 'OS', color: 'var(--yellow)', value: regMap['2'] }] },
      { label: '3 · Oeste', total: regMap['3'], segs: [{ label: 'OS', color: 'var(--purple)', value: regMap['3'] }] }
    ];
    if (regMap['']) regRows.push({ label: 'Sem regional', total: regMap[''], segs: [{ label: 'OS', color: 'var(--text3)', value: regMap[''] }] });
    var maxReg = 0;
    regRows.forEach(function (x) { if (x.total > maxReg) maxReg = x.total; });
    var cr = $('m-chart-reg');
    if (cr) cr.innerHTML = set.length ? stackedBars(regRows, maxReg) : chartEmpty('Sem OS para os filtros atuais.');
    // ---- Top serviços ----
    var servMap = {};
    set.forEach(function (p) {
      var c = String(p.codserv || '').trim() || '—';
      servMap[c] = (servMap[c] || 0) + 1;
    });
    var servRows = Object.keys(servMap).map(function (c) {
      return { label: c, total: servMap[c], segs: [{ label: 'OS', color: 'var(--accent)', value: servMap[c] }] };
    }).sort(function (a, b) { return b.total - a.total || (a.label < b.label ? -1 : 1); }).slice(0, 10);
    var maxServ = servRows.length ? servRows[0].total : 0;
    var cse = $('m-chart-serv');
    if (cse) cse.innerHTML = servRows.length ? stackedBars(servRows, maxServ) : chartEmpty('Sem OS para os filtros atuais.');
    // ---- Tabela por usuário ----
    var hu = $('m-tbl-user');
    if (hu) {
      if (!rows.length) {
        hu.innerHTML = '<div class="no-results"><div class="big">' + SADICON('chart', 38) + '</div>Sem dados.<br>Cadastre usuários e importe OS para ver as métricas.</div>';
      } else {
        var h = '<div class="table-wrap"><table><thead><tr>' +
          '<th>Usuário</th><th>Perfil</th><th>Total no filtro</th><th>Encerradas</th><th>Despachadas</th><th>Em mãos</th><th>Ocorrências</th><th></th>' +
          '</tr></thead><tbody>';
        rows.forEach(function (g) {
          h += '<tr><td class="mono">' + esc(g.email) + '</td>' +
            '<td>' + (g.role === 'admin' ? '<span class="badge badge-yellow">ADMIN</span>' : '<span class="badge badge-gray">USUÁRIO</span>') + '</td>' +
            '<td class="mono"><b>' + g.total + '</b></td>' +
            '<td><span class="badge ' + (g.enc ? 'badge-green' : 'badge-gray') + '">' + g.enc + '</span></td>' +
            '<td><span class="badge ' + (g.dsp ? 'badge-purple' : 'badge-gray') + '">' + g.dsp + '</span></td>' +
            '<td class="mono">' + g.maos + '</td>' +
            '<td><span class="badge ' + (g.oco ? 'badge-red' : 'badge-gray') + '">' + g.oco + '</span></td>' +
            '<td style="white-space:nowrap"><button class="btn-small" data-act="ver-os" data-email="' + esc(g.email) + '">Ver OS</button></td></tr>';
        });
        hu.innerHTML = h + '</tbody></table></div>';
      }
    }
    // ---- Tabela por dia/semana ----
    var hd = $('m-tbl-day');
    if (hd) {
      if (!bucketInfo.buckets.length) {
        hd.innerHTML = chartEmpty('Sem período válido.');
      } else {
        var hh = '<div class="table-wrap"><table style="min-width:420px"><thead><tr><th>' + (bucketInfo.weekly ? 'Semana' : 'Dia') +
          '</th><th>Encerradas</th><th>Despachadas</th><th>Total</th></tr></thead><tbody>';
        for (var bi2 = bucketInfo.buckets.length - 1; bi2 >= 0; bi2--) {
          var b = bucketInfo.buckets[bi2], te = encArr[bi2], td = dspArr[bi2];
          hh += '<tr><td class="mono">' + esc(b.full) + '</td>' +
            '<td><span class="badge ' + (te ? 'badge-green' : 'badge-gray') + '">' + te + '</span></td>' +
            '<td><span class="badge ' + (td ? 'badge-purple' : 'badge-gray') + '">' + td + '</span></td>' +
            '<td class="mono">' + (te + td) + '</td></tr>';
        }
        hd.innerHTML = hh + '</tbody></table></div>' +
          (bucketInfo.weekly ? '<div class="panel-hint">Período longo: tabela agrupada por semana.</div>' : '');
      }
    }
    if ($('m-day-sub')) $('m-day-sub').textContent = 'Encerradas e despachadas por ' + (bucketInfo.weekly ? 'semana' : 'dia') + ' no período' + (f.user ? ' · ' + f.user : ' · todos');
    state.metrics._rows = rows.map(function (g) {
      return { email: g.email, role: g.role, enc: g.enc, dsp: g.dsp, maos: g.maos, oco: g.oco, total: g.total };
    });
    state.metrics._range = r;
  }
  function exportMetricasCSV() {
    var rows = state.metrics._rows || [], r = state.metrics._range || mRange();
    if (!rows.length) { alert('Nada para exportar.'); return; }
    function cell(v) {
      v = String(v == null ? '' : v);
      return (/[";\n\r]/.test(v)) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    var cols = ['USUARIO', 'PERFIL', 'TOTAL_NO_FILTRO', 'ENCERRADAS', 'DESPACHADAS', 'EM_MAOS', 'OCORRENCIAS'];
    var txt = '\uFEFF' + cols.join(';') + '\r\n' + rows.map(function (g) {
      return [g.email, g.role, g.total, g.enc, g.dsp, g.maos, g.oco].map(cell).join(';');
    }).join('\r\n');
    downloadBlob(new Blob([txt], { type: 'text/csv;charset=utf-8' }), 'metricas_' + r.ini + '_' + r.fim + '.csv');
  }

  // ---------- OS de um usuário (admin: métricas / acompanhar) ----------
  function openUserOS(email) {
    var ov = $('modal-user'), body = $('modal-user-body'), title = $('modal-user-title');
    if (!ov || !body) return;
    var db = loadDB();
    var em = String(email || '').toLowerCase();
    var list = db.principal.filter(function (p) { return String(p.responsavel || '').toLowerCase() === em; });
    var map = { 'A INICIAR': 0, 'EM ANDAMENTO': 0, 'OCORRENCIA': 0, 'ENCERRADO': 0, 'DESPACHADO': 0 };
    list.forEach(function (p) { if (map[p.statusDemanda] !== undefined) map[p.statusDemanda]++; });
    var user = (typeof getUsers === 'function' ? getUsers() : []).filter(function (u) { return String(u.email).toLowerCase() === em; })[0];
    if (title) title.textContent = 'OS de ' + (user ? user.email : (email || '—')) + ' — ' + list.length + ' na caixa';
    var filter = 'TODOS';
    function chip(val, label, n) {
      return '<span class="chip' + (filter === val ? ' active' : '') + '" data-uf="' + val + '">' + esc(label) + ' <b>' + n + '</b></span>';
    }
    function reload() {
      db = loadDB();
      list = db.principal.filter(function (p) { return String(p.responsavel || '').toLowerCase() === em; });
      map = { 'A INICIAR': 0, 'EM ANDAMENTO': 0, 'OCORRENCIA': 0, 'ENCERRADO': 0, 'DESPACHADO': 0 };
      list.forEach(function (p) { if (map[p.statusDemanda] !== undefined) map[p.statusDemanda]++; });
      if (title) title.textContent = 'OS de ' + (user ? user.email : (email || '—')) + ' — ' + list.length + ' no total';
    }
    function render() {
      var rows = list.filter(function (p) { return filter === 'TODOS' || p.statusDemanda === filter; });
      var html = '<div class="status-filter" style="margin-bottom:14px">' +
        chip('TODOS', 'Todos', list.length) +
        chip('A INICIAR', 'A iniciar', map['A INICIAR']) +
        chip('EM ANDAMENTO', 'Em andamento', map['EM ANDAMENTO']) +
        chip('OCORRENCIA', 'Em ocorrência', map['OCORRENCIA']) +
        chip('ENCERRADO', 'Encerrado', map['ENCERRADO']) +
        chip('DESPACHADO', 'Despachado', map['DESPACHADO']) +
        '</div>';
      if (!rows.length) {
        html += '<div class="no-results">Nenhuma OS nesse filtro.</div>';
      } else {
        html += '<div class="table-wrap"><table style="min-width:0"><thead><tr>' +
          '<th>NUM OS</th><th>CODSERV</th><th>CIDADE</th><th>DATA SOL</th><th>STATUS</th><th>MOTIVO</th>' +
          (state.isAdmin ? '<th>AÇÕES</th>' : '') +
          '</tr></thead><tbody>';
        rows.forEach(function (p) {
          var acts = state.isAdmin
            ? '<td style="white-space:nowrap">' +
              '<button class="btn-small" data-uoco="' + esc(p.numos) + '">Ocorrência</button> ' +
              '<button class="btn-small ok" data-uenc="' + esc(p.numos) + '">Encerrar</button> ' +
              '<button class="btn-small" data-udsp="' + esc(p.numos) + '">Despachar</button> ' +
              '<button class="btn-small danger" data-ulos="' + esc(p.numos) + '">Retirar</button></td>'
            : '';
          html += '<tr><td><span class="os-id">' + esc(p.numos) + '</span></td>' +
            '<td class="mono">' + esc(p.codserv || '—') + '</td>' +
            '<td>' + esc(p.cidade || '—') + '</td>' +
            '<td class="mono">' + esc(p.dataISO || p.datasol || '—') + '</td>' +
            '<td>' + statusBadge(p.statusDemanda) + '</td>' +
            '<td style="font-size:12px;max-width:240px">' + esc(p.motivoOcorrencia || '—') + '</td>' +
            acts + '</tr>';
        });
        html += '</tbody></table></div><div class="panel-hint">' + rows.length + ' OS listada(s).</div>';
      }
      body.innerHTML = html;
      body.querySelectorAll('[data-uf]').forEach(function (c) {
        c.addEventListener('click', function () { filter = c.getAttribute('data-uf'); render(); });
      });
      // Retirar (volta para os disponíveis)
      body.querySelectorAll('[data-ulos]').forEach(function (c) {
        c.addEventListener('click', function () {
          var numos = c.getAttribute('data-ulos');
          if (!confirm('Retirar a OS ' + numos + ' de ' + (email || '') + '? Ela volta para os disponíveis.')) return;
          var d = loadDB();
          var px = d.principal.find(function (x) { return x.numos === numos; });
          if (px) {
            px.responsavel = null; px.statusDemanda = 'A INICIAR';
            px.encerradoEm = null; px.encerradoPor = null; px.motivoOcorrencia = '';
            px.despachadoEm = null; px.despachadoPor = null;
            saveDB(d);
          }
          reload(); render();
          var msg = 'OS ' + numos + ' retirada de ' + (email || '') + '.';
          renderAll(msg);
          refreshIfShared(msg);
        });
      });
      // Encerrar (admin encerra a OS de alguém)
      body.querySelectorAll('[data-uenc]').forEach(function (c) {
        c.addEventListener('click', function () {
          var numos = c.getAttribute('data-uenc');
          if (!confirm('Encerrar a OS ' + numos + ' de ' + (email || '') + '?')) return;
          var d = loadDB();
          var px = d.principal.find(function (x) { return x.numos === numos; });
          if (!px) return;
          px.statusDemanda = 'ENCERRADO';
          px.encerradoEm = new Date().toISOString();
          px.encerradoPor = px.responsavel || (state.user && state.user.email) || '';
          px.motivoOcorrencia = '';
          px.despachadoEm = null; px.despachadoPor = null;
          saveDB(d);
          try { var rd = autoDistribute(d, [px.encerradoPor]); if (rd.n > 0) saveDB(d); } catch (e) {}
          reload(); render();
          var msg = 'OS ' + numos + ' encerrada.';
          renderAll(msg);
          refreshIfShared(msg);
        });
      });
      // Despachar (admin despacha a OS de alguém)
      body.querySelectorAll('[data-udsp]').forEach(function (c) {
        c.addEventListener('click', function () {
          var numos = c.getAttribute('data-udsp');
          if (!confirm('Despachar a OS ' + numos + ' de ' + (email || '') + '?')) return;
          var d = loadDB();
          var px = d.principal.find(function (x) { return x.numos === numos; });
          if (!px) return;
          px.statusDemanda = 'DESPACHADO';
          px.despachadoEm = new Date().toISOString();
          px.despachadoPor = px.responsavel || (state.user && state.user.email) || '';
          px.encerradoEm = null; px.encerradoPor = null; px.motivoOcorrencia = '';
          saveDB(d);
          try { var rd = autoDistribute(d, [px.despachadoPor]); if (rd.n > 0) saveDB(d); } catch (e) {}
          reload(); render();
          var msg = 'OS ' + numos + ' despachada.';
          renderAll(msg);
          refreshIfShared(msg);
        });
      });
      // Mandar para ocorrência (pede o motivo)
      body.querySelectorAll('[data-uoco]').forEach(function (c) {
        c.addEventListener('click', function () {
          var numos = c.getAttribute('data-uoco');
          openOcorrenciaModal(numos, '', function (motivo) {
            var d = loadDB();
            var px = d.principal.find(function (x) { return x.numos === numos; });
            if (px) {
              px.statusDemanda = 'OCORRENCIA';
              px.motivoOcorrencia = motivo;
              px.encerradoEm = null; px.encerradoPor = null;
              px.despachadoEm = null; px.despachadoPor = null;
              saveDB(d);
            }
            reload(); render();
            var msg = 'OS ' + numos + ' → OCORRÊNCIA.';
            renderAll(msg);
            refreshIfShared(msg);
          });
        });
      });
    }
    render();
    ov.style.display = 'flex';
  }
  function closeUserOS() { var ov = $('modal-user'); if (ov) ov.style.display = 'none'; }

  // ---------- modal de ocorrência (motivo obrigatório) ----------
  var _ocCtx = null;
  function openOcorrenciaModal(os, current, onOk, onCancel) {
    var ov = $('modal-ocorrencia');
    if (!ov) { if (onOk) onOk(current || ''); return; }
    _ocCtx = { os: os, onOk: onOk, onCancel: onCancel };
    var lbl = $('oc-os-label'); if (lbl) lbl.textContent = 'OS ' + os;
    var ta = $('oc-motivo'); if (ta) ta.value = current || '';
    var err = $('oc-err'); if (err) { err.style.display = 'none'; err.textContent = ''; }
    ov.style.display = 'flex';
    if (ta) setTimeout(function () { ta.focus(); }, 30);
  }
  function closeOcorrenciaModal(cancelled) {
    var ctx = _ocCtx;
    if (!ctx) return;
    if (cancelled) {
      _ocCtx = null;
      var o = $('modal-ocorrencia'); if (o) o.style.display = 'none';
      if (ctx.onCancel) ctx.onCancel();
      return;
    }
    var motivo = ((($('oc-motivo') || {}).value) || '').trim();
    if (motivo.length < 3) {
      var err = $('oc-err');
      if (err) { err.textContent = 'Informe o motivo (mínimo 3 caracteres).'; err.style.display = ''; }
      return;
    }
    _ocCtx = null;
    var ov = $('modal-ocorrencia'); if (ov) ov.style.display = 'none';
    if (ctx.onOk) ctx.onOk(motivo);
  }

  // ---------- distribuição automática (admin configura, sistema entrega) ----------
  // Config compartilhada na nuvem (tabela `config`), via js/db.js.
  function defaultCfg() { return { distrib: { enabled: false, qty: 10, per: {}, autoOff: {} } }; }
  function loadCfg() {
    try {
      if (window.SADDB) {
        var c = SADDB.loadCfg();
        if (c && c.distrib) return c;
      }
    } catch (e) {}
    return defaultCfg();
  }
  function saveCfg(c) {
    try { if (window.SADDB) return SADDB.saveCfg(c); } catch (e) {}
    return false;
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
      if (String(p.responsavel || '').toLowerCase() === em && !isFinalStatus(p.statusDemanda)) n++;
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
    var pool = db.principal.filter(function (p) { return !p.responsavel && !isFinalStatus(p.statusDemanda); });
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
      if ((cfg.autoOff || {})[String(email).toLowerCase()]) return; // auto desligada p/ essa pessoa
      if (openCount(db, email) > 0) return; // só quem zerou
      var q = distQtyFor(email, cfg);
      if (q <= 0) return;
      var lot = pool.splice(0, q);
      lot.forEach(function (p) {
        p.responsavel = email;
        if (p.statusDemanda === 'A INICIAR') p.statusDemanda = 'EM ANDAMENTO';
        p.encerradoEm = null; p.encerradoPor = null;
        p.despachadoEm = null; p.despachadoPor = null;
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
    cfg.distrib = cfg.distrib || { enabled: false, qty: 10, per: {}, autoOff: {} };
    cfg.distrib.autoOff = cfg.distrib.autoOff || {};
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
        el.innerHTML = '<div class="no-results"><div class="big">' + SADICON('truck', 38) + '</div>Sem usuários cadastrados.</div>';
      } else {
        var h = '<div class="table-wrap"><table style="min-width:620px"><thead><tr>' +
          '<th>Usuário</th><th>Perfil</th><th>Auto</th><th>Abertas</th><th>Qtd individual</th>' +
          '</tr></thead><tbody>';
        users.forEach(function (u) {
          var isUser = u.role === 'usuario';
          var ov = (cfg.distrib.per || {})[String(u.email).toLowerCase()];
          var off = !!(cfg.distrib.autoOff || {})[String(u.email).toLowerCase()];
          h += '<tr><td class="mono">' + esc(u.email) + '</td>' +
            '<td>' + (u.role === 'admin' ? '<span class="badge badge-yellow">ADMIN</span>' : '<span class="badge badge-gray">USUÁRIO</span>') + '</td>' +
            '<td>' + (isUser
              ? '<label class="check-pill' + (off ? '' : ' on') + '" style="padding:5px 10px"><input type="checkbox" data-dist-auto="' + esc(u.email) + '"' + (off ? '' : ' checked') + '>Auto</label>'
              : '<span class="mono" style="font-size:11px;color:var(--text3)">—</span>') + '</td>' +
            '<td class="mono">' + (isUser ? openCount(db, u.email) : '—') + '</td>' +
            '<td>' + (isUser
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

  // ---------- usuários (Supabase Auth: criar/trocar papel pelo site) ----------
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
        (me ? '<span class="mono" style="font-size:11px;color:var(--text3)">conta atual</span>'
          : '<button class="btn-small" data-act="user-role" data-email="' + esc(u.email) + '" data-role="' + esc(u.role) + '">tornar ' + (u.role === 'admin' ? 'usuário' : 'admin') + '</button>') +
        '</td></tr>';
    });
    el.innerHTML = h + '</tbody></table></div>' +
      '<div class="panel-hint">' + users.length + ' conta(s) no Supabase. Crie pelo formulário acima. Excluir conta: ' +
      '<b>Supabase → Authentication → Users</b>.</div>';
  }

  function renderAll(msg) {
    var db = loadDB();
    populateCaixaFilters(db);
    populateQuarFilters(db);
    renderTables(msg);
    renderEncerrados();
    renderDespachados();
    renderOcorrencias();
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

  // ---------- LIST conectada (SharePoint → Supabase) ----------
  function isoToBr(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  function dataHoraBr(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function uuidV4() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
      h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  var BM = { pub: '', csv: '', carregado: false, carregando: false };

  async function carregarBookmarklets() {
    if (BM.carregado || BM.carregando) return;
    BM.carregando = true;
    var st = $('bm-status');
    if (st) st.textContent = 'Carregando conector…';
    try {
      var base = 'automacao/list-primeira-versao/';
      var rs = await Promise.all([
        fetch(base + 'conector.txt', { cache: 'no-cache' }),
        fetch(base + 'bookmarklet.txt', { cache: 'no-cache' }),
      ]);
      if (!rs[0].ok || !rs[1].ok) {
        throw new Error('HTTP ' + rs[0].status + '/' + rs[1].status);
      }
      var pub = (await rs[0].text()).trim();
      var csv = (await rs[1].text()).trim();
      if (pub.indexOf('javascript:') !== 0 || csv.indexOf('javascript:') !== 0) {
        throw new Error('conteúdo do bookmarklet inválido');
      }
      BM.pub = pub;
      BM.csv = csv;
      BM.carregado = true;
      aplicarBookmarklets();
      if (st) st.textContent = 'Pronto. Arraste os botões para a barra de favoritos.';
    } catch (e) {
      if (st) {
        st.textContent = 'Não consegui carregar os conectores (' +
          ((e && e.message) || e) + '). Confira se a pasta automacao foi publicada.';
      }
    } finally {
      BM.carregando = false;
    }
  }

  function aplicarBookmarklets() {
    [['bm-pub', BM.pub], ['bm-csv', BM.csv]].forEach(function (par) {
      var a = $(par[0]);
      if (!a || !par[1]) return;
      a.setAttribute('href', par[1]);
      a.setAttribute('draggable', 'true');
    });
  }

  function copiarTexto(txt, botao) {
    if (!txt) {
      alert('O conector ainda não terminou de carregar. Aguarde um instante.');
      return;
    }
    function ok() {
      if (!botao) return;
      var antigo = botao.getAttribute('data-rotulo') || botao.textContent;
      botao.setAttribute('data-rotulo', antigo);
      botao.textContent = 'Copiado!';
      setTimeout(function () { botao.textContent = antigo; }, 1500);
    }
    function falhou() { window.prompt('Copie o código do conector:', txt); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(ok, falhou);
    } else {
      falhou();
    }
  }

  function listFiltrada() {
    var f = state.list.filtro || {};
    var q = String(f.q || '').trim().toUpperCase();
    var reg = String(f.reg || '').trim().toUpperCase();
    var st = String(f.status || '').trim().toUpperCase();
    var pedidas = parseOSFiltro(f.os);
    var pedidasSet = {};
    pedidas.forEach(function (os) { pedidasSet[os] = 1; });
    var rows = (state.list.itens || []).filter(function (r) {
      if (pedidas.length && !pedidasSet[r.numos]) return false;
      if (f.semData && r.primeiraVersao) return false;
      if (q) {
        var alvo = (r.numos + ' ' + r.codserv + ' ' + r.descricao + ' ' + r.local + ' ' + r.regional).toUpperCase();
        if (alvo.indexOf(q) === -1) return false;
      }
      if (reg && String(r.regional || '').toUpperCase().indexOf(reg) === -1) return false;
      if (st && String(r.status || '').toUpperCase().indexOf(st) === -1) return false;
      if (f.dini && (!r.primeiraVersao || r.primeiraVersao < f.dini)) return false;
      if (f.dfim && (!r.primeiraVersao || r.primeiraVersao > f.dfim)) return false;
      return true;
    });
    var sort = f.sort || 'pv-asc';
    if (sort === 'os-lista' && pedidas.length) {
      var pos = {};
      pedidas.forEach(function (os, i) { pos[os] = i; });
      rows.sort(function (a, b) {
        var pa = pos.hasOwnProperty(a.numos) ? pos[a.numos] : 1e9;
        var pb = pos.hasOwnProperty(b.numos) ? pos[b.numos] : 1e9;
        if (pa !== pb) return pa - pb;
        return a.numos < b.numos ? -1 : a.numos > b.numos ? 1 : 0;
      });
      return rows;
    }
    rows.sort(function (a, b) {
      if (sort === 'os-asc') return a.numos < b.numos ? -1 : a.numos > b.numos ? 1 : 0;
      if (sort === 'os-desc') return a.numos > b.numos ? -1 : a.numos < b.numos ? 1 : 0;
      if (sort === 'mod-desc') return String(b.modificadoEm || '').localeCompare(String(a.modificadoEm || ''));
      var pa = a.primeiraVersao || '', pb = b.primeiraVersao || '';
      if (!pa && !pb) return 0;
      if (!pa) return 1;
      if (!pb) return -1;
      return sort === 'pv-desc' ? pb.localeCompare(pa) : pa.localeCompare(pb);
    });
    return rows;
  }

  function parseOSFiltro(v) {
    var out = [], seen = {};
    String(v || '').split(/[\s,;]+/).forEach(function (x) {
      var os = normOS(x);
      if (os && !seen[os]) { seen[os] = 1; out.push(os); }
    });
    return out;
  }

  function renderListStatus() {
    var n = (state.list.itens || []).length;
    var comData = (state.list.itens || []).filter(function (x) { return x.primeiraVersao; }).length;
    var badge = $('list-badge');
    if (badge) {
      badge.textContent = state.list.carregando ? 'carregando…' : (n ? 'Conectada' : 'Sem dados');
      badge.className = 'panel-step' + (n ? ' ok' : '');
    }
    var resumo = $('list-resumo');
    if (resumo) {
      resumo.textContent = n
        ? n + ' item(ns) · ' + comData + ' com data da 1ª versão · última atualização ' +
          (dataHoraBr(state.list.meta && state.list.meta.atualizadoEm) || '—')
        : 'Nenhum item conectado ainda. Gere o token e rode o conector na lista do SharePoint.';
    }
    var bl = $('btn-list-limpar');
    if (bl) bl.disabled = !n;
  }

  function renderList() {
    var wrap = $('l-tabela');
    if (!wrap) return;
    var rows = listFiltrada();
    var totalP = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (state.list.page > totalP) state.list.page = totalP;
    var slice = rows.slice((state.list.page - 1) * PAGE_SIZE, state.list.page * PAGE_SIZE);
    var html = '';
    if (!slice.length) {
      html = '<div class="no-results"><div class="big">' + SADICON('database', 38) + '</div>' +
        (state.list.itens.length ? 'Nenhum item para esses filtros.' :
          'Nenhum item conectado. Vá em <b>Gerar token</b> e rode o conector na lista do SharePoint.') + '</div>';
    } else {
      html = '<div class="table-wrap"><table><thead><tr>' +
        '<th>OS</th><th>1ª VERSÃO</th><th>ÚLT. MODIFICAÇÃO</th><th>CODSERV</th>' +
        '<th>DESCRIÇÃO</th><th>LOCAL</th><th>REGIONAL</th><th>SOLICITAÇÃO</th><th>STATUS</th>' +
        '</tr></thead><tbody>';
      slice.forEach(function (r) {
        html += '<tr>' +
          '<td><span class="os-id">' + esc(r.numos) + '</span></td>' +
          '<td class="mono">' + esc(r.primeiraVersao ? isoToBr(r.primeiraVersao) : '—') + '</td>' +
          '<td class="mono">' + esc(r.modificadoEm ? dataHoraBr(r.modificadoEm) : '—') + '</td>' +
          '<td class="mono">' + esc(r.codserv || '—') + '</td>' +
          '<td>' + esc(r.descricao || '—') + '</td>' +
          '<td>' + esc(r.local || '—') + '</td>' +
          '<td>' + esc(r.regional || '—') + '</td>' +
          '<td class="mono">' + esc(r.solicitacao || '—') + '</td>' +
          '<td>' + esc(r.status || '—') + '</td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
      html += '<div class="pagination"><button class="page-btn" data-lpg="prev">‹</button>' +
        '<span class="page-info">Pág ' + state.list.page + '/' + totalP + ' • ' + rows.length + ' itens</span>' +
        '<button class="page-btn" data-lpg="next">›</button></div>';
    }
    wrap.innerHTML = html;
    renderListStatus();
    renderListOSInfo(rows);
  }

  function renderListOSInfo(rows) {
    var el = $('l-os-info');
    if (!el) return;
    var pedidas = parseOSFiltro((state.list.filtro || {}).os);
    if (!pedidas.length) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    var base = {};
    (state.list.itens || []).forEach(function (r) { base[r.numos] = 1; });
    var encontradas = [], faltando = [];
    pedidas.forEach(function (os) { (base[os] ? encontradas : faltando).push(os); });
    var h = '<b>' + encontradas.length + ' de ' + pedidas.length + '</b> OS informadas encontradas na base';
    if (rows.length !== encontradas.length) {
      h += ' · <b>' + rows.length + '</b> exibida(s) pelos filtros atuais';
    }
    if (faltando.length) {
      h += ' · <span style="color:#e0a800">não encontrada(s): ' +
        esc(faltando.slice(0, 12).join(', ')) + (faltando.length > 12 ? '…' : '') + '</span>' +
        ' <button class="btn-small" id="l-copiar-faltando">Copiar não encontradas</button>';
    }
    el.innerHTML = h;
    el.style.display = '';
    var bk = $('l-copiar-faltando');
    if (bk) bk.addEventListener('click', function () {
      var txt = faltando.join('\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () {
          bk.textContent = 'Copiado!';
          setTimeout(function () { bk.textContent = 'Copiar não encontradas'; }, 1500);
        }, function () { window.prompt('OS não encontradas:', txt); });
      } else {
        window.prompt('OS não encontradas:', txt);
      }
    });
  }

  async function carregarListConexao(silencioso) {
    if (typeof isSupabaseMode !== 'function' || !isSupabaseMode()) {
      renderListStatus();
      return false;
    }
    state.list.carregando = true;
    renderListStatus();
    try {
      var out = [], from = 0, page = 1000;
      for (;;) {
        var res = await supa().from('list_itens').select('*')
          .order('numos', { ascending: true })
          .range(from, from + page - 1);
        if (res.error) throw res.error;
        var rows = res.data || [];
        out = out.concat(rows);
        if (rows.length < page) break;
        from += page;
      }
      state.list.itens = out.map(function (r) {
        return {
          numos: String(r.numos || ''),
          itemId: r.item_id || '',
          codserv: r.codserv == null ? '' : String(r.codserv),
          descricao: r.descricao || '',
          local: r.local || '',
          regional: r.regional || '',
          solicitacao: r.solicitacao || '',
          solicitacaoISO: r.solicitacao_iso || '',
          status: r.status_origem || '',
          telefone: r.telefone || '',
          primeiraVersao: r.data_primeira_versao || '',
          primeiraVersaoEm: r.primeira_versao_em || '',
          modificadoEm: r.modificado_em || '',
          atualizadoEm: r.atualizado_em || '',
        };
      });
      var maxAt = '';
      state.list.itens.forEach(function (r) {
        if (r.atualizadoEm && r.atualizadoEm > maxAt) maxAt = r.atualizadoEm;
      });
      state.list.meta = out.length ? { atualizadoEm: maxAt, total: out.length } : null;
      return true;
    } catch (e) {
      state.list.itens = [];
      state.list.meta = null;
      if (!silencioso) {
        alert('Não consegui ler a LIST conectada: ' + ((e && e.message) || e) +
          '\n\nConfira se rodou docs/CONEXAO_LIST.sql no Supabase.');
      }
      return false;
    } finally {
      state.list.carregando = false;
      renderListStatus();
      renderList();
    }
  }

  function renderTokenList() {
    var box = $('list-token-box');
    if (!box) return;
    if (!state.list.token) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = '';
    box.innerHTML =
      '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
      '<b>Token de conexão:</b>' +
      '<code style="user-select:all">' + esc(state.list.token.token) + '</code>' +
      '<button class="btn-small" id="list-copy-token">Copiar token</button>' +
      '<button class="btn-small" id="list-revoke-tokens">Revogar tokens</button>' +
      '</div>' +
      '<div style="margin-top:8px">Válido até <b>' + esc(dataHoraBr(state.list.token.expiraEm)) +
      '</b>. Abra a lista no SharePoint e clique no favorito <b>Conector LIST</b>; cole este token quando ele pedir.</div>';
    var cp = $('list-copy-token');
    if (cp) cp.addEventListener('click', function () {
      var t = state.list.token && state.list.token.token;
      if (!t) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function () {
          cp.textContent = 'Copiado!';
          setTimeout(function () { cp.textContent = 'Copiar token'; }, 1500);
        }, function () { window.prompt('Copie o token:', t); });
      } else {
        window.prompt('Copie o token:', t);
      }
    });
    var rv = $('list-revoke-tokens');
    if (rv) rv.addEventListener('click', function () {
      if (!confirm('Revogar todos os tokens de conexão? O conector precisará de um novo.')) return;
      supa().from('list_conexao_tokens').delete().not('token', 'is', null).then(function (r) {
        if (r && r.error) { alert('Falha ao revogar: ' + r.error.message); return; }
        state.list.token = null;
        renderTokenList();
        alert('Tokens revogados. Gere um novo quando precisar.');
      });
    });
  }

  async function gerarTokenList() {
    if (typeof isSupabaseMode !== 'function' || !isSupabaseMode()) {
      alert('Supabase não configurado.');
      return;
    }
    var token = uuidV4();
    var expira = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    try {
      // Limpa tokens vencidos (higiene; não afeta tokens válidos).
      try { await supa().from('list_conexao_tokens').delete().lt('expira_em', new Date().toISOString()); } catch (eT) {}
      var res = await supa().from('list_conexao_tokens')
        .insert({ token: token, expira_em: expira, criado_por: (state.user && state.user.id) || null })
        .select('token,expira_em')
        .single();
      if (res.error) throw res.error;
      state.list.token = { token: token, expiraEm: expira };
      renderTokenList();
    } catch (e) {
      alert('Não consegui gerar o token: ' + ((e && e.message) || e) +
        '\n\nRode docs/CONEXAO_LIST.sql no Supabase (tabela list_conexao_tokens).');
    }
  }

  function exportListCSV() {
    var rows = listFiltrada();
    if (!rows.length) { alert('Nada para exportar com os filtros atuais.'); return; }
    var cols = ['OS', 'PRIMEIRA VERSAO', 'ULTIMA MODIFICACAO', 'CODSERV', 'DESCRICAO', 'LOCAL', 'REGIONAL', 'SOLICITACAO', 'STATUS', 'TELEFONE'];
    function cell(v) {
      v = String(v == null ? '' : v);
      return (/[";\n\r]/.test(v)) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    var txt = '\uFEFF' + cols.join(';') + '\r\n' + rows.map(function (r) {
      return [
        r.numos, isoToBr(r.primeiraVersao), r.modificadoEm ? dataHoraBr(r.modificadoEm) : '',
        r.codserv, r.descricao, r.local, r.regional, r.solicitacao, r.status, r.telefone,
      ].map(cell).join(';');
    }).join('\r\n');
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    downloadBlob(new Blob([txt], { type: 'text/csv;charset=utf-8' }),
      'list_sharepoint_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.csv');
  }

  async function limparListBase() {
    if (!state.list.itens.length) return;
    if (!confirm('Apagar os ' + state.list.itens.length + ' itens da LIST salvos NO SISTEMA?\n\n' +
      'Isso NÃO altera a lista no SharePoint e NÃO mexe nas OS da caixa ou da quarentena.\n' +
      'A próxima execução do Conector LIST baixa tudo de novo.')) return;
    if (!(await pedirSenha('Limpar dados da LIST', 'Confirme sua senha para apagar os dados da LIST salvos no sistema. O SharePoint não é alterado.'))) return;
    supa().from('list_itens').delete().neq('numos', '').then(function (r) {
      if (r && r.error) { alert('Falha ao limpar: ' + r.error.message); return; }
      carregarListConexao(true);
    });
  }

  function applySearch() {
    state.search = ($('q') || {}).value || '';
    state.pagePrincipal = 1; state.pageQuar = 1;
    renderAll();
  }

  // ---------- eventos ----------
  function bindEvents() {
    // LIST conectada (SharePoint → Supabase)
    ['l-q', 'l-reg', 'l-status'].forEach(function (id) {
      var el = $(id);
      var chave = id === 'l-q' ? 'q' : (id === 'l-reg' ? 'reg' : 'status');
      if (el) el.addEventListener('input', function () {
        state.list.filtro[chave] = el.value;
        state.list.page = 1;
        renderList();
      });
    });
    var los = $('l-os');
    if (los) los.addEventListener('input', function () {
      var tinha = String(state.list.filtro.os || '').trim();
      state.list.filtro.os = los.value;
      // Ao colar uma lista pela primeira vez, mostra na ordem colada.
      if (!tinha && los.value.trim() && state.list.filtro.sort === 'pv-asc') {
        state.list.filtro.sort = 'os-lista';
        if (lsort) lsort.value = 'os-lista';
      } else if (!los.value.trim() && state.list.filtro.sort === 'os-lista') {
        state.list.filtro.sort = 'pv-asc';
        if (lsort) lsort.value = 'pv-asc';
      }
      state.list.page = 1;
      renderList();
    });
    var semPill = $('l-semdata-pill');
    if (semPill) semPill.addEventListener('click', function () {
      setTimeout(function () {
        var inp = semPill.querySelector('input');
        state.list.filtro.semData = !!(inp && inp.checked);
        state.list.page = 1;
        renderList();
      }, 0);
    });
    ['l-dini', 'l-dfim'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', function () {
        state.list.filtro[id === 'l-dini' ? 'dini' : 'dfim'] = el.value;
        state.list.page = 1;
        renderList();
      });
    });
    var lsort = $('l-sort');
    if (lsort) lsort.addEventListener('change', function () {
      state.list.filtro.sort = lsort.value;
      state.list.page = 1;
      renderList();
    });
    var llimpar = $('l-limparfiltros');
    if (llimpar) llimpar.addEventListener('click', function () {
      state.list.filtro = { q: '', os: '', reg: '', status: '', dini: '', dfim: '', semData: false, sort: 'pv-asc' };
      state.list.page = 1;
      ['l-q', 'l-os', 'l-reg', 'l-status', 'l-dini', 'l-dfim'].forEach(function (id) {
        var el = $(id); if (el) el.value = '';
      });
      if (lsort) lsort.value = 'pv-asc';
      var semInp = $('l-semdata');
      if (semInp) semInp.checked = false;
      var semPill2 = $('l-semdata-pill');
      if (semPill2) semPill2.classList.remove('on');
      renderList();
    });
    var ltok = $('btn-list-token');
    if (ltok) ltok.addEventListener('click', gerarTokenList);
    var lref = $('btn-list-refresh');
    if (lref) lref.addEventListener('click', function () {
      lref.disabled = true;
      carregarListConexao(false).then(function () { lref.disabled = false; });
    });
    var ltoggle = $('btn-list-install-toggle');
    if (ltoggle) ltoggle.addEventListener('click', function () {
      var box = $('list-install');
      if (!box) return;
      var abrir = box.style.display === 'none' || !box.style.display;
      box.style.display = abrir ? 'block' : 'none';
      ltoggle.setAttribute('aria-expanded', abrir ? 'true' : 'false');
      var rotulo = $('btn-list-install-label');
      if (rotulo) rotulo.textContent = abrir ? 'Ocultar instalação' : 'Instalar conector';
      if (abrir) carregarBookmarklets();
    });
    var llim = $('btn-list-limpar');
    if (llim) llim.addEventListener('click', limparListBase);
    var lexp = $('l-export');
    if (lexp) lexp.addEventListener('click', exportListCSV);

    // Bookmarklets de instalação (na própria tela LIST)
    ['bm-pub', 'bm-csv'].forEach(function (id) {
      var a = $(id);
      if (a) a.addEventListener('click', function (e) {
        e.preventDefault();
        alert('Arraste este botão para a barra de favoritos.\nDepois abra a lista no SharePoint e clique no favorito.');
      });
    });
    var bcp = $('bm-copy-pub');
    if (bcp) bcp.addEventListener('click', function () { copiarTexto(BM.pub, bcp); });
    var bcc = $('bm-copy-csv');
    if (bcc) bcc.addEventListener('click', function () { copiarTexto(BM.csv, bcc); });

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
        var mp = c.getAttribute('data-mp');
        if (mp === 'custom') {
          var cur = mRange(); // período atual antes de trocar para personalizado
          state.metrics.dini = cur.ini;
          state.metrics.dfim = cur.fim;
        }
        state.metrics.preset = mp;
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
    // filtros múltiplos de métricas (dropdown com checkboxes)
    mselInit('m-user', { search: true, placeholder: 'Todos', onChange: renderMetricas });
    mselInit('m-status', { search: false, placeholder: 'Todos', onChange: renderMetricas });
    mselInit('m-reg', { search: false, placeholder: 'Todas', selNoun: 'selecionadas', onChange: renderMetricas });
    mselInit('m-serv', { search: true, placeholder: 'Todos', onChange: renderMetricas });
    mselSetOptions('m-status', M_STATUS.map(function (s) { return { value: s.key, label: s.label }; }), 'Todos');
    mselSetOptions('m-reg', [
      { value: '1', label: '1 · Leste' },
      { value: '2', label: '2 · Centro' },
      { value: '3', label: '3 · Oeste' }
    ], 'Todas');
    document.addEventListener('click', function () { mselCloseAll(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') mselCloseAll();
    });
    var mreset = $('m-reset');
    if (mreset) mreset.addEventListener('click', function () {
      state.metrics.preset = 'hoje';
      state.metrics.dini = '';
      state.metrics.dfim = '';
      state.metrics.user = [];
      state.metrics.status = [];
      state.metrics.reg = [];
      state.metrics.serv = [];
      mselSetSelected('m-user', []);
      mselSetSelected('m-status', []);
      mselSetSelected('m-reg', []);
      mselSetSelected('m-serv', []);
      ['m-dini', 'm-dfim'].forEach(function (id) {
        var el = $(id);
        if (el) el.value = '';
      });
      document.querySelectorAll('.chip[data-mp]').forEach(function (x) {
        x.classList.toggle('active', x.getAttribute('data-mp') === 'hoje');
      });
      renderMetricas();
    });
    var mex = $('m-export');
    if (mex) mex.addEventListener('click', exportMetricasCSV);
    // período do resumo do usuário
    document.querySelectorAll('#r-presets [data-rp]').forEach(function (c) {
      c.addEventListener('click', function () {
        state.resumo.preset = c.getAttribute('data-rp');
        renderResumoUser(loadDB());
      });
    });
    ['r-dini', 'r-dfim'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        state.resumo.dini = ($('r-dini') || {}).value || '';
        state.resumo.dfim = ($('r-dfim') || {}).value || '';
        state.resumo.preset = 'custom';
        renderResumoUser(loadDB());
      });
    });
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
    var muo = $('modal-user-ok');
    if (muo) muo.addEventListener('click', closeUserOS);
    var muov = $('modal-user');
    if (muov) muov.addEventListener('click', function (e) { if (e.target === muov) closeUserOS(); });
    var ocOk = $('oc-ok');
    if (ocOk) ocOk.addEventListener('click', function () { closeOcorrenciaModal(false); });
    var ocCancel = $('oc-cancel');
    if (ocCancel) ocCancel.addEventListener('click', function () { closeOcorrenciaModal(true); });
    var ocOv = $('modal-ocorrencia');
    if (ocOv) ocOv.addEventListener('click', function (e) { if (e.target === ocOv) closeOcorrenciaModal(true); });
    // busca da tela Encerrados
    var qe = $('q-enc');
    if (qe) {
      qe.addEventListener('input', function () { state.encSearch = qe.value || ''; state.pageEnc = 1; renderEncerrados(); });
      qe.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.encSearch = qe.value || ''; state.pageEnc = 1; renderEncerrados(); } });
    }
    var qo = $('q-oco');
    if (qo) {
      qo.addEventListener('input', function () { state.ocoSearch = qo.value || ''; state.pageOco = 1; renderOcorrencias(); });
      qo.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.ocoSearch = qo.value || ''; state.pageOco = 1; renderOcorrencias(); } });
    }
    var qd = $('q-desp');
    if (qd) {
      qd.addEventListener('input', function () { state.despSearch = qd.value || ''; state.pageDesp = 1; renderDespachados(); });
      qd.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.despSearch = qd.value || ''; state.pageDesp = 1; renderDespachados(); } });
    }
    // filtros por campo da tela Despachados
    ['d-numos', 'd-codserv', 'd-cliente', 'd-cidade', 'd-reg', 'd-origem', 'd-resp', 'd-desppor', 'd-dini', 'd-dfim', 'd-despcini', 'd-despfim', 'd-sort'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      var apply = function () {
        if (id === 'd-sort') state.desp.sort = el.value || 'desp-desc';
        state.desp = readDespFilters();
        state.pageDesp = 1;
        renderDespachados();
      };
      el.addEventListener('input', apply);
      el.addEventListener('change', apply);
    });
    var despToggle = $('btn-desp-f-toggle');
    if (despToggle) despToggle.addEventListener('click', function () {
      var open = true;
      try { open = localStorage.getItem('sad-desp-f-open') !== '0'; } catch (e) {}
      try { localStorage.setItem('sad-desp-f-open', open ? '0' : '1'); } catch (e) {}
      syncDespToggle();
    });
    var despClear = $('btn-desp-f-clear');
    if (despClear) despClear.addEventListener('click', function () {
      state.desp = { numos: '', codserv: '', cliente: '', cidade: '', reg: '', origem: '', resp: '', despPor: '', dini: '', dfim: '', despIni: '', despFim: '', sort: 'desp-desc' };
      state.despSearch = '';
      if (qd) qd.value = '';
      state.pageDesp = 1;
      syncDespFilterInputs();
      renderDespachados();
    });
    var despCsv = $('btn-desp-exp-csv');
    if (despCsv) despCsv.addEventListener('click', exportDespachadosCSV);
    var despXlsx = $('btn-desp-exp-xlsx');
    if (despXlsx) despXlsx.addEventListener('click', exportDespachadosXLSX);
    var despExport = $('btn-desp-export');
    if (despExport) despExport.addEventListener('click', exportDespachadosXLSX);
    var despExportTop = $('btn-desp-export-top');
    if (despExportTop) despExportTop.addEventListener('click', exportDespachadosXLSX);
    // ordenação por clique no cabeçalho da tabela de Despachados
    document.addEventListener('click', function (e) {
      var th = e.target.closest ? e.target.closest('th[data-dsort]') : null;
      if (!th) return;
      var col = th.getAttribute('data-dsort');
      var cur = state.desp.sort || 'desp-desc';
      var asc = cur === col + '-asc';
      state.desp.sort = col + (asc ? '-desc' : '-asc');
      state.pageDesp = 1;
      if ($('d-sort')) $('d-sort').value = state.desp.sort;
      renderDespachados();
    });
    var linkDesp = $('link-despachados');
    if (linkDesp) linkDesp.addEventListener('click', function (e) { e.preventDefault(); showView('despachados'); });

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
      renderAll(ar.added + ' OS aprovada(s) → caixa principal.' + (ar.skipped ? ' (' + ar.skipped + ' conflito(s) ignorados — revise um a um na aba Conflitos.)' : ''));
    });
    var bqd = $('btn-q-apagar');
    if (bqd) bqd.addEventListener('click', async function () {
      if (!state.isAdmin) { alert('Somente admin.'); return; }
      var qf = quarFilteredKeys();
      if (!qf.list.length) { alert('Nada nos filtros atuais.'); return; }
      if (!confirm('Apagar ' + qf.list.length + ' item(ns) FILTRADO(S) da quarentena? (Arquiva como reprovada p/ não voltar na próxima importação. A caixa NÃO é tocada.)')) return;
      if (!(await pedirSenha('Apagar quarentena', 'Confirme sua senha para apagar ' + qf.list.length + ' item(ns) filtrado(s) da quarentena.'))) return;
      var n = removeQuarList(qf.list, true);
      renderAll(n + ' item(ns) apagado(s) da quarentena.');
    });
    var bql = $('btn-q-limpar');
    if (bql) bql.addEventListener('click', async function () {
      if (!state.isAdmin) { alert('Somente admin.'); return; }
      var db0 = loadDB();
      if (!db0.quarentena.length) { alert('Quarentena já está vazia.'); return; }
      if (!confirm('Apagar TUDO da quarentena (' + db0.quarentena.length + ' itens)? Arquiva como reprovadas p/ não voltarem. A caixa principal NÃO é tocada.')) return;
      if (!confirm('Confirma mesmo? Essa ação esvazia a quarentena.')) return;
      if (!(await pedirSenha('Esvaziar quarentena', 'Confirme sua senha para apagar TODA a quarentena (' + db0.quarentena.length + ' itens).'))) return;
      var n = removeQuarList(db0.quarentena, true);
      renderAll('Quarentena esvaziada: ' + n + ' item(ns) apagado(s).');
    });
    // gestão de usuários (admin, local; Supabase vira definitivo)
    var bua = $('btn-user-add');
    if (bua) bua.addEventListener('click', async function () {
      if (!state.isAdmin || typeof createUser !== 'function') { alert('Somente admin.'); return; }
      var em = (($('new-user-email') || {}).value || '').trim();
      var pw = (($('new-user-pass') || {}).value || '');
      var rl = (($('new-user-role') || {}).value || 'usuario');
      bua.disabled = true;
      try {
        var r = await createUser(em, pw, rl);
        if (r.error) { alert(r.error); return; }
        if ($('new-user-email')) $('new-user-email').value = '';
        if ($('new-user-pass')) $('new-user-pass').value = '';
        var extra = (r.data && r.data.needsConfirm)
          ? ' O usuário precisa confirmar o e-mail (ou desative "Confirm email" no Supabase) para entrar.'
          : '';
        renderAll('Usuário ' + em + ' criado como ' + rl + '.' + extra);
      } finally {
        bua.disabled = false;
      }
    });

    document.addEventListener('click', function (e) {
      var pg = e.target.getAttribute && e.target.getAttribute('data-pg');
      if (pg === 'p-prev' && state.pagePrincipal > 1) { state.pagePrincipal--; renderAll(); }
      if (pg === 'p-next') { state.pagePrincipal++; renderAll(); }
      if (pg === 'q-prev' && state.pageQuar > 1) { state.pageQuar--; renderAll(); }
      if (pg === 'q-next') { state.pageQuar++; renderAll(); }
      if (pg === 'e-prev' && state.pageEnc > 1) { state.pageEnc--; renderEncerrados(); }
      if (pg === 'e-next') { state.pageEnc++; renderEncerrados(); }
      if (pg === 'd-prev' && state.pageDesp > 1) { state.pageDesp--; renderDespachados(); }
      if (pg === 'd-next') { state.pageDesp++; renderDespachados(); }
      if (pg === 'o-prev' && state.pageOco > 1) { state.pageOco--; renderOcorrencias(); }
      if (pg === 'o-next') { state.pageOco++; renderOcorrencias(); }
      var lpg = e.target.getAttribute && e.target.getAttribute('data-lpg');
      if (lpg === 'prev' && state.list.page > 1) { state.list.page--; renderList(); }
      if (lpg === 'next') { state.list.page++; renderList(); }

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
          p.despachadoEm = null; p.despachadoPor = null;
          saveDB(db); renderAll('Salvando OS ' + os + '…');
          refreshIfShared('OS ' + os + ' na sua caixa.');
        }
      }
      if (act === 'liberar') {
        var p2 = db.principal.find(function (x) { return x.numos === os; });
        if (p2) {
          if (!state.isAdmin && p2.responsavel && !isMine(p2)) { alert('Essa OS já está com outro usuário.'); return; }
          var who = p2.responsavel || ((state.user && state.user.email) || '');
          p2.responsavel = null; p2.statusDemanda = 'A INICIAR';
          p2.encerradoEm = null; p2.encerradoPor = null; p2.motivoOcorrencia = '';
          p2.despachadoEm = null; p2.despachadoPor = null;
          saveDB(db);
          var refill2 = '';
          if (who) {
            try {
              var rl = autoDistribute(db, [who]);
              if (rl.n > 0 && saveDB(db)) refill2 = ' +' + rl.n + ' nova(s) na sua caixa.';
            } catch (e7) {}
          }
          renderAll('OS ' + os + ' devolvida aos disponíveis.' + refill2);
          refreshIfShared('OS ' + os + ' devolvida aos disponíveis.' + refill2);
        }
      }
      if (act === 'ver-os') { openUserOS(btn.getAttribute('data-email') || ''); return; }
      if (act === 'resolver-ocorrencia') {
        var po = db.principal.find(function (x) { return x.numos === os; });
        if (!po) return;
        if (!state.isAdmin && !isMine(po)) { alert('Essa OS está com outro usuário.'); return; }
        if (!confirm('Ocorrência resolvida? A OS volta para a caixa e sai de Ocorrências.')) return;
        po.statusDemanda = 'EM ANDAMENTO';
        po.motivoOcorrencia = '';
        po.encerradoEm = null; po.encerradoPor = null;
        po.despachadoEm = null; po.despachadoPor = null;
        if (!po.responsavel) po.responsavel = (state.user && state.user.email) || po.responsavel;
        saveDB(db);
        renderAll('OS ' + os + ' — ocorrência resolvida, de volta à caixa.');
        refreshIfShared('OS ' + os + ' — ocorrência resolvida, de volta à caixa.');
        return;
      }
      if (act === 'reabrir') {
        var pr = db.principal.find(function (x) { return x.numos === os; });
        if (pr && pr.statusDemanda === 'DESPACHADO') {
          if (!state.isAdmin && pr.responsavel && !isMine(pr)) { alert('Essa OS está com outro usuário.'); return; }
          pr.statusDemanda = pr.responsavel ? 'EM ANDAMENTO' : 'A INICIAR';
          pr.despachadoEm = null; pr.despachadoPor = null;
          pr.encerradoEm = null; pr.encerradoPor = null; pr.motivoOcorrencia = '';
          saveDB(db);
          renderAll('OS ' + os + ' reaberta → ' + pr.statusDemanda + '.');
          refreshIfShared('OS ' + os + ' reaberta → ' + pr.statusDemanda + '.');
        }
        return;
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
          if (!saveDB(db)) { alert('NÃO SALVOU: banco indisponível (Supabase).'); return; }
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
      if (act === 'user-role') {
        if (!state.isAdmin || typeof setUserRole !== 'function') { alert('Somente admin.'); return; }
        var em2 = btn.getAttribute('data-email') || '';
        var curRole = btn.getAttribute('data-role') || 'usuario';
        var nr = curRole === 'admin' ? 'usuario' : 'admin';
        btn.disabled = true;
        setUserRole(em2, nr).then(function (rr) {
          btn.disabled = false;
          if (rr && rr.error) { alert(rr.error); return; }
          renderAll(em2 + ' agora é ' + nr + '.');
        });
      }
    });

    document.addEventListener('change', function (e) {
      var s = e.target.closest ? e.target.closest('select[data-act="status"]') : null;
      if (!s) return;
      var os = s.getAttribute('data-os');
      var db = loadDB();
      var p = db.principal.find(function (x) { return x.numos === os; });
      if (!p || STATUS_LIST.indexOf(s.value) === -1) return;
      if (!state.isAdmin && p.responsavel && !isMine(p)) { alert('Essa OS está com outro usuário.'); renderAll(); return; }
      var novo = s.value;
      function aplicar(motivo) {
        // Mudar o status de uma OS disponível implica assumi-la (senão ela
        // sairia da caixa sem dono — foi o que deixava o responsável como "—"
        // em Encerrados/Ocorrências). "A INICIAR" é o estado do pool, mantém sem dono.
        if (!state.isAdmin && !p.responsavel && novo !== 'A INICIAR') {
          p.responsavel = (state.user && state.user.email) || 'eu';
        }
        p.statusDemanda = novo;
        p.motivoOcorrencia = (novo === 'OCORRENCIA') ? (motivo || '') : '';
        var credit = '';
        if (novo === 'ENCERRADO') {
          p.encerradoEm = new Date().toISOString();
          p.encerradoPor = p.responsavel || ((state.user && state.user.email) || '');
          p.despachadoEm = null; p.despachadoPor = null;
          credit = p.encerradoPor;
        } else if (novo === 'DESPACHADO') {
          p.despachadoEm = new Date().toISOString();
          p.despachadoPor = p.responsavel || ((state.user && state.user.email) || '');
          p.encerradoEm = null; p.encerradoPor = null;
          credit = p.despachadoPor;
        } else {
          p.encerradoEm = null; p.encerradoPor = null;
          p.despachadoEm = null; p.despachadoPor = null;
        }
        saveDB(db);
        var refill = '';
        if (credit) {
          try {
            var rd = autoDistribute(db, [credit]);
            if (rd.n > 0 && saveDB(db)) refill = ' +' + rd.n + ' nova(s) na sua caixa.';
          } catch (e6) {}
        }
        var destino = novo === 'DESPACHADO' ? ' (foi para Despachados)' : '';
        var msg = 'OS ' + os + ' → ' + (novo === 'OCORRENCIA' ? 'OCORRÊNCIA' : novo) + '.' + destino + refill;
        renderAll(msg);
        refreshIfShared(msg);
      }
      if (novo === 'OCORRENCIA') {
        openOcorrenciaModal(os, p.motivoOcorrencia || '', aplicar, function () { renderAll(); });
        return;
      }
      aplicar();
    });

    // Delegado porque as opções de Auto individual são criadas ao abrir a tela.
    document.addEventListener('click', function (e) {
      var pill = e.target.closest ? e.target.closest('.check-pill') : null;
      if (!pill) return;
      if (e && e.preventDefault) e.preventDefault();
      var inp = pill.querySelector('input');
      if (!inp) return;
      inp.checked = !inp.checked;
      pill.classList.toggle('on', inp.checked);
      if (inp.getAttribute('data-dist-auto') !== null) {
        if (!state.isAdmin) return;
        var emailAuto = String(inp.getAttribute('data-dist-auto') || '').toLowerCase();
        var cfgAuto = loadCfg();
        cfgAuto.distrib = cfgAuto.distrib || { enabled: false, qty: 10, per: {}, autoOff: {} };
        cfgAuto.distrib.autoOff = cfgAuto.distrib.autoOff || {};
        if (inp.checked) delete cfgAuto.distrib.autoOff[emailAuto];
        else cfgAuto.distrib.autoOff[emailAuto] = true;
        saveCfg(cfgAuto);
        renderDistribuicao();
      }
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
      if (!saveDB(db)) { alert('NÃO SALVOU: banco indisponível (Supabase).'); return; }
      var dl = $('dist-log');
      if (dl) dl.textContent = new Date().toLocaleString('pt-BR') + ' — manual: ' + distSummary(r) + '.';
      renderAll('Distribuídas ' + r.n + ' OS: ' + distSummary(r) + '.');
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
    var bui = $('btn-undo-import');
    if (bui) bui.addEventListener('click', undoLastImport);
    var bc = $('btn-clear');
    if (bc) bc.addEventListener('click', openClearModal);

    // Modal limpar banco (tudo ou filtrado por serviço)
    var ccancel = $('clr-cancel');
    if (ccancel) ccancel.addEventListener('click', closeClearModal);
    var cok = $('clr-ok');
    if (cok) cok.addEventListener('click', confirmClear);
    var cmf = $('clr-mode-filter');
    if (cmf) cmf.addEventListener('click', function () { setClearMode('filter'); });
    var cma = $('clr-mode-all');
    if (cma) cma.addEventListener('click', function () { setClearMode('all'); });
    var csel = $('clr-selall');
    if (csel) csel.addEventListener('click', function () {
      if (!_clearCtx) return;
      _clearCtx.cods.forEach(function (c) { _clearCtx.sel[c] = true; });
      renderClearCodList();
      renderClearPreview();
    });
    var cnone = $('clr-selnone');
    if (cnone) cnone.addEventListener('click', function () {
      if (!_clearCtx) return;
      _clearCtx.cods.forEach(function (c) { _clearCtx.sel[c] = false; });
      renderClearCodList();
      renderClearPreview();
    });
    var csearch = $('clr-search');
    if (csearch) csearch.addEventListener('input', renderClearCodList);
    var ccods = $('clr-cods');
    if (ccods) ccods.addEventListener('change', function (e) {
      if (!_clearCtx) return;
      var cb = e.target;
      if (!cb || cb.getAttribute('data-cod') === null) return;
      _clearCtx.sel[cb.getAttribute('data-cod')] = !!cb.checked;
      renderClearPreview();
    });
    var mc = $('modal-clear');
    if (mc) mc.addEventListener('click', function (e) { if (e.target === mc) closeClearModal(); });
    var cpw = $('clr-senha');
    if (cpw) cpw.addEventListener('keydown', function (e) { if (e.key === 'Enter') confirmClear(); });

    // Modal de senha (confirmação de exclusões)
    var scancel = $('senha-cancel');
    if (scancel) scancel.addEventListener('click', function () { fecharSenha(false); });
    var sok = $('senha-ok');
    if (sok) sok.addEventListener('click', confirmarSenhaModal);
    var sinp = $('senha-input');
    if (sinp) sinp.addEventListener('keydown', function (e) { if (e.key === 'Enter') confirmarSenhaModal(); });
    var sov = $('modal-senha');
    if (sov) sov.addEventListener('click', function (e) { if (e.target === sov) fecharSenha(false); });
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
    state.listClean.forEach(function (l) { if (l.codserv) set[l.codserv] = 1; });
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
    cmp.filteredSiate = u.siate.length;
    cmp.filteredList = u.list.length;
    state.result = cmp;
    var f = u.f;
    var lines = [];
    lines.push('FILTROS APLICADOS A CADA PLANILHA; comparação pela união dos NUMOS elegíveis:');
    lines.push('- SIATE que passou nos filtros: ' + u.eligibleSiate.length + ' de ' + state.siateClean.length +
      ' (' + u.excludedSiate + ' excluídas) | LIST: ' + u.eligibleList.length + ' de ' + state.listClean.length +
      ' (' + u.excludedList + ' excluídas)');
    if (u.pairedSiate || u.pairedList) {
      lines.push('- Pares incluídos para detectar divergência: ' + u.pairedSiate + ' registro(s) SIATE + ' + u.pairedList +
        ' LIST que não passaram individualmente, mas têm NUMOS presente na outra base elegível.');
    }
    lines.push('- Universo comparado: ' + u.siate.length + ' NUMOS na SIATE | ' + u.list.length + ' na LIST. OS sem correspondência que não passaram em nenhum lado ficam totalmente fora.');
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
      var selectedNums = {};
      u.siate.forEach(function (s) { selectedNums[s.numos] = 1; });
      u.list.forEach(function (l) { selectedNums[l.numos] = 1; });
      var fS = {}, fL = {};
      u.eligibleSiate.forEach(function (s) { fS[s.numos] = 1; });
      u.eligibleList.forEach(function (l) { fL[l.numos] = 1; });
      var full = compare(state.siateClean, state.listClean);
      var fullSp = splitConflicts(full.cong, state.listClean);
      // OS pareadas nas bases completas que não passaram em nenhum lado: não
      // entram nem na comparação filtrada nem na quarentena.
      victims = full.cong.filter(function (s) { return !selectedNums[s.numos]; });
      fullSp.confl.forEach(function (c) { if (!selectedNums[c.s.numos]) victims.push(c.s); });
      state.result.victims = victims;
      state.result.fullCong = full.cong.length + fullSp.confl.length;
      state.result.fullConfl = fullSp.confl.length;
      state.result.fullSoSiate = full.soSiate.length;
      state.result.fullSoList = full.soList.length;
    } catch (e2) { victims = []; }
    if (victims.length) {
      lines.push('FORA DO UNIVERSO FILTRADO (' + victims.length + ' OS): existem nas duas bases, mas nenhum dos lados passou todos os filtros. Não serão comparadas, enviadas à quarentena nem gravadas:');
      victims.slice(0, 20).forEach(function (s) {
        lines.push('  • OS ' + s.numos + ' (' + (fS[s.numos] ? 'SIATE ok' : 'SIATE cortada') + ' | ' + (fL[s.numos] ? 'LIST ok' : 'LIST cortada') + ')');
      });
      if (victims.length > 20) lines.push('  … e mais ' + (victims.length - 20) + ' (alargue o filtro para ver todas).');
    } else {
      lines.push('OK: não há OS pareadas fora do universo filtrado.');
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
      if (warnSame) lines.push('ATENÇÃO — QUARENTENA ZERADA SUSPEITA: ' + warnSame + '.');
    } catch (e3) {}
    lines.push('Filtros: regional=' + (f.regs.join(',') || 'todas') + ' | codserv=' + (f.codserv || 'todos') + ' | cidade=' + (f.cidade || 'todas') + ' | período=' + (f.dIni || '…') + '→' + (f.dFim || '…'));
    $('log').textContent = lines.join('\n');
    $('alert').style.display = '';
    if (victims.length || warnSame) {
      $('alert').innerHTML = (warnSame ? '<b>Quarentena zerada suspeita:</b> ' + esc(warnSame) + '.<br>' : '') +
        (victims.length ? '<b>' + victims.length + '</b> OS estão nas duas bases, mas não passaram nos filtros em nenhum lado; foram excluídas e não irão para a quarentena nem para o banco.<br>' : '') +
        '<b>' + cmp.cong.length + '</b> congruentes p/ caixa &nbsp;•&nbsp; <b>' + (cmp.soSiate.length + cmp.soList.length) + '</b> divergentes p/ quarentena. Confira e clique em <b>“Jogar no banco”</b>.';
      $('alert').className = 'alert-box';
    } else {
      $('alert').innerHTML = '<b>' + cmp.cong.length + '</b> congruentes p/ caixa principal &nbsp;•&nbsp; <b>' + (cmp.soSiate.length + cmp.soList.length) + '</b> divergentes p/ quarentena (tudo do universo filtrado). Filtro limpo, sem vítimas. <br>Confira e clique em <b>“Jogar no banco”</b>.';
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
    if (title) title.textContent = confl.length ? 'Incongruências entre as bases' : 'Comparação pronta';
    var h = '<b>' + cmp.cong.length + '</b> congruentes → caixa &nbsp;•&nbsp; <b>' + div + '</b> divergentes → quarentena';
    if (confl.length) h += ' &nbsp;•&nbsp; <b>' + confl.length + '</b> conflitos';
    h += '<br><br>Uma OS entra no universo quando pelo menos uma das bases passa em todos os filtros. O registro com o mesmo NUM OS na outra base também é comparado, mesmo que tenha serviço/data diferente, para revelar divergências.<br><br>';
    if (confl.length) {
      h += 'OS nas <b>duas bases</b> mas com <b>serviço diferente</b> — revise antes de ir para a caixa:<br>';
      confl.slice(0, 8).forEach(function (c) {
        h += '<div class="modal-row"><span class="os-id">' + esc(c.s.numos) + '</span> &nbsp;SIATE <b>' + esc(c.s.codserv || '—') + '</b> × LIST <b>' + esc(c.l.codserv || '—') + '</b></div>';
      });
      if (confl.length > 8) h += '<div class="modal-row">… e mais ' + (confl.length - 8) + '</div>';
      h += '<br>Vão para a aba <b>Conflitos</b> da quarentena (libera SIATE ou LIST, ou reprova). As que só existem em uma base vão para <b>Só SIATE / Só LIST</b>.<br>';
    } else {
      h += 'Nenhum conflito de serviço neste universo filtrado. Quando uma OS passa no filtro em uma base, o registro correspondente da outra base também é incluído para detectar diferenças de serviço.<br>';
    }
    if (victims && victims.length) h += '<br><b>' + victims.length + '</b> OS estão nas duas bases, mas nenhum lado passou nos filtros; foram excluídas e não irão para a quarentena nem para o banco.<br>';
    if (warnSame) h += '<br><b>Quarentena zerada suspeita:</b> ' + esc(warnSame) + '.<br>';
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
    // Carrega o banco compartilhado (Supabase). Somente nuvem.
    var dbMode = 'unconfigured';
    try { if (window.SADDB) dbMode = await SADDB.init(); } catch (e0) {}
    state.dbMode = dbMode;
    try {
      if (window.SADDB && SADDB.onError) {
        SADDB.onError(function (m) { alert('Falha ao gravar no banco (Supabase): ' + m + '\nA alteração pode não ter sido salva.'); });
      }
    } catch (eE) {}
    if (dbMode !== 'supabase') {
      var motivo = dbMode === 'unconfigured'
        ? 'Supabase não configurado (js/config.js).'
        : 'Não foi possível carregar o banco no Supabase (conexão, policies ou config).';
      alert(motivo + ' O sistema funciona somente com a nuvem — nada será gravado localmente.');
    }
    try {
      var tb = document.querySelector('.topbar-right');
      if (tb) {
        var modeBadge = document.createElement('span');
        modeBadge.className = 'badge ' + (dbMode === 'supabase' ? 'badge-green' : (dbMode === 'error' ? 'badge-red' : 'badge-yellow'));
        modeBadge.innerHTML = dbMode === 'supabase'
          ? SADICON('cloud', 13) + ' Compartilhado'
          : (dbMode === 'error' ? SADICON('alert', 13) + ' Sem banco' : SADICON('settings', 13) + ' Não configurado');
        modeBadge.title = dbMode === 'supabase'
          ? 'Banco no Supabase: todos os usuários veem a mesma caixa.'
          : 'Sem banco disponível. Configure/conserte o Supabase (js/config.js).';
        tb.insertBefore(modeBadge, tb.firstChild);
      }
    } catch (eM) {}
    var role = sess.role || (state.isAdmin ? 'admin' : 'usuario');
    $('me').textContent = sess.email;
    if ($('role')) $('role').textContent = role;
    if ($('avatar')) $('avatar').textContent = String(sess.email || '?').charAt(0).toUpperCase();
    if (!state.isAdmin) {
      // Quarentena, acompanhar e importar: só admin
      document.querySelectorAll('.admin-only').forEach(function (el) { el.style.display = 'none'; });
      var up = $('panel-upload');
      if (up) up.style.display = 'none';
    }
    window.SADshow = function (v) { showView(v); };
    bindEvents();
    syncCaixaFilterInputs();
    if (state.isAdmin) {
      try { carregarListConexao(true); } catch (eL) {}
    }
    var welcome = '';
    if (!state.isAdmin && state.user && state.user.email) {
      try {
        var db0 = loadDB();
        var rd0 = autoDistribute(db0, [state.user.email]);
        if (rd0.n > 0 && saveDB(db0)) welcome = 'Você recebeu ' + rd0.n + ' OS na sua caixa.';
      } catch (e8) {}
    }
    renderAll(welcome || undefined);
    $('log').textContent = 'Pronto. ' + (state.isAdmin ? 'Suba as duas bases para comparar.' : 'Aguardando importação do admin.');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
