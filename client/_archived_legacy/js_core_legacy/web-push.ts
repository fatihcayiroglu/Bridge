// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/WebPushPanel.svelte
//              client/js/core/web-push-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/web-push.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Tarayıcı Web Push abonelik yönetimi (VAPID)

import { getAPI } from './globals.js';

// ── Tip tanımları ─────────────────────────────────────────────

type NotificationPermission = 'unsupported' | 'default' | 'granted' | 'denied';

interface EnableResult {
  ok: boolean;
  reason?: string;
}

interface DisableResult {
  ok: boolean;
}

// ── Destek kontrolü ─────────────────────────────────────────

const supported: boolean = (
  'serviceWorker' in navigator &&
  'PushManager'   in window &&
  'Notification'  in window
);

// ── Dahili durum ─────────────────────────────────────────────

let _swReg: ServiceWorkerRegistration | null = null;
let _subscription: PushSubscription | null = null;
let _vapidKey: string | null = null;

// ── Yardımcılar ──────────────────────────────────────────────

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function _fetchVapidKey(): Promise<string | null> {
  if (_vapidKey) return _vapidKey;
  try {
    const r = await fetch(`${getAPI() ?? ''}/api/webpush/vapid-public-key`);
    if (!r.ok) return null;
    const data = await r.json() as { publicKey?: string };
    _vapidKey = data.publicKey ?? null;
    return _vapidKey;
  } catch {
    return null;
  }
}

async function _syncToServer(subscription: PushSubscription): Promise<void> {
  try {
    const token = localStorage.getItem('token');
    if (!token) return;
    const body = subscription.toJSON();
    await fetch(`${getAPI() ?? ''}/api/webpush/subscribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ endpoint: body.endpoint, keys: body.keys }),
    });
  } catch { /* non-fatal */ }
}

async function _removeFromServer(endpoint: string): Promise<void> {
  try {
    const token = localStorage.getItem('token');
    if (!token) return;
    await fetch(`${getAPI() ?? ''}/api/webpush/unsubscribe`, {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ endpoint }),
    });
  } catch { /* non-fatal */ }
}

async function _getSwRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (_swReg) return _swReg;
  if (!('serviceWorker' in navigator)) return null;
  try {
    _swReg = await navigator.serviceWorker.ready;
    return _swReg;
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════

export async function init(): Promise<void> {
  if (!supported) return;
  const reg = await _getSwRegistration();
  if (!reg) return;
  try {
    _subscription = await reg.pushManager.getSubscription();
  } catch { _subscription = null; }
}

export function getState(): NotificationPermission {
  if (!supported) return 'unsupported';
  return Notification.permission as NotificationPermission;
}

export function isSubscribed(): boolean {
  return !!_subscription;
}

export async function enable(): Promise<EnableResult> {
  if (!supported)              return { ok: false, reason: 'unsupported' };
  if (getState() === 'denied') return { ok: false, reason: 'denied' };

  const vapidKey = await _fetchVapidKey();
  if (!vapidKey) return { ok: false, reason: 'no_vapid_key' };

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
    return { ok: false, reason: (err as Error).message };
  }
}

export async function disable(): Promise<DisableResult> {
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

export function syncToggleUI(): void {
  setTimeout(() => {
    const track = document.getElementById('push-toggle-track');
    const thumb = document.getElementById('push-toggle-thumb');
    const chk   = document.getElementById('push-notif-toggle') as HTMLInputElement | null;
    const badge = document.getElementById('push-notif-badge');
    if (!track || !thumb || !chk) return;

    const on = isSubscribed() && getState() === 'granted';
    chk.checked = on;
    track.style.background = on ? 'var(--brand, #2d9cdb)' : 'var(--bg-3)';
    thumb.style.left       = on ? 'calc(100% - 21px)'    : '3px';

    if (badge) {
      if (!supported)                    { badge.textContent = '❌ Bu tarayıcı desteklenmiyor'; badge.style.color = 'var(--red)'; }
      else if (getState() === 'denied')  { badge.textContent = '🚫 İzin reddedildi — tarayıcı ayarlarından açın'; badge.style.color = 'var(--red)'; }
      else if (on)                       { badge.textContent = '✅ Bildirimler etkin'; badge.style.color = 'var(--green)'; }
      else                               { badge.textContent = '🔔 Kapalı'; badge.style.color = 'var(--text-muted)'; }
    }
  }, 0);
}

export async function onToggle(checked: boolean): Promise<void> {
  const badge = document.getElementById('push-notif-badge');
  if (badge) { badge.textContent = '⏳ İşleniyor...'; badge.style.color = 'var(--text-muted)'; }

  const result = checked ? await enable() : await disable();

  if (!result.ok && checked) {
    const chk = document.getElementById('push-notif-toggle') as HTMLInputElement | null;
    if (chk) chk.checked = false;
    const reasonMap: Record<string, string> = {
      denied:            'Tarayıcı bildirim iznini reddetti. Adres çubuğundaki kilit simgesine tıklayarak izin verebilirsiniz.',
      no_vapid_key:      'Sunucu bildirim desteği henüz yapılandırılmamış.',
      no_sw:             'Service Worker bulunamadı.',
      permission_denied: 'Bildirim izni verilmedi.',
      unsupported:       'Bu tarayıcı Web Push desteklemiyor.',
    };
    const msg = (result.reason && reasonMap[result.reason]) ?? 'Bir hata oluştu.';
    if (badge) { badge.textContent = `⚠️ ${msg}`; badge.style.color = 'var(--yellow, #faa61a)'; }
    return;
  }

  syncToggleUI();
}

// ── Global bağlantı (HTML inline handler'ları için) ──────────
(window as unknown as Record<string, unknown>)['WebPush'] = { init, enable, disable, getState, isSubscribed, syncToggleUI, onToggle };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  void init();
}

export const web_pushReady = true;
