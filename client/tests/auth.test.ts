// client/tests/auth.test.ts
// Auth — CANLI sözleşme testleri (native Vitest/ESM).
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — LIVE_MOVED_CONTRACT + NATIVE_VITEST_MIGRATION
// ════════════════════════════════════════════════════════════════════════════
//
// ÇÖKME NEDENİ: dosya `loadAuthModule()` içinde CJS `require('../js/core/auth')`
// kullanıp named export'ları `global`e yayıyordu. `js/core/auth` ARTIK YOK;
// süit "Cannot find module '../js/core/auth'" ile toplanamıyordu ve içindeki
// 21 test "skipped" sayılıyordu. Jest→Vitest sözdizimi sorunu DEĞİLDİ:
// modül sahipliği taşınmıştı.
//
// BUGÜNKÜ SAHİPLER (kaynak doğrulandı):
//   js/core/api-fetch.ts    → apiFetch, refreshAccessToken, resetRefreshState
//   js/core/auth-compat.ts  → showAuthMsg, switchAuthTab, login, register,
//                             startApp, logout, readToken, saveToken
//
// 21 İDDİANIN TAMAMI CANLI SÖZLEŞMEYE EŞLENDİ (FULL_DEAD = 0). Üç iddia
// TAŞINMIŞ+DARALMIŞ olduğu için bugünkü davranışa göre yeniden ifade edildi;
// hiçbiri zayıflatılmadı:
//
//   [A] "refresh token yoksa" → refresh artık httpOnly `bridge_refresh`
//       COOKIE'sine dayanır (api-fetch.ts:9-12). localStorage'daki
//       `bridge_refresh_token` kapısı ÖLÜ. Bugünkü eşdeğer canlı sözleşme:
//       yenileme kullanılamaz durumdaysa (`_refreshDisabled`) fetch'e HİÇ
//       gidilmeden false döner.
//
//   [B] "startApp çağrıldı" → `startApp` MODÜL-YEREL binding ile çağrılır
//       (auth-compat.ts:174, :201). `globalThis.startApp` monkeypatch'i bu
//       çağrıyı YAKALAYAMAZ. Bunun yerine startApp'in BUGÜNKÜ gözlemlenebilir
//       etkileri doğrulanır: token kalıcılığı · `bridge:auth-success` olayı ·
//       auth-screen→app geçişi · currentUser durumu.
//       Ayrıca eski 3. argüman (`refreshToken`) üretimde YOK — startApp
//       2 parametrelidir (token, user).
//
//   [C] "lockout geri sayımı" → istemcide geri sayım YOK. `login()` 429'u da
//       diğer hatalar gibi `errorText(payload, ...)` ile gösterir
//       (auth-compat.ts:165-167). ÖLEN kısım istemci-içi sayaçtır; CANLI kalan
//       kısım kilit yanıtının kullanıcıya sessizce yutulmadan iletilmesidir.
//       Test bugünkü davranışı doğrular ve sahte zamanlayıcıyla geri sayımın
//       GERÇEKTEN olmadığını kanıtlar (mesaj 60 sn sonra değişmez).
//
// GÜVENLİK: 401 işleme, yenileme başarısızlığı, logout ve ağ hatası izolasyonu
// zayıflatılmadı. Test edilen fonksiyonların hiçbiri mock'lanmadı; yalnız dış
// sınır (`fetch`) mock'landı. Bu turda üretim kodu DEĞİŞTİRİLMEDİ.
//
// TOKEN GÜVENLİĞİ: sentetik token dizeleri yalnız bellek içinde karşılaştırılır;
// hiçbir token / Authorization / cookie değeri stdout'a yazılmaz.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// ── KOPYA METNİ TEST SABİTİ DEĞİLDİR ──────────────────────────────────────
// Bu dosya kimlik akışlarının kullanıcıya gösterdiği metinleri İNGİLİZCE ham
// dizgeler (`'Invalid credentials'`, `/fill in all fields/i`) ya da doğrudan
// SUNUCU/İSTİSNA metni (`'Network error'`) olarak bekliyordu. Üretim bu
// metinleri i18n sözlüğünden alır ve `api-error.ts` güvenlik sözleşmesi gereği
// ham sunucu/istisna ayrıntısını ASLA göstermez. Beklentiler bu yüzden
// anahtarın kendisinden türetilir; ayrıca ham metnin SIZMADIĞI da denetlenir.
import { t } from '../js/core/i18n/index.ts';

