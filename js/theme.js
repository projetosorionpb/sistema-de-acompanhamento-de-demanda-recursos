// ── Tema claro / escuro com persistência ──
(function () {
  var STORAGE_KEY = 'sad-theme';
  var DARK_BG = '#0d1117';
  var LIGHT_BG = '#f6f8fa';

  function getSavedTheme() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
      theme = 'dark';
    }
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? LIGHT_BG : DARK_BG);
    syncButtons(theme);
  }
  function syncButtons(theme) {
    var btns = document.querySelectorAll('[data-theme-toggle]');
    btns.forEach(function (btn) {
      btn.setAttribute('aria-label', theme === 'light' ? 'Alternar para tema escuro' : 'Alternar para tema claro');
      btn.setAttribute('title', theme === 'light' ? 'Alternar para tema escuro' : 'Alternar para tema claro');
    });
  }
  function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  function toggleTheme() { applyTheme(getCurrentTheme() === 'light' ? 'dark' : 'light'); }

  var saved = getSavedTheme();
  if (saved === 'light' || saved === 'dark') applyTheme(saved);
  else syncButtons(getCurrentTheme());

  document.addEventListener('DOMContentLoaded', function () {
    syncButtons(getCurrentTheme());
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', toggleTheme);
    });
  });

  window.toggleTheme = toggleTheme;
  window.getCurrentTheme = getCurrentTheme;
  window.applyTheme = applyTheme;
})();
