// client/js/core/v42/index.js ModÃ¼l Loader
'use strict';

(function() {
  const BASE = document.currentScript?.src?.replace('/index.js', '') || '/client/js/core/v42';
  const MODULES = [
    'forum.js',
    'stage.js',
    'calendar-picker.js',
    'automod.js',
    'mobile.js',   // CSS enjeksiyonunu iÃ§erdiÄŸi iÃ§in en sona
  ];
  MODULES.forEach(m => {
    const s = document.createElement('script');
    s.src = `${BASE}/${m}`;
    s.defer = true;
    document.head.appendChild(s);
  });
  
})();

