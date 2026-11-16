// ==UserScript==
// @name         LIST SharePoint · Data da 1ª versão da OS
// @namespace    sad-demanda
// @version      1.2.0
// @description  Lê a lista "Gerenciador de Obras" no SharePoint e extrai a data da primeira versão (v1.0) de cada OS, com CSV e publicação no Supabase.
// @match        https://*.sharepoint.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ────────────────────────────────────────────────────────────────────────────
   O QUE FAZ
   Roda na própria página da lista (logado) e usa a API REST do SharePoint:
     GET /_api/web/lists(guid'...')/items                → itens + Criado/Modificado
     GET /_api/web/lists(guid'...')/items(<id>)/versions → histórico de versões

   "Data da primeira versão" = Created da versão 1.0 do item.
   Por padrão (modo 'auto') o script usa o campo Criado do item, que é
   exatamente o instante em que a versão 1.0 foi gravada, e confere uma
   amostra contra o histórico real. Use modo 'versoes' ou 'ambos' para
   buscar o histórico item a item (mais lento, mais requisições).

   COMO USAR
   1) Abra a lista no SharePoint (logado) — ex.: .../Lists/Gerenciador de Obras
   2) Abra o console (F12) e cole este arquivo inteiro, ou instale via Tampermonkey.
      (Se o Chrome bloquear o paste, digite: allow pasting)
   3) Rode:  LPV.executar()
      Uma OS só:  LPV.uma('123456')
   ──────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── Configuração ──────────────────────────────────────────────────────────
  const CFG = {
    // 'auto'    → usa Criado e confere amostra (listas grandes) / histórico (listas até 400 itens)
    // 'criado'  → só o campo Criado do item (rápido: ~1 requisição por 200 itens)
    // 'versoes' → busca o histórico de cada item e pega a versão 1.0 (lento em listas grandes)
    // 'ambos'   → busca o histórico de todos e compara com o campo Criado
    modo: 'auto',

    campoOS: '',          // '' = detecta sozinho; senão informe o InternalName (ex.: 'OS', 'Title')
    filtroOS: '',         // '' = todas; '123' / '123,456' ou regex /^12/
    limite: 0,            // 0 = todos os itens
    tamanhoPagina: 500,   // itens por requisição (cursor por Id; máx. 5000)
    concorrencia: 6,      // requisições simultâneas ao histórico
    conferirAmostra: 15,  // no modo 'criado': quantos itens conferir contra /versions
    fuso: 'America/Sao_Paulo',
    csvSeparador: ';',    // Excel pt-BR usa ';'
    baixarCSV: true,
    baixarJSON: false,
    nomeArquivo: 'primeira-versao-os',
    logCada: 250,

    // Publicação no sistema (Supabase) — usada por LPV.publicar().
    // A anon key é pública por design; a escrita só passa pela função
    // publicar_list(), que exige o token gerado na tela LIST do site.
    supabaseUrl: 'https://qvefbyhotjgfmyplkdop.supabase.co',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF2ZWZieWhvdGpnZm15cGxrZG9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4OTg0MDYsImV4cCI6MjEwNzQ3NDQwNn0.YZW9jSFlzi2C_Q_I_wVtUvw2KICbIFPdKDkmF40H8xA',
    tamanhoLote: 400,
  };

  const estado = {
    rodando: false,
    parar: false,
    itens: [],
    linhas: [],
    erros: [],
  };

  // ── Utilitários ───────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('%c[LPV]', 'color:#f0a500;font-weight:700', ...a);
  const warn = (...a) => console.warn('%c[LPV]', 'color:#d98c00;font-weight:700', ...a);

  function normalizar(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  function normOS(v) {
    if (v == null) return '';
    if (typeof v === 'number') return String(Math.trunc(v));
    let s = String(v).trim();
    if (/^\d+\.0+$/.test(s)) s = s.split('.')[0];
    return s.replace(/\s+/g, '');
  }

  // Converte o ISO/UTC do SharePoint para data local (fuso configurado).
  function dataPartes(iso, fuso) {
    if (!iso) return { iso: '', br: '', hora: '' };
    const d = new Date(iso);
    if (isNaN(d.getTime())) return { iso: '', br: '', hora: '' };
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      });
    } catch (e) {
      fmt = new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      });
    }
    const p = {};
    fmt.formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    return {
      iso: p.year + '-' + p.month + '-' + p.day,
      br: p.day + '/' + p.month + '/' + p.year,
      hora: p.hour + ':' + p.minute + ':' + p.second,
    };
  }

  function csvEscape(v, sep) {
    const s = v == null ? '' : String(v);
    return /["\n\r]/.test(s) || s.indexOf(sep) !== -1
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }

  function paraCSV(linhas, sep) {
    if (!linhas.length) return '';
    const cols = Object.keys(linhas[0]);
    const out = [cols.join(sep)];
    linhas.forEach((r) => {
      out.push(cols.map((c) => csvEscape(r[c], sep)).join(sep));
    });
    return out.join('\r\n');
  }

  function baixar(nome, texto, mime) {
    const blob = new Blob([texto], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function carimbo() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function uuidv4() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [];
    for (let j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
      h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  // ── Contexto / endpoints ──────────────────────────────────────────────────
  function contexto() {
    const c = window._spPageContextInfo || {};
    const m = location.pathname.match(/^(.*?\/Lists\/[^/]+)/i);
    const web = c.webAbsoluteUrl ||
      (location.origin + (c.webServerRelativeUrl || location.pathname.replace(/\/Lists\/.*$/i, '')));
    const titulo = c.listTitle || (m ? decodeURIComponent(m[1].split('/').pop()) : '');
    return {
      web: web,
      listId: String(c.listId || '').replace(/[{}]/g, ''),
      listUrl: c.listUrl || (m ? decodeURIComponent(m[1]) : ''),
      titulo: titulo,
      itemCount: Number(c.listItemCount) || 0,
    };
  }

  function baseLista(ctx) {
    if (ctx.listId) return ctx.web + "/_api/web/lists(guid'" + ctx.listId + "')";
    if (!ctx.titulo) {
      throw new Error('Não identifiquei a lista. Abra a página da lista antes de rodar.');
    }
    return ctx.web + "/_api/web/lists/GetByTitle('" + ctx.titulo.replace(/'/g, "''") + "')";
  }

  // fetch com retentativa para 429/503/504 (throttling do SharePoint).
  async function api(url, tentativas) {
    tentativas = tentativas || 5;
    let espera = 1000;
    for (let t = 1; t <= tentativas; t++) {
      let r;
      try {
        r = await fetch(url, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json;odata=nometadata' },
        });
      } catch (e) {
        if (t === tentativas) throw new Error('Falha de rede em ' + url + ' — ' + e.message);
        await sleep(espera);
        espera = Math.min(espera * 2, 20000);
        continue;
      }
      if (r.ok) {
        const txt = await r.text();
        return txt ? JSON.parse(txt) : {};
      }
      if (r.status === 429 || r.status === 503 || r.status === 504) {
        const ra = Number(r.headers.get('Retry-After')) || 0;
        const ms = ra > 0 ? ra * 1000 : espera;
        warn('HTTP ' + r.status + ' — aguardando ' + Math.round(ms / 1000) + 's (' + t + '/' + tentativas + ')');
        await sleep(ms + Math.floor(Math.random() * 400));
        espera = Math.min(espera * 2, 60000);
        continue;
      }
      const corpo = await r.text().catch(() => '');
      const err = new Error('HTTP ' + r.status + ' — ' + url + (corpo ? ' — ' + corpo.slice(0, 300) : ''));
      err.status = r.status;
      throw err;
    }
    throw new Error('Tentativas esgotadas: ' + url);
  }

  const CAMPOS_LIST = {
    os: ['os', 'numos', 'numeroos', 'numerodaos', 'nros', 'nroos',
      'ordemdeservico', 'numerodaordemdeservico', 'numosordemdeservico'],
    codserv: ['codserv', 'codigodeservico', 'codigoservico'],
    descricao: ['descricao', 'descricaodoservico', 'dscsvc'],
    local: ['local', 'cidade', 'localidade'],
    regional: ['regional', 'codreg'],
    solicitacao: ['solicitacao', 'datasolicitacao'],
    status: ['status', 'statusos'],
    telefone: ['telefone', 'telefonecliente', 'numtel'],
  };

  async function detectarCampos(base) {
    const j = await api(base + '/fields?$select=InternalName,Title,TypeAsString&$top=500');
    const todos = j.value || [];
    const escolhidos = {};

    Object.keys(CAMPOS_LIST).forEach((chave) => {
      const nomes = CAMPOS_LIST[chave];
      let f = null;
      if (chave === 'os' && CFG.campoOS) {
        f = todos.find((x) => x.InternalName === CFG.campoOS) || null;
      }
      if (!f) f = todos.find((x) => nomes.indexOf(normalizar(x.Title)) !== -1) || null;
      if (!f) f = todos.find((x) => nomes.indexOf(normalizar(x.InternalName)) !== -1) || null;
      if (f) escolhidos[chave] = f.InternalName;
    });

    if (!escolhidos.os) {
      warn('Não achei a coluna OS. Campos disponíveis:');
      console.table(todos.map((x) => ({ Title: x.Title, InternalName: x.InternalName, Tipo: x.TypeAsString })));
      throw new Error("Defina CFG.campoOS com o InternalName correto (ex.: 'OS') e rode de novo.");
    }
    log('Colunas: ' + Object.keys(escolhidos).map((k) => k + '=' + escolhidos[k]).join(', '));
    return escolhidos;
  }

  function valorCampo(it, campos, chave) {
    const nome = campos[chave];
    return nome ? it[nome] : '';
  }

  // Solicitação pode vir como DateTime ISO ou texto BR/ISO.
  function solicitacaoPartes(v) {
    if (v == null || v === '') return { txt: '', iso: '' };
    const s = String(v).trim();
    const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (br) {
      let yy = br[3];
      if (yy.length === 2) yy = '20' + yy;
      return {
        txt: s,
        iso: yy + '-' + br[2].padStart(2, '0') + '-' + br[1].padStart(2, '0'),
      };
    }
    const d = dataPartes(s, CFG.fuso);
    if (d.iso) return { txt: d.br, iso: d.iso };
    return { txt: s, iso: '' };
  }

  async function listarItens(base, campos) {
    const nomes = Object.keys(campos).map((k) => campos[k]);
    const sel = ['Id', 'Created', 'Modified'].concat(nomes)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(',');
    const itens = [];
    let ultimoId = 0;
    let tamanho = CFG.tamanhoPagina;
    let tentouReduzir = false;
    let semOS = 0;

    // Paginação por cursor de Id: `Id gt <último>` usa o índice da lista e
    // atravessa o limite de 5.000 itens da vista. `$top` + `$orderby=Id`
    // sozinho estoura SPQueryThrottledException em listas grandes.
    while (!estado.parar) {
      const url = base + '/items?$select=' + sel +
        '&$filter=Id gt ' + ultimoId +
        '&$orderby=Id asc&$top=' + tamanho;

      let j;
      try {
        j = await api(url);
      } catch (e) {
        const limiar = e.status === 500 && /limiar|threshold|throttl/i.test(e.message);
        if (limiar && !tentouReduzir) {
          tentouReduzir = true;
          tamanho = 100;
          warn('A consulta atingiu o limite da vista — reduzindo a página para ' +
            tamanho + ' e continuando do Id ' + ultimoId + '.');
          continue;
        }
        throw e;
      }

      const vs = j.value || [];
      if (!vs.length) break;

      for (let i = 0; i < vs.length; i++) {
        const it = vs[i];
        if (CFG.limite && itens.length >= CFG.limite) break;
        const os = normOS(it[campos.os]);
        if (!os) { semOS++; continue; } // pastas/itens sem OS
        itens.push({
          id: it.Id,
          os: os,
          criado: it.Created,
          modificado: it.Modified,
          codserv: valorCampo(it, campos, 'codserv'),
          descricao: valorCampo(it, campos, 'descricao'),
          local: valorCampo(it, campos, 'local'),
          regional: valorCampo(it, campos, 'regional'),
          solicitacao: valorCampo(it, campos, 'solicitacao'),
          status: valorCampo(it, campos, 'status'),
          telefone: valorCampo(it, campos, 'telefone'),
        });
      }

      const novoUltimo = Number(vs[vs.length - 1].Id);
      if (!(novoUltimo > ultimoId)) break;
      ultimoId = novoUltimo;
      log('Itens lidos: ' + itens.length + ' (último Id ' + ultimoId + ')…');

      if (CFG.limite && itens.length >= CFG.limite) break;
      if (vs.length < tamanho) break;
    }

    if (semOS) log(semOS + ' item(ns) sem OS ignorado(s).');
    return itens;
  }

  function aplicarFiltro(itens) {
    if (!CFG.filtroOS) return itens;
    const bruto = String(CFG.filtroOS).trim();
    let teste;
    const m = bruto.match(/^\/(.*)\/([a-z]*)$/i);
    if (m) {
      const re = new RegExp(m[1], m[2]);
      teste = (os) => re.test(os);
    } else {
      const alvo = {};
      bruto.split(/[\s,;]+/).forEach((x) => {
        const k = normOS(x);
        if (k) alvo[k] = 1;
      });
      teste = (os) => !!alvo[os];
    }
    const f = itens.filter((i) => teste(i.os));
    log('Filtro de OS: ' + f.length + ' de ' + itens.length + ' item(ns).');
    return f;
  }

  async function versoesDoItem(base, id) {
    const j = await api(base + '/items(' + id + ')/versions' +
      '?$select=ID,VersionLabel,Created,IsCurrentVersion');
    return j.value || [];
  }

  function versao1(vs) {
    if (!vs || !vs.length) return null;
    const rotulo = vs.find((v) => String(v.VersionLabel) === '1.0');
    if (rotulo) return rotulo;
    return vs.reduce((a, b) => (Number(a.ID) <= Number(b.ID) ? a : b));
  }

  // Pool de concorrência simples; erros não derrubam o restante.
  async function emPool(arr, n, fn, aoTerminar) {
    const total = arr.length;
    let prox = 0;
    let feitos = 0;
    async function operario() {
      while (prox < total && !estado.parar) {
        const i = prox++;
        try {
          await fn(arr[i], i);
        } catch (e) {
          estado.erros.push({ id: arr[i] && arr[i].id, os: arr[i] && arr[i].os, erro: e.message });
        }
        feitos++;
        if (aoTerminar && (feitos % CFG.logCada === 0 || feitos === total)) {
          aoTerminar(feitos, total);
        }
      }
    }
    const operarios = [];
    const qtd = Math.max(1, Math.min(n, total));
    for (let i = 0; i < qtd; i++) operarios.push(operario());
    await Promise.all(operarios);
  }

  // ── Execução ──────────────────────────────────────────────────────────────
  async function executar() {
    if (estado.rodando) {
      warn('Já está rodando. Use LPV.parar() para interromper.');
      return estado.linhas;
    }
    estado.rodando = true;
    estado.parar = false;
    estado.erros = [];
    estado.linhas = [];
    const t0 = performance.now();

    try {
      const ctx = contexto();
      log('Web: ' + ctx.web);
      log('Lista: ' + (ctx.titulo || '(sem título)') + (ctx.listId ? ' — ' + ctx.listId : ''));
      const base = baseLista(ctx);

      const info = await api(base + '?$select=Title,ItemCount,EnableVersioning,MajorVersionLimit')
        .catch((e) => { warn('Não consegui ler os metadados da lista: ' + e.message); return {}; });
      const totalLista = Number(info.ItemCount) || ctx.itemCount || 0;
      if (info.Title) {
        log('“' + info.Title + '” — ' + (totalLista || '?') + ' itens; versionamento: ' +
          (info.EnableVersioning === undefined ? '?' : (info.EnableVersioning ? 'ligado' : 'desligado')));
      }

      const campos = await detectarCampos(base);
      let itens = await listarItens(base, campos);
      itens = aplicarFiltro(itens);
      estado.itens = itens;
      if (!itens.length) {
        warn('Nenhum item para processar.');
        return [];
      }

      const versionamento = info.EnableVersioning;
      let modo = CFG.modo;
      if (modo === 'auto') {
        modo = info.ItemCount && Number(info.ItemCount) <= 400 ? 'ambos' : 'criado';
        log('Modo automático escolhido: ' + modo);
      }
      if (versionamento === false && (modo === 'versoes' || modo === 'ambos')) {
        warn('O versionamento desta lista está desligado — caindo para o campo Criado do item.');
        modo = 'criado';
      }

      const precisaHistorico = modo === 'versoes' || modo === 'ambos';
      const historico = {}; // id → { v1, total, atual }

      if (precisaHistorico) {
        if (itens.length > 1500 && typeof window.confirm === 'function') {
          const ok = window.confirm(
            'O modo “' + modo + '” fará cerca de ' + itens.length +
            ' requisições de histórico (pode demorar e sofrer throttling). Continuar?'
          );
          if (!ok) { log('Cancelado.'); return []; }
        }
        log('Lendo histórico de ' + itens.length + ' item(ns) (concorrência ' + CFG.concorrencia + ')…');
        await emPool(itens, CFG.concorrencia, async (it) => {
          const vs = await versoesDoItem(base, it.id);
          historico[it.id] = {
            v1: versao1(vs),
            total: vs.length,
            atual: (vs.find((v) => v.IsCurrentVersion) || {}).VersionLabel || '',
          };
        }, (feitos, total) => log('Histórico: ' + feitos + '/' + total));
      } else if (CFG.conferirAmostra > 0 && versionamento !== false) {
        const passo = Math.max(1, Math.floor(itens.length / CFG.conferirAmostra));
        const amostra = [];
        for (let i = 0; i < itens.length && amostra.length < CFG.conferirAmostra; i += passo) {
          amostra.push(itens[i]);
        }
        log('Conferindo ' + amostra.length + ' item(ns) da amostra contra o histórico real…');
        await emPool(amostra, Math.min(CFG.concorrencia, 4), async (it) => {
          const vs = await versoesDoItem(base, it.id);
          const v1 = versao1(vs);
          if (!v1) return;
          const a = dataPartes(it.criado, CFG.fuso).iso;
          const b = dataPartes(v1.Created, CFG.fuso).iso;
          if (a !== b) {
            warn('Divergência no item ' + it.id + ' (OS ' + it.os + '): Criado=' + a + ' × v1.0=' + b);
          }
        });
      }

      estado.linhas = itens.map((it) => {
        const r = historico[it.id];
        const v1 = r ? r.v1 : null;
        const criado = dataPartes(it.criado, CFG.fuso);
        const dv1 = v1 ? dataPartes(v1.Created, CFG.fuso) : null;
        const principal = v1 ? dv1 : criado;
        const sol = solicitacaoPartes(it.solicitacao);
        return {
          OS: it.os,
          ItemID: it.id,
          DataPrimeiraVersao: principal.iso,
          DataPrimeiraVersaoBR: principal.br,
          HoraPrimeiraVersao: principal.hora,
          RotuloVersao: v1 ? String(v1.VersionLabel || '') : '1.0',
          OrigemData: v1 ? 'Histórico de versões' : 'Campo Criado do item',
          TotalVersoes: r ? r.total : '',
          VersaoAtual: r ? r.atual : '',
          CODSERV: it.codserv == null ? '' : String(it.codserv),
          DESCRICAO: it.descricao || '',
          LOCAL: it.local || '',
          REGIONAL: it.regional || '',
          SOLICITACAO: sol.txt,
          SOLICITACAO_ISO: sol.iso,
          STATUS: it.status || '',
          TELEFONE: it.telefone || '',
          CriadoUTC: it.criado,
          ModificadoUTC: it.modificado,
          ModificadoBR: dataPartes(it.modificado, CFG.fuso).br,
        };
      }).sort((a, b) => (a.OS < b.OS ? -1 : a.OS > b.OS ? 1 : 0));

      const stamp = carimbo();
      if (CFG.baixarCSV) {
        baixar(CFG.nomeArquivo + '-' + stamp + '.csv',
          '\uFEFF' + paraCSV(estado.linhas, CFG.csvSeparador), 'text/csv');
      }
      if (CFG.baixarJSON) {
        baixar(CFG.nomeArquivo + '-' + stamp + '.json',
          JSON.stringify(estado.linhas, null, 2), 'application/json');
      }

      console.table(estado.linhas.slice(0, 20));
      if (estado.erros.length) {
        warn(estado.erros.length + ' item(ns) com erro. Primeiros 10:');
        console.table(estado.erros.slice(0, 10));
      }
      log('Concluído em ' + ((performance.now() - t0) / 1000).toFixed(1) + 's — ' +
        estado.linhas.length + ' OS, ' + estado.erros.length + ' erro(s).');
      return estado.linhas;
    } finally {
      estado.rodando = false;
    }
  }

  // ── Publicação no sistema (Supabase) ──────────────────────────────────────
  const TOKEN_KEY = 'LPV_TOKEN';

  function tokenConexao(forcar) {
    if (forcar) {
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    }
    let t = '';
    try { t = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
    if (!t) {
      if (typeof prompt !== 'function') throw new Error('Token não informado.');
      t = prompt(
        'Token de conexão LIST (gerado no site → tela LIST → “Gerar token”):'
      ) || '';
      t = t.trim();
      if (!t) throw new Error('Token não informado — conexão cancelada.');
      try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
    }
    return t;
  }

  async function publicarLote(token, itens) {
    const base = String(CFG.supabaseUrl || '').replace(/\/+$/, '');
    if (!base || !CFG.supabaseKey) throw new Error('Supabase não configurado no conector.');

    let r;
    try {
      r = await fetch(base + '/rest/v1/rpc/publicar_list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: CFG.supabaseKey,
          Authorization: 'Bearer ' + CFG.supabaseKey,
        },
        body: JSON.stringify({ p_token: token, p_itens: itens }),
      });
    } catch (e) {
      throw new Error('Falha de rede ao publicar no Supabase: ' + e.message);
    }

    const txt = await r.text().catch(() => '');
    let corpo = {};
    try { corpo = txt ? JSON.parse(txt) : {}; } catch (e2) { corpo = { message: txt }; }
    if (!r.ok) {
      const msg = (corpo && (corpo.message || corpo.error_description || corpo.error)) ||
        txt || ('HTTP ' + r.status);
      const err = new Error(String(msg).slice(0, 300));
      err.status = r.status;
      throw err;
    }
    return corpo;
  }

  async function finalizarPublicacao(token, runId) {
    const base = String(CFG.supabaseUrl || '').replace(/\/+$/, '');
    const r = await fetch(base + '/rest/v1/rpc/finalizar_list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFG.supabaseKey,
        Authorization: 'Bearer ' + CFG.supabaseKey,
      },
      body: JSON.stringify({ p_token: token, p_run: runId }),
    });
    const txt = await r.text().catch(() => '');
    let corpo = {};
    try { corpo = txt ? JSON.parse(txt) : {}; } catch (e2) { corpo = { message: txt }; }
    if (!r.ok) {
      throw new Error(String((corpo && corpo.message) || txt || ('HTTP ' + r.status)).slice(0, 300));
    }
    return corpo;
  }

  async function publicar() {
    if (estado.rodando) {
      warn('Já está rodando. Use LPV.parar() para interromper.');
      return { ok: false, erro: 'em andamento' };
    }
    const baixarAntes = CFG.baixarCSV;
    CFG.baixarCSV = false; // publicar não baixa CSV
    try {
      let token = tokenConexao(false);
      const runId = uuidv4();
      const linhas = await executar();
      if (estado.parar) {
        warn('Extração interrompida — nada foi publicado.');
        return { ok: false, erro: 'cancelado' };
      }
      if (!linhas || !linhas.length) {
        warn('Nenhuma OS para publicar.');
        return { ok: false, erro: 'sem itens' };
      }

      const ordem = [];
      const porOS = {};
      linhas.forEach((l) => {
        if (!l.OS) return;
        if (!porOS[l.OS]) {
          porOS[l.OS] = l;
          ordem.push(l.OS);
          return;
        }
        // Mesma OS em vários itens: fica a 1ª versão mais antiga.
        const atual = porOS[l.OS];
        const a = atual.CriadoUTC || '';
        const b = l.CriadoUTC || '';
        if (b && (!a || b < a)) porOS[l.OS] = l;
      });
      const unicas = ordem.map((os) => porOS[os]);
      if (unicas.length !== linhas.length) {
        log('Consolidadas ' + (linhas.length - unicas.length) +
          ' linha(s) com a mesma OS (mantida a 1ª versão mais antiga).');
      }

      const itens = unicas.map((l) => ({
        numos: l.OS,
        item_id: l.ItemID,
        codserv: l.CODSERV || '',
        descricao: l.DESCRICAO || '',
        local: l.LOCAL || '',
        regional: l.REGIONAL || '',
        solicitacao: l.SOLICITACAO || '',
        solicitacao_iso: l.SOLICITACAO_ISO || '',
        status_origem: l.STATUS || '',
        telefone: l.TELEFONE || '',
        data_primeira_versao: l.DataPrimeiraVersao || '',
        primeira_versao_em: l.CriadoUTC || '',
        modificado_em: l.ModificadoUTC || '',
        run_id: runId,
      }));

      const lote = Math.max(50, Number(CFG.tamanhoLote) || 400);
      const total = itens.length;
      let enviados = 0;

      for (let i = 0; i < total; i += lote) {
        const parte = itens.slice(i, i + lote);
        try {
          await publicarLote(token, parte);
        } catch (e) {
          if (/token|uuid|sintaxe|syntax/i.test(e.message)) {
            warn('Token recusado (' + e.message + '). Informe um novo.');
            token = tokenConexao(true);
            await publicarLote(token, parte);
          } else {
            throw e;
          }
        }
        enviados += parte.length;
        log('Publicado no Supabase: ' + enviados + '/' + total);
      }

      // Só remove itens antigos quando a extração foi completa (sem filtro/limite).
      if (!CFG.filtroOS && !CFG.limite) {
        try {
          const fin = await finalizarPublicacao(token, runId);
          if (fin && fin.apagadas) {
            log('Removidos ' + fin.apagadas + ' item(ns) que não estão mais na lista.');
          }
        } catch (e) {
          warn('Publicado, mas não consegui remover itens antigos: ' + e.message);
        }
      }

      try { localStorage.setItem('LPV_ULTIMA_PUBLICACAO', new Date().toISOString()); } catch (e) {}
      log('LIST publicada: ' + total + ' OS com a data da 1ª versão.');
      if (typeof alert === 'function') {
        alert('LIST publicada no sistema: ' + total + ' OS com a data da 1ª versão.\n\nVolte ao site e clique em Atualizar na tela LIST.');
      }
      return { ok: true, total: total };
    } catch (e) {
      warn('Falha ao publicar: ' + e.message);
      if (typeof alert === 'function') alert('Falha ao publicar a LIST: ' + e.message);
      return { ok: false, erro: e.message };
    } finally {
      CFG.baixarCSV = baixarAntes;
      estado.rodando = false;
    }
  }

  window.LPV = {
    CFG: CFG,
    estado: estado,
    executar: executar,
    publicar: publicar,
    parar: function () { estado.parar = true; warn('Parando após as requisições em andamento…'); },
    uma: function (os) { CFG.filtroOS = String(os); return executar(); },
  };

  log('Pronto. Rode LPV.executar() (CSV), LPV.publicar() (envia ao site) — ou LPV.uma("123456").');
})();
