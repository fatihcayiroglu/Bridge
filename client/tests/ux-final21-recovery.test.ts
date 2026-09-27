// client/tests/ux-final21-recovery.test.ts
//
// Final21 UX turu — HESAP KURTARMA (U-01) ve KENDİ VARLIK DURUMU (U-04)
//
// U-01: sunucuda şifre sıfırlama vardı ama istemcide hiçbir giriş noktası yoktu
// (girişte "Şifremi unuttum" yok, e-postadaki /reset-password bağlantısı API 404'üne
// düşüyordu, e-posta eklemenin yeri yoktu). Şifresini unutan kullanıcı hesabını kaybediyordu.
// U-04: kullanıcı paneli bir HTTP yanıtının anlık görüntüsüydü; sunucu oluşturma soketi
// kapatıp açarken alınan `/api/me` "offline" döndü ve panel yeniden yüklemeye dek
// "Çevrimdışı" kaldı.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'http://test.local' }));

const registryCalls: Array<{ ad: string; args: unknown[] }> = [];
let toastRegistered = false;
vi.mock('../js/core/bridge-registry.ts', () => ({
  BridgeRegistry: {
    call: (ad: string, ...args: unknown[]) => { registryCalls.push({ ad, args }); },
    get: () => undefined,
    register: () => {},
    has: (ad: string) => ad === 'toast' && toastRegistered,
  },
}));

const AUTH_DOM = `
  <div id="app"></div><div id="auth-screen"></div>
  <div class="auth-tabs"><button class="auth-tab"></button><button class="auth-tab"></button></div>
  <div id="auth-msg" style="display:none"></div>
  <div id="my-avatar"></div><div id="my-username"></div>
  <div id="my-status-dot"></div><div id="my-tag"></div>
  <div id="login-form"><div id="login-credentials"><input id="l-username"><input id="l-password"></div>
    <div id="twofactor-login-form" style="display:none"><input id="l-2fa-code"></div></div>
  <div id="forgot-form" style="display:none"><input id="f-email"><button class="btn-primary"></button></div>
  <div id="reset-form" style="display:none"><input id="rp-password"><button class="btn-primary"></button></div>
  <div id="register-form" style="display:none"></div>`;

type AuthModule = typeof import('../js/core/auth-compat.ts');
async function freshModule(url = '/'): Promise<AuthModule> {
  window.history.replaceState(null, '', url);
  vi.resetModules();
  const mod = await import('../js/core/auth-compat.ts');
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  return mod;
}
const shown = (id: string) => document.getElementById(id)!.style.display !== 'none';
const msg = () => document.getElementById('auth-msg')!.textContent ?? '';
const fetchMock = vi.fn();

// Her `freshModule()` modülün YENİ bir örneğini yükler ve o örnek `document` üzerine kendi
// dinleyicilerini bağlar (üründe modül tek kez yüklenir). Önceki testlerin örnekleri bağlı
// kalırsa tek bir Enter/tıklama eski örneklerde de çalışır; test yalıtımı için her testin
// eklediği dinleyiciler test sonunda kaldırılır.
const addedListeners: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];
const nativeAdd = document.addEventListener.bind(document);

beforeEach(() => {
  localStorage.clear();
  registryCalls.length = 0;
  toastRegistered = false;
  document.body.innerHTML = AUTH_DOM;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    addedListeners.push([type, listener, options]);
    nativeAdd(type, listener, options);
  });
});
afterEach(() => {
  for (const [type, listener, options] of addedListeners.splice(0)) document.removeEventListener(type, listener, options);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('U-01 "Şifremi unuttum" — istek', () => {
  it('istek formunu açar, sekmeleri gizler, odağı e-postaya verir', async () => {
    const auth = await freshModule();
    auth.openForgotPassword();
    expect(shown('forgot-form')).toBe(true);
    expect(shown('login-credentials')).toBe(false);
    expect((document.querySelector('.auth-tabs') as HTMLElement).style.display).toBe('none');
    expect(document.activeElement?.id).toBe('f-email');
  });

  it('geçersiz adres sunucuya gitmez; kullanıcıya ne yapacağı söylenir', async () => {
    const auth = await freshModule();
    auth.openForgotPassword();
    (document.getElementById('f-email') as HTMLInputElement).value = 'olmayan-adres';
    fetchMock.mockClear();
    await auth.sendResetLink();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg()).toMatch(/geçerli bir e-posta/i);
  });

  it('yanıt hesabın varlığını sızdırmaz: aynı dürüst mesaj, 1 saat ve yönetici yolu', async () => {
    const auth = await freshModule();
    auth.openForgotPassword();
    (document.getElementById('f-email') as HTMLInputElement).value = 'ben@example.test';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await auth.sendResetLink();
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toBe('http://test.local/api/email/forgot');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ email: 'ben@example.test' });
    expect(msg()).toMatch(/doğrulanmış bir hesaba aitse/);
    expect(msg()).toMatch(/1 saat/);
    expect(msg()).toMatch(/yöneticisine/);
  });

  it('hız sınırında ürün dili kullanılır, sunucu gövdesi yansıtılmaz', async () => {
    const auth = await freshModule();
    auth.openForgotPassword();
    (document.getElementById('f-email') as HTMLInputElement).value = 'ben@example.test';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: '<b>raw</b>' }) });
    await auth.sendResetLink();
    expect(msg()).toMatch(/Çok fazla deneme/);
    expect(msg()).not.toContain('raw');
  });
});

