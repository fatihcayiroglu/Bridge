// Production-reachable branch contracts for the canonical HTTP client.
// These cases exercise concurrency, cross-tab takeover, CSRF recovery and
// terminal retry behavior without replacing the behavior-level auth suite.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = { token: null as string | null };
  return {
    state,
    saveToken: vi.fn((token: string) => { state.token = token; }),
    logout: vi.fn(() => { state.token = null; }),
    storageAvailable: vi.fn<() => boolean>(),
    tryAcquireLease: vi.fn<() => boolean>(),
    releaseLease: vi.fn(),
    publishResult: vi.fn(),
    waitForOtherTab: vi.fn<() => Promise<boolean>>(),
    register: vi.fn(),
    log: {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    },
  };
});

vi.mock('../js/core/globals.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../js/core/globals.ts')>()), getAPI: () => 'https://bridge.test' }));
vi.mock('../js/core/auth-compat.ts', () => ({
  readToken: () => mocks.state.token,
  saveToken: mocks.saveToken,
  logout: mocks.logout,
}));
vi.mock('../js/core/refresh-coordinator.ts', () => ({
  storageAvailable: mocks.storageAvailable,
  tryAcquireLease: mocks.tryAcquireLease,
  releaseLease: mocks.releaseLease,
  publishResult: mocks.publishResult,
  waitForOtherTab: mocks.waitForOtherTab,
}));
vi.mock('../js/core/logger.ts', () => ({ createLogger: () => mocks.log }));
vi.mock('../js/core/bridge-registry.ts', () => ({
  BridgeRegistry: { register: mocks.register },
}));

import {
  apiFetch, isRefreshInFlight, refreshAccessToken,
  resetCsrfState, resetRefreshState, wasLastRefreshAnonymous, wasLastRefreshFailureTransient,
} from '../js/core/api-fetch.ts';

function response(body: unknown = {}, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone: () => response(body, status),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.token = null;
  mocks.storageAvailable.mockReturnValue(false);
  mocks.tryAcquireLease.mockReturnValue(true);
  mocks.waitForOtherTab.mockResolvedValue(false);
  resetRefreshState();
  resetCsrfState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRefreshState();
  resetCsrfState();
});

