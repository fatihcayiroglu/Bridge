// core/offline-banner.js
// Çevrimdışı banner: bağlantı kesilince göster, gelince gizle.
//
// Kullandığı sinyal kaynakları (öncelik sırası):
//   1. SW'den gelen SW_NETWORK_STATUS mesajı   (en güvenilir — gerçek API testi)
//   2. window online / offline olayları         (hızlı ama bazen yanlış pozitif)
//   3. Sayfa yüklenince SW'ye REQUEST_NETWORK_STATUS gönder
//
// Banner özellikleri:
//   • Sayfanın en üstüne sticky olarak monte edilir
//   • CSS transition ile kayarak açılır/kapanır
//   • Offline iken input alanı disabled + placeholder güncellenir
//   • Yeniden bağlanınca toast gösterilir + outbox pending sayısı bildirilir
//   • Offline cache'den yüklenen mesajlar için kanal başlığına rozet eklenir

(function initBridgeOfflineBanner() {
  'use strict';

  // ─── Sabitler ──────────────────────────────────────────────
  const BANNER_ID        = 'bridge-offline-banner';
  const RECONNECTED_ID   = 'bridge-reconnect-toast';
  const OFFLINE_INPUT_PLACEHOLDER = '✈️ Çevrimdışısın — mesajlar kuyrukta bekler';
  const RECONNECT_MSG    = '🟢 Bağlantı yeniden kuruldu';
  const CSS = `
    #${BANNER_ID} {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 99999;
      background: #ed4245;
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: .3px;
      text-align: center;
      padding: 0 12px;
      height: 0;
      overflow: hidden;
      transition: height 220ms cubic-bezier(.4,0,.2,1),
                  padding-top 220ms, padding-bottom 220ms;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      pointer-events: none;
      user-select: none;
    }
    #${BANNER_ID}.is-visible {
      height: 34px;
      padding-top: 6px;
      padding-bottom: 6px;
      pointer-events: auto;
    }
    #${BANNER_ID} .ob-icon { font-size: 15px; animation: ob-pulse 1.4s ease-in-out infinite; }
    @keyframes ob-pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

    #${RECONNECTED_ID} {
      position: fixed;
      bottom: 24px; left: 50%; transform: translateX(-50%) translateY(60px);
      z-index: 99999;
      background: #3ba55d;
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      padding: 9px 20px;
      border-radius: 20px;
      box-shadow: 0 4px 16px rgba(0,0,0,.35);
      transition: transform 280ms cubic-bezier(.4,0,.2,1), opacity 280ms;
      opacity: 0;
      pointer-events: none;
    }
    #${RECONNECTED_ID}.is-visible {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }

    /* Offline durumunda mesaj inputu soluklaştır */
    body.bridge-offline #msg-input {
      background: var(--input-bg, #1e2124) !important;
      opacity: .6;
      cursor: not-allowed;
    }
    body.bridge-offline .msg-send-btn {
      opacity: .4;
      pointer-events: none;
    }

    /* Offline cache'den yüklenince kanal başlığına rozet */
    .offline-cache-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 500;
      background: rgba(237,66,69,.18);
      color: #ed4245;
      border: 1px solid rgba(237,66,69,.3);
      border-radius: 10px;
      padding: 1px 7px;
      margin-left: 8px;
      vertical-align: middle;
      animation: ob-pulse 1.4s ease-in-out infinite;
    }
  `;

  // ─── DOM — banner & toast ───────────────────────────────────
  function injectStyles() {
    if (document.getElementById('bridge-offline-styles')) return;
    const style = document.createElement('style');
    style.id = 'bridge-offline-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function createBanner() {
    if (document.getElementById(BANNER_ID)) return;
    const el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `<span class="ob-icon">📡</span><span class="ob-text">Çevrimdışısın — geçmiş mesajlar önbellekten gösteriliyor</span>`;
    document.body.insertBefore(el, document.body.firstChild);
  }

  function createReconnectToast() {
    if (document.getElementById(RECONNECTED_ID)) return;
    const el = document.createElement('div');
    el.id = RECONNECTED_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'assertive');
    el.textContent = RECONNECT_MSG;
    document.body.appendChild(el);
  }

  // ─── Durum yönetimi ────────────────────────────────────────
  let _isOffline = false;
  let _reconnectTimer = null;
  let _originalInputPlaceholder = null;

  function setOffline() {
    if (_isOffline) return;
    _isOffline = true;
    clearTimeout(_reconnectTimer);

    document.body.classList.add('bridge-offline');

    const banner = document.getElementById(BANNER_ID);
    if (banner) banner.classList.add('is-visible');

    // Mesaj inputunu devre dışı bırak / placeholder güncelle
    const input = document.getElementById('msg-input');
    if (input) {
      _originalInputPlaceholder = input.placeholder;
      input.placeholder = OFFLINE_INPUT_PLACEHOLDER;
      input.dataset.offlineDisabled = '1';
    }

    // Kanal başlığına offline cache badge ekle
    _attachCacheBadge();

    window.dispatchEvent(new CustomEvent('bridge:offline'));
  }

  function setOnline(pendingCount = 0) {
    if (!_isOffline) return;
    _isOffline = false;

    document.body.classList.remove('bridge-offline');

    const banner = document.getElementById(BANNER_ID);
    if (banner) banner.classList.remove('is-visible');

    // Input'u geri al
    const input = document.getElementById('msg-input');
    if (input && input.dataset.offlineDisabled) {
      input.placeholder = _originalInputPlaceholder || 'Bir mesaj yaz…';
      delete input.dataset.offlineDisabled;
    }

    // Cache badge'ini kaldır
    _removeCacheBadge();

    // Yeniden bağlanma toast'u
    _showReconnectToast(pendingCount);

    window.dispatchEvent(new CustomEvent('bridge:online', { detail: { pendingCount } }));
  }

  function _showReconnectToast(pendingCount) {
    const el = document.getElementById(RECONNECTED_ID);
    if (!el) return;
    el.textContent = pendingCount > 0
      ? `${RECONNECT_MSG} — ${pendingCount} mesaj gönderiliyor…`
      : RECONNECT_MSG;
    el.classList.add('is-visible');
    clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(() => el.classList.remove('is-visible'), 3500);
  }

  function _attachCacheBadge() {
    _removeCacheBadge();
    const channelName = document.getElementById('channel-name') ||
                        document.querySelector('.channel-name-header') ||
                        document.querySelector('[data-channel-name]');
    if (!channelName) return;
    const badge = document.createElement('span');
    badge.className = 'offline-cache-badge';
    badge.id = 'bridge-cache-badge';
    badge.textContent = '📦 önbellek';
    channelName.appendChild(badge);
  }

  function _removeCacheBadge() {
    document.getElementById('bridge-cache-badge')?.remove();
  }

  // ─── Sinyal kaynakları ─────────────────────────────────────

  // 1) SW mesajı (en güvenilir)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'SW_NETWORK_STATUS') {
        event.data.online ? setOnline() : setOffline();
      }
      if (event.data?.type === 'OUTBOX_FLUSHED') {
        const remaining = event.data.remaining || 0;
        if (remaining === 0 && _isOffline === false) {
          _showReconnectToast(0);
        }
      }
    });

    // Sayfa yüklenince SW'ye mevcut durumu sor
    navigator.serviceWorker.ready.then(reg => {
      reg.active?.postMessage({ type: 'REQUEST_NETWORK_STATUS' });
    }).catch(() => {});
  }

  // 2) Tarayıcı online/offline (hızlı yedek)
  window.addEventListener('offline', () => setOffline());
  window.addEventListener('online',  () => {
    // Online olduğumuzda gerçek bir API isteği bekleyip SW onaylasın;
    // geçici olarak banner'ı kaldır ama _isOffline'ı hemen sıfırlama.
    // SW'den SW_NETWORK_STATUS{online:true} gelince setOnline() çağrılır.
    // Ancak SW yoksa hemen online kabul et:
    if (!('serviceWorker' in navigator)) setOnline();
    else {
      // SW varsa, 1.5s içinde SW onaylamazsa kendimiz online yap
      const guard = setTimeout(() => setOnline(), 1500);
      navigator.serviceWorker.ready.then(reg => {
        reg.active?.postMessage({ type: 'REQUEST_NETWORK_STATUS' });
      }).catch(() => { clearTimeout(guard); setOnline(); });
    }
  });

  // ─── Başlangıç durumu ──────────────────────────────────────
  function init() {
    injectStyles();
    createBanner();
    createReconnectToast();

    // İlk yüklemede navigator.onLine kontrolü
    if (!navigator.onLine) setOffline();
  }

  // DOM hazır olunca başlat
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ─── Genel API ─────────────────────────────────────────────
  // offlineCache.js'in "Offline cache shown" bildirimini yakala ve
  // badge'i doğru zamanda göster.
  window.addEventListener('bridge:messages-from-cache', () => {
    if (_isOffline) _attachCacheBadge();
  });

  // Diğer modüllerin durumu sorgulaması için
  window.bridgeOfflineBanner = {
    get isOffline() { return _isOffline; },
    setOffline,
    setOnline,
  };
})();

// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
export const offlineBannerReady = true;