describe('U-01 e-postadaki bağlantı — yeni şifre', () => {
  it('/reset-password bağlantısı sıfırlama formunu açar ve jetonu adres çubuğundan siler', async () => {
    await freshModule('/reset-password?token=r.abc123');
    expect(shown('reset-form')).toBe(true);
    expect(window.location.search).toBe('');
    expect(document.activeElement?.id).toBe('rp-password');
    // Oturum geri yüklenmez (bağlantı, oturum açık bir cihazda da açılabilir).
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/me'))).toBe(false);
  });

  it('kısa ve uzun şifre sunucuya gitmeden reddedilir', async () => {
    const auth = await freshModule('/reset-password?token=r.abc123');
    fetchMock.mockClear();
    (document.getElementById('rp-password') as HTMLInputElement).value = 'kısa';
    await auth.saveNewPassword();
    expect(msg()).toMatch(/en az 8/);
    (document.getElementById('rp-password') as HTMLInputElement).value = 'x'.repeat(129);
    await auth.saveNewPassword();
    expect(msg()).toMatch(/en fazla 128/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('başarıda jeton gönderilir, giriş ekranına dönülür, şifre alanı temizlenir', async () => {
    const auth = await freshModule('/reset-password?token=r.abc123');
    (document.getElementById('rp-password') as HTMLInputElement).value = 'yeni-şifre-123';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await auth.saveNewPassword();
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toBe('http://test.local/api/email/reset-password');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ token: 'r.abc123', newPassword: 'yeni-şifre-123' });
    expect(shown('reset-form')).toBe(false);
    expect(shown('login-credentials')).toBe(true);
    expect(window.location.pathname).toBe('/');
    expect((document.getElementById('rp-password') as HTMLInputElement).value).toBe('');
    expect(msg()).toMatch(/güncellendi/);
  });

  it('geçersiz/süresi dolmuş bağlantı açıkça söylenir', async () => {
    const auth = await freshModule('/reset-password?token=r.eski');
    (document.getElementById('rp-password') as HTMLInputElement).value = 'yeni-şifre-123';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'Invalid or expired link' }) });
    await auth.saveNewPassword();
    expect(msg()).toMatch(/geçersiz ya da süresi dolmuş/);
    expect(shown('reset-form')).toBe(true);
  });

  it('jetonsuz bağlantı formu açar ama geçersiz olduğunu hemen söyler', async () => {
    await freshModule('/reset-password');
    expect(shown('reset-form')).toBe(true);
    expect(msg()).toMatch(/geçersiz ya da süresi dolmuş/);
  });
});

describe('U-01 doğrulama bağlantısı uygulamaya döner', () => {
  it('/?email=verified onay gösterir ve bayrağı adresten temizler', async () => {
    toastRegistered = true;
    await freshModule('/?email=verified');
    expect(window.location.search).toBe('');
    expect(registryCalls.some((c) => c.ad === 'toast' && /doğrulandı/.test(String(c.args[0])))).toBe(true);
  });
});

describe('U-04 kendi varlık durumu canlı bağlantıya bağlıdır', () => {
  it('bağlıyken SEÇİLEN durum gösterilir; anlık "offline" yanıtı paneli bozmaz', async () => {
    const auth = await freshModule();
    auth.updateUserPanel({ _id: 'u1', username: 'deniz', status: 'offline', presenceStatus: 'online' });
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(document.getElementById('my-tag')!.textContent).toBe('Çevrimiçi');
    // Sunucu oluşturmada soket yeniden bağlanırken alınan /api/me yanıtı (ölçüldü):
    auth.updateUserPanel({ _id: 'u1', username: 'deniz', status: 'offline', presenceStatus: 'online' });
    expect(document.getElementById('my-tag')!.textContent).toBe('Çevrimiçi');
  });

  it('bağlantı gerçekten koparsa çevrimdışı, dönünce seçilen durum', async () => {
    const auth = await freshModule();
    auth.updateUserPanel({ _id: 'u1', username: 'deniz', status: 'online', presenceStatus: 'dnd' });
    document.dispatchEvent(new CustomEvent('bridge:socket-disconnected'));
    expect(document.getElementById('my-status-dot')!.dataset.status).toBe('offline');
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    expect(document.getElementById('my-status-dot')!.dataset.status).toBe('dnd');
    expect(document.getElementById('my-tag')!.textContent).toBe('Rahatsız etmeyin');
  });

  it('seçim bilinmiyorsa (eski yanıt) anlık görüntüye düşer', async () => {
    const auth = await freshModule();
    auth.updateUserPanel({ _id: 'u1', username: 'deniz', status: 'idle' });
    expect(document.getElementById('my-status-dot')!.dataset.status).toBe('idle');
  });
});

