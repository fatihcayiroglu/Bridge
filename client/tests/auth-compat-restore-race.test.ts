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

async function loadAuth(readyState: DocumentReadyState = 'complete') {
  Object.defineProperty(document, 'readyState', { configurable: true, value: readyState });
  return import('../js/core/auth-compat.ts');
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
  vi.useRealTimers();
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
