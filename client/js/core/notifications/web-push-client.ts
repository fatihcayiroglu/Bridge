// Canonical browser Web Push subscription owner for the production settings UI.
// Server authority: /api/webpush/* (VAPID + caller-scoped subscription storage).

import { t } from '../i18n/index.ts';
import { rememberWebEndpoint } from '../push-installation.ts';
export type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type WebPushReason =
  | 'unsupported'
  | 'permission_denied'
  | 'not_configured'
  | 'service_worker_unavailable'
  | 'server_unavailable'
  | 'subscribe_failed'
  | 'unsubscribe_failed';

export interface WebPushState {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  configured: boolean;
}

export interface WebPushResult {
  ok: boolean;
  reason?: WebPushReason;
}

const SERVER_SYNC_KEY = 'bridge_web_push_server_synced_v1';

function serverSyncEnabled(): boolean {
  try { return localStorage.getItem(SERVER_SYNC_KEY) === 'yes'; } catch { return false; }
}

function setServerSyncEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(SERVER_SYNC_KEY, 'yes');
    else localStorage.removeItem(SERVER_SYNC_KEY);
  } catch { /* storage can be disabled */ }
}

function supported(): boolean {
  return typeof window !== 'undefined'
    && 'Notification' in window
    && 'PushManager' in window
    && 'serviceWorker' in navigator;
}

function urlBase64ToApplicationServerKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  try { return await navigator.serviceWorker.ready; }
  catch { return null; }
}

async function fetchVapid(api: ApiFetch): Promise<string | null> {
  try {
    const res = await api('/api/webpush/vapid-public-key');
    if (!res.ok) return null;
    const body = await res.json() as { publicKey?: unknown };
    return typeof body.publicKey === 'string' && body.publicKey.length > 0 ? body.publicKey : null;
  } catch {
    return null;
  }
}

export async function getWebPushState(api: ApiFetch): Promise<WebPushState> {
  if (!supported()) {
    return { supported: false, permission: 'unsupported', subscribed: false, configured: false };
  }
  const [reg, vapid] = await Promise.all([registration(), fetchVapid(api)]);
  let subscription: PushSubscription | null = null;
  try { subscription = await reg?.pushManager.getSubscription() ?? null; } catch { subscription = null; }
  return {
    supported: true,
    permission: Notification.permission,
    subscribed: Boolean(subscription) && Notification.permission === 'granted' && serverSyncEnabled(),
    configured: Boolean(vapid),
  };
}

/**
 * Enable Web Push and prove server persistence before reporting success.
 * If this call created a new local subscription but server persistence fails,
 * it rolls the browser subscription back so UI state cannot become false-success.
 */
export async function enableWebPush(api: ApiFetch): Promise<WebPushResult> {
  if (!supported()) return { ok: false, reason: 'unsupported' };
  if (Notification.permission === 'denied') return { ok: false, reason: 'permission_denied' };

  const vapid = await fetchVapid(api);
  if (!vapid) return { ok: false, reason: 'not_configured' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'permission_denied' };

  const reg = await registration();
  if (!reg) return { ok: false, reason: 'service_worker_unavailable' };

  let subscription: PushSubscription | null = null;
  let created = false;
  try {
    subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToApplicationServerKey(vapid),
      });
      created = true;
    }
  } catch {
    return { ok: false, reason: 'subscribe_failed' };
  }

  try {
    const body = subscription.toJSON();
    const res = await api('/api/webpush/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: body.endpoint, keys: body.keys }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setServerSyncEnabled(true);
    rememberWebEndpoint(body.endpoint ?? null);
    return { ok: true };
  } catch {
    if (created) {
      try { await subscription.unsubscribe(); } catch { /* best-effort rollback */ }
    }
    return { ok: false, reason: 'server_unavailable' };
  }
}

/** Disable server delivery first, then retire the local browser subscription. */
export async function disableWebPush(api: ApiFetch): Promise<WebPushResult> {
  if (!supported()) return { ok: true };
  const reg = await registration();
  if (!reg) return { ok: false, reason: 'service_worker_unavailable' };

  let subscription: PushSubscription | null = null;
  try { subscription = await reg.pushManager.getSubscription(); }
  catch { return { ok: false, reason: 'unsubscribe_failed' }; }
  if (!subscription) { setServerSyncEnabled(false); rememberWebEndpoint(null); return { ok: true }; }

  try {
    const res = await api('/api/webpush/unsubscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    if (!res.ok) return { ok: false, reason: 'server_unavailable' };
    setServerSyncEnabled(false);
    rememberWebEndpoint(null);
  } catch {
    return { ok: false, reason: 'server_unavailable' };
  }

  try {
    const unsubscribed = await subscription.unsubscribe();
    if (!unsubscribed) return { ok: true, reason: 'unsubscribe_failed' };
  } catch {
    return { ok: true, reason: 'unsubscribe_failed' };
  }
  return { ok: true };
}

export async function sendTestWebPush(api: ApiFetch): Promise<WebPushResult> {
  try {
    const res = await api('/api/webpush/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: t('push_test_message') }),
    });
    if (!res.ok) return { ok: false, reason: res.status === 503 ? 'not_configured' : 'server_unavailable' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'server_unavailable' };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// P4 — A SIGNED-OUT BROWSER STOPS RECEIVING THE ACCOUNT'S PUSHES
// ════════════════════════════════════════════════════════════════════════════
// The subscription is browser-scoped, not session-scoped. Before P4 logout left
// it in place: on a shared computer the next person saw the previous account's
// DM/mention previews. The server row is removed by the logout request itself
// (auth-compat sends this endpoint); here the browser subscription is retired so
// even a missed logout request cannot keep delivery alive.
let sessionBound = false;

export function bindWebPushToSession(): void {
  if (sessionBound || typeof document === 'undefined') return;
  sessionBound = true;
  document.addEventListener('bridge:auth-logout', () => {
    setServerSyncEnabled(false);
    rememberWebEndpoint(null);
    if (!supported()) return;
    void registration()
      .then((reg) => reg?.pushManager.getSubscription() ?? null)
      .then((subscription) => subscription?.unsubscribe())
      .catch(() => { /* best effort: the server row is already gone with the logout request */ });
  });
}

/** Test hook. */
export function _resetWebPushSessionBindingForTest(): void { sessionBound = false; }