import {
  showAuthMsg,
  switchAuthTab,
  login,
  completeTwoFactorLogin,
  register,
  readToken,
  saveToken,
} from '../js/core/auth-compat.ts';

import {
  apiFetch,
  refreshAccessToken,
  resetRefreshState,
  wasLastRefreshFailureTransient,
} from '../js/core/api-fetch.ts';

// ─── Yardımcılar ────────────────────────────────────────────────────────────

type FetchMock = ReturnType<typeof vi.fn>;

/** Üretimin beklediği yüzey: ok · status · json(). */
function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: FetchMock;

/** Belirli bir yola giden çağrı sayısı — logout'un kendi fetch'ini dışlar. */
function callsTo(path: string): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(path)).length;
}

/** Kaynağın GERÇEKTEN sorguladığı seçiciler (auth-compat.ts taraması). */
function buildAuthDOM(): void {
  document.body.innerHTML = `
    <div id="auth-screen">
      <button class="auth-tab">Giriş</button>
      <button class="auth-tab">Kayıt</button>
      <div id="auth-msg"></div>
      <div id="login-form">
        <div id="login-credentials">
          <input  id="l-username" value="">
          <input  id="l-password" type="password" value="">
          <button class="btn-primary">Sign In</button>
        </div>
        <div id="twofactor-login-form" style="display:none">
          <input id="l-2fa-code" value="">
          <button class="btn-primary">Verify</button>
        </div>
      </div>
      <div id="register-form">
        <input  id="r-displayname" value="">
        <input  id="r-username"    value="">
        <input  id="r-password"    type="password" value="">
        <button class="btn-primary">Create Account</button>
      </div>
    </div>
    <div id="app" style="display:none">
      <div id="my-avatar"></div>
      <div id="my-username"></div>
    </div>
  `;
}

function setValue(id: string, value: string): void {
  (document.getElementById(id) as HTMLInputElement).value = value;
}

function authMsg(): HTMLElement {
  return document.getElementById('auth-msg') as HTMLElement;
}

/** `bridge:auth-success` dinleyicisi — her zaman sökülür. */
function captureAuthSuccess(): { detail: () => unknown; count: () => number; stop: () => void } {
  const seen: unknown[] = [];
  const handler = (event: Event): void => { seen.push((event as CustomEvent).detail); };
  document.addEventListener('bridge:auth-success', handler);
  return {
    detail: () => seen[0],
    count: () => seen.length,
    stop: () => document.removeEventListener('bridge:auth-success', handler),
  };
}

// ─── İzolasyon ──────────────────────────────────────────────────────────────

beforeEach(() => {
  buildAuthDOM();
  localStorage.clear();

  // api-fetch.ts modül-düzeyi durumu (_refreshPromise / _refreshDisabled).
  resetRefreshState();

  // startApp/logout globalThis'e yazar — testler arası sızmasın.
  delete (globalThis as Record<string, unknown>).currentUser;
  delete (globalThis as Record<string, unknown>).me;

  fetchMock = vi.fn(async () => jsonResponse(200, {}));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
  localStorage.clear();
  delete (globalThis as Record<string, unknown>).currentUser;
  delete (globalThis as Record<string, unknown>).me;
});

