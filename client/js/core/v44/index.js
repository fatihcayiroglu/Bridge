// client/js/core/v44/index.js Modül Loader
'use strict';

(function() {
  const BASE = document.currentScript?.src?.replace('/index.js', '') || '/client/js/core/v44';
  const MODULES = [
    'voice-volume.js',
    'advanced-search.js',
    'slow-mode.js',
    'audit-log.js',
    'boost.js',
    'styles.js',    // CSS + console.log en sona
  ];
  MODULES.forEach(m => {
    const s = document.createElement('script');
    s.src = `${BASE}/${m}`;
    s.defer = true;
    document.head.appendChild(s);
  });
  
})();
