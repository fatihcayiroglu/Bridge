// client/js/core/native-push.ts
//
// P4 — NATIVE PUSH REGISTRATION, OWNED BY THE APP (not by the native bridge)
//
// The Capacitor bridge (mobile/capacitor-bridge.ts) owns the plugin calls; this module owns the
// server conversation. Before P4 the bridge posted the device token itself with
// `fetch('/api/mobile/push/register-native')`:
//   · a RELATIVE url — the packaged app's origin is https://localhost, so the request went to
//     the app itself, never to the Bridge server;
//   · a Bearer request without the CSRF header, which `enforceApiCsrf` rejects with 403.
// A native device therefore could never register for push. Here the token goes through
// `apiFetch` (API base, access-token refresh, CSRF) exactly like every other authenticated
// call.
//
// Session contract:
//   · sign-in (or account switch on the same phone) → the stored token is (re)registered; the
//     server moves an existing token to the new account (NotificationRepository.upsertNativeToken)
//   · sign-out → the token is sent with the logout request (push-installation.ts) so the server
//     removes this installation's row; the bridge also unregisters the token natively.

import { apiFetch } from './api-fetch.ts';
import { readToken } from './auth-compat.ts';
import { createLogger } from './logger.ts';
import { NATIVE_PLATFORM_KEY as PLATFORM_KEY, NATIVE_TOKEN_KEY as TOKEN_KEY } from './push-installation.ts';

const log = createLogger('NativePush');

type Platform = 'ios' | 'android' | 'unknown';

function readStored(): { token: string; platform: Platform } | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    const p = localStorage.getItem(PLATFORM_KEY);
    return { token, platform: p === 'ios' || p === 'android' ? p : 'unknown' };
  } catch {
    return null;
  }
}

function store(token: string, platform: Platform): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(PLATFORM_KEY, platform);
  } catch { /* storage disabled — the in-flight registration still happens */ }
}

function forget(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PLATFORM_KEY);
  } catch { /* no-op */ }
}

let inFlight: Promise<boolean> | null = null;

/** Registers the stored token for the signed-in account. Resolves true when the server stored it. */
export async function registerStoredNativeToken(): Promise<boolean> {
  const stored = readStored();
  if (!stored || !readToken()) return false;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await apiFetch('/api/mobile/push/register-native', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: stored.token, platform: stored.platform }),
      });
      if (!res.ok) log.warn(`Native push registration was rejected (${res.status})`);
      return res.ok;
    } catch (err) {
      log.warn('Native push registration failed', err);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function isPlatform(value: unknown): value is Platform {
  return value === 'ios' || value === 'android' || value === 'unknown';
}

let installed = false;
const listeners: Array<[EventTarget, string, EventListener]> = [];

function listen(target: EventTarget, type: string, handler: EventListener): void {
  target.addEventListener(type, handler);
  listeners.push([target, type, handler]);
}

export function initNativePush(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // The bridge reports the token it received from APNs/FCM.
  listen(window, 'bridge:native-push-token', (event) => {
    const detail = (event as CustomEvent<{ token?: unknown; platform?: unknown }>).detail;
    if (typeof detail?.token !== 'string' || !detail.token || detail.token.length > 4096) return;
    store(detail.token, isPlatform(detail.platform) ? detail.platform : 'unknown');
    void registerStoredNativeToken();
  });

  // A token received before sign-in (or kept from an earlier session) belongs to whoever signs in.
  listen(document, 'bridge:auth-success', () => { void registerStoredNativeToken(); });

  // Server-side removal rides on the logout request (auth-compat); the native side is unregistered
  // by the bridge. The local copy must not survive into the next person's session.
  listen(document, 'bridge:auth-logout', () => { forget(); });

  // The OS badge is cleared on the device by the bridge; the server-side count (iOS APNs badge)
  // is cleared here, through the authenticated client.
  listen(window, 'bridge:badge-cleared', () => {
    if (!readToken()) return;
    void apiFetch('/api/mobile/push/badge/clear', { method: 'POST' }).catch(() => {});
  });
}

/** Test hook: removes this instance's listeners. */
export function _resetNativePushForTest(): void {
  for (const [target, type, handler] of listeners.splice(0)) target.removeEventListener(type, handler);
  installed = false;
  inFlight = null;
}
