/* Gera o bookmarklet a partir do userscript (fonte única).
   Uso:  node automacao/list-primeira-versao/build-bookmarklet.js  */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const FONTE = path.join(DIR, 'list-primeira-versao.user.js');
const TXT = path.join(DIR, 'bookmarklet.txt');
const HTML = path.join(DIR, 'instalar-bookmarklet.html');

// ── Minificador conservador ────────────────────────────────────────────────
// Remove comentários e espaços horizontais repetidos, preservando strings,
// regex e quebras de linha (para não depender de ASI).
function minificar(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let ultimoChar = '';
  let palavra = '';
  let ultimaPalavra = '';

  function fimPalavra() {
    if (palavra) ultimaPalavra = palavra;
    palavra = '';
  }

  function copiarString(quote) {
    out += quote;
    i++;
    while (i < n) {
      const c = src[i];
      out += c;
      i++;
      if (c === '\\') {
        if (i < n) { out += src[i]; i++; }
        continue;
      }
      if (c === quote) return;
    }
  }

  function copiarRegex() {
    out += '/';
    i++;
    let classe = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        out += c; i++;
        if (i < n) { out += src[i]; i++; }
        continue;
      }
      if (c === '[') classe = true;
      else if (c === ']') classe = false;
      else if (c === '/' && !classe) { out += c; i++; break; }
      out += c;
      i++;
    }
    while (i < n && /[a-z]/i.test(src[i])) { out += src[i]; i++; }
  }

  const PALAVRAS_ANTES_REGEX = ['return', 'typeof', 'instanceof', 'in', 'of', 'new',
    'delete', 'void', 'case', 'do', 'else', 'yield', 'await'];

  function podeRegex() {
    if (!ultimoChar) return true;
    if (/[A-Za-z0-9_$)\]}"']/.test(ultimoChar)) {
      return PALAVRAS_ANTES_REGEX.indexOf(ultimaPalavra) !== -1;
    }
    return true;
  }

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      if (out && out[out.length - 1] !== ' ' && out[out.length - 1] !== '\n') out += ' ';
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      fimPalavra();
      copiarString(c);
      ultimoChar = c;
      ultimaPalavra = '';
      continue;
    }

    if (c === '/' && podeRegex()) {
      fimPalavra();
      copiarRegex();
      ultimoChar = '/';
      ultimaPalavra = '';
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') {
      if (out && out[out.length - 1] !== ' ' && out[out.length - 1] !== '\n') out += ' ';
      i++;
      continue;
    }

    if (c === '\n') {
      out = out.replace(/ +$/, '');
      if (out && out[out.length - 1] !== '\n') out += '\n';
      i++;
      continue;
    }

    out += c;
    if (/[A-Za-z0-9_$]/.test(c)) {
      palavra += c;
    } else {
      fimPalavra();
    }
    if (!/\s/.test(c)) ultimoChar = c;
    i++;
  }

  return out.trim();
}

// ── Montagem ───────────────────────────────────────────────────────────────
const codigo = fs.readFileSync(FONTE, 'utf8');
const semCabecalho = codigo.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==[ \t]*\r?\n?/, '');
const min = minificar(semCabecalho);

// Não roda duas extrações ao mesmo tempo no mesmo navegador.
function montar(chamada) {
  return "(function(){if(window.LPV&&window.LPV.estado&&window.LPV.estado.rodando){" +
    "console.warn('[LPV] extração já em andamento');return;}" +
    min +
    "\n;window.LPV&&window.LPV." + chamada + "();})();";
}

