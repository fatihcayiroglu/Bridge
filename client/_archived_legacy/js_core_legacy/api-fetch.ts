// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ApiFetchPanel.svelte
//              client/js/core/api-fetch-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/api-fetch.ts
// Sprint 34: .js → .ts rename, JSDoc → TypeScript types
// Bağımlılıklar: globals.ts (getAPI)
// Tüketiciler  : auth.ts, servers.ts, messages/loader.ts, vb.

import { getAPI } from './globals.js';

let _token:        string | null = null;
let _refreshToken: string | null = null;

export function setToken(t: string | null):        void { _token = t; }
export function setRefreshToken(r: string | null): void { _refreshToken = r; }
export function getToken():        string | null { return _token; }
export function getRefreshToken(): string | null { return _refreshToken; }

function _currentToken(): string | null {
  return _token;
}

// ── Pending refresh — aynı anda tek istek ────────────────────────────────────
let _refreshPromise: Promise<boolean> | null = null;

export async function refreshAccessToken(): Promise<boolean> {
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async (): Promise<boolean> => {
    try {
      const r = await fetch(`${getAPI()}/api/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (!r.ok) return false;
      const d = await r.json() as { token?: string };
      setToken(d.token ?? null);
      localStorage.removeItem('bridge_refresh_token');
      return true;
    } catch {
      return false;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

export async function apiFetch(
  url: string,
  opts: RequestInit & { headers?: Record<string, string> } = {}
): Promise<Response> {
  opts.headers = Object.assign({}, opts.headers ?? {}, {
    Authorization: `Bearer ${_currentToken()}`,
  }) as Record<string, string>;
  opts.credentials = opts.credentials ?? 'include';

  let r = await fetch(url, opts);
  if (r.status === 401 && _refreshToken) {
    const ok = await refreshAccessToken();
    if (ok) {
      (opts.headers as Record<string, string>).Authorization = `Bearer ${_currentToken()}`;
      r = await fetch(url, opts);
    }
  }
  return r;
}
