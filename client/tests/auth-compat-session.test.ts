// client/tests/auth-compat-session.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// İSTEMCİ OTURUM DURUMU — JETON DEPOLAMA VE ÇIKIŞ TEMİZLİĞİ
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// `js/core/auth-compat.ts` 351 satırdır ve HİÇ testi yoktu. İstemci tarafı
// kimlik durumunun tamamı burada yaşar: jeton okuma/yazma, oturum geri
// yükleme ve ÇIKIŞ.
//
// ── ÇIKIŞ BİR GİZLİLİK SÖZLEŞMESİDİR ────────────────────────────────────────
// Üretim kodundaki yorum gerçek bir kusuru anlatıyor:
//
//   "Öncesinde hiçbir olay yayınlanmıyordu; taslak gibi kullanıcıya özel
//    görünür durumlar ekranda kalıp bir sonraki kullanıcıya sızabiliyordu."
//
// Yani çıkış yapmak jetonları silmekten ibaret değildir: kimlik sıfırlanmalı,
// `bridge:auth-logout` olayı YAYINLANMALI ve dinleyen modüller kullanıcıya
// özel durumlarını temizlemelidir. Paylaşılan bir bilgisayarda bu, bir
// kullanıcının taslağının diğerine görünmesi demektir.
//
// ── JETON ANAHTARI SÖZLEŞMESİ ───────────────────────────────────────────────
// `saveToken` İKİ anahtar birden yazar (`token` ve `bridge_token`) çünkü
// `SocketManager.svelte` aynı depolama sözleşmesini kullanır. Yalnızca birini
// yazmak, soketin kimliksiz kalmasına yol açar.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'http://test.local' }));
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

const _registryCalls: Array<{ ad: string; arg: unknown }> = [];
vi.mock('../js/core/bridge-registry.ts', () => ({
  BridgeRegistry: {
    call: (ad: string, arg: unknown) => { _registryCalls.push({ ad, arg }); },
    get: () => undefined,
    register: () => {},
    has: () => false,
  },
}));

import {
  readToken, saveToken, logout, startApp, switchAuthTab, showAuthMsg, resetLogoutGuard,
} from '../js/core/auth-compat.ts';

beforeEach(() => {
  localStorage.clear();
  _registryCalls.length = 0;
  document.body.innerHTML = `
    <div id="app"></div>
    <div id="auth-screen" style="display:none"></div>
    <div id="auth-msg"></div>
    <div id="my-avatar"></div><div id="my-username"></div>
    <div id="my-status-dot" class="online"></div><div id="my-tag"></div>
    <div id="login-credentials"></div><div id="twofactor-login-form"></div>
    <form id="login-form"></form><form id="register-form"></form>
    <input id="l-2fa-code" value="stale">
    <div class="auth-tab"></div><div class="auth-tab"></div>`;
  (globalThis as Record<string, unknown>).currentUser = { id: 'u1' };
  (globalThis as Record<string, unknown>).me = { id: 'u1' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => { vi.unstubAllGlobals(); });

// ════════════════════════════════════════════════════════════════════════════
// JETON DEPOLAMA SÖZLEŞMESİ
// ════════════════════════════════════════════════════════════════════════════
describe('jeton depolama', () => {
  it('saveToken HER İKİ anahtarı da yazar', () => {
    // SocketManager.svelte `bridge_token` okur; yalnizca `token` yazmak
    // soketi kimliksiz birakirdi.
    saveToken('jeton-abc');
    expect({
      token: localStorage.getItem('token'),
      bridge: localStorage.getItem('bridge_token'),
    }).toEqual({ token: 'jeton-abc', bridge: 'jeton-abc' });
  });

  it('readToken birincil anahtarı okur', () => {
    localStorage.setItem('token', 'birincil');
    expect(readToken()).toBe('birincil');
  });

  it('readToken YEDEK anahtara düşer', () => {
    // Eski surumlerden kalan oturumlar `bridge_token` tasiyabilir.
    localStorage.setItem('bridge_token', 'yedek');
    expect(readToken()).toBe('yedek');
  });

  it('jeton yoksa null döner', () => {
    expect(readToken()).toBeNull();
  });

  it('BOŞ dize jeton sayılmaz', () => {
    // Bos dize "giris yapilmis" gibi degerlendirilirse kullanici kimliksiz
    // bir oturuma dusurulur.
    localStorage.setItem('token', '');
    expect(readToken()).toBeNull();
  });

  it('depolama PATLARSA readToken çökmez', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('depolama kapali');
    });
    expect(() => readToken()).not.toThrow();
    expect(readToken()).toBeNull();
    spy.mockRestore();
  });

  it('depolama PATLARSA saveToken çökmez', () => {
    // Gizli sekmede/kisitli tarayicida depolama yazma atabilir; sayfa
    // oturumu yine calisabilmeli.
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('depolama kapali');
    });
    expect(() => saveToken('x')).not.toThrow();
    spy.mockRestore();
  });
});

