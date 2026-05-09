// core/api-fetch.js
// ─────────────────────────────────────────────────────────────
// apiFetch + refreshAccessToken — globals.js ↔ auth.js
// döngüsünü kırmak için ayrı dosyaya taşındı.
//
// Bağımlılıklar: globals.js (getAPI)
// Tüketiciler  : auth.js, servers.js, messages/loader.js, vb.
// ─────────────────────────────────────────────────────────────

import { getAPI } from './globals.js';

// Token — api-fetch.js'in kendi yerel state'i
let _token = null;
let _refreshToken = null;

export function setToken(t) { _token = t; }
export function setRefreshToken(r) { _refreshToken = r; }
export function getToken() { return _token; }
export function getRefreshToken() { return _refreshToken; }

function _currentToken() {
  return _token;
}

// ── Pending refresh — aynı anda tek istek ────────────────────
let _refreshPromise = null;

export async function refreshAccessToken() {
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    try {
      const r = await fetch(`${getAPI()}/api/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (!r.ok) return false;
      const d = await r.json();
      setToken(d.token);
      localStorage.removeItem('bridge_refresh_token');
      return true;
    } catch { return false; }
    finally { _refreshPromise = null; }
  })();

  return _refreshPromise;
}

export async function apiFetch(url, opts = {}) {
  opts.headers = {
    ...(opts.headers || {}),
    Authorization: `Bearer ${_currentToken()}`,
  };
  opts.credentials = opts.credentials || 'include';

  let r = await fetch(url, opts);
  if (r.status === 401 && _refreshToken) {
    const ok = await refreshAccessToken();
    if (ok) {
      opts.headers.Authorization = `Bearer ${_currentToken()}`;
      r = await fetch(url, opts);
    }
  }
  return r;
}

