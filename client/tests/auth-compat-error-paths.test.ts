// client/tests/auth-compat-error-paths.test.ts
// ── KOPYA METNİ TEST SABİTİ DEĞİLDİR ──────────────────────────────────────
// Beklentiler i18n anahtarindan turetilir; ham metin sabitlemek testin
// davranis yerine bir dizgenin harflerini olcmesine yol aciyordu.
import { t } from '../js/core/i18n/index.ts';
//
// ════════════════════════════════════════════════════════════════════════════
// js/core/auth-compat.ts — GİRİŞ AKIŞININ HATA DALLARI
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR: `auth-compat.ts` üretim paketindeki EN GÜVENLİK-KRİTİK
// istemci modülü ve dal kapsamı %62.3 idi (61 kapsanmayan dal). Modül giriş,
// kayıt, 2FA ikinci adımı, oturum kurulumu ve çıkışı yönetir.
//
// Kapsanmayan dalların çoğu HATA yollarıydı — tam olarak sunucu tarafında bir
// P0'ın saklandığı sınıf (bir `.catch()` gövdesindeki import edilmemiş
// `logger`). Mutlu yolu test etmek bu sınıfı yakalamaz.
//
// Ölçülen davranışlar:
//   · eksik alanlar sunucuya İSTEK GÖNDERMEDEN reddedilir
//   · 202 + requiresTwoFactor → ikinci adım açılır, oturum AÇILMAZ
//   · 2FA kodu boşken istek gönderilmez
//   · 2FA reddi kullanıcıya gösterilir ve oturum AÇILMAZ
//   · sunucu bozuk yük döndürürse (token yok / user yok) oturum AÇILMAZ
//   · ağ hatası kullanıcıya okunabilir mesaj verir
//   · iptal, bekleyen 2FA jetonunu TEMİZLER (yeniden kullanılamaz)
//   · her yolda buton "busy" durumundan ÇIKAR (UI kilitlenmez)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Dış sınırlar — gerçek ağ ve gerçek uygulama başlatma çağrılmaz.
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'http://test.local' }));

const shell = `
  <div id="auth-msg"></div>
  <div id="login-credentials">
    <input id="l-username" />
    <input id="l-password" />
  </div>
  <form id="login-form"><button class="btn-primary">Sign In</button></form>
  <div id="twofactor-login-form" style="display:none">
    <input id="l-2fa-code" />
    <button class="btn-primary">Verify</button>
  </div>
  <form id="register-form"><button class="btn-primary">Create</button></form>
  <input id="r-username" /><input id="r-displayname" /><input id="r-password" />
  <div id="app"></div><div id="auth-screen"></div>
`;

function setValue(id: string, value: string): void {
  (document.getElementById(id) as HTMLInputElement).value = value;
}

function authMsg(): string {
  return document.getElementById('auth-msg')?.textContent ?? '';
}

function loginButton(): HTMLButtonElement {
  return document.querySelector('#login-form .btn-primary') as HTMLButtonElement;
}