describe('kanonik oturum kurulumu ve kullanıcı paneli', () => {
  it('doğrulanmış kullanıcıyı tek atomik yol üzerinden bütün sahiplerle paylaşır', async () => {
    const success = vi.fn();
    document.addEventListener('bridge:auth-success', success, { once: true });
    const user = {
      _id: 'u1', displayName: 'Alice Smith', username: 'alice', avatarColor: '#123456',
      status: 'idle', statusEmoji: '🌙', statusText: 'Odakta',
    };

    await startApp('access-token', user);

    expect(localStorage.getItem('token')).toBe('access-token');
    expect((globalThis as Record<string, unknown>).currentUser).toBe(user);
    expect(_registryCalls).toContainEqual({ ad: 'setMe', arg: user });
    expect(document.getElementById('my-avatar')?.textContent).toBe('AS');
    expect((document.getElementById('my-avatar') as HTMLElement).style.background).toBe('rgb(18, 52, 86)');
    expect(document.getElementById('my-status-dot')?.classList.contains('idle')).toBe(true);
    expect((document.getElementById('my-status-dot') as HTMLElement).dataset.status).toBe('idle');
    expect(document.getElementById('my-tag')?.textContent).toBe('🌙 Odakta');
    expect(document.getElementById('my-tag')?.title).toContain('Boşta');
    expect(document.getElementById('my-username')?.title).toBe('Alice Smith');
    expect((document.getElementById('auth-screen') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('app') as HTMLElement).style.display).toBe('flex');
    expect(success).toHaveBeenCalledTimes(1);
  });

  it('bilinmeyen presence ve eksik profil alanlarını fail-closed varsayılanlara eşler', async () => {
    await startApp('t1', { id: 'u1', username: 'Bob', status: 'invisible', statusEmoji: 7, statusText: ' ' });
    expect(document.getElementById('my-status-dot')?.classList.contains('offline')).toBe(true);
    expect(document.getElementById('my-tag')?.textContent).toBe('Çevrimdışı');
    expect(document.getElementById('my-tag')?.title).toBe('Çevrimdışı');

    await startApp('t2', { id: 'u2' });
    expect(document.getElementById('my-username')?.textContent).toBe(t('ui_bridge_user'));
    // Bas harfler ARTIK cevrilmis addan turetilir ('Bridge kullanicisi' -> 'BK').
    const fallbackName = t('ui_bridge_user');
    const initials = fallbackName.split(/\s+/).filter(Boolean).slice(0, 2)
      .map(part => part[0]?.toUpperCase() ?? '').join('');
    expect(document.getElementById('my-avatar')?.textContent).toBe(initials);
  });

  it('boş token, dizi, kimliksiz nesne ve boş kimliği kullanıcı saymaz', async () => {
    await expect(startApp('', { _id: 'u' })).rejects.toThrow('Geçersiz');
    await expect(startApp('t', [] as any)).rejects.toThrow('Geçersiz');
    await expect(startApp('t', {})).rejects.toThrow('Geçersiz');
    await expect(startApp('t', { username: '   ' })).rejects.toThrow('Geçersiz');
  });

  it('isteğe bağlı kabuk düğümleri yokken de doğrulanmış sayfa oturumu çalışır', async () => {
    document.body.innerHTML = '';
    await expect(startApp('t', { _id: 'u' })).resolves.toBeUndefined();
    expect((globalThis as Record<string, any>).currentUser?._id).toBe('u');
    showAuthMsg('görünmez');
  });
});

