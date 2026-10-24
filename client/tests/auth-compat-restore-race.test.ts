import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
const warnMock = vi.fn();
const registryCall = vi.fn();

vi.mock('../js/core/api-fetch.ts', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'http://test.local' }));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: warnMock, error: vi.fn(), debug: vi.fn() }),
}));
// KANONİK SÖZLÜĞE DEVRET.
// Önceki çift `(key, fallback) => fallback` biçimindeydi: yedek metni olmayan
// çağrılar HAM ANAHTAR döndürüyor, üçüncü argüman (`vars`) ise tamamen yok
// sayıldığı için `'{count} ses yüklendi'` gibi metinler YER TUTUCULARI
// YERLEŞTİRİLMEDEN kalıyordu. Böyle bir çift, ürünün yapmadığı bir davranışı
// ölçer; testler de gerçek metni değil çiftin kusurunu doğrular.
vi.mock('../js/core/i18n/index', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { ...real };
});
vi.mock('../js/core/bridge-registry.ts', () => ({
  BridgeRegistry: { call: registryCall, get: vi.fn(), register: vi.fn(), has: vi.fn(() => false) },
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

async function settleBootstrap(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const loadedAuthModules: Array<typeof import('../js/core/auth-compat.ts')> = [];

async function loadAuth(readyState: DocumentReadyState = 'complete') {
  Object.defineProperty(document, 'readyState', { configurable: true, value: readyState });
  const auth = await import('../js/core/auth-compat.ts');
  loadedAuthModules.push(auth);
  return auth;
}

beforeEach(() => {
  vi.resetModules();
  apiFetchMock.mockReset();
  warnMock.mockReset();
  registryCall.mockReset();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = `
    <div id="auth-msg"></div><div id="auth-screen"></div><div id="app" style="display:none"></div>
    <div id="my-avatar"></div><div id="my-username"></div>
    <div id="my-status-dot"></div><div id="my-tag"></div>
    <div class="auth-tab"></div><div class="auth-tab"></div>
  `;
  (globalThis as Record<string, unknown>).currentUser = null;
  (globalThis as Record<string, unknown>).me = null;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {})));
});

afterEach(() => {
  for (const auth of loadedAuthModules.splice(0)) auth.cancelTwoFactorLogin();
  vi.useRealTimers();
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session recovery after an offline cold start', () => {
  it.each(['online', 'native-network', 'native-resume', 'visible'])('retries a failed bootstrap on %s and restores the existing session', async (signal) => {
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(response(200, { _id: 'restored-user' }));
    await loadAuth();
    await vi.waitFor(() => expect(warnMock).toHaveBeenCalled());
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
    expect(localStorage.getItem('token')).toBe('stored');

    if (signal === 'online') window.dispatchEvent(new Event('online'));
    if (signal === 'native-network') window.dispatchEvent(new CustomEvent('bridge:network', { detail: { connected: true } }));
    if (signal === 'native-resume') window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } }));
    if (signal === 'visible') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    }

    await vi.waitFor(() => expect((globalThis as { currentUser?: { _id?: string } }).currentUser?._id).toBe('restored-user'));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(document.getElementById('app')?.style.display).toBe('flex');
    expect(document.getElementById('auth-screen')?.style.display).toBe('none');
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } }));
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces foreground/connectivity signals while recovery is pending and ignores inactive/offline signals', async () => {
    const recovery = deferred<Response>();
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockRejectedValueOnce(new TypeError('offline')).mockImplementationOnce(() => recovery.promise);
    await loadAuth();
    await vi.waitFor(() => expect(warnMock).toHaveBeenCalled());

    window.dispatchEvent(new CustomEvent('bridge:network', { detail: { connected: false } }));
    window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: false } }));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new CustomEvent('bridge:network', { detail: { connected: true } }));
    window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } }));
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    recovery.resolve(response(200, { _id: 'restored-user' }));
    await vi.waitFor(() => expect((globalThis as { currentUser?: { _id?: string } }).currentUser?._id).toBe('restored-user'));
  });

  it('waits for an external recovery signal after exhausting the existing transient retry budget', async () => {
    vi.useFakeTimers();
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockResolvedValue(response(503, {}));
    await loadAuth();
    await settleBootstrap();
    await vi.runAllTimersAsync();
    expect(apiFetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apiFetchMock).toHaveBeenCalledTimes(4);

    apiFetchMock.mockResolvedValueOnce(response(200, { _id: 'service-recovered' }));
    window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } }));
    await vi.runAllTimersAsync();
    expect(apiFetchMock).toHaveBeenCalledTimes(5);
    expect((globalThis as { currentUser?: { _id?: string } }).currentUser?._id).toBe('service-recovered');
  });

  it('does not schedule repeated requests when event-triggered recovery also fails offline', async () => {
    vi.useFakeTimers();
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockRejectedValue(new TypeError('offline'));
    await loadAuth();
    // Observe the actual failed request before simulating restored connectivity;
    // a fixed number of microtasks does not await the dynamic API import.
    await vi.waitFor(() => expect(warnMock).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('online'));
    await settleBootstrap();
    await vi.runAllTimersAsync();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
    expect(localStorage.getItem('token')).toBe('stored');
  });

  it.each([401, 403])('never restores an identity or registers recovery work after HTTP %s', async (status) => {
    localStorage.setItem('token', 'invalid');
    apiFetchMock.mockResolvedValueOnce(response(status, {}));
    await loadAuth();
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } }));
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledOnce();
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
  });

  it.each([401, 403])('stops deferred recovery when revalidation returns HTTP %s', async status => {
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(response(status, {}));
    await loadAuth();
    await vi.waitFor(() => expect(warnMock).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    await settleBootstrap();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } }));
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
  });

  it('logout cancels a deferred recovery before the device reconnects', async () => {
    localStorage.setItem('token', 'old-token');
    apiFetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const auth = await loadAuth();
    await vi.waitFor(() => expect(warnMock).toHaveBeenCalled());
    auth.logout();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } }));
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledOnce();
    expect(localStorage.getItem('token')).toBeNull();
  });

  it.each(['logout', 'new-login'])('ignores a late recovered identity after %s', async (transition) => {
    const recovery = deferred<Response>();
    localStorage.setItem('token', 'old-token');
    apiFetchMock.mockRejectedValueOnce(new TypeError('offline')).mockImplementationOnce(() => recovery.promise);
    const auth = await loadAuth();
    await vi.waitFor(() => expect(warnMock).toHaveBeenCalled());
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    if (transition === 'logout') auth.logout();
    else await auth.startApp('new-token', { _id: 'new-user' });
    recovery.resolve(response(200, { _id: 'old-user' }));
    await settleBootstrap();
    expect((globalThis as { currentUser?: { _id?: string } }).currentUser?._id ?? null).toBe(transition === 'logout' ? null : 'new-user');
    expect(localStorage.getItem('token')).toBe(transition === 'logout' ? null : 'new-token');
    window.dispatchEvent(new Event('online'));
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('bootstrap session restoration', () => {
  it('does no network work without a stored access token', async () => {
    await loadAuth();
    await settleBootstrap();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('restores a direct user response with redirect blocking', async () => {
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockResolvedValueOnce(response(200, { _id: 'u1', username: 'alice' }));
    await loadAuth();
    await vi.waitFor(() => expect((globalThis as Record<string, any>).currentUser?._id).toBe('u1'));
    expect(apiFetchMock.mock.calls[0]).toEqual([
      'http://test.local/api/me', { redirect: 'error' },
    ]);
    expect(localStorage.getItem('token')).toBe('stored');
  });

  it('uses a refreshed stored token and unwraps { user } responses', async () => {
    localStorage.setItem('token', 'expired');
    apiFetchMock.mockImplementationOnce(async () => {
      localStorage.setItem('token', 'refreshed');
      localStorage.setItem('bridge_token', 'refreshed');
      return response(200, { user: { id: 'u2', username: 'bob' } });
    });
    await loadAuth();
    await vi.waitFor(() => expect((globalThis as Record<string, any>).currentUser?.id).toBe('u2'));
    expect(localStorage.getItem('token')).toBe('refreshed');
  });

  it('retries 429/5xx with bounded exponential delays and recovers', async () => {
    vi.useFakeTimers();
    localStorage.setItem('token', 'stored');
    apiFetchMock
      .mockResolvedValueOnce(response(429, {}))
      .mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(response(200, { user: { _id: 'recovered' } }));
    await loadAuth();
    await settleBootstrap();
    await vi.runAllTimersAsync();
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
    expect((globalThis as Record<string, any>).currentUser?._id).toBe('recovered');
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('1000 ms'));
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('2000 ms'));
  });

  it('stops after the bounded transient retry budget', async () => {
    vi.useFakeTimers();
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockResolvedValue(response(503, {}));
    await loadAuth();
    await settleBootstrap();
    await vi.runAllTimersAsync();
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledTimes(4);
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
    expect(localStorage.getItem('token')).toBe('stored');
  });

  it('does not retry a non-transient rejection', async () => {
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockResolvedValueOnce(response(403, {}));
    await loadAuth();
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
  });

  it('bounds malformed JSON and transport exceptions without clearing a potentially valid token', async () => {
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => { throw new SyntaxError('html'); },
    });
    await loadAuth();
    await vi.waitFor(() => expect(warnMock)
      .toHaveBeenCalledWith('Oturum geri yüklenemedi', expect.any(SyntaxError)));
    expect(localStorage.getItem('token')).toBe('stored');

    vi.resetModules();
    apiFetchMock.mockReset().mockRejectedValueOnce(new Error('offline'));
    warnMock.mockReset();
    await loadAuth();
    await vi.waitFor(() => expect(warnMock)
      .toHaveBeenCalledWith('Oturum geri yüklenemedi', expect.any(Error)));
  });

  it('does not treat malformed successful identity payloads as sessions', async () => {
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockResolvedValueOnce(response(200, { user: [] }));
    await loadAuth();
    await settleBootstrap();
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
  });

  it('runs bootstrap exactly once after DOMContentLoaded when imported during parsing', async () => {
    localStorage.setItem('token', 'stored');
    apiFetchMock.mockResolvedValueOnce(response(200, { _id: 'dom-user' }));
    await loadAuth('loading');
    await settleBootstrap();
    expect(apiFetchMock).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('restore race invalidation', () => {
  it('logout while /api/me is pending cannot resurrect the old session', async () => {
    localStorage.setItem('token', 'old-token');
    const me = deferred<Response>();
    apiFetchMock.mockImplementationOnce(() => me.promise);
    const auth = await loadAuth();
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    auth.logout();
    me.resolve(response(200, { _id: 'old-user' }));
    await settleBootstrap();
    expect(localStorage.getItem('token')).toBeNull();
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
    expect((document.getElementById('app') as HTMLElement).style.display).toBe('none');
  });

  it('logout during retry backoff prevents the next credentialed request', async () => {
    vi.useFakeTimers();
    localStorage.setItem('token', 'old-token');
    apiFetchMock.mockResolvedValueOnce(response(429, {}));
    const auth = await loadAuth();
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    auth.logout();
    await vi.runAllTimersAsync();
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('logout while a retry request is pending ignores that late response', async () => {
    vi.useFakeTimers();
    localStorage.setItem('token', 'old-token');
    const retry = deferred<Response>();
    apiFetchMock
      .mockResolvedValueOnce(response(503, {}))
      .mockImplementationOnce(() => retry.promise);
    const auth = await loadAuth();
    await settleBootstrap();
    await vi.advanceTimersByTimeAsync(1_000);
    await settleBootstrap();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    auth.logout();
    retry.resolve(response(200, { _id: 'late-user' }));
    await settleBootstrap();
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
  });
});
