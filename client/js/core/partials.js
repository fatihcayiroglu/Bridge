// client/js/core/partials.js
// Büyük modal/panel HTML'lerini lazy load eder
// index.html'i küçük tutar, ilk yükleme hızlanır

'use strict';

const Partials = (() => {
  const _loaded = new Set();

  // Partial HTML dosyalarını tanımla
  // key: partial adı, value: hangi element id'sine inject edileceği
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
      console.warn(`[Partials] ${name} yüklenemedi:`, e.message);
    }
    return false;
  }

  // Modal açılmadan önce içeriği yükle
  async function ensureLoaded(name) {
    return _loaded.has(name) || await load(name);
  }

  // Tüm visible trigger'ları izle, yakında görünecekleri önceden yükle
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

  // DOMContentLoaded'dan sonra çalıştır
  function init() {
    preloadVisible();

    // Kritik partial'ları hemen yükle (settings modal sık kullanılır)
    setTimeout(() => {
      load('settings');
    }, 2000);
  }

  return { load, ensureLoaded, init, isLoaded: (n) => _loaded.has(n) };
})();

// Sayfa hazır olduğunda başlat
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Partials.init());
} else {
  Partials.init();
}

export const getPartials = () => window.Partials;
