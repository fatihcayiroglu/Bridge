// P7 offline reload: a local-only session (no server authority yet) sends
// nothing but the /api/me validation; every other call gets the same offline
// answer the service worker gives, so callers fall back to local data.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../js/core/api-fetch.ts';
import { handleApiError } from '../js/core/api-error.ts';
import { setSessionAuthority } from '../js/core/session-authority.ts';

afterEach(() => {
  setSessionAuthority('none');
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('apiFetch in a local-only session', () => {
  it('answers every request except GET /api/me locally, as an offline network failure', async () => {
    localStorage.setItem('token', 'stored-token');
    const fetch = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    setSessionAuthority('local');

    for (const [url, method] of [['/api/servers', 'GET'], ['/api/messages/m1', 'DELETE'], ['/api/me', 'PATCH']] as const) {
      const res = await apiFetch(url, { method });
      expect(res.status).toBe(503);
      expect(res.headers.get('X-Bridge-Offline')).toBe('1');
      expect(handleApiError(res, { silent: true }).network).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();

    const me = await apiFetch('/api/me');
    expect(me.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a server-validated session is not affected', async () => {
    localStorage.setItem('token', 'stored-token');
    const fetch = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    setSessionAuthority('server');
    expect((await apiFetch('/api/servers')).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