// encodeURI deixa '#' passar (viraria fragmento da URL).
function urlDe(chamada) {
  return 'javascript:' + encodeURI(montar(chamada)).replace(/#/g, '%23');
}

const urlCSV = urlDe('executar');
const urlPub = urlDe('publicar');
const CONECTOR = path.join(DIR, 'conector.txt');

fs.writeFileSync(TXT, urlCSV, 'utf8');
fs.writeFileSync(CONECTOR, urlPub, 'utf8');

const hrefCSV = urlCSV.replace(/&/g, '&amp;');
const hrefPub = urlPub.replace(/&/g, '&amp;');
const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Instalar bookmarklets · LIST SharePoint</title>
<style>
  :root { color-scheme: dark; --laranja: #f0a500; --fundo: #0f1115; --card: #171a21; --linha: #262b36; --texto: #e7e9ee; --fraco: #9aa3b2; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--fundo); color: var(--texto); }
  main { max-width: 860px; margin: 48px auto; padding: 0 24px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 17px; margin: 0 0 4px; }
  h1 span, h2 span { color: var(--laranja); }
  h2 span.fraco { color: var(--fraco); font-weight: 400; font-size: 13px; }
  p.sub { color: var(--fraco); margin: 0 0 28px; }
  .card { background: var(--card); border: 1px solid var(--linha); border-radius: 14px; padding: 24px; }
  .btn { display: inline-flex; align-items: center; gap: 10px; background: var(--laranja); color: #17130a; font-weight: 700; text-decoration: none; padding: 14px 22px; border-radius: 10px; cursor: grab; user-select: none; margin: 12px 0; }
  .btn:active { cursor: grabbing; }
  .btn svg { width: 18px; height: 18px; }
  ol { padding-left: 20px; }
  li { margin: 8px 0; }
  code { background: #0b0d12; border: 1px solid var(--linha); border-radius: 6px; padding: 1px 6px; font-family: "Space Mono", ui-monospace, Consolas, monospace; font-size: 13px; }
  .fraco { color: var(--fraco); }
  a { color: var(--laranja); }
  details { margin-top: 22px; }
  textarea { width: 100%; height: 110px; margin-top: 10px; background: #0b0d12; color: var(--fraco); border: 1px solid var(--linha); border-radius: 8px; padding: 10px; font: 12px/1.4 ui-monospace, Consolas, monospace; resize: vertical; }
  .linha { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 18px; }
  button.sec { background: transparent; color: var(--texto); border: 1px solid var(--linha); border-radius: 8px; padding: 10px 16px; font: inherit; cursor: pointer; }
  button.sec:hover { border-color: var(--laranja); color: var(--laranja); }
  .ok { color: #56d364; }
  .cards { display: grid; gap: 18px; }
</style>
</head>
<body>
<main>
  <h1>Bookmarklets · <span>LIST SharePoint</span></h1>
  <p class="sub">Arraste os botões para a barra de favoritos. O <strong>Conector LIST</strong> envia as OS direto para o sistema (sem CSV).</p>

  <div class="cards">
    <div class="card">
      <h2>1) Conector LIST <span class="fraco">(recomendado)</span></h2>
      <p class="fraco">Lê a lista logada (OS, serviço, local, solicitação, status e a data da 1ª versão) e grava no Supabase.</p>
      <a class="btn" id="bm-pub" href="${hrefPub}" draggable="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg>
        Conector LIST (publicar no site)
      </a>
      <div class="linha">
        <button class="sec" data-copiar="bm-pub">Copiar código do conector</button>
        <span class="fraco" data-msg="bm-pub"></span>
      </div>
      <ol>
        <li>No site, tela <strong>LIST</strong> → <strong>Gerar token (24h)</strong> e copie o token.</li>
        <li>Abra a lista no SharePoint logado: <code>.../Lists/Gerenciador de Obras</code> → <strong>Todos os itens</strong>.</li>
        <li>Clique no favorito <strong>Conector LIST</strong> e cole o token quando ele pedir.</li>
        <li>Volte ao site → <strong>LIST</strong> → <strong>Atualizar</strong>.</li>
      </ol>
    </div>

    <div class="card">
      <h2>2) Extrair para CSV <span class="fraco">(alternativa, não envia nada)</span></h2>
      <p class="fraco">Só baixa o CSV com as OS e as datas — útil para conferência ou importação manual.</p>
      <a class="btn" id="bm-csv" href="${hrefCSV}" draggable="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg>
        Data da 1ª versão da OS (CSV)
      </a>
      <div class="linha">
        <button class="sec" data-copiar="bm-csv">Copiar código do CSV</button>
        <span class="fraco" data-msg="bm-csv"></span>
      </div>
    </div>
  </div>

  <p class="fraco" style="margin-top:20px">Dica: se preferir, crie um favorito qualquer, edite a URL e cole o código copiado. O Chrome remove o prefixo <code>javascript:</code> quando você cola na barra de endereços — por isso o caminho é arrastar ou colar na URL do favorito. Se o clique não fizer nada (política de segurança da página), abra o console (F12) e cole o mesmo código lá.</p>

  <details>
    <summary class="fraco">Ver os códigos (${(urlPub.length / 1024).toFixed(1)} KB conector · ${(urlCSV.length / 1024).toFixed(1)} KB CSV)</summary>
    <textarea id="codigo-pub" readonly>${hrefPub.replace(/</g, '&lt;')}</textarea>
    <textarea id="codigo-csv" readonly>${hrefCSV.replace(/</g, '&lt;')}</textarea>
  </details>
</main>
<script>
  (function () {
    var AREAS = { 'bm-pub': 'codigo-pub', 'bm-csv': 'codigo-csv' };
    document.querySelectorAll('[data-copiar]').forEach(function (botao) {
      botao.addEventListener('click', function () {
        var id = botao.getAttribute('data-copiar');
        var alvo = document.getElementById(id);
        var area = document.getElementById(AREAS[id]);
        var msg = botao.parentNode.querySelector('[data-msg]');
        if (!alvo) return;
        function ok() { if (msg) { msg.textContent = 'Copiado.'; msg.className = 'ok'; } }
        function falhou() {
          if (area) {
            area.closest('details').open = true;
            area.select();
            if (msg) msg.textContent = 'Selecione e copie manualmente.';
          }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(alvo.getAttribute('href')).then(ok, falhou);
        } else {
          falhou();
        }
      });
    });
  })();
</script>
</body>
</html>
`;

fs.writeFileSync(HTML, html, 'utf8');

console.log('Fonte        :', path.relative(process.cwd(), FONTE));
console.log('Userscript   :', codigo.length, 'bytes');
console.log('Minificado   :', min.length, 'bytes');
console.log('CSV          :', urlCSV.length, 'bytes (' + (urlCSV.length / 1024).toFixed(1) + ' KB)');
console.log('Conector     :', urlPub.length, 'bytes (' + (urlPub.length / 1024).toFixed(1) + ' KB)');
console.log('Arquivos     :', path.relative(process.cwd(), TXT), '|', path.relative(process.cwd(), CONECTOR), '|', path.relative(process.cwd(), HTML));