function twoFactorVisible(): boolean {
  return (document.getElementById('twofactor-login-form') as HTMLElement).style.display !== 'none';
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = shell;
  localStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loadAuth() {
  return import('../js/core/auth-compat.ts');
}

// ════════════════════════════════════════════════════════════════════════════
describe('login — girdi doğrulama', () => {
  it('kullanıcı adı EKSİKKEN sunucuya istek GÖNDERİLMEZ', async () => {
    const auth = await loadAuth();
    setValue('l-username', '');
    setValue('l-password', 'parola123');

    await auth.login();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(authMsg()).toBe(t('adm_all_required'));
  });

  it('parola EKSİKKEN sunucuya istek GÖNDERİLMEZ', async () => {
    const auth = await loadAuth();
    setValue('l-username', 'ayse');
    setValue('l-password', '');

    await auth.login();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('form düğümleri tamamen yokken de eksik girdiyi güvenle reddeder', async () => {
    const auth = await loadAuth();
    document.body.innerHTML = '';
    await expect(auth.login()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('login — 2FA ikinci adımı', () => {
  it('202 + requiresTwoFactor OTURUM AÇMAZ, ikinci adımı gösterir', async () => {
    // ── EN ÖNEMLİ İDDİA ────────────────────────────────────────────────────
    // 202 yanıtı BAŞARILI GİRİŞ DEĞİLDİR. Token kaydedilirse ikinci faktör
    // tamamen atlanmış olurdu.
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      requiresTwoFactor: true, tempToken: 'gecici-jeton',
    }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');

    await auth.login();

    expect(twoFactorVisible()).toBe(true);
    expect(localStorage.getItem('token')).toBeNull();
    expect(loginButton().disabled).toBe(false);       // UI kilitlenmedi
  });

  it('202 geldiği hâlde tempToken YOKSA ikinci adım açılmaz', async () => {
    // Bozuk bir yanıt, kullanıcıyı doldurulamaz bir forma kilitlememeli.
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, { requiresTwoFactor: true }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');

    await auth.login();

    expect(twoFactorVisible()).toBe(false);
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('2FA kodu BOŞKEN sunucuya istek gönderilmez', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      requiresTwoFactor: true, tempToken: 'gecici-jeton',
    }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await auth.login();
    fetchMock.mockClear();

    setValue('l-2fa-code', '');
    await auth.completeTwoFactorLogin();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(authMsg()).toMatch(/kodunu girin/i);
  });

  it('2FA REDDEDİLİRSE oturum açılmaz ve mesaj gösterilir', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      requiresTwoFactor: true, tempToken: 'gecici-jeton',
    }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await auth.login();

    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Kod hatalı' }));
    setValue('l-2fa-code', '000000');
    await auth.completeTwoFactorLogin();

    expect(authMsg()).toMatch(/geçersiz|süresi dolmuş/i);
    expect(authMsg()).not.toContain('Kod hatalı');
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('iptal bekleyen 2FA jetonunu TEMİZLER', async () => {
    // Jeton bellekte kalsaydı, iptalden sonra kod girmek yine oturum açardı.
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      requiresTwoFactor: true, tempToken: 'gecici-jeton',
    }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await auth.login();

    auth.cancelTwoFactorLogin();
    expect(twoFactorVisible()).toBe(false);

    fetchMock.mockClear();
    setValue('l-2fa-code', '123456');
    await auth.completeTwoFactorLogin();

    expect(fetchMock).not.toHaveBeenCalled();   // jeton yok → istek yok
  });

  it('geçerli ikinci faktör oturumu kurar ve geçici jetonu tekrar kullanılamaz yapar', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      requiresTwoFactor: true, tempToken: 'gecici-jeton',
    }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await auth.login();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      token: 'access', user: { _id: 'u1', username: 'ayse' },
    }));
    setValue('l-2fa-code', '123456');

    await auth.completeTwoFactorLogin();

    expect(localStorage.getItem('token')).toBe('access');
    fetchMock.mockClear();
    await auth.completeTwoFactorLogin();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ user: { _id: 'u1' } }, 'token'],
    [{ token: 't', user: {} }, 'user'],
  ])('bozuk 2FA oturum yanıtını reddeder (%s)', async (completion) => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      requiresTwoFactor: true, tempToken: 'gecici-jeton',
    }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await auth.login();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, completion));
    setValue('l-2fa-code', '123456');
    await auth.completeTwoFactorLogin();
    expect(authMsg()).toBe(t('auth_session_failed'));
  });

  it('Error olmayan 2FA ağ reddini genel ve güvenli mesaja dönüştürür', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      requiresTwoFactor: true, tempToken: 'gecici-jeton',
    }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await auth.login();
    fetchMock.mockRejectedValueOnce('opaque');
    setValue('l-2fa-code', '123456');
    await auth.completeTwoFactorLogin();
    expect(authMsg()).toMatch(/başarısız/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('login — sunucu ve ağ hataları', () => {
  it('401 kullanıcıya sabit ürün mesajı gösterir ve ham gövdeyi yansıtmaz', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'SQL auth backend detail' }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'yanlis');

    await auth.login();

    expect(authMsg()).toContain('şifre hatalı');
    expect(authMsg()).not.toContain('SQL auth backend detail');
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('400 hata gövdesindeki message alanını DOMa yansıtmaz', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { message: 'Hesap kilitli' }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');

    await auth.login();
    expect(authMsg()).toContain('şifre hatalı');
    expect(authMsg()).not.toContain('Hesap kilitli');
  });

  it('hata gövdesi BOŞSA genel mesaj gösterilir', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');

    await auth.login();
    expect(authMsg()).toMatch(/kimlik doğrulama hizmeti/i);
  });

  it('JSON olmayan HTTP hatasını genel mesajla sınırlar', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 502, json: async () => { throw new SyntaxError('html'); },
    });
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await auth.login();
    expect(authMsg()).toMatch(/kimlik doğrulama hizmeti/i);
  });

  it('200 dönse bile TOKEN yoksa oturum açılmaz', async () => {
    // Bozuk/kısmi bir yanıt "giriş yapıldı" sayılmamalı.
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { user: { _id: 'u1' } }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');

    await auth.login();

    expect(localStorage.getItem('token')).toBeNull();
    expect(authMsg()).toBe(t('auth_session_failed'));
  });

  it('200 dönse bile USER yoksa oturum açılmaz', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'abc' }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');

    await auth.login();

    expect(localStorage.getItem('token')).toBeNull();
  });

  it('AĞ hatası okunabilir mesaj verir ve butonu serbest bırakır', async () => {
    const auth = await loadAuth();
    fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');

    await auth.login();

    expect(authMsg().length).toBeGreaterThan(0);
    expect(loginButton().disabled).toBe(false);   // UI KİLİTLENMEZ
  });

  it('Error olmayan ağ reddini sabit bağlantı mesajına dönüştürür', async () => {
    const auth = await loadAuth();
    fetchMock.mockRejectedValueOnce({ opaque: true });
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await auth.login();
    expect(authMsg()).toMatch(/sunucuya bağlanılamadı/i);
  });

  it('login butonu yoksa başarılı oturum yine kurulabilir', async () => {
    const auth = await loadAuth();
    loginButton().remove();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      token: 'access', user: { id: 'u1', username: 'ayse' },
    }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await expect(auth.login()).resolves.toBeUndefined();
    expect(localStorage.getItem('token')).toBe('access');
  });

  it('parola taşıyan istek 307/308 yönlendirmelerinde gövdeyi başka origin\'e iletmez', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    setValue('l-username', 'ayse');
    setValue('l-password', 'çok-gizli-parola');

    await auth.login();

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('daha eski ve yavaş login yanıtı yeni oturumu GERİ ALAMAZ', async () => {
    const auth = await loadAuth();
    const eski = deferred<Response>();
    const yeni = deferred<Response>();
    fetchMock.mockImplementationOnce(() => eski.promise).mockImplementationOnce(() => yeni.promise);

    setValue('l-username', 'eski');
    setValue('l-password', 'parola-1');
    const eskiGiris = auth.login();
    setValue('l-username', 'yeni');
    setValue('l-password', 'parola-2');
    const yeniGiris = auth.login();

    yeni.resolve(jsonResponse(200, { token: 'yeni-token', user: { _id: 'u-yeni', username: 'yeni' } }));
    await yeniGiris;
    eski.resolve(jsonResponse(200, { token: 'eski-token', user: { _id: 'u-eski', username: 'eski' } }));
    await eskiGiris;

    expect(localStorage.getItem('token')).toBe('yeni-token');
    expect((globalThis as Record<string, any>).currentUser?._id).toBe('u-yeni');
  });

  it('eski login ağ hatası yeni oturumun mesajını da durumunu da bozamaz', async () => {
    const auth = await loadAuth();
    const eski = deferred<Response>();
    fetchMock.mockImplementationOnce(() => eski.promise)
      .mockResolvedValueOnce(jsonResponse(200, { token: 'new', user: { _id: 'new-user' } }));
    setValue('l-username', 'eski'); setValue('l-password', 'p1');
    const oldAttempt = auth.login();
    setValue('l-username', 'yeni'); setValue('l-password', 'p2');
    await auth.login();
    const before = authMsg();
    eski.reject(new Error('stale network failure'));
    await oldAttempt;
    expect(localStorage.getItem('token')).toBe('new');
    expect(authMsg()).toBe(before);
  });

  it('kimlik alanı olmayan nesneyi 200 yanıtında kullanıcı saymaz', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'token', user: {} }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');

    await auth.login();

    expect(localStorage.getItem('token')).toBeNull();
    expect(authMsg()).toBe(t('auth_session_failed'));
  });
});

