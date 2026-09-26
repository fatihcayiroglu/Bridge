// client/tests/security-tab-2fa.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GUVENLIK TABI — 2FA AKISLARI VE GIZLILIK SOZLESMESI
// ════════════════════════════════════════════════════════════════════════════
// Sunucu 2FA'si bu programda sertlestirilmisti (hashli + TEK KULLANIMLIK yedek
// kodlar, atomik tuketim, sabit zamanli karsilastirma, devre disi birakmada
// GERCEK parola dogrulamasi). Ancak uretim istemcisinde hicbir yonetim yuzeyi
// YOKTU — kullanicinin 2FA'yi acmasinin yolu yoktu.
//
// ── EN KRITIK IKI IDDIA ─────────────────────────────────────────────────────
// 1. SUNUCU REDDETTIGINDE arayuz BASARI GOSTERMEZ. Yanlis parolayi "kapatildi"
//    diye gostermek, kullaniciya korumasinin kalktigini soylerken aslinda
//    acik birakmak demektir (ya da tersi) — dogrudan guvenlik yaniltmasi.
// 2. YEDEK KODLAR KALICI DEPOYA YAZILMAZ. localStorage/sessionStorage'a
//    dusen bir yedek kod, parolayi atlayan kalici bir anahtardir. Paylasilan
//    bilgisayarda cikis sonrasi da gorunmemelidir.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SecurityTab from '../js/core/settings/tabs/SecurityTab.svelte';

const tokenKaydet = vi.hoisted(() => vi.fn());

// KANONİK SÖZLÜĞE DEVRET (reaktif sarmalayıcı yalnızca Svelte reaktifliği
// ekler; metin sahibi `i18n/index.ts`tir). Elle yazılmış çiftler yedek metni
// olmayan anahtarlarda ham anahtar döndürüyor ve `vars` yerleştirmesini
// düşürüyordu.
vi.mock('../js/core/i18n/reactive.svelte.ts', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { t: real.t, $t: real.t, localeTag: () => 'tr', localeTick: () => 0 };
});
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => '' }));
vi.mock('../js/core/auth-compat.ts', () => ({ saveToken: tokenKaydet }));

type Yanit = { ok: boolean; status: number; json: () => Promise<unknown> };
const cagrilar: Array<{ url: string; init?: RequestInit }> = [];
let yonlendir: (url: string, init?: RequestInit) => Yanit;

vi.mock('../js/core/api-fetch.ts', () => ({
  apiFetch: async (url: string, init?: RequestInit) => {
    cagrilar.push({ url, init });
    return yonlendir(url, init);
  },
}));

const yanit = (durum: number, govde: unknown): Yanit =>
  ({ ok: durum >= 200 && durum < 300, status: durum, json: async () => govde });

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

const sahteStore = {
  subscribe: () => () => {}, save: async () => true, setTab: () => {},
} as never;

