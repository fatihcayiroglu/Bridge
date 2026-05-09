// client/js/core/web-push.js
// Tarayıcı Web Push abonelik yönetimi (VAPID)
//
//  ┌──────────────────────────────────────────────────────────┐
//  │  API                                                      │
//  │  WebPush.init()         → SW kayıt + mevcut durum yükle  │
//  │  WebPush.enable()       → izin iste + abone ol           │
//  │  WebPush.disable()      → aboneliği iptal et             │
//  │  WebPush.getState()     → 'unsupported'|'denied'|        │
//  │                           'granted'|'default'            │
//  │  WebPush.isSubscribed() → boolean                        │
//  └──────────────────────────────────────────────────────────┘
'use strict';
import { getAPI } from './globals.js';

(function (global) {

  // ── Destek kontrolü ─────────────────────────────────────────
  const supported = (
    'serviceWorker' in navigator &&
    'PushManager'   in window    &&
    'Notification'  in window
  );

  // ── Dahili durum ─────────────────────────────────────────────
  let _swReg        = null;   // ServiceWorkerRegistration
  let _subscription = null;   // PushSubscription | null
  let _vapidKey     = null;   // base64url string

  // ── Yardımcı: base64url → Uint8Array ─────────────────────────
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  // ── VAPID public key'i sunucudan al (tek seferlik) ───────────
  async function _fetchVapidKey() {
    if (_vapidKey) return _vapidKey;
    try {
      const r    = await fetch(`${getAPI() || ''}/api/webpush/vapid-public-key`);
      if (!r.ok) return null;
      const data = await r.json();
      _vapidKey  = data.publicKey || null;
      return _vapidKey;
    } catch {
      return null;
    }
  }

  // ── Aboneliği sunucuya kaydet ─────────────────────────────────
  async function _syncToServer(subscription) {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      const body = subscription.toJSON();
      await fetch(`${getAPI() || ''}/api/webpush/subscribe`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ endpoint: body.endpoint, keys: body.keys }),
      });
    } catch { /* non-fatal */ }
  }

  // ── Aboneliği sunucudan sil ───────────────────────────────────
  async function _removeFromServer(endpoint) {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      await fetch(`${getAPI() || ''}/api/webpush/unsubscribe`, {
        method:  'DELETE',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ endpoint }),
      });
    } catch { /* non-fatal */ }
  }

  // ── SW kaydını al / bekle ─────────────────────────────────────
  async function _getSwRegistration() {
    if (_swReg) return _swReg;
    if (!('serviceWorker' in navigator)) return null;
    try {
      // Zaten kayıtlı bir SW varsa kullan, yoksa kaydet
      _swReg = await navigator.serviceWorker.ready;
      return _swReg;
    } catch {
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /** Desteklenip desteklenmediği, mevcut izin ve abonelik durumunu yükle. */
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

  /** Kullanıcının aktif aboneliği var mı? */
  function isSubscribed() {
    return !!_subscription;
  }

  /**
   * Bildirim izni iste → pushManager.subscribe → sunucuya gönder.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async function enable() {
    if (!supported)         return { ok: false, reason: 'unsupported' };
    if (getState() === 'denied') return { ok: false, reason: 'denied' };

    const vapidKey = await _fetchVapidKey();
    if (!vapidKey) return { ok: false, reason: 'no_vapid_key' };

    // İzin iste (zaten 'granted' ise sorulmaz)
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
   * Aboneliği iptal et ve sunucudan sil.
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
   * Ayarlar modalı açıldığında toggle state'ini senkronize eder.
   * Çağrıyı setTimeout ile ertele — modal DOM'a eklendikten sonra.
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
        if (!supported)           { badge.textContent = '❌ Bu tarayıcı desteklenmiyor'; badge.style.color = 'var(--red)'; }
        else if (getState() === 'denied') { badge.textContent = '🚫 İzin reddedildi — tarayıcı ayarlarından açın'; badge.style.color = 'var(--red)'; }
        else if (on)              { badge.textContent = '✅ Bildirimler etkin'; badge.style.color = 'var(--green)'; }
        else                      { badge.textContent = '🔔 Kapalı'; badge.style.color = 'var(--text-muted)'; }
      }
    }, 0);
  }

  /**
   * Settings toggle onchange handler.
   * HTML: onchange="WebPush.onToggle(this.checked)"
   */
  async function onToggle(checked) {
    const badge = document.getElementById('push-notif-badge');
    if (badge) { badge.textContent = '⏳ İşleniyor...'; badge.style.color = 'var(--text-muted)'; }

    const result = checked ? await enable() : await disable();

    if (!result.ok && checked) {
      // Abone olamadık — toggle'ı geri al
      const chk = document.getElementById('push-notif-toggle');
      if (chk) chk.checked = false;
      const reason = {
        denied:          'Tarayıcı bildirim iznini reddetti. Adres çubuğundaki kilit simgesine tıklayarak izin verebilirsiniz.',
        no_vapid_key:    'Sunucu bildirim desteği henüz yapılandırılmamış.',
        no_sw:           'Service Worker bulunamadı.',
        permission_denied: 'Bildirim izni verilmedi.',
        unsupported:     'Bu tarayıcı Web Push desteklemiyor.',
      }[result.reason] || 'Bir hata oluştu.';
      if (badge) { badge.textContent = `⚠️ ${reason}`; badge.style.color = 'var(--yellow, #faa61a)'; }
      return;
    }

    syncToggleUI();
  }

  // ── Global olarak erişilebilir yap ───────────────────────────
  global.WebPush = { init, enable, disable, getState, isSubscribed, syncToggleUI, onToggle };

  // ── Sayfa yüklendiğinde otomatik init ────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);

export const web_pushReady = true;
