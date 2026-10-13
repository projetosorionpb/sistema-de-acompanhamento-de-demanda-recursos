/* ── Ícones SVG (stroke, currentColor) — sem emojis ──────────────────────
   Uso no HTML:  <span class="ico" data-icon="inbox"></span>
   Uso no JS:    SADICON('inbox')  |  SADICON('truck', 14)
   Hidratado automaticamente em [data-icon].                              */
(function () {
  'use strict';

  var P = {
    brand: 'M13 2 4.5 13.5H10l-1 8.5L19.5 10H14z',
    inbox: 'M22 12h-6l-2 3h-4l-2-3H2|M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z|M22 21v-2a4 4 0 0 0-3-3.87|M16 3.13a4 4 0 0 1 0 7.75',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2',
    chart: 'M3 3v18h18|M18 17V9|M13 17V5|M8 17v-3',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M17 8l-5-5-5 5|M12 3v12',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3',
    truck: 'M1 4h14v12H1z|M15 8h4l3 3v5h-7z|M7.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z|M18.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    dashboard: 'M3 3h7v9H3z|M14 3h7v5h-7z|M14 12h7v9h-7z|M3 16h7v5H3z',
    menu: 'M3 6h18|M3 12h18|M3 18h18',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z|M12 1v2|M12 21v2|M4.2 4.2l1.4 1.4|M18.4 18.4l1.4 1.4|M1 12h2|M21 12h2|M4.2 19.8l1.4-1.4|M18.4 5.6l1.4-1.4',
    moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z|M21 21l-4.35-4.35',
    x: 'M18 6 6 18|M6 6l12 12',
    check: 'M20 6 9 17l-5-5',
    'check-circle': 'M22 11.08V12a10 10 0 1 1-5.93-9.14|M22 4 12 14.01l-3-3',
    alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z|M12 9v4|M12 17h.01',
    'alert-circle': 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 8v4|M12 16h.01',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 16v-4|M12 8h.01',
    trash: 'M3 6h18|M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6|M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2|M10 11v6|M14 11v6',
    plus: 'M12 5v14|M5 12h14',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4|M16 17l5-5-5-5|M21 12H9',
    package: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z|m3.3 7 8.7 5 8.7-5|M12 22V12',
    clipboard: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2|M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z|M9 12h6|M9 16h6',
    calendar: 'M3 4h18v18H3z|M16 2v4|M8 2v4|M3 10h18',
    key: 'M7.5 19a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z|m21 2-9.6 9.6|m15.5 7.5 3 3L22 7l-3-3',
    refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8|M21 3v5h-5|M21 12a9 9 0 0 1-15 6.7L3 16|M3 21v-5h5',
    cloud: 'M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6-1.6A4 4 0 0 0 6 19z',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    'arrow-up': 'M12 19V5|m5 12 7-7 7 7',
    'arrow-down': 'M12 5v14|m19 12-7 7-7-7',
    sort: 'm7 15 5 5 5-5|m7 9 5-5 5 5',
    'chevron-down': 'm6 9 6 6 6-6',
    'chevron-left': 'm15 18-6-6 6-6',
    'chevron-right': 'm9 18 6-6-6-6',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M9 13h6|M9 17h6',
    folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z',
    send: 'm22 2-7 20-4-9-9-4z|M22 2 11 13',
    filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
    database: 'M12 8a9 3 0 1 0 0-6 9 3 0 0 0 0 6z|M3 5v14a9 3 0 0 0 18 0V5|M3 12a9 3 0 0 0 18 0',
    'external-link': 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6|M15 3h6v6|M10 14 21 3',
    flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z|M4 22v-7',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z|M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'
  };

  function SADICON(name, size) {
    var d = P[name] || P.info;
    var s = size || 18;
    var inner = d.split('|').map(function (p) {
      return '<path d="' + p + '"/>';
    }).join('');
    return '<svg class="svg-ico" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      inner + '</svg>';
  }

  function hydrate(root) {
    var scope = root || document;
    var els = scope.querySelectorAll('[data-icon]:not([data-icon-done])');
    Array.prototype.forEach.call(els, function (el) {
      var size = parseInt(el.getAttribute('data-size'), 10) || 18;
      el.innerHTML = SADICON(el.getAttribute('data-icon'), size);
      el.setAttribute('data-icon-done', '1');
    });
  }

  window.SADICON = SADICON;
  window.SADICON_hydrate = hydrate;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { hydrate(); });
  } else {
    hydrate();
  }
})();