describe('refreshAccessToken derin dallari', () => {
  it('sekme-ici eszamanli cagrilari tek fetchte birlestirir ve ucus durumunu bildirir', async () => {
    const pendingResponse = deferred<Response>();
    const fetchMock = vi.fn(() => pendingResponse.promise);
    vi.stubGlobal('fetch', fetchMock);

    const first = refreshAccessToken();
    const second = refreshAccessToken();
    expect(isRefreshInFlight()).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    pendingResponse.resolve(response({ token: 'fresh' }));
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(isRefreshInFlight()).toBe(false);
    expect(mocks.saveToken).toHaveBeenCalledWith('fresh');
  });

  it('diger sekmenin yeni tokenini kabul eder ve sunucuya istek gondermez', async () => {
    mocks.state.token = 'old';
    mocks.storageAvailable.mockReturnValue(true);
    mocks.tryAcquireLease.mockReturnValue(false);
    mocks.waitForOtherTab.mockImplementation(async () => {
      mocks.state.token = 'new-from-peer';
      return true;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshAccessToken()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.publishResult).toHaveBeenCalledWith(true);
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
  });

  it('diger sekme basarili dese de token degismediyse kirayi yeniden almadan durur', async () => {
    mocks.state.token = 'same';
    mocks.storageAvailable.mockReturnValue(true);
    mocks.tryAcquireLease.mockReturnValueOnce(false).mockReturnValueOnce(false);
    mocks.waitForOtherTab.mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn());

    await expect(refreshAccessToken()).resolves.toBe(false);
    expect(mocks.tryAcquireLease).toHaveBeenCalledTimes(2);
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('diger sekme basarisizsa suresi dolan kirayi devralip yeniler', async () => {
    mocks.storageAvailable.mockReturnValue(true);
    mocks.tryAcquireLease.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mocks.waitForOtherTab.mockResolvedValue(false);
    const fetchMock = vi.fn().mockResolvedValue(response({ token: 'taken-over' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshAccessToken()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.state.token).toBe('taken-over');
  });

  it('koordinator bekleyicisi reddederse basarisiz sonucu yayinlar ve kirayi birakir', async () => {
    mocks.storageAvailable.mockReturnValue(true);
    mocks.tryAcquireLease.mockReturnValue(false);
    mocks.waitForOtherTab.mockRejectedValue(new Error('coordinator failed'));
    vi.stubGlobal('fetch', vi.fn());

    await expect(refreshAccessToken()).rejects.toThrow('coordinator failed');
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.publishResult).toHaveBeenCalledWith(false);
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
  });

  it.each([
    [{}, 'missing'],
    [{ token: '' }, 'empty'],
  ])('gecersiz token govdesini reddeder (%s)', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(refreshAccessToken()).resolves.toBe(false);
    expect(mocks.saveToken).not.toHaveBeenCalled();
  });

  it('ag hatasini gecici false sonucuna cevirir ve ucus kilidini temizler', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(refreshAccessToken()).resolves.toBe(false);
    expect(wasLastRefreshFailureTransient()).toBe(true);
    expect(isRefreshInFlight()).toBe(false);
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('401 sonrasi refresh 503 ise kullaniciyi logout etmeden gecici 503 dondurur', async () => {
    mocks.state.token = 'expired';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({}, 503));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('/api/value');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.state.token).toBe('expired');
  });
});

describe('apiFetch derin dallari', () => {
  it('ozel Accept/credentials degerlerini korur ve typed yardimcisini calistirir', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ value: 7 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch<{ value: number }>('/api/value', {
      headers: { Accept: 'application/problem+json' }, credentials: 'omit',
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('Accept')).toBe('application/problem+json');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(init.credentials).toBe('omit');
    await expect(res.typed()).resolves.toEqual({ value: 7 });
  });

  it('eszamanli CSRF onarimlarinda jeton istegini tek ucurur', async () => {
    const csrfResponse = deferred<Response>();
    let csrfCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/csrf-token')) {
        csrfCalls += 1;
        return csrfResponse.promise;
      }
      const token = new Headers(init?.headers).get('X-CSRF-Token');
      return token ? response({ ok: true }) : response({ error: 'CSRF token missing' }, 403);
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = apiFetch('/api/a', { method: 'POST' });
    const second = apiFetch('/api/b', { method: 'POST' });
    await vi.waitFor(() => expect(csrfCalls).toBe(1));
    csrfResponse.resolve(response({ token: 'shared-csrf' }));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(csrfCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('bos CSRF tokeninda ozgun 403 yanitini tekrar etmeden dondurur', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: 'CSRF token missing' }, 403))
      .mockResolvedValueOnce(response({ token: '' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('/api/mutate', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('CSRF jeton ag hatasinda ozgun 403 yanitini korur', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: 'CSRF token missing' }, 403))
      .mockRejectedValueOnce(new Error('csrf endpoint offline'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('/api/mutate', { method: 'PATCH' });
    expect(res.status).toBe(403);
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('okunamayan 403 govdesini CSRF reddi saymaz', async () => {
    const broken = {
      ok: false,
      status: 403,
      json: async () => ({ error: 'original' }),
      clone: () => ({ json: async () => { throw new Error('invalid json'); } }),
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(broken);
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('/api/mutate', { method: 'POST' });
    expect(res).toBe(broken);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('mutasyon retryinda guncel tokeni tasir ve ikinci 401de oturumu kapatir', async () => {
    mocks.state.token = 'expired';
    const fetchMock = vi.fn()
      // Faz 18: oturum açık ve önbellekte CSRF jetonu yok → jeton ÖNCE alınır
      // (eskiden istek jetonsuz gidip garantili bir 403 ile geri dönüyordu).
      .mockResolvedValueOnce(response({ token: 'csrf-1' }))
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ token: 'renewed' }))
      .mockResolvedValueOnce(response({}, 401));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('/api/mutate', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/csrf-token');
    const retryInit = fetchMock.mock.calls[3]![1] as RequestInit;
    expect(new Headers(retryInit.headers).get('Authorization')).toBe('Bearer renewed');
    expect(mocks.logout).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    await expect(refreshAccessToken()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Final21 Faz 18 — GİRİŞ YAPMAMIŞ ZİYARETÇİ "SÜRESİ DOLMUŞ OTURUM" DEĞİLDİR
// ════════════════════════════════════════════════════════════════════════════
// Canlı ölçüm (taze tarayıcı profili, saklı jeton yok): 8 kimlikli GET 401 döndü,
// `POST /api/refresh` 400 "refreshToken required" verdi ve istemci DOKUZ kez
// "Oturum süresi doldu — çıkış yapılıyor" yazıp her seferinde `logout()` çağırdı —
// hiç giriş yapmamış biri için. Sunucu iki durumu zaten ayırıyor:
//   400 → ortada kimlik YOK (anonim)     401/403 → kimlik REDDEDİLDİ (süresi doldu)
describe('Final21 Faz 18 — anonim 401', () => {
  it('oturum yokken 401 çıkış TETİKLEMEZ ve süre doldu UYARISI basmaz', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401))   // korumalı uç
      .mockResolvedValueOnce(response({ error: 'refreshToken required' }, 400)); // refresh
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('https://bridge.test/api/dm');

    // 401 ÇAĞIRANA döner: giriş ekranını göstermek onun işidir.
    expect(res.status).toBe(401);
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(wasLastRefreshAnonymous()).toBe(true);
    const warnings = mocks.log.warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnings.some((w: string) => /Oturum süresi doldu/.test(w))).toBe(false);
  });

  it('aynı ziyaretçinin SONRAKİ istekleri de çıkış tetiklemez', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ error: 'refreshToken required' }, 400))
      .mockResolvedValue(response({}, 401));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('https://bridge.test/api/dm');
    await apiFetch('https://bridge.test/api/friends');
    await apiFetch('https://bridge.test/api/inbox');

    // Sınıflandırma korunur; yoksa ikinci istekten itibaren eski gürültü geri gelirdi.
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(wasLastRefreshAnonymous()).toBe(true);
  });

  it('POZİTİF KONTROL: gerçekten süresi dolmuş oturum (401) HÂLÂ çıkış yaptırır', async () => {
    mocks.state.token = 'eski-token';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ error: 'Invalid or expired refresh token' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('https://bridge.test/api/dm');

    expect(res.status).toBe(401);
    expect(mocks.logout).toHaveBeenCalled();
    expect(wasLastRefreshAnonymous()).toBe(false);
    const warnings = mocks.log.warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnings.some((w: string) => /Oturum süresi doldu/.test(w))).toBe(true);
  });

  it('geçici arıza (503) hâlâ oturumu KORUR', async () => {
    mocks.state.token = 'gecerli-token';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({}, 503));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('https://bridge.test/api/dm');

    expect(res.status).toBe(503);
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(wasLastRefreshFailureTransient()).toBe(true);
    expect(wasLastRefreshAnonymous()).toBe(false);
  });
});

// ── ANONİM KISA DEVRE ───────────────────────────────────────────────────────
// Oturumsuz olduğu belirlendikten SONRA her panel/yoklama isteği yalnızca 401
// üretir: istemcide konsol hatası, sunucu ölçümlerinde sahte 401 trafiği.
describe('Final21 Faz 18 — anonim kısa devre', () => {
  it('oturumsuz olduğu belirlendikten sonra istek AĞA ÇIKMAZ', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ error: 'refreshToken required' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('https://bridge.test/api/dm');      // 2 çağrı: istek + refresh
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const later = await apiFetch('https://bridge.test/api/inbox');
    expect(later.status).toBe(401);
    // Yeni ağ çağrısı YOK.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('erişim jetonu VARKEN kısa devre yapmaz (jeton yenilenmiş olabilir)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ error: 'refreshToken required' }, 400))
      .mockResolvedValue(response({ ok: true }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('https://bridge.test/api/dm');
    mocks.state.token = 'yeni-giris-jetonu';

    const res = await apiFetch('https://bridge.test/api/inbox');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('durum belirlenmeden ÖNCE istek gönderilir (jetonsuz ama çerezli kurtarma)', async () => {
    // Erişim jetonu yok ama refresh çerezi geçerli: istek çıkmalı, 401 alınmalı,
    // refresh başarılı olmalı ve istek TEKRARLANMALIDIR. Kısa devre bunu engellemez.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ token: 'kurtarilan-jeton' }, 200))
      .mockResolvedValueOnce(response({ ok: true }, 200));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('https://bridge.test/api/dm');

    expect(res.status).toBe(200);
    expect(mocks.saveToken).toHaveBeenCalledWith('kurtarilan-jeton');
    expect(mocks.logout).not.toHaveBeenCalled();
  });
});

// ── GİRİŞ ESKİ REDDİ SİLER ──────────────────────────────────────────────────
// Giriş bir SPA geçişidir; sayfa yeniden yüklenmez. Oturumsuz ziyarette alınan
// kalıcı yenileme reddi temizlenmezse, kişi giriş yaptıktan SONRA ilk jeton süresi
// dolduğunda sessizce yenilenmek yerine OTURUMDAN ATILIR.
describe('Final21 Faz 18 — bridge:auth-success yenileme durumunu sıfırlar', () => {
  it('oturumsuz 400 sonrası giriş yapılınca yenileme TEKRAR denenir', async () => {
    const anonymous = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ error: 'refreshToken required' }, 400));
    vi.stubGlobal('fetch', anonymous);
    await apiFetch('https://bridge.test/api/dm');
    expect(wasLastRefreshAnonymous()).toBe(true);

    // Kişi giriş yapar: jeton kaydedilir ve kanonik olay yayılır.
    mocks.state.token = 'yeni-oturum-jetonu';
    document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: {} }));

    // Jeton süresi dolar: yenileme GERÇEKTEN denenmeli ve başarılı olmalı.
    const afterLogin = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ token: 'yenilenen-jeton' }, 200))
      .mockResolvedValueOnce(response({ ok: true }, 200));
    vi.stubGlobal('fetch', afterLogin);

    const res = await apiFetch('https://bridge.test/api/inbox');

    expect(res.status).toBe(200);
    expect(mocks.saveToken).toHaveBeenCalledWith('yenilenen-jeton');
    // Oturum KORUNUR: eski red yüzünden çıkış yapılmaz.
    expect(mocks.logout).not.toHaveBeenCalled();
  });
});

