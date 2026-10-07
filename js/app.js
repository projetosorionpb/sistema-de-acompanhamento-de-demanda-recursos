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
    tab: 'principal', search: '', statusFilter: 'TODOS',
    pagePrincipal: 1, pageQuar: 1,
    isAdmin: false, user: null,
    codservOptions: [],
  };

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
  function compactQ(dados, origem) {
    var d = dados || {};
    if (origem === 'SO_SIATE') {
      return {
        n: d.numos || '', c: d.codserv || '', d: d.dataISO || '',
        r: d.codreg || '', cid: String(d.cidade || '').slice(0, 40),
        cli: String(d.cliente || '').slice(0, 50), t: d.tel1 || '',
      };
    }
    return {
      n: d.numos || '', c: d.codserv || '', desc: String(d.descricao || '').slice(0, 60),
      loc: String(d.local || '').slice(0, 40), t: d.telefone || '',
    };
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

  // ---------- jogar no banco (universo já filtrado nas 2 bases) ----------
  function pushToDB() {
    if (!state.siateClean.length || !state.listClean.length) { alert('Suba as duas bases e compare primeiro.'); return; }
    var u = filteredUniverse();
    var cmp = compare(u.siate, u.list);
    state.result = cmp;
    var f = u.f;
    var db = loadDB();
    var haveP = {}, haveQ = {};
    db.principal.forEach(function (p) { haveP[p.numos] = 1; });
    db.quarentena.forEach(function (q) { haveQ[q.numos + '|' + q.origem] = 1; });

    var newP = 0;
    cmp.cong.forEach(function (s) {
      if (haveP[s.numos]) return;
      db.principal.push({
        numos: s.numos, codserv: s.codserv, datasol: s.datasol, dataISO: s.dataISO,
        codreg: s.codreg, regional: s.regional, cidade: s.cidade, cliente: s.cliente,
        tel1: s.tel1, tel2: s.tel2, obs: s.obs, dscsvc: s.dscsvc,
        statusDemanda: 'A INICIAR', responsavel: null, origem: 'CONGRUENTE',
        createdAt: new Date().toISOString(),
      });
      newP++;
    });
    var newQ = 0;
    cmp.soSiate.forEach(function (s) {
      var key = s.numos + '|SO_SIATE';
      if (haveQ[key]) return;
      db.quarentena.push({ numos: s.numos, origem: 'SO_SIATE', d: compactQ(s, 'SO_SIATE'), createdAt: new Date().toISOString() });
      newQ++;
    });
    cmp.soList.forEach(function (l) {
      var key = l.numos + '|SO_LIST';
      if (haveQ[key]) return;
      db.quarentena.push({ numos: l.numos, origem: 'SO_LIST', d: compactQ(l, 'SO_LIST'), createdAt: new Date().toISOString() });
      newQ++;
    });
    db.imports.push({ ts: new Date().toISOString(), filtros: f, siateFiltrada: u.siate.length, listFiltrada: u.list.length, congTotal: cmp.cong.length, novasPrincipal: newP, novasQuarentena: newQ });
    if (!saveDB(db)) {
      var kb = 0;
      try { kb = Math.round(JSON.stringify(db).length / 1024); } catch (e) {}
      renderAll();
      alert('NÃO SALVOU: banco local cheio (quota ~5MB; tentativa com aprox. ' + kb + 'KB). Nada foi gravado.\n\nSaídas:\n1) Jogue em partes usando filtros (ex: 1 regional por vez);\n2) Migre para o Supabase (docs/SUPABASE_SCHEMA.sql).');
      return;
    }
    renderAll('Banco atualizado: +' + newP + ' na caixa principal, +' + newQ + ' na quarentena (universo filtrado: SIATE ' + u.siate.length + ', LIST ' + u.list.length + ').');
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
    return db.principal.filter(function (p) {
      if (state.statusFilter !== 'TODOS' && p.statusDemanda !== state.statusFilter) return false;
      if (!q) return true;
      return String(p.numos).indexOf(q) !== -1 ||
        String(p.cliente || '').toUpperCase().indexOf(q) !== -1 ||
        String(p.cidade || '').toUpperCase().indexOf(q) !== -1 ||
        String(p.codserv || '').indexOf(q) !== -1;
    });
  }
  function filteredQuar(db) {
    var q = state.search.trim().toUpperCase();
    return db.quarentena.filter(function (x) {
      if (!q) return true;
      return String(x.numos).indexOf(q) !== -1 ||
        String(qget(x, 'cli') || qget(x, 'cid') || qget(x, 'loc') || '').toUpperCase().indexOf(q) !== -1;
    });
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
    $('count-badge').textContent = db.principal.length + ' na caixa • ' + db.quarentena.length + ' quarentena';
    $('tab-n-p').textContent = db.principal.length;
    $('tab-n-q').textContent = db.quarentena.length;
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
      html = '<div class="no-results"><div style="font-size:36px">📭</div>Nenhuma demanda na caixa principal.<br>Importe as bases acima (admin) para começar.</div>';
    } else {
      html = '<div class="table-wrap"><table><thead><tr>' +
        '<th>NUM OS</th><th>CODSERV</th><th>DATA SOL</th><th>REGIONAL</th><th>CIDADE</th><th>CLIENTE</th><th>TELEFONE</th><th>STATUS</th><th>RESPONSÁVEL</th><th>AÇÕES</th>' +
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
      hq = '<div class="no-results"><div style="font-size:36px">🛡️</div>Quarentena vazia.<br>Divergências (só em uma base) aparecem aqui após a importação.</div>';
    } else {
      hq = '<div class="table-wrap"><table><thead><tr>' +
        '<th>NUM OS</th><th>ORIGEM</th><th>MOTIVO</th><th>DETALHE</th><th>AÇÕES (admin)</th>' +
        '</tr></thead><tbody>';
      sliceQ.forEach(function (x) {
        var det = '';
        if (x.origem === 'SO_SIATE') {
          det = 'CODSERV ' + esc(qget(x, 'c') || '—') + ' • ' + esc(qget(x, 'cid')) + ' • ' + esc(qget(x, 'cli')) + ' • REG ' + esc(qget(x, 'r') || '—');
        } else {
          det = 'CODSERV ' + esc(qget(x, 'c') || '—') + ' • ' + esc(qget(x, 'loc')) + ' • ' + esc(qget(x, 'desc'));
        }
        var dis = state.isAdmin ? '' : ' disabled title="Somente admin"';
        var motivo = x.motivo || (x.origem === 'SO_SIATE' ? 'Tem na SIATE e não tem na LIST' : 'Tem na LIST e não tem na SIATE');
        hq += '<tr>' +
          '<td><span class="os-id">' + esc(x.numos) + '</span></td>' +
          '<td>' + (x.origem === 'SO_SIATE' ? '<span class="badge badge-yellow">SÓ SIATE</span>' : '<span class="badge badge-red">SÓ LIST</span>') + '</td>' +
          '<td class="mono" style="font-size:11px">' + esc(motivo) + '</td>' +
          '<td style="font-size:12px">' + det + '</td>' +
          '<td style="white-space:nowrap"><button class="btn-small ok" data-act="aprovar" data-os="' + esc(x.numos) + '" data-org="' + esc(x.origem) + '"' + dis + '>Aprovar</button> ' +
          '<button class="btn-small danger" data-act="reprovar" data-os="' + esc(x.numos) + '" data-org="' + esc(x.origem) + '"' + dis + '>Reprovar</button></td></tr>';
      });
      hq += '</tbody></table></div>';
      hq += '<div class="pagination"><button class="page-btn" data-pg="q-prev">‹</button>' +
        '<span class="page-info">Pág ' + state.pageQuar + '/' + totalQ + ' • ' + lq.length + ' itens</span>' +
        '<button class="page-btn" data-pg="q-next">›</button></div>';
    }
    $('tbl-quarentena').innerHTML = hq;

    if (msg) $('result-msg').textContent = msg;
    renderStats();
  }

  function renderAll(msg) {
    renderTables(msg);
    // visibilidade das abas
    $('view-principal').style.display = state.tab === 'principal' ? '' : 'none';
    $('view-quarentena').style.display = state.tab === 'quarentena' ? '' : 'none';
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === state.tab);
    });
    document.querySelectorAll('.chip[data-st]').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-st') === state.statusFilter);
    });
  }

  // ---------- eventos ----------
  function bindEvents() {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); renderAll(); });
    });
    document.querySelectorAll('.chip[data-st]').forEach(function (c) {
      c.addEventListener('click', function () { state.statusFilter = c.getAttribute('data-st'); state.pagePrincipal = 1; renderAll(); });
    });
    var bs = $('btn-search');
    if (bs) bs.addEventListener('click', function () { state.search = ($('q') || {}).value || ''; state.pagePrincipal = 1; state.pageQuar = 1; renderAll(); });
    var qi = $('q');
    if (qi) qi.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.search = qi.value; state.pagePrincipal = 1; state.pageQuar = 1; renderAll(); } });

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
        if (p) { p.responsavel = (state.user && state.user.email) || 'eu'; if (p.statusDemanda === 'A INICIAR') p.statusDemanda = 'EM ANDAMENTO'; saveDB(db); renderAll('OS ' + os + ' assumida.'); }
      }
      if (act === 'liberar') {
        var p2 = db.principal.find(function (x) { return x.numos === os; });
        if (p2) { p2.responsavel = null; p2.statusDemanda = 'A INICIAR'; saveDB(db); renderAll('OS ' + os + ' devolvida à caixa.'); }
      }
      if ((act === 'aprovar' || act === 'reprovar') && !state.isAdmin) { alert('Somente admin pode aprovar/reprovar.'); return; }
      if (act === 'aprovar') {
        var org = btn.getAttribute('data-org');
        var ix = db.quarentena.findIndex(function (x) { return x.numos === os && x.origem === org; });
        if (ix !== -1) {
          var item = db.quarentena.splice(ix, 1)[0];
          if (!db.principal.find(function (x) { return x.numos === os; })) {
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
          renderAll('OS ' + os + ' aprovada → caixa principal.');
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
    });

    document.addEventListener('change', function (e) {
      var s = e.target.closest ? e.target.closest('select[data-act="status"]') : null;
      if (!s) return;
      var os = s.getAttribute('data-os');
      var db = loadDB();
      var p = db.principal.find(function (x) { return x.numos === os; });
      if (p && STATUS_LIST.indexOf(s.value) !== -1) { p.statusDemanda = s.value; saveDB(db); renderAll('OS ' + os + ' → ' + s.value + '.'); }
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
    state.result = cmp;
    var f = u.f;
    var lines = [];
    lines.push('FILTROS RECORTARAM AS DUAS BASES (resto descartado):');
    lines.push('- SIATE: ' + u.siate.length + ' de ' + state.siateClean.length + ' | LIST: ' + u.list.length + ' de ' + state.listClean.length);
    lines.push('COMPARAÇÃO POR NUMOS (exato) no universo filtrado:');
    lines.push('- Congruentes: ' + cmp.cong.length + ' → caixa principal');
    lines.push('- Só SIATE: ' + cmp.soSiate.length + ' → quarentena');
    lines.push('- Só LIST: ' + cmp.soList.length + ' → quarentena');
    lines.push('Filtros: regional=' + (f.regs.join(',') || 'todas') + ' | codserv=' + (f.codserv || 'todos') + ' | cidade=' + (f.cidade || 'todas') + ' | período=' + (f.dIni || '…') + '→' + (f.dFim || '…'));
    $('log').textContent = lines.join('\n');
    $('alert').style.display = '';
    $('alert').innerHTML = '✔ <b>' + cmp.cong.length + '</b> congruentes p/ caixa principal &nbsp;•&nbsp; ⚠ <b>' + (cmp.soSiate.length + cmp.soList.length) + '</b> divergentes p/ quarentena (tudo do universo filtrado). <br>Confira e clique em <b>“Jogar no banco”</b>.';
    $('alert').className = 'alert-box green';
    renderStats();
  }

  // ---------- init ----------
  async function init() {
    var sess = await requireAuth();
    if (!sess) return;
    state.user = sess;
    state.isAdmin = isAdminEmail(sess.email);
    $('me').innerHTML = esc(sess.email) + ' • <b>' + esc(sess.role || (state.isAdmin ? 'admin' : 'usuario')) + '</b>';
    if (!state.isAdmin) {
      var up = $('panel-upload');
      if (up) up.style.display = 'none';
      var nq = $('not-admin');
      if (nq) nq.style.display = '';
    }
    bindEvents();
    renderAll();
    $('log').textContent = 'Pronto. ' + (state.isAdmin ? 'Suba as duas bases para comparar.' : 'Aguardando importação do admin.');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
