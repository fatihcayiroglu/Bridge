// client/js/core/v43/index.js Modül Loader
'use strict';

(function() {
  const BASE = document.currentScript?.src?.replace('/index.js', '') || '/client/js/core/v43';
  const MODULES = [
    'virtual-scroll.js',
    'skeleton-loading.js',
    'search-highlight.js',
    'drafts.js',
    'themes.js',          // CSS içerir
    'ai-streaming.js',
    'auth-revoked.js',    // en sona — console.log + socket hook
  ];
  MODULES.forEach(m => {
    const s = document.createElement('script');
    s.src = `${BASE}/${m}`;
    s.defer = true;
    document.head.appendChild(s);
  });
  
})();
