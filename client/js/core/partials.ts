// client/js/core/partials.js
// BÃ¼yÃ¼k modal/panel HTML'lerini lazy load eder
// index.html'i kÃ¼Ã§Ã¼k tutar, ilk yÃ¼kleme hÄ±zlanÄ±r

'use strict';

const Partials = (() => {
  const _loaded = new Set();

  // Partial HTML dosyalarÄ±nÄ± tanÄ±mla
  // key: partial adÄ±, value: hangi element id'sine inject edileceÄŸi
  const REGISTRY = {
    'settings':     { containerId: 'settings-modal-container',    trigger: '#settings-modal' },
    'addserver':    { containerId: 'addserver-modal-container',   trigger: '#addserver-modal' },
    'friends':      { containerId: 'friends-panel-container',     trigger: '#friends-panel' },
    'dm-call':      { containerId: 'dm-call-container',           trigger: '#dm-call-overlay' },
  };

  async function load(name) {
    if (_loaded.has(name)) return true;
    const entry = REGISTRY[name];
    if (!entry) return false;

    try {
      const r = await fetch(`/partials/${name}.html`);
      if (!r.ok) return false;
      const html = await r.text();
      const container = document.getElementById(entry.containerId);
      if (container) {
        container.innerHTML = html;
        _loaded.add(name);
        return true;
      }
    } catch (e) {
      console.warn(`[Partials] ${name} yÃ¼klenemedi:`, e.message);
    }
    return false;
  }

  // Modal aÃ§Ä±lmadan Ã¶nce iÃ§eriÄŸi yÃ¼kle
  async function ensureLoaded(name) {
    return _loaded.has(name) || await load(name);
  }

  // TÃ¼m visible trigger'larÄ± izle, yakÄ±nda gÃ¶rÃ¼necekleri Ã¶nceden yÃ¼kle
  function preloadVisible() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const name = entry.target.dataset.partial;
          if (name) load(name);
        }
      });
    }, { rootMargin: '200px' });

    document.querySelectorAll('[data-partial]').forEach(el => observer.observe(el));
  }

  // DOMContentLoaded'dan sonra Ã§alÄ±ÅŸtÄ±r
  function init() {
    preloadVisible();

    // Kritik partial'larÄ± hemen yÃ¼kle (settings modal sÄ±k kullanÄ±lÄ±r)
    setTimeout(() => {
      load('settings');
    }, 2000);
  }

  return { load, ensureLoaded, init, isLoaded: (n) => _loaded.has(n) };
})();

window.Partials = Partials;

// Sayfa hazÄ±r olduÄŸunda baÅŸlat
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Partials.init());
} else {
  Partials.init();
}