describe('auth görünüm geçişleri', () => {
  it('login/register sekmelerini, mesajı ve bekleyen kodu birlikte sıfırlar', () => {
    switchAuthTab('register');
    const tabs = [...document.querySelectorAll('.auth-tab')];
    expect(tabs[0].classList.contains('active')).toBe(false);
    expect(tabs[1].classList.contains('active')).toBe(true);
    expect((document.getElementById('login-form') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('register-form') as HTMLElement).style.display).toBe('');
    expect((document.getElementById('l-2fa-code') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('auth-msg') as HTMLElement).style.display).toBe('none');

    switchAuthTab('login');
    expect(tabs[0].classList.contains('active')).toBe(true);
    expect(tabs[1].classList.contains('active')).toBe(false);
    expect((document.getElementById('login-form') as HTMLElement).style.display).toBe('');
    expect((document.getElementById('register-form') as HTMLElement).style.display).toBe('none');
  });

  it('başarı ve hata mesajını textContent ile güvenli biçimde yazar', () => {
    showAuthMsg('<img src=x>', 'success');
    const msg = document.getElementById('auth-msg')!;
    expect(msg.textContent).toBe('<img src=x>');
    expect(msg.querySelector('img')).toBeNull();
    expect(msg.className).toBe('auth-success');
    showAuthMsg('hata');
    expect(msg.className).toBe('auth-error');
  });

  it('isteğe bağlı sekme/form düğümleri yokken geçiş çökmez', () => {
    document.body.innerHTML = '';
    expect(() => switchAuthTab('login')).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ÇIKIŞ — gizlilik sözleşmesi
// ════════════════════════════════════════════════════════════════════════════
describe('logout', () => {
  // `logout()` artık İDEMPOTENTtir: bir oturum için yalnızca BİR kez tam çalışır
  // (fırtına düzeltmesi — bkz. auth-logout-idempotent.test.ts). Her `it` mantıksal
  // olarak YENİ bir oturumdur; üretimde `startApp` guard'ı sıfırlar, testte biz.
  beforeEach(() => { resetLogoutGuard(); });

  it('ÜÇ jeton anahtarını da siler (refresh dahil)', () => {
    // `bridge_refresh_token` kalirsa oturum sessizce yeniden canlanabilirdi.
    localStorage.setItem('token', 'a');
    localStorage.setItem('bridge_token', 'a');
    localStorage.setItem('bridge_refresh_token', 'r');
    logout();
    expect({
      token:   localStorage.getItem('token'),
      bridge:  localStorage.getItem('bridge_token'),
      refresh: localStorage.getItem('bridge_refresh_token'),
    }).toEqual({ token: null, bridge: null, refresh: null });
  });

  it('KİMLİK global durumu sıfırlanır', () => {
    logout();
    expect({
      currentUser: (globalThis as Record<string, unknown>).currentUser,
      me:          (globalThis as Record<string, unknown>).me,
    }).toEqual({ currentUser: null, me: null });
  });

  it('registry setMe(null) ile bilgilendirilir', () => {
    logout();
    expect(_registryCalls).toContainEqual({ ad: 'setMe', arg: null });
  });

  it('bridge:auth-logout olayı YAYINLANIR', () => {
    // ASIL GIZLILIK KUSURU BUYDU: olay yayinlanmadigi icin kullaniciya ozel
    // gorunur durumlar (taslaklar) ekranda kalip SONRAKI kullaniciya
    // sizabiliyordu. Bu testi kaybetmek o sizintiyi geri getirir.
    const dinleyici = vi.fn();
    document.addEventListener('bridge:auth-logout', dinleyici);
    logout();
    expect(dinleyici).toHaveBeenCalledTimes(1);
    document.removeEventListener('bridge:auth-logout', dinleyici);
  });

  it('uygulama GİZLENİR, giriş ekranı GÖSTERİLİR', () => {
    logout();
    expect({
      app:  (document.getElementById('app') as HTMLElement).style.display,
      auth: (document.getElementById('auth-screen') as HTMLElement).style.display,
    }).toEqual({ app: 'none', auth: '' });
  });

  it('sunucuya çıkış isteği GÖNDERİLİR (kimlik bilgisiyle)', () => {
    // Sunucu tarafinda refresh cookie'si iptal edilmezse oturum yasamaya
    // devam ederdi.
    // P4: cerez `/api/refresh` yoluna kapsamlidir; istek DOGRUDAN kapsamli uca gider.
    // Eskiden `/api/logout` → 307 idi ve `redirect: 'error'` yuzunden hic izlenmiyordu
    // (olculdu: cikistan sonra /api/refresh → 200). Bkz. p4-session-logout.test.ts.
    logout();
    const cagri = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(String(cagri[0])).toMatch(/\/api\/refresh\/logout$/);
    expect((cagri[1] as { credentials?: string }).credentials).toBe('include');
    expect((cagri[1] as { redirect?: string }).redirect).toBe('error');
  });

  it('sunucu isteği BAŞARISIZ olsa bile yerel temizlik yapılır', () => {
    // Cevrimdisi cikis yapan kullanici, jetonlari diskte BIRAKMAMALI.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ag yok')));
    localStorage.setItem('token', 'a');
    expect(() => logout()).not.toThrow();
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('depolama silme kapalı ve kabuk eksik olsa bile bellek kimliğini temizler', () => {
    document.body.innerHTML = '';
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('privacy');
    });
    expect(() => logout()).not.toThrow();
    expect((globalThis as Record<string, unknown>).currentUser).toBeNull();
    remove.mockRestore();
  });
});
