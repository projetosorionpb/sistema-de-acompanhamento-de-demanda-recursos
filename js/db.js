// ── Camada de dados: Supabase (somente nuvem) ──
// Mantém em memória um cache no MESMO formato do banco local (sad_db_v1), para
// que o app.js continue lendo de forma síncrona (loadDB) e gravando (saveDB).
// Quando há Supabase + sessão: carrega/sincroniza tabelas demandas/quarentena/
// reprovadas/importacoes. Sem isso: comportamento local idêntico ao anterior.
(function () {
  'use strict';

  var PAGE = 1000; // Supabase devolve no máximo 1000 linhas por request

  var cache = null;              // { principal, quarentena, imports, reproved }
  var remoteReady = false;       // true = cache veio do Supabase e pode sincronizar
  var baseline = null;           // snapshot do último estado confirmado no servidor
  var chain = Promise.resolve(); // serializa as gravações
  var errorHandler = null;       // callback p/ o app avisar falha de gravação

  function emptyDB() { return { principal: [], quarentena: [], imports: [], reproved: [], cfg: null }; }
  function supabaseOn() {
    try { return typeof isSupabaseMode === 'function' && isSupabaseMode(); }
    catch (e) { return false; }
  }

  // Busca todas as linhas de uma tabela respeitando o teto de 1000 por request.
  async function fetchAll(table, columns, orderCol, extra) {
    var client = supa();
    var out = [], from = 0;
    for (;;) {
      var q = client.from(table).select(columns || '*').range(from, from + PAGE - 1);
      if (orderCol) q = q.order(orderCol, { ascending: true });
      if (extra) q = extra(q);
      var res = await q;
      if (res.error) throw res.error;
      var rows = res.data || [];
      out = out.concat(rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
    return out;
  }

  // ── mapeadores (colunas do Supabase ↔ objetos locais) ──
  function demandFromRow(r) {
    return {
      numos: String(r.numos || ''),
      codserv: r.codserv == null ? '' : String(r.codserv),
      datasol: r.datasol || '', dataISO: r.data_iso || '',
      codreg: (r.codreg == null ? '' : r.codreg),
      regional: r.regional || '', cidade: r.cidade || '', cliente: r.cliente || '',
      tel1: r.tel1 || '', tel2: r.tel2 || '', obs: r.obs || '', dscsvc: r.dscsvc || '',
      statusDemanda: r.status_demanda || 'A INICIAR',
      responsavel: r.responsavel || null,
      origem: r.origem || 'CONGRUENTE',
      createdAt: r.created_at || '',
      encerradoEm: r.encerrado_em || null,
      encerradoPor: r.encerrado_por || null,
      motivoOcorrencia: r.motivo_ocorrencia || '',
    };
  }
  function demandToRow(p) {
    return {
      numos: p.numos, codserv: p.codserv == null ? null : String(p.codserv),
      datasol: p.datasol || '', data_iso: p.dataISO || null,
      codreg: (p.codreg === '' || p.codreg == null) ? null : (parseInt(p.codreg, 10) || null),
      regional: p.regional || '', cidade: p.cidade || '', cliente: p.cliente || '',
      tel1: p.tel1 || '', tel2: p.tel2 || '', obs: p.obs || '', dscsvc: p.dscsvc || '',
      status_demanda: p.statusDemanda || 'A INICIAR',
      responsavel: p.responsavel || null,
      origem: p.origem || 'CONGRUENTE',
      encerrado_em: p.encerradoEm || null,
      encerrado_por: p.encerradoPor || null,
      motivo_ocorrencia: p.motivoOcorrencia || '',
    };
  }
  // A quarentena local usa chaves curtas (n,c,d,r,cid,cli,t,desc,loc) — o JSONB
  // guarda esse objeto compacto; DIVERGENTE guarda cs/cl/ds/dl/rs/ts/tl.
  var QMAP = { n: 'n', c: 'c', d: 'd', r: 'r', cid: 'cid', cli: 'cli', t: 't', desc: 'desc', loc: 'loc', cs: 'cs', cl: 'cl', ds: 'ds', dl: 'dl', rs: 'rs', ts: 'ts', tl: 'tl' };
  function qToRow(x) {
    return {
      numos: x.numos, origem: x.origem, motivo: x.motivo || null,
      dados: x.d || x.dados || null,
    };
  }
  function qFromRow(r) {
    var raw = r.dados || {};
    var d = {};
    Object.keys(QMAP).forEach(function (k) { if (raw[k] !== undefined) d[k] = raw[k]; });
    return { numos: String(r.numos || ''), origem: r.origem, motivo: r.motivo || '', d: d };
  }
  function repFromRow(r) {
    return { numos: String(r.numos || ''), origem: r.origem, ts: r.created_at || '', por: r.por || '' };
  }
  function repToRow(x) {
    return { numos: x.numos, origem: x.origem, por: x.por || null };
  }
  function impFromRow(r) {
    var f = r.filtros || {};
    return {
      ts: r.created_at || '', filtros: f,
      siateFiltrada: r.siate_filtrada || 0, listFiltrada: r.list_filtrada || 0,
      congTotal: r.cong_total || 0, novasPrincipal: r.novas_principal || 0,
      novasQuarentena: r.novas_quarentena || 0, promovidas: r.promovidas || 0,
      ignoradasReprovadas: r.ignoradas_reprovadas || 0, preservadasCaixa: r.preservadas_caixa || 0,
      duplicadasQuarentena: r.duplicadas_quarentena || 0, _id: r.id, _synced: true,
    };
  }
  function impToRow(x) {
    return {
      por: (x.por || null), filtros: x.filtros || {}, siate_filtrada: x.siateFiltrada || 0,
      list_filtrada: x.listFiltrada || 0, cong_total: x.congTotal || 0,
      novas_principal: x.novasPrincipal || 0, novas_quarentena: x.novasQuarentena || 0,
      promovidas: x.promovidas || 0, ignoradas_reprovadas: x.ignoradasReprovadas || 0,
      preservadas_caixa: x.preservadasCaixa || 0, duplicadas_quarentena: x.duplicadasQuarentena || 0,
    };
  }

  function keyOf(o) { return String(o.numos) + '|' + String(o.origem || ''); }

  // ── carregar do Supabase ──
  async function loadRemote() {
    try {
      var sess = await getSession();
      if (!sess) return false;
      var adm = typeof isAdminEmail === 'function' && isAdminEmail(sess.email);
      var cfgRow = null;
      var jobs = [
        fetchAll('demandas', '*', 'numos'),
        fetchAll('reprovadas', 'numos,origem,por,created_at', 'numos'),
        fetchAll('config', 'key,valor', null, function (q) { return q.eq('key', 'distrib'); }),
        adm ? fetchAll('quarentena', 'numos,origem,motivo,dados,created_at', 'numos') : Promise.resolve([]),
        adm ? fetchAll('importacoes', '*', null, function (q) { return q.order('id', { ascending: true }); }) : Promise.resolve([]),
      ];
      var rs = await Promise.all(jobs);
      cfgRow = (rs[2] || [])[0];
      cache = {
        principal: (rs[0] || []).map(demandFromRow),
        reproved: (rs[1] || []).map(repFromRow),
        cfg: cfgRow ? (cfgRow.valor || null) : null,
        quarentena: (rs[3] || []).map(qFromRow),
        imports: (rs[4] || []).map(impFromRow),
      };
      baseline = JSON.stringify(cache);
      remoteReady = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── gravar diff no Supabase (serializado) ──
  function doSync() {
    if (!remoteReady || !cache || !baseline) return Promise.resolve();
    var prev;
    try { prev = JSON.parse(baseline); } catch (e) { prev = emptyDB(); }
    // Congela o estado deste write. Se outra ação mudar o cache enquanto o
    // request está em trânsito, a próxima operação calcula seu diff contra
    // este snapshot confirmado, sem perder a alteração mais nova.
    var target;
    try { target = JSON.parse(JSON.stringify(cache)); } catch (e0) { target = emptyDB(); }
    var client = supa();

    var prevP = {}, nextP = {};
    (prev.principal || []).forEach(function (p) { prevP[String(p.numos)] = p; });
    (target.principal || []).forEach(function (p) { nextP[String(p.numos)] = p; });
    var insP = [], updP = [];
    (target.principal || []).forEach(function (p) {
      var pk = String(p.numos);
      if (!prevP[pk]) insP.push(demandToRow(p));
      else if (JSON.stringify(prevP[pk]) !== JSON.stringify(p)) updP.push(demandToRow(p));
    });
    var delP = [];
    (prev.principal || []).forEach(function (p) {
      if (!nextP[String(p.numos)]) delP.push(String(p.numos));
    });

    var prevQ = {}, nextQ = {};
    (prev.quarentena || []).forEach(function (x) { prevQ[keyOf(x)] = x; });
    (target.quarentena || []).forEach(function (x) { nextQ[keyOf(x)] = x; });
    var newQ = [];
    (target.quarentena || []).forEach(function (x) {
      var k = keyOf(x);
      if (!prevQ[k] || JSON.stringify(prevQ[k]) !== JSON.stringify(x)) newQ.push(qToRow(x));
    });
    var delQ = [];
    (prev.quarentena || []).forEach(function (x) { if (!nextQ[keyOf(x)]) delQ.push(x); });

    var prevR = {}, nextR = {};
    (prev.reproved || []).forEach(function (x) { prevR[keyOf(x)] = x; });
    (target.reproved || []).forEach(function (x) { nextR[keyOf(x)] = x; });
    var newR = [];
    (target.reproved || []).forEach(function (x) { if (!prevR[keyOf(x)]) newR.push(repToRow(x)); });
    var delR = [];
    (prev.reproved || []).forEach(function (x) { if (!nextR[keyOf(x)]) delR.push(x); });

    // Importações: insere as ainda não sincronizadas (flag _synced), nunca duplica.
    var newI = [], pendingI = [];
    (target.imports || []).forEach(function (x, index) {
      if (!x._synced) { newI.push(impToRow(x)); pendingI.push({ index: index, ts: x.ts }); }
    });
    // Importações removidas (limpar banco) → apaga o histórico no servidor.
    var delI = (prev.imports || []).length > 0 && !(target.imports || []).length;

    // Configuração do app (ex.: distribuição): só grava se mudou.
    var cfgChanged = JSON.stringify(prev.cfg || null) !== JSON.stringify(target.cfg || null);

    var ops = [];
    var BATCH = 500; // evita payload gigante em importações (milhares de linhas)
    function chunk(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
    chunk(insP, BATCH).forEach(function (b) { ops.push(client.from('demandas').insert(b)); });
    // Updates em linhas existentes: UPDATE (não upsert) — funciona para o
    // usuário comum, que só tem policy de UPDATE na própria caixa.
    updP.forEach(function (row) {
      // Retorna numos para saber se o RLS permitiu a alteração. Em disputa
      // para pegar a mesma OS, só a primeira atualização deve vencer.
      var updateOp = client.from('demandas').update(row).eq('numos', row.numos).select('numos');
      ops.push(Promise.resolve(updateOp).then(function (r) {
        if (r && r.error) return r;
        if (r && Array.isArray(r.data) && !r.data.length) {
          return { error: 'A OS ' + row.numos + ' não foi atualizada: pode ter sido assumida por outro usuário. Atualize a tela.' };
        }
        return r;
      }));
    });
    // Apagar em massa (quando a lista final fica vazia) é mais robusto que
    // apagar item a item — usado pelo "Limpar banco".
    if (delP.length) {
      if (!(target.principal || []).length) ops.push(client.from('demandas').delete().neq('numos', ''));
      else chunk(delP, BATCH).forEach(function (b) { ops.push(client.from('demandas').delete().in('numos', b)); });
    }
    chunk(newQ, BATCH).forEach(function (b) { ops.push(client.from('quarentena').upsert(b, { onConflict: 'numos,origem' })); });
    if (delQ.length) {
      if (!(target.quarentena || []).length) ops.push(client.from('quarentena').delete().neq('numos', ''));
      else delQ.forEach(function (x) {
        ops.push(client.from('quarentena').delete().eq('numos', x.numos).eq('origem', x.origem));
      });
    }
    chunk(newR, BATCH).forEach(function (b) { ops.push(client.from('reprovadas').upsert(b, { onConflict: 'numos,origem' })); });
    if (delR.length) {
      if (!(target.reproved || []).length) ops.push(client.from('reprovadas').delete().neq('numos', ''));
      else delR.forEach(function (x) {
        ops.push(client.from('reprovadas').delete().eq('numos', x.numos).eq('origem', x.origem));
      });
    }
    chunk(newI, BATCH).forEach(function (b) { ops.push(client.from('importacoes').insert(b)); });
    if (delI) ops.push(client.from('importacoes').delete().neq('id', -1));
    if (cfgChanged) ops.push(client.from('config').upsert({ key: 'distrib', valor: target.cfg || {} }, { onConflict: 'key' }));

    if (!ops.length) { baseline = JSON.stringify(target); return Promise.resolve(); }
    return Promise.all(ops).then(function (rs) {
      var err = null;
      rs.forEach(function (r) { if (r && r.error) err = r.error; });
      if (err) return { error: err.message };
      pendingI.forEach(function (p) {
        if (target.imports[p.index]) target.imports[p.index]._synced = true;
        var live = cache.imports && cache.imports[p.index];
        if (live && live.ts === p.ts) live._synced = true;
      });
      baseline = JSON.stringify(target);
      return { error: null };
    });
  }

  function syncNow() {
    chain = chain.then(function () { return doSync(); }).then(function (r) {
      if (r && r.error && errorHandler) { try { errorHandler(r.error); } catch (e) {} }
      return r;
    }).catch(function (e) {
      if (errorHandler) { try { errorHandler((e && e.message) || 'falha de sincronização'); } catch (e2) {} }
      return { error: 'sync' };
    });
    return chain;
  }

  window.SADDB = {
    // loadDB/saveDB sincronos — usados pelo app.js. Tudo na nuvem: sem cache
    // carregado, retorna vazio; sem nuvem, save falha (o app avisa).
    load: function () {
      return cache || emptyDB();
    },
    save: function (db) {
      if (!remoteReady) return false; // não grava localmente
      cache = db;
      try { syncNow(); } catch (e) {}
      return true;
    },
    // chamado no boot do app após requireAuth
    init: async function () {
      if (!supabaseOn()) { cache = emptyDB(); remoteReady = false; return 'unconfigured'; }
      var ok = await loadRemote();
      if (!ok) { cache = emptyDB(); remoteReady = false; return 'error'; }
      return 'supabase';
    },
    // re-busca do servidor (após ações que afetam outros usuários)
    refresh: async function () {
      if (!remoteReady) return false;
      try {
        // Espera todas as gravações pendentes antes de buscar. Evita que uma
        // resposta antiga sobrescreva o cache logo após pegar/alterar uma OS.
        var pending = await chain;
        var loaded = await loadRemote();
        return !!loaded && !(pending && pending.error);
      } catch (e) { return false; }
    },
    enabled: function () { return remoteReady; },
    onError: function (fn) { errorHandler = fn; },
    // configuração compartilhada (ex.: distribuição automática)
    loadCfg: function () {
      if (!cache) return null;
      return cache.cfg || null;
    },
    saveCfg: function (cfg) {
      if (!cache) cache = emptyDB();
      cache.cfg = cfg;
      if (remoteReady) { try { syncNow(); } catch (e) {} }
      return remoteReady;
    },
  };
})();
