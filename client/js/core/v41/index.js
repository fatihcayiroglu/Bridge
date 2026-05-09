// client/js/core/v41/index.js Modül Loader
// Bu dosyayı HTML'e ekleyerek tüm v41 modüllerini yükleyebilirsiniz.
// Sıra önemli: go-live, onboarding, outgoing-webhooks
'use strict';

(function() {
  const BASE = document.currentScript?.src?.replace('/index.js', '') || '/client/js/core/v41';
  const MODULES = [
    'go-live.js',
    'onboarding.js',
    'outgoing-webhooks.js',
  ];
  MODULES.forEach(m => {
    const s = document.createElement('script');
    s.src = `${BASE}/${m}`;
    s.defer = true;
    document.head.appendChild(s);
  });
  
})();