// Gerçek kabuk işaretlemesi: giriş kartı `client/index.html`den okunur; testler elle yazılmış bir
// taklide değil, ürünün kullandığı `data-auth-action` / `data-auth-enter` sözleşmesine bağlanır.
describe('U-01 gerçek giriş kartı üzerinden (delege edilmiş tıklama ve Enter)', () => {
  async function realCard(url = '/'): Promise<AuthModule> {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
    const card = html.slice(html.indexOf('<div id="auth-screen"'), html.indexOf('<!-- MAIN APP -->'));
    document.body.innerHTML = `${card}<div id="app"></div><div id="my-avatar"></div><div id="my-username"></div><div id="my-status-dot"></div><div id="my-tag"></div>`;
    return freshModule(url);
  }
  const click = (sel: string) => document.querySelector<HTMLElement>(sel)!.click();
  const enter = (id: string) => document.getElementById(id)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('"Şifremi unuttum" düğmesi istek formunu açar; Enter gönderir; "Geri" girişe döner', async () => {
    await realCard();
    click('[data-auth-action="forgot"]');
    expect(shown('forgot-form')).toBe(true);
    expect(document.activeElement?.id).toBe('f-email');
    (document.getElementById('f-email') as HTMLInputElement).value = 'ben@example.test';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    enter('f-email');
    await settle();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/api/email/forgot'))).toBe(true);
    expect(msg()).toMatch(/doğrulanmış bir hesaba aitse/);
    click('#forgot-form [data-auth-action="recovery-back"]');
    expect(shown('forgot-form')).toBe(false);
    expect(shown('login-credentials')).toBe(true);
    expect(document.activeElement?.id).toBe('l-username');
    // İstek formundan dönüş bir sıfırlama yolu değildi: adres değişmez.
    expect(window.location.pathname).toBe('/');
  });

  it('sıfırlama formunda Enter kaydeder; jetonsuz bağlantıda kayıt sunucuya gitmez', async () => {
    await realCard('/reset-password');
    fetchMock.mockClear();
    (document.getElementById('rp-password') as HTMLInputElement).value = 'yeterince-uzun-1';
    enter('rp-password');
    await settle();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/email/reset-password'))).toBe(false);
    expect(msg()).toMatch(/geçersiz ya da süresi dolmuş/);
    click('#reset-form [data-auth-action="recovery-back"]');
    expect(window.location.pathname).toBe('/');
    expect(shown('reset-form')).toBe(false);
  });

  it('sunucu çöktüğünde (5xx) ve ağ yokken ürün dili; ham gövde yansıtılmaz', async () => {
    const auth = await realCard('/reset-password?token=r.abc');
    (document.getElementById('rp-password') as HTMLInputElement).value = 'yeterince-uzun-1';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'stack at db.js:12' }) });
    await auth.saveNewPassword();
    expect(msg()).toMatch(/şu anda kullanılamıyor/);
    expect(msg()).not.toContain('db.js');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await auth.saveNewPassword();
    expect(msg()).not.toBe('');
    expect(shown('reset-form')).toBe(true);
    auth.openForgotPassword();
    (document.getElementById('f-email') as HTMLInputElement).value = 'ben@example.test';
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await auth.sendResetLink();
    expect(msg()).not.toBe('');
    expect((document.querySelector('#forgot-form .btn-primary') as HTMLButtonElement).disabled).toBe(false);
  });

  it('doğrulama bayrağı diğer parametreleri korur; bildirim sahibi yoksa giriş kartında gösterilir', async () => {
    toastRegistered = false;
    await realCard('/?email=verified&invite=abc');
    expect(window.location.search).toBe('?invite=abc');
    expect(msg()).toMatch(/doğrulandı/);
  });

  it('fareyle: "Kaydet" jetonla kaydeder ve girişe döner; "Bağlantı gönder" isteği yollar', async () => {
    await realCard('/reset-password?token=r.abc');
    (document.getElementById('rp-password') as HTMLInputElement).value = 'yeterince-uzun-1';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    click('#reset-form [data-auth-action="reset-save"]');
    await settle();
    const saved = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/email/reset-password'));
    expect(JSON.parse(String((saved?.[1] as RequestInit | undefined)?.body ?? '{}'))).toEqual({ token: 'r.abc', newPassword: 'yeterince-uzun-1' });
    expect(msg()).toMatch(/Şifren güncellendi/);
    expect(shown('reset-form')).toBe(false);
    expect(shown('login-credentials')).toBe(true);
    expect(window.location.pathname).toBe('/');

    click('[data-auth-action="forgot"]');
    (document.getElementById('f-email') as HTMLInputElement).value = 'ben@example.test';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    click('#forgot-form [data-auth-action="forgot-send"]');
    await settle();
    const sent = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/email/forgot'));
    expect(JSON.parse(String((sent?.[1] as RequestInit | undefined)?.body ?? '{}'))).toEqual({ email: 'ben@example.test' });
    expect(msg()).toMatch(/doğrulanmış bir hesaba aitse/);
  });
});