// ════════════════════════════════════════════════════════════════════════════
// apiFetch — api-fetch.ts:90
// ════════════════════════════════════════════════════════════════════════════
describe('apiFetch()', () => {
  it('token varken Authorization header ekler', async () => {
    saveToken('test-jwt-token');

    await apiFetch('/api/servers');

    // withAuth `new Headers(...)` kurar (api-fetch.ts:74) — düz nesne DEĞİL.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;

    expect(headers.get('Authorization')).toBe('Bearer test-jwt-token');
    // Aynı sözleşmenin diğer yarısı: varsayılan Accept ve credentials.
    expect(headers.get('Accept')).toBe('application/json');
    expect(init.credentials).toBe('include');
  });

  it('401 alınca refresh dener, başarılıysa isteği TAM BİR KEZ tekrarlar', async () => {
    saveToken('expired-token');

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401))                              // orijinal
      .mockResolvedValueOnce(jsonResponse(200, { token: 'renewed-token' }))  // /api/refresh
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));               // retry

    const res = await apiFetch('/api/me');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callsTo('/api/me')).toBe(2);       // orijinal + tek retry
    expect(callsTo('/api/refresh')).toBe(1);  // tek yenileme
    expect(readToken()).toBe('renewed-token');
  });

  it('yenileme başarısızsa ORİJİNAL 401 yanıtını döndürür ve retry YAPMAZ', async () => {
    saveToken('expired-token');

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401))   // orijinal
      .mockResolvedValueOnce(jsonResponse(401));  // /api/refresh reddetti
    // Sonraki çağrılar (logout'un /api/logout'u) varsayılan mock'a düşer.

    const res = await apiFetch('/api/me');

    expect(res.status).toBe(401);
    expect(callsTo('/api/me')).toBe(1);        // TEKRAR DENENMEDİ
    // logout() yolu: oturum kimliği bırakıldı.
    expect(readToken()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// showAuthMsg — auth-compat.ts:72
// ════════════════════════════════════════════════════════════════════════════
describe('showAuthMsg()', () => {
  it('hata mesajını auth-error class ile gösterir', () => {
    showAuthMsg('Invalid credentials');

    expect(authMsg().className).toBe('auth-error');
    expect(authMsg().textContent).toBe('Invalid credentials');
    expect(authMsg().style.display).not.toBe('none');
  });

  it('başarı mesajını auth-success class ile gösterir', () => {
    showAuthMsg('Account created!', 'success');

    expect(authMsg().className).toBe('auth-success');
    expect(authMsg().textContent).toBe('Account created!');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// switchAuthTab — auth-compat.ts:80
// ════════════════════════════════════════════════════════════════════════════
describe('switchAuthTab()', () => {
  it('"login" sekmesi login-form\'u gösterir ve ilk sekmeyi aktifler', () => {
    switchAuthTab('login');

    expect(document.getElementById('login-form')!.style.display).not.toBe('none');
    expect(document.getElementById('register-form')!.style.display).toBe('none');

    const tabs = document.querySelectorAll('.auth-tab');
    expect(tabs[0].classList.contains('active')).toBe(true);
    expect(tabs[1].classList.contains('active')).toBe(false);
  });

  it('"register" sekmesi register-form\'u gösterir ve ikinci sekmeyi aktifler', () => {
    switchAuthTab('register');

    expect(document.getElementById('register-form')!.style.display).not.toBe('none');
    expect(document.getElementById('login-form')!.style.display).toBe('none');

    const tabs = document.querySelectorAll('.auth-tab');
    expect(tabs[1].classList.contains('active')).toBe(true);
    expect(tabs[0].classList.contains('active')).toBe(false);
  });

  it('sekme değişince auth-msg gizlenir', () => {
    showAuthMsg('önceki hata');
    expect(authMsg().style.display).not.toBe('none');

    switchAuthTab('login');

    expect(authMsg().style.display).toBe('none');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// login — auth-compat.ts:157
// ════════════════════════════════════════════════════════════════════════════
describe('login()', () => {
  it('alanlar boşken hata mesajı gösterir, fetch çağırmaz', async () => {
    setValue('l-username', '');
    setValue('l-password', '');

    await login();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(authMsg().textContent).toBe(t('adm_all_required'));
  });

  it('başarılı girişte oturum kurulur (startApp gözlemlenebilir etkileri)', async () => {
    // NOT: startApp modül-yerel çağrılır; spy YERİNE etkileri doğrulanır.
    const user = { id: '1', username: 'fatih', displayName: 'Fatih' };
    setValue('l-username', 'fatih');
    setValue('l-password', 'pass123');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'session-token', user }));

    const events = captureAuthSuccess();
    try {
      await login();

      expect(callsTo('/api/login')).toBe(1);
      expect(readToken()).toBe('session-token');             // saveToken
      expect(events.count()).toBe(1);                        // bridge:auth-success
      expect(events.detail()).toEqual(user);
      expect((globalThis as Record<string, unknown>).currentUser).toEqual(user);
      expect(document.getElementById('auth-screen')!.style.display).toBe('none');
      expect(document.getElementById('app')!.style.display).toBe('flex');
      expect(document.getElementById('my-username')!.textContent).toBe('Fatih');
    } finally {
      events.stop();
    }
  });

  it('[SECURITY] 2FA challenge tamamlanmadan oturum kurulmaz; tempToken servera geri gönderilir', async () => {
    const user = { id: '1', username: 'fatih', displayName: 'Fatih' };
    setValue('l-username', 'fatih');
    setValue('l-password', 'pass123');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(202, { requiresTwoFactor: true, tempToken: 'opaque-temp-token-12345678901234567890' }))
      .mockResolvedValueOnce(jsonResponse(200, { token: 'session-after-2fa', user }));

    await login();
    expect(readToken()).toBeNull();
    expect(document.getElementById('login-credentials')!.style.display).toBe('none');
    expect(document.getElementById('twofactor-login-form')!.style.display).not.toBe('none');

    setValue('l-2fa-code', '123456');
    await completeTwoFactorLogin();

    expect(readToken()).toBe('session-after-2fa');
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody).toEqual({ tempToken: 'opaque-temp-token-12345678901234567890', code: '123456' });
    expect(secondBody).not.toHaveProperty('userId');
  });

  it('hatalı kimlik bilgilerinde hata gösterir, oturum KURULMAZ', async () => {
    setValue('l-username', 'fatih');
    setValue('l-password', 'wrong');

    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Invalid credentials' }));

    const events = captureAuthSuccess();
    try {
      await login();

      // Sunucunun `error` gövdesi kullanıcıya SIZMAZ: 401 kanonik metne eşlenir.
      expect(authMsg().textContent).toBe(t('auth_invalid_credentials'));
      expect(authMsg().textContent).not.toContain('Invalid credentials');
      expect(authMsg().className).toBe('auth-error');
      expect(events.count()).toBe(0);          // startApp'e HİÇ ulaşılmadı
      expect(readToken()).toBeNull();
      expect(document.getElementById('app')!.style.display).not.toBe('flex');
    } finally {
      events.stop();
    }
  });

  it('kilit yanıtı (429) kullanıcıya iletilir — istemci geri sayımı YOKTUR', async () => {
    // TAŞINMIŞ+DARALMIŞ [C]: istemci-içi retryAfter sayacı üretimde yok.
    // Canlı kalan güvence: kilit yanıtı sessizce yutulmaz.
    vi.useFakeTimers();
    setValue('l-username', 'fatih');
    setValue('l-password', 'wrong');

    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { error: 'Hesap geçici olarak kilitli', locked: true, retryAfter: 60 }),
    );

    await login();

    expect(authMsg().textContent).toBe(t('auth_too_many_attempts'));
    expect(authMsg().className).toBe('auth-error');

    // Geri sayım OLSAYDI metin değişirdi; bugünkü sözleşmede sabit kalır.
    const afterShow = authMsg().textContent;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(authMsg().textContent).toBe(afterShow);
  });

  it('ağ hatası kullanıcıya iletilir, sessizce yutulmaz', async () => {
    setValue('l-username', 'fatih');
    setValue('l-password', 'pass');

    // Error fırlatılırsa mesajı gösterilir (auth-compat.ts:177).
    fetchMock.mockRejectedValueOnce(new Error('Network error'));
    await login();
    // İstisnanın `message`'ı da ham veridir; ağ hatası kanonik metne eşlenir.
    expect(authMsg().textContent).toBe(t('error_network'));
    expect(authMsg().textContent).not.toContain('Network error');
    expect(authMsg().className).toBe('auth-error');

    // Error DIŞI bir reddedişte genel bağlantı mesajına düşülür.
    fetchMock.mockRejectedValueOnce('boom');
    await login();
    expect(authMsg().textContent).toBe(t('auth_connection_failed'));
  });

  it('login sonrası buton enabled/text sıfırlanır', async () => {
    setValue('l-username', 'fatih');
    setValue('l-password', 'pass');
    const btn = document.querySelector('#login-form .btn-primary') as HTMLButtonElement;

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'tok', user: {} }));

    await login();

    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(t('sign_in'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// register — auth-compat.ts:183
// ════════════════════════════════════════════════════════════════════════════
describe('register()', () => {
  it('alanlar boşken fetch çağırmaz ve hata gösterir', async () => {
    setValue('r-username', '');
    setValue('r-password', '');

    await register();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(authMsg().textContent).toBe(t('adm_all_required'));
  });

  it('başarılı kayıtta oturum kurulur (startApp gözlemlenebilir etkileri)', async () => {
    const user = { id: '2', username: 'fatih42', displayName: 'Fatih' };
    setValue('r-displayname', 'Fatih');
    setValue('r-username', 'fatih42');
    setValue('r-password', 'secure123');

    fetchMock.mockResolvedValueOnce(jsonResponse(201, { token: 'new-session', user }));

    const events = captureAuthSuccess();
    try {
      await register();

      expect(callsTo('/api/register')).toBe(1);
      // displayName gövdeye dahil edilir (auth-compat.ts:193).
      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      expect(body.username).toBe('fatih42');
      expect(body.displayName).toBe('Fatih');

      expect(readToken()).toBe('new-session');
      expect(events.count()).toBe(1);
      expect(events.detail()).toEqual(user);
      expect(document.getElementById('app')!.style.display).toBe('flex');
    } finally {
      events.stop();
    }
  });

  it('kullanıcı adı alındıysa sunucu hatasını gösterir', async () => {
    setValue('r-username', 'existing');
    setValue('r-password', 'gecerli-parola'); // Faz 18: kurala uyan girdi (yanıt işlenişi ölçülüyor)

    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'Username already taken' }));

    await register();

    expect(authMsg().textContent).toBe(t('auth_username_taken'));
    expect(readToken()).toBeNull();
  });

  it('kayıt sonrası buton enabled/text sıfırlanır', async () => {
    setValue('r-username', 'newuser');
    setValue('r-password', 'gecerli-parola'); // Faz 18: kurala uyan girdi (yanıt işlenişi ölçülüyor)
    const btn = document.querySelector('#register-form .btn-primary') as HTMLButtonElement;

    fetchMock.mockResolvedValueOnce(jsonResponse(201, { token: 't', user: {} }));

    await register();

    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(t('create_account'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// refreshAccessToken — api-fetch.ts:36
// ════════════════════════════════════════════════════════════════════════════
describe('refreshAccessToken()', () => {
  it('yenileme kullanılamaz durumdayken fetch\'e GİTMEDEN false döner', async () => {
    // TAŞINMIŞ [A]: localStorage refresh-token kapısı yok; kapı `_refreshDisabled`.
    fetchMock.mockResolvedValueOnce(jsonResponse(401));
    expect(await refreshAccessToken()).toBe(false);   // kalıcı olarak devre dışı bıraktı

    fetchMock.mockClear();
    expect(await refreshAccessToken()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('başarılı yenileme token\'ı kaydeder ve true döner', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'refreshed-token' }));

    expect(await refreshAccessToken()).toBe(true);
    expect(readToken()).toBe('refreshed-token');
    // saveToken her iki anahtarı da yazar (auth-compat.ts:46-48).
    expect(localStorage.getItem('bridge_token')).toBe('refreshed-token');

    // Sözleşme: POST + cookie taşıyan credentials.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/refresh');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('geçici sunucu hatasında oturumu kalıcı olarak kilitlemeden false döner', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500));

    expect(await refreshAccessToken()).toBe(false);
    expect(wasLastRefreshFailureTransient()).toBe(true);
    expect(readToken()).toBeNull();

    // 5xx kullanıcının refresh oturumunu geçersiz KANITLAMAZ; sonraki deneme
    // ağ/dependency düzeldiğinde tekrar sunucuya gidebilmelidir.
    expect(await refreshAccessToken()).toBe(false);
    expect(callsTo('/api/refresh')).toBe(2);
  });
});
