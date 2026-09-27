import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';

vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'http://test.local' }));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// KANONIK SOZLUGE DEVRET.
// Onceki cift yedek metin verilmeyen her cagriyi HAM ANAHTAR olarak
// donduruyordu; bu yuzden `api-error.ts` uzerinden gelen mesajlar testlerde
// `'error_unauthorized'` gibi gorunuyordu. Gercek urunde o metinler
// cevrilidir, yani cift urunun YAPMADIGI bir seyi olcuyordu.
vi.mock('../js/core/i18n/index', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { ...real };
});
vi.mock('../js/core/bridge-registry.ts', () => ({
  // Completed against the canonical BridgeRegistry surface.
  BridgeRegistry: { call: vi.fn(), get: vi.fn(), register: vi.fn(), unregister: vi.fn(), has: vi.fn(() => false) },
}));

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  document.body.innerHTML = `
    <div id="auth-msg"></div>
    <div id="auth-screen"></div>
    <div id="app" style="display:none"></div>
    <div id="my-avatar"></div><div id="my-username"></div>
    <div id="my-status-dot"></div><div id="my-tag"></div>
  `;
  (globalThis as Record<string, unknown>).currentUser = null;
  (globalThis as Record<string, unknown>).me = null;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SSO callback handoff', () => {
  it('consumes the HttpOnly handoff once and enters the canonical app session', async () => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback');
    fetchMock
      .mockResolvedValueOnce(response(200, { token: 'sso-access' }))
      .mockResolvedValueOnce(response(200, { user: { _id: 'u-sso', username: 'sso-user' } }));

    await expect(auth.consumeSsoSessionHandoff()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [handoffUrl, handoffInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(handoffUrl).toBe('http://test.local/api/sso/session');
    expect(handoffInit).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(handoffInit.redirect).toBe('error');
    expect(handoffInit.body).toBeUndefined();
    expect(new Headers(handoffInit.headers).get('Authorization')).toBeNull();

    const [meUrl, meInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(meUrl).toBe('http://test.local/api/me');
    expect(new Headers(meInit.headers).get('Authorization')).toBe('Bearer sso-access');
    expect(meInit.redirect).toBe('error');
    expect(localStorage.getItem('token')).toBe('sso-access');
    expect(localStorage.getItem('bridge_token')).toBe('sso-access');
    expect((globalThis as Record<string, unknown>).currentUser).toMatchObject({ _id: 'u-sso' });
    expect((document.getElementById('app') as HTMLElement).style.display).toBe('flex');
    expect(window.location.pathname).toBe('/');
  });

  it.each([
    [401, () => t('auth_sso_invalid')],
    [503, () => t('auth_service_unavailable')],
  ])('does not retry a failed single-use handoff (HTTP %s)', async (status, expected) => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback');
    fetchMock.mockResolvedValueOnce(response(status, { error: 'SSO handoff rejected' }));

    await expect(auth.consumeSsoSessionHandoff()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('token')).toBeNull();
    // Sunucunun gonderdigi metin (`SSO handoff rejected`) EKRANA BASILMAZ:
    // durum koduna gore kanonik ve cevrilmis mesaj gosterilir.
    const shown = document.getElementById('auth-msg')?.textContent ?? '';
    expect(shown).toBe(expected());
    expect(shown).not.toContain('SSO handoff rejected');
    expect(window.location.pathname).toBe('/');
  });

  it('ignores ordinary application routes', async () => {
    const auth = await import('../js/core/auth-compat.ts');
    await expect(auth.consumeSsoSessionHandoff()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes trailing slashes and accepts the direct /api/me user shape', async () => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback///');
    fetchMock
      .mockResolvedValueOnce(response(200, { token: 'direct-token' }))
      .mockResolvedValueOnce(response(200, { _id: 'direct-user', username: 'alice' }));
    await expect(auth.consumeSsoSessionHandoff()).resolves.toBe(true);
    expect((globalThis as Record<string, any>).currentUser?._id).toBe('direct-user');
  });

  it.each([
    [{}, 'auth_sso_session_failed'],
    [{ token: '' }, 'auth_sso_session_failed'],
    [{ token: 7 }, 'auth_sso_session_failed'],
  ])('rejects malformed successful handoff payload %j', async (payload, key) => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback');
    fetchMock.mockResolvedValueOnce(response(200, payload));
    await expect(auth.consumeSsoSessionHandoff()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('auth-msg')?.textContent).toBe(t(key));
  });

  it('uses bounded fallbacks for non-JSON handoff and /api/me bodies', async () => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback');
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 502, json: async () => { throw new SyntaxError('html'); },
    });
    await auth.consumeSsoSessionHandoff();
    // 502, `authResponseText` icindeki >=500 dalina duser: kanonik
    // "hizmet kullanilamiyor" metni. Cagiranin verdigi yedek yalnizca
    // siniflandirilamayan durumlarda kullanilir.
    expect(document.getElementById('auth-msg')?.textContent).toBe(t('auth_service_unavailable'));

    window.history.replaceState(null, '', '/sso-callback');
    fetchMock
      .mockResolvedValueOnce(response(200, { token: 'candidate' }))
      .mockResolvedValueOnce({
        ok: true, status: 200, json: async () => { throw new SyntaxError('empty'); },
      });
    await auth.consumeSsoSessionHandoff();
    expect(document.getElementById('auth-msg')?.textContent).toBe(t('auth_sso_user_unverified'));
  });

  // `/api/me` reddi `ApiResponseError` ile tasinir ve `api-error.ts` durum
  // koduna gore KANONIK metne esler. Sunucunun gonderdigi govde
  // (`token rejected`) kullaniciya ULASMAZ.
  it.each([
    [401, { error: 'token rejected' }, () => t('error_unauthorized')],
    [503, 'not-json-shape', () => t('error_server')],
  ])('fails closed when /api/me returns %s without persisting the candidate', async (status, body, expected) => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback');
    fetchMock
      .mockResolvedValueOnce(response(200, { token: 'candidate' }))
      .mockResolvedValueOnce(response(status, body));
    await auth.consumeSsoSessionHandoff();
    expect(localStorage.getItem('token')).toBeNull();
    const shown = document.getElementById('auth-msg')?.textContent ?? '';
    expect(shown).toBe(expected());
    expect(shown).not.toContain('token rejected');
  });

  it('a newer explicit session supersedes a handoff while /api/me JSON is pending', async () => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback');
    const json = deferred<unknown>();
    fetchMock
      .mockResolvedValueOnce(response(200, { token: 'stale-sso' }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => json.promise });
    const handoff = auth.consumeSsoSessionHandoff();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await auth.startApp('new-session', { _id: 'new-user' });
    json.resolve({ user: { _id: 'stale-user' } });
    await handoff;
    expect(localStorage.getItem('token')).toBe('new-session');
    expect((globalThis as Record<string, any>).currentUser?._id).toBe('new-user');
  });

  it('a newer transition supersedes a handoff before its one-time response arrives', async () => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback');
    const handoffResponse = deferred<Response>();
    fetchMock.mockImplementationOnce(() => handoffResponse.promise);
    const handoff = auth.consumeSsoSessionHandoff();
    await auth.startApp('new-session', { _id: 'new-user' });
    handoffResponse.resolve(response(200, { token: 'stale' }));
    await handoff;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('token')).toBe('new-session');
  });

  it('opaque thrown failures use the fixed generic message', async () => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback');
    fetchMock.mockRejectedValueOnce({ opaque: true });
    await auth.consumeSsoSessionHandoff();
    expect(document.getElementById('auth-msg')?.textContent).toBe('SSO oturumu tamamlanamadı.');
  });

  it.each([
    ['HTTP failure', () => Promise.resolve(response(503, { error: 'temporary' }))],
    ['network failure', () => Promise.reject(new Error('offline'))],
  ])('does not persist an unverified handoff token after %s', async (_label, meResult) => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback');
    fetchMock
      .mockResolvedValueOnce(response(200, { token: 'candidate-token' }))
      .mockImplementationOnce(meResult);

    await expect(auth.consumeSsoSessionHandoff()).resolves.toBe(true);

    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('bridge_token')).toBeNull();
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
  });

  it('rejects a 200 /api/me object without a stable user identity', async () => {
    const auth = await import('../js/core/auth-compat.ts');
    window.history.replaceState(null, '', '/sso-callback');
    fetchMock
      .mockResolvedValueOnce(response(200, { token: 'candidate-token' }))
      .mockResolvedValueOnce(response(200, { user: {} }));

    await expect(auth.consumeSsoSessionHandoff()).resolves.toBe(true);

    expect(localStorage.getItem('token')).toBeNull();
    expect(document.getElementById('auth-msg')?.textContent).toBe(t('auth_sso_user_unverified'));
  });
});