describe('Final21 Faz 18 — ilk mutasyon garantili 403 üretmez', () => {
  it('oturum açıkken jeton ÖNCE alınır; istek jetonla gider, 403 yok', async () => {
    mocks.state.token = 'gecerli';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ token: 'csrf-abc' }))
      .mockResolvedValueOnce(response({ ok: true }, 200));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('https://bridge.test/api/me', { method: 'PATCH', body: '{}' });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/csrf-token');
    expect(new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers).get('X-CSRF-Token')).toBe('csrf-abc');
  });

  it('yeni giriş önceki kimliğin jetonunu TAŞIMAZ', async () => {
    mocks.state.token = 'kullanici-a';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ token: 'csrf-a' }))
      .mockResolvedValueOnce(response({ ok: true }, 200))
      .mockResolvedValueOnce(response({ token: 'csrf-b' }))
      .mockResolvedValueOnce(response({ ok: true }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('https://bridge.test/api/me', { method: 'PATCH', body: '{}' });
    mocks.state.token = 'kullanici-b';
    document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: {} }));
    await apiFetch('https://bridge.test/api/me', { method: 'PATCH', body: '{}' });

    expect(new Headers((fetchMock.mock.calls[3]![1] as RequestInit).headers).get('X-CSRF-Token')).toBe('csrf-b');
  });
});
