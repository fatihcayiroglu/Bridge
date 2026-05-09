// client/js/core/web-push.js
// TarayÄ±cÄ± Web Push abonelik yÃ¶netimi (VAPID)
//
//  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
//  â”‚  API                                                      â”‚
//  â”‚  WebPush.init()         â†’ SW kayÄ±t + mevcut durum yÃ¼kle  â”‚
//  â”‚  WebPush.enable()       â†’ izin iste + abone ol           â”‚
//  â”‚  WebPush.disable()      â†’ aboneliÄŸi iptal et             â”‚
//  â”‚  WebPush.getState()     â†’ 'unsupported'|'denied'|        â”‚
//  â”‚                           'granted'|'default'            â”‚
//  â”‚  WebPush.isSubscribed() â†’ boolean                        â”‚
//  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
'use strict';

(function (global) {

  // â”€â”€ Destek kontrolÃ¼ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const supported = (
    'serviceWorker' in navigator &&
    'PushManager'   in window    &&
    'Notification'  in window
  );

  // â”€â”€ Dahili durum â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let _swReg        = null;   // ServiceWorkerRegistration
  let _subscription = null;   // PushSubscription | null
  let _vapidKey     = null;   // base64url string

  // â”€â”€ YardÄ±mcÄ±: base64url â†’ Uint8Array â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  // â”€â”€ VAPID public key'i sunucudan al (tek seferlik) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _fetchVapidKey() {
    if (_vapidKey) return _vapidKey;
    try {
      const r    = await fetch(`${window.API || ''}/api/webpush/vapid-public-key`);
      if (!r.ok) return null;
      const data = await r.json();
      _vapidKey  = data.publicKey || null;
      return _vapidKey;
    } catch {
      return null;
    }
  }

  // â”€â”€ AboneliÄŸi sunucuya kaydet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _syncToServer(subscription) {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      const body = subscription.toJSON();
      await fetch(`${window.API || ''}/api/webpush/subscribe`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ endpoint: body.endpoint, keys: body.keys }),
      });
    } catch { /* non-fatal */ }
  }

  // â”€â”€ AboneliÄŸi sunucudan sil â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _removeFromServer(endpoint) {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      await fetch(`${window.API || ''}/api/webpush/unsubscribe`, {
        method:  'DELETE',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ endpoint }),
      });
    } catch { /* non-fatal */ }
  }

  // â”€â”€ SW kaydÄ±nÄ± al / bekle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _getSwRegistration() {
    if (_swReg) return _swReg;
    if (!('serviceWorker' in navigator)) return null;
    try {
      // Zaten kayÄ±tlÄ± bir SW varsa kullan, yoksa kaydet
      _swReg = await navigator.serviceWorker.ready;
      return _swReg;
    } catch {
      return null;
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // PUBLIC API
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /** Desteklenip desteklenmediÄŸi, mevcut izin ve abonelik durumunu yÃ¼kle. */
  async function init() {
    if (!supported) return;
    const reg = await _getSwRegistration();
    if (!reg) return;
    try {
      _subscription = await reg.pushManager.getSubscription();
    } catch { _subscription = null; }
  }

  /** Mevcut bildirim izni durumu */
  function getState() {
    if (!supported) return 'unsupported';
    return Notification.permission; // 'default' | 'granted' | 'denied'
  }

  /** KullanÄ±cÄ±nÄ±n aktif aboneliÄŸi var mÄ±? */
  function isSubscribed() {
    return !!_subscription;
  }

  /**
   * Bildirim izni iste â†’ pushManager.subscribe â†’ sunucuya gÃ¶nder.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async function enable() {
    if (!supported)         return { ok: false, reason: 'unsupported' };
    if (getState() === 'denied') return { ok: false, reason: 'denied' };

    const vapidKey = await _fetchVapidKey();
    if (!vapidKey) return { ok: false, reason: 'no_vapid_key' };

    // Ä°zin iste (zaten 'granted' ise sorulmaz)
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'permission_denied' };

    const reg = await _getSwRegistration();
    if (!reg) return { ok: false, reason: 'no_sw' };

    try {
      _subscription = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      await _syncToServer(_subscription);
      return { ok: true };
    } catch (err) {
      _subscription = null;
      return { ok: false, reason: err.message };
    }
  }

  /**
   * AboneliÄŸi iptal et ve sunucudan sil.
   * @returns {Promise<{ok:boolean}>}
   */
  async function disable() {
    if (!_subscription) return { ok: true };
    try {
      const endpoint = _subscription.endpoint;
      await _subscription.unsubscribe();
      _subscription = null;
      await _removeFromServer(endpoint);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Ayarlar modalÄ± aÃ§Ä±ldÄ±ÄŸÄ±nda toggle state'ini senkronize eder.
   * Ã‡aÄŸrÄ±yÄ± setTimeout ile ertele â€” modal DOM'a eklendikten sonra.
   */
  function syncToggleUI() {
    setTimeout(() => {
      const track = document.getElementById('push-toggle-track');
      const thumb = document.getElementById('push-toggle-thumb');
      const chk   = document.getElementById('push-notif-toggle');
      const badge = document.getElementById('push-notif-badge');
      if (!track || !thumb || !chk) return;

      const on = isSubscribed() && getState() === 'granted';
      chk.checked = on;

      // Track & thumb rengi
      track.style.background = on ? 'var(--brand, #5865f2)' : 'var(--bg-3)';
      thumb.style.left       = on ? 'calc(100% - 21px)'    : '3px';

      // Durum badge
      if (badge) {
        if (!supported)           { badge.textContent = 'âŒ Bu tarayÄ±cÄ± desteklenmiyor'; badge.style.color = 'var(--red)'; }
        else if (getState() === 'denied') { badge.textContent = 'ğŸš« Ä°zin reddedildi â€” tarayÄ±cÄ± ayarlarÄ±ndan aÃ§Ä±n'; badge.style.color = 'var(--red)'; }
        else if (on)              { badge.textContent = 'âœ… Bildirimler etkin'; badge.style.color = 'var(--green)'; }
        else                      { badge.textContent = 'ğŸ”” KapalÄ±'; badge.style.color = 'var(--text-muted)'; }
      }
    }, 0);
  }

  /**
   * Settings toggle onchange handler.
   * HTML: onchange="WebPush.onToggle(this.checked)"
   */
  async function onToggle(checked) {
    const badge = document.getElementById('push-notif-badge');
    if (badge) { badge.textContent = 'â³ Ä°ÅŸleniyor...'; badge.style.color = 'var(--text-muted)'; }

    const result = checked ? await enable() : await disable();

    if (!result.ok && checked) {
      // Abone olamadÄ±k â€” toggle'Ä± geri al
      const chk = document.getElementById('push-notif-toggle');
      if (chk) chk.checked = false;
      const reason = {
        denied:          'TarayÄ±cÄ± bildirim iznini reddetti. Adres Ã§ubuÄŸundaki kilit simgesine tÄ±klayarak izin verebilirsiniz.',
        no_vapid_key:    'Sunucu bildirim desteÄŸi henÃ¼z yapÄ±landÄ±rÄ±lmamÄ±ÅŸ.',
        no_sw:           'Service Worker bulunamadÄ±.',
        permission_denied: 'Bildirim izni verilmedi.',
        unsupported:     'Bu tarayÄ±cÄ± Web Push desteklemiyor.',
      }[result.reason] || 'Bir hata oluÅŸtu.';
      if (badge) { badge.textContent = `âš ï¸ ${reason}`; badge.style.color = 'var(--yellow, #faa61a)'; }
      return;
    }

    syncToggleUI();
  }

  // â”€â”€ Global olarak eriÅŸilebilir yap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  global.WebPush = { init, enable, disable, getState, isSubscribed, syncToggleUI, onToggle };

  // â”€â”€ Sayfa yÃ¼klendiÄŸinde otomatik init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);

