/* Gera o bookmarklet a partir do userscript (fonte única).
   Uso:  node automacao/list-primeira-versao/build-bookmarklet.js  */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const FONTE = path.join(DIR, 'list-primeira-versao.user.js');
const TXT = path.join(DIR, 'bookmarklet.txt');

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
console.log('Fonte        :', path.relative(process.cwd(), FONTE));
console.log('Userscript   :', codigo.length, 'bytes');
console.log('Minificado   :', min.length, 'bytes');
console.log('CSV          :', urlCSV.length, 'bytes (' + (urlCSV.length / 1024).toFixed(1) + ' KB)');
console.log('Conector     :', urlPub.length, 'bytes (' + (urlPub.length / 1024).toFixed(1) + ' KB)');
console.log('Arquivos     :', path.relative(process.cwd(), TXT), '|', path.relative(process.cwd(), CONECTOR));