const el = (testid: string) => host.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
const yaz = (testid: string, deger: string) => {
  const input = el(testid) as HTMLInputElement;
  input.value = deger;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const tikla = (testid: string) => { (el(testid) as HTMLElement).click(); flushSync(); };
/** Mikrotask kuyrugunu bosaltir — bilesen `await` zincirlerini tamamlasin. */
// Mikrotask kuyrugunu bosaltirken HER adimda flushSync yapilir. Ilk yazimda
// once tum mikrotasklar beklenip SONRA tek bir flushSync cagriliyordu; o
// sirada bilesen bazi yollarda 'yukleniyor' asamasinda takili kaliyor ve test
// "hata gosterilmedi" sanip dusuyordu — kusur olcumdeydi, uründe degil.
const bekle = async () => {
  for (let i = 0; i < 12; i++) { await Promise.resolve(); flushSync(); }
};

async function kur(durum: unknown = { enabled: false, backupRemaining: 0 }) {
  yonlendir = (url) => (url.includes('/status') ? yanit(200, durum) : yanit(200, {}));
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(SecurityTab, { target: host, props: { store: sahteStore } });
  await bekle();
}

beforeEach(() => {
  cagrilar.length = 0;
  tokenKaydet.mockClear();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host?.remove();
});

// ════════════════════════════════════════════════════════════════════════════
describe('durum gosterimi', () => {
  it('2FA KAPALIYKEN acma dugmesi gosterilir', async () => {
    await kur({ enabled: false, backupRemaining: 0 });
    expect(el('sec-state')?.textContent).toContain('kapalı');
    expect(el('sec-enable')).not.toBeNull();
  });

  it('2FA ACIKKEN kalan yedek kod sayisi gosterilir', async () => {
    await kur({ enabled: true, backupRemaining: 7 });
    expect(el('sec-state')?.textContent).toContain('açık');
    expect(el('sec-remaining')?.textContent).toContain('7');
    expect(el('sec-enable')).toBeNull();
  });

  it('durum alinamazsa HATA gosterilir, sessizce gecilmez', async () => {
    yonlendir = () => yanit(500, { error: 'boom' });
    host = document.createElement('div');
    document.body.appendChild(host);
    instance = mount(SecurityTab, { target: host, props: { store: sahteStore } });
    await bekle();
    expect(el('sec-error')?.textContent).toContain('boom');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('etkinlestirme akisi', () => {
  it('kurulum QR ve ELLE anahtari gosterir', async () => {
    await kur();
    yonlendir = () => yanit(200, { secret: 'GIZLIANAHTAR', qrCode: 'data:image/png;base64,AAA' });
    tikla('sec-enable');
    await bekle();
    expect(el('sec-secret')?.textContent).toBe('GIZLIANAHTAR');
    expect((el('sec-qr') as HTMLImageElement).src).toContain('data:image/png');
  });

  it('DOGRU kod yedek kodlari gosterir ve durumu ACIK yapar', async () => {
    await kur();
    yonlendir = () => yanit(200, { secret: 'S', qrCode: 'data:,' });
    tikla('sec-enable'); await bekle();

    yonlendir = () => yanit(200, { ok: true, backupCodes: ['aaa11111', 'bbb22222'] });
    yaz('sec-code', '123456');
    tikla('sec-verify'); await bekle();

    expect(el('sec-codes')?.textContent).toContain('aaa11111');
    expect(el('sec-codes-warning')?.textContent).toContain('BİR kez');
  });

  it('YANLIS kod ASLA etkinlestirmez', async () => {
    // Guvenlik yaniltmasina karsi: basarisiz dogrulama "acik" gostermemeli.
    await kur();
    yonlendir = () => yanit(200, { secret: 'S', qrCode: 'data:,' });
    tikla('sec-enable'); await bekle();

    yonlendir = () => yanit(400, { error: 'Invalid code. Check your authenticator app.' });
    yaz('sec-code', '000000');
    tikla('sec-verify'); await bekle();

    expect(el('sec-error')?.textContent).toContain('Invalid code');
    expect(el('sec-codes')).toBeNull();
    expect(el('sec-state')).toBeNull();       // hala kurulum asamasinda
  });

  it('BOS kod sunucuya GONDERILMEZ', async () => {
    await kur();
    yonlendir = () => yanit(200, { secret: 'S', qrCode: 'data:,' });
    tikla('sec-enable'); await bekle();
    const oncekiSayi = cagrilar.length;
    tikla('sec-verify'); await bekle();
    expect(cagrilar.length).toBe(oncekiSayi);
    expect(el('sec-error')?.textContent).toContain('kodunu girin');
  });

  it('kod DOGRULAMA istegi kodu govdede tasir', async () => {
    await kur();
    yonlendir = () => yanit(200, { secret: 'S', qrCode: 'data:,' });
    tikla('sec-enable'); await bekle();
    yonlendir = () => yanit(200, { ok: true, backupCodes: ['x'] });
    yaz('sec-code', '654321');
    tikla('sec-verify'); await bekle();
    const dogrulama = cagrilar.find(c => c.url.includes('/verify'));
    expect(JSON.parse(String(dogrulama?.init?.body))).toEqual({ code: '654321' });
  });

  it('AG HATASI cokmez, mesaja donusur', async () => {
    await kur();
    yonlendir = () => { throw new Error('ağ yok'); };
    tikla('sec-enable'); await bekle();
    expect(el('sec-error')).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('devre disi birakma', () => {
  async function acikKur() {
    await kur({ enabled: true, backupRemaining: 5 });
    tikla('sec-disable-start');
  }

  it('parola SUNUCUYA gonderilir', async () => {
    await acikKur();
    yonlendir = () => yanit(200, { ok: true });
    yaz('sec-password', 'parolam');
    tikla('sec-disable-confirm'); await bekle();
    const istek = cagrilar.find(c => c.url.includes('/disable'));
    expect(JSON.parse(String(istek?.init?.body))).toEqual({ password: 'parolam' });
  });

  it('YANLIS parola BASARI gibi gosterilmez', async () => {
    // Kullaniciya "kapatildi" demek ama sunucuda ACIK kalmasi (veya tersi)
    // dogrudan guvenlik yaniltmasidir.
    await acikKur();
    yonlendir = () => yanit(400, { error: 'Invalid credentials' });
    yaz('sec-password', 'yanlis');
    tikla('sec-disable-confirm'); await bekle();
    expect(el('sec-error')?.textContent).toContain('Invalid credentials');
    expect(el('sec-disable-confirm')).not.toBeNull();   // hala onay asamasinda
  });

  it('BOS parola ile istek GONDERILMEZ', async () => {
    await acikKur();
    const oncekiSayi = cagrilar.length;
    tikla('sec-disable-confirm'); await bekle();
    expect(cagrilar.length).toBe(oncekiSayi);
  });

  it('BASARILI kapatma durumu KAPALI yapar', async () => {
    await acikKur();
    yonlendir = () => yanit(200, { ok: true });
    yaz('sec-password', 'dogru');
    tikla('sec-disable-confirm'); await bekle();
    expect(el('sec-state')?.textContent).toContain('kapalı');
    expect(el('sec-enable')).not.toBeNull();
  });

  it('VAZGEC parolayi temizler', async () => {
    await acikKur();
    yaz('sec-password', 'gizli');
    tikla('sec-disable-cancel');
    tikla('sec-disable-start');
    expect((el('sec-password') as HTMLInputElement).value).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GIZLILIK
// ════════════════════════════════════════════════════════════════════════════
describe('yedek kod gizliligi', () => {
  async function kodlariGoster() {
    await kur();
    yonlendir = () => yanit(200, { secret: 'S', qrCode: 'data:,' });
    tikla('sec-enable'); await bekle();
    yonlendir = () => yanit(200, { ok: true, backupCodes: ['gizli-kod-1', 'gizli-kod-2'] });
    yaz('sec-code', '123456');
    tikla('sec-verify'); await bekle();
  }

  it('yedek kodlar KALICI DEPOYA yazilmaz', async () => {
    await kodlariGoster();
    const hepsi = JSON.stringify({
      local: { ...localStorage }, session: { ...sessionStorage },
    });
    expect(hepsi).not.toContain('gizli-kod-1');
    expect(hepsi).not.toContain('gizli-kod-2');
  });

  it('CIKIS yapilinca kodlar ekrandan KALKAR', async () => {
    // Paylasilan bilgisayar: sonraki kullanici onceki kullanicinin yedek
    // kodlarini gormemeli.
    await kodlariGoster();
    expect(el('sec-codes')).not.toBeNull();
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();
    expect(el('sec-codes')).toBeNull();
  });

  it('"kaydettim" sonrasi kodlar ekrandan kalkar', async () => {
    await kodlariGoster();
    tikla('sec-codes-done');
    expect(el('sec-codes')).toBeNull();
    expect(el('sec-state')?.textContent).toContain('açık');
  });

  it('bilesen SOKULUNCA kodlar bellekte tutulmaz', async () => {
    await kodlariGoster();
    unmount(instance!);
    instance = null;
    expect(host.textContent ?? '').not.toContain('gizli-kod-1');
  });
});

describe('bozuk yanıtlar, ağ hataları ve yedek kod yenileme', () => {
  it('durum ağ hatasını ve JSON olmayan hata yanıtını güvenli mesaja dönüştürür', async () => {
    yonlendir = () => { throw new Error('offline'); };
    host = document.createElement('div');
    document.body.appendChild(host);
    instance = mount(SecurityTab, { target: host, props: { store: sahteStore } });
    await bekle();
    expect(el('sec-error')?.textContent).toContain('Sunucuya ulaşılamadı');

    unmount(instance!);
    instance = null;
    host.remove();
    yonlendir = () => ({
      ok: false, status: 502, json: async () => { throw new SyntaxError('html'); },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    instance = mount(SecurityTab, { target: host, props: { store: sahteStore } });
    await bekle();
    expect(el('sec-error')?.textContent).toContain('Durum alınamadı');
  });

  it('yedek sayısı olmayan açık durumda sayı uydurmaz', async () => {
    await kur({ enabled: true, backupRemaining: '7' });
    expect(el('sec-state')?.textContent).toContain('açık');
    expect(el('sec-remaining')).toBeNull();
  });

  it('kurulum reddini gösterir ve eksik opsiyonel QR/secret alanlarıyla güvenli devam eder', async () => {
    await kur();
    yonlendir = () => yanit(400, {});
    tikla('sec-enable');
    await bekle();
    expect(el('sec-error')?.textContent).toContain('Kurulum başlatılamadı');

    yonlendir = () => yanit(200, {});
    tikla('sec-enable');
    await bekle();
    expect(el('sec-secret')?.textContent).toBe('');
    expect(el('sec-qr')).toBeNull();
  });

  it('verify tokenını kaydeder, bozuk backupCodes değerini kod listesi saymaz', async () => {
    await kur();
    yonlendir = () => yanit(200, { secret: 'S' });
    tikla('sec-enable');
    await bekle();
    yonlendir = () => yanit(200, { token: 'rotated', backupCodes: 'not-an-array' });
    yaz('sec-code', ' 123456 ');
    tikla('sec-verify');
    await bekle();

    expect(tokenKaydet).toHaveBeenCalledWith('rotated');
    expect(el('sec-codes')?.querySelectorAll('li')).toHaveLength(0);
  });

  it('verify ağ hatasını başarıya çevirmeden kurulum aşamasında kalır', async () => {
    await kur();
    yonlendir = () => yanit(200, { secret: 'S' });
    tikla('sec-enable');
    await bekle();
    yonlendir = () => { throw new Error('offline'); };
    yaz('sec-code', '123456');
    tikla('sec-verify');
    await bekle();

    expect(el('sec-error')?.textContent).toContain('Sunucuya ulaşılamadı');
    expect(el('sec-verify')).not.toBeNull();
  });

  it('yenilemede boş parolayı engeller, reddi gösterir ve başarıda yeni seti eskisinin üzerine yazar', async () => {
    await kur({ enabled: true, backupRemaining: 1 });
    tikla('sec-regen-start');
    const onceki = cagrilar.length;
    tikla('sec-regen-confirm');
    expect(cagrilar).toHaveLength(onceki);
    expect(el('sec-error')?.textContent).toContain('Parolanızı girin');

    yaz('sec-regen-password', 'gizli');
    yonlendir = () => yanit(403, {});
    tikla('sec-regen-confirm');
    await bekle();
    expect(el('sec-error')?.textContent).toContain('Yedek kodlar yenilenemedi');
    expect(el('sec-regen-confirm')).not.toBeNull();

    yonlendir = () => yanit(200, { backupCodes: ['yeni-1', 'yeni-2'] });
    tikla('sec-regen-confirm');
    await bekle();
    const istek = cagrilar.find(c => c.url.includes('/backup-codes/regenerate') && c.init?.body);
    expect(JSON.parse(String(istek?.init?.body))).toEqual({ password: 'gizli' });
    expect(el('sec-codes')?.textContent).toContain('yeni-2');
  });

  it('yenileme iptali parolayı temizler ve ağ hatası görünür kalır', async () => {
    await kur({ enabled: true, backupRemaining: 2 });
    tikla('sec-regen-start');
    yaz('sec-regen-password', 'sil-beni');
    tikla('sec-regen-cancel');
    tikla('sec-regen-start');
    expect((el('sec-regen-password') as HTMLInputElement).value).toBe('');

    yaz('sec-regen-password', 'parola');
    yonlendir = () => { throw new Error('offline'); };
    tikla('sec-regen-confirm');
    await bekle();
    expect(el('sec-error')?.textContent).toContain('Sunucuya ulaşılamadı');
  });

  it('disable ağ hatasında açık kalır ve sonraki tokenlı başarıyı kaydeder', async () => {
    await kur({ enabled: true, backupRemaining: 2 });
    tikla('sec-disable-start');
    yaz('sec-password', 'parola');
    yonlendir = () => { throw new Error('offline'); };
    tikla('sec-disable-confirm');
    await bekle();
    expect(el('sec-error')?.textContent).toContain('Sunucuya ulaşılamadı');
    expect(el('sec-disable-confirm')).not.toBeNull();

    yonlendir = () => yanit(200, { token: 'disabled-token' });
    tikla('sec-disable-confirm');
    await bekle();
    expect(tokenKaydet).toHaveBeenCalledWith('disabled-token');
    expect(el('sec-state')?.textContent).toContain('kapalı');
  });
});

// Final21 UX (U-01): hesap kurtarma e-postası. Sunucu şifre sıfırlamayı destekliyordu ama
// kullanıcının e-posta ekleyebileceği hiçbir yer yoktu; sıfırlama kimseye ulaşamıyordu.
describe('kurtarma e-postası', () => {
  async function kurEposta(me: unknown, add: Yanit = yanit(200, { ok: true })) {
    yonlendir = (url) => {
      if (url.includes('/status')) return yanit(200, { enabled: false, backupRemaining: 0 });
      if (url.endsWith('/api/me')) return yanit(200, me);
      if (url.includes('/api/email/add') || url.includes('/api/email/resend')) return add;
      return yanit(200, {});
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    instance = mount(SecurityTab, { target: host, props: { store: sahteStore } });
    await bekle();
  }

  it('adres yoksa yalnız giriş alanı; kayıtlı ve doğrulanmışsa "Doğrulandı"', async () => {
    await kurEposta({});
    expect(el('sec-recovery')).toBeTruthy();
    expect(el('sec-recovery-state')).toBeNull();
    unmount(instance!); instance = null; host.remove();
    await kurEposta({ email: 'ben@example.test', emailVerified: true });
    expect(el('sec-recovery-state')!.textContent).toMatch(/ben@example\.test — Doğrulandı/);
    expect(el('sec-recovery-resend')).toBeNull();
  });

  it('kaydet: adresi gönderir, "bekleniyor" durumuna geçer, yeniden gönder sunar', async () => {
    await kurEposta({});
    yaz('sec-recovery-input', '  Ben@Example.test ');
    tikla('sec-recovery-save');
    await bekle();
    const istek = cagrilar.find((c) => c.url.endsWith('/api/email/add'))!;
    expect(JSON.parse(String(istek.init?.body))).toEqual({ email: 'Ben@Example.test' });
    expect(el('sec-recovery-message')!.textContent).toMatch(/gönderildi/);
    expect(el('sec-recovery-state')!.textContent).toMatch(/ben@example\.test — Doğrulama bekleniyor/);
    tikla('sec-recovery-resend');
    await bekle();
    expect(cagrilar.some((c) => c.url.endsWith('/api/email/resend'))).toBe(true);
  });

  it('geçersiz adres sunucuya gitmez; Enter da kaydeder', async () => {
    await kurEposta({});
    yaz('sec-recovery-input', 'adres-değil');
    (el('sec-recovery-input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await bekle();
    expect(cagrilar.some((c) => c.url.includes('/api/email/add'))).toBe(false);
    expect(el('sec-recovery-error')!.textContent).toMatch(/geçerli bir e-posta/i);
  });

  it('sunucu reddi ve hız sınırı ürün diliyle gösterilir (ham gövde yansıtılmaz)', async () => {
    await kurEposta({}, yanit(400, { error: 'This email is already used by another account' }));
    yaz('sec-recovery-input', 'baskasi@example.test');
    tikla('sec-recovery-save');
    await bekle();
    expect(el('sec-recovery-error')!.textContent).toBe('Bu adres kaydedilemedi.');
    unmount(instance!); instance = null; host.remove();
    await kurEposta({}, yanit(429, {}));
    yaz('sec-recovery-input', 'ben@example.test');
    tikla('sec-recovery-save');
    await bekle();
    expect(el('sec-recovery-error')!.textContent).toMatch(/Çok fazla deneme/);
  });
});