describe('2FA — yarış ve gizli veri aktarımı', () => {
  it('iptal edilen devam eden doğrulama sonradan oturum AÇAMAZ', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      requiresTwoFactor: true, tempToken: 'gecici-jeton',
    }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await auth.login();

    const kontrol = deferred<Response>();
    fetchMock.mockImplementationOnce(() => kontrol.promise);
    setValue('l-2fa-code', '123456');
    const tamamla = auth.completeTwoFactorLogin();
    auth.cancelTwoFactorLogin();
    kontrol.resolve(jsonResponse(200, {
      token: 'iptalden-sonra', user: { _id: 'u1', username: 'ayse' },
    }));
    await tamamla;

    expect(localStorage.getItem('token')).toBeNull();
    expect((globalThis as Record<string, any>).currentUser?._id).not.toBe('u1');
  });

  it('geçici jeton ve kod taşıyan istek yönlendirme izlemez', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      requiresTwoFactor: true, tempToken: 'gecici-jeton',
    }));
    setValue('l-username', 'ayse');
    setValue('l-password', 'parola123');
    await auth.login();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    setValue('l-2fa-code', '123456');

    await auth.completeTwoFactorLogin();

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ redirect: 'error' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('register — girdi doğrulama', () => {
  it('alanlar eksikken istek gönderilmez', async () => {
    const auth = await loadAuth();
    setValue('r-username', '');
    setValue('r-displayname', '');
    setValue('r-password', '');

    await auth.register();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parola taşıyan kayıt isteği yönlendirme izlemez', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {}));
    setValue('r-username', 'ayse');
    setValue('r-displayname', 'Ayşe');
    setValue('r-password', 'çok-gizli-parola');

    await auth.register();

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('başarılı kayıt aynı kanonik oturum yolunu kullanır', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      token: 'registered', user: { username: 'ayse' },
    }));
    setValue('r-username', 'ayse');
    setValue('r-displayname', '');
    setValue('r-password', 'parola123');
    await auth.register();
    expect(localStorage.getItem('token')).toBe('registered');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ displayName: '' });
  });

  it('Faz 18: formun ESKİ ipucuna uyan 7 karakterlik parola istekten önce, NEDENİYLE reddedilir', async () => {
    // Canlı ölçüm: form "min. 6" diyordu, sunucu 8 istiyordu; 7 karakter giren kişi genel
    // "Kayıt bilgileri geçersiz" mesajı görüyordu. Artık ağa gitmeden hangi kural olduğu söylenir.
    const auth = await loadAuth();
    setValue('r-username', 'yeni_kisi'); setValue('r-password', 'abc1234');
    await auth.register();
    expect(authMsg()).toBe(t('auth_err_password_short'));
    expect(fetchMock).not.toHaveBeenCalled();

    setValue('r-username', 'ayşe'); setValue('r-password', 'gecerli-parola');
    await auth.register();
    expect(authMsg()).toBe(t('auth_err_username_chars'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('kayıt hatalarında ham sunucu/transport ayrıntısını göstermeden güvenli durum mesajı verir', async () => {
    const auth = await loadAuth();
    // Faz 18: kayıt artık sunucunun kurallarını istekten ÖNCE denetler; bu testler sunucu
    // YANITININ işlenişini ölçtüğü için girdi kurallara uymalıdır (eskiden dolgu olarak 'p').
    setValue('r-username', 'ayse'); setValue('r-password', 'gecerli-parola');

    fetchMock.mockResolvedValueOnce(jsonResponse(409, { message: 'already exists' }));
    await auth.register();
    expect(authMsg()).toMatch(/kullanıcı adı.*kullanılıyor/i);
    expect(authMsg()).not.toContain('already exists');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 't', user: [] }));
    await auth.register();
    expect(authMsg()).toBe(t('auth_session_failed'));

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await auth.register();
    expect(authMsg()).toBe(t('error_network'));
    expect(authMsg()).not.toBe('offline');

    fetchMock.mockRejectedValueOnce({ opaque: true });
    await auth.register();
    expect(authMsg()).toMatch(/sunucuya bağlanılamadı/i);
  });

  it('eski kayıt yanıtı daha yeni giriş oturumunu değiştiremez', async () => {
    const auth = await loadAuth();
    const old = deferred<Response>();
    fetchMock.mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(jsonResponse(200, { token: 'login', user: { _id: 'u-login' } }));
    // Faz 18: kayıt artık sunucunun kurallarını istekten ÖNCE denetler; bu testler sunucu
    // YANITININ işlenişini ölçtüğü için girdi kurallara uymalıdır (eskiden dolgu olarak 'p').
    setValue('r-username', 'register'); setValue('r-password', 'gecerli-parola');
    const registration = auth.register();
    setValue('l-username', 'login'); setValue('l-password', 'p');
    await auth.login();
    old.resolve(jsonResponse(200, { token: 'register', user: { _id: 'u-register' } }));
    await registration;
    expect(localStorage.getItem('token')).toBe('login');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('token depolama', () => {
  it('depolama ERİŞİLEMEZKEN readToken çökmez', async () => {
    // Gizli sekme / kota hatası oturumu patlatmamalı.
    const auth = await loadAuth();
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(auth.readToken()).toBeNull();
    spy.mockRestore();
  });

  it('depolama ERİŞİLEMEZKEN saveToken çökmez', async () => {
    const auth = await loadAuth();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => auth.saveToken('abc')).not.toThrow();
    spy.mockRestore();
  });

  it('her iki depolama anahtarı da okunur (geriye dönük uyumluluk)', async () => {
    const auth = await loadAuth();
    localStorage.setItem('bridge_token', 'eski-anahtar');
    expect(auth.readToken()).toBe('eski-anahtar');
  });
});
