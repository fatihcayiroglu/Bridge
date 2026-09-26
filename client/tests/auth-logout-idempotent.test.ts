// client/tests/auth-logout-idempotent.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ÇIKIŞ İDEMPOTANLIĞI — TEK OTURUM SÜRE DOLUMU = TEK GEÇİŞ
// ════════════════════════════════════════════════════════════════════════════
// GERİLEME TESTİ. Canlı denetimde ölçüldü: oturum süresi dolduğunda konsol bir
// HATA FIRTINASI üretiyordu — "çıkış yapılıyor" ~10×, kanal-listesi mount ~8×.
//
// KÖK NEDEN: `api-fetch.ts` refresh'i tek-uçuşlu, ama refresh başarısız olunca
// UÇUŞTAKİ HER 401 çağıranı ayrı ayrı `logout()` çağırıyordu ve `logout()`
// idempotent değildi: her çağrı bir `POST /api/logout`, bir `bridge:auth-logout`
// olayı, DOM takası ve tab geçişi yürütüyordu. N eşzamanlı 401 → N tam çıkış.
//
// Bu test üretim koşulunu birebir kurar (N ardışık `logout()` çağrısı) ve yan
// etkilerin YALNIZCA BİR KEZ çalıştığını doğrular. Eski davranış (guard yok) bu
// testi kesin olarak DÜŞÜRÜR — yani ayırt edicidir.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'http://test.local' }));

const shell = `
  <div id="auth-msg"></div>
  <div id="login-credentials"><input id="l-username" /><input id="l-password" /></div>
  <form id="login-form"><button class="btn-primary">Sign In</button></form>
  <div id="twofactor-login-form" style="display:none"><input id="l-2fa-code" /><button class="btn-primary">Verify</button></div>
  <form id="register-form"><button class="btn-primary">Create</button></form>
  <input id="r-username" /><input id="r-displayname" /><input id="r-password" />
  <div id="app"></div><div id="auth-screen"></div>
`;

let fetchMock: ReturnType<typeof vi.fn>;
let logoutEvents: number;
const onLogout = (): void => { logoutEvents += 1; };
const logoutPostCount = () =>
  fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/logout')).length;

beforeEach(() => {
  document.body.innerHTML = shell;
  localStorage.clear();
  logoutEvents = 0;
  // Adlandırılmış handler: afterEach'te KALDIRILIR ki testler arası sızmasın
  // (aksi halde `resetModules` sonrası ikinci test olayı iki kez sayardı).
  document.addEventListener('bridge:auth-logout', onLogout);
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  document.removeEventListener('bridge:auth-logout', onLogout);
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules();
});

describe('logout() tek oturum için idempotenttir', () => {
  it('N eşzamanlı 401 çağrısı TEK çıkış geçişi üretir (fırtına yok)', async () => {
    const { logout } = await import('../js/core/auth-compat.ts');

    // Uçuştaki 8 istek aynı anda 401 alıp logout()'u çağırıyormuş gibi.
    for (let i = 0; i < 8; i++) logout();

    expect(logoutEvents).toBe(1);            // TEK 'bridge:auth-logout'
    expect(logoutPostCount()).toBe(1);       // TEK POST /api/logout
    // Kullanıcıya dönük durum yine de doğru: giriş ekranı görünür.
    expect((document.getElementById('auth-screen') as HTMLElement).style.display).toBe('');
    expect((document.getElementById('app') as HTMLElement).style.display).toBe('none');
  });

  it('yeni oturum kurulunca guard sıfırlanır — sonraki süre dolumu yine temiz çalışır', async () => {
    const mod = await import('../js/core/auth-compat.ts');

    mod.logout(); mod.logout();               // ilk oturum: 1 geçiş
    expect(logoutEvents).toBe(1);
    expect(logoutPostCount()).toBe(1);

    // startApp'in yaptığı gibi guard'ı sıfırla (yeni geçerli oturum).
    mod.resetLogoutGuard();

    mod.logout(); mod.logout(); mod.logout(); // ikinci oturum: 1 geçiş DAHA
    expect(logoutEvents).toBe(2);
    expect(logoutPostCount()).toBe(2);
  });
});
