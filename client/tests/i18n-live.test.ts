// client/tests/i18n-live.test.ts
// I18N — GERÇEK sahip sözleşmesi (çeviri motoru + DOM uygulayıcısı + seçici).
//
// ════════════════════════════════════════════════════════════════════════════
// BATCH 2 — I18N DÜRÜST TESLİMAT
// ════════════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: emekliye ayrılan `tests/i18n.test.ts` kendi `createI18n()`
// klonunu kuruyor, kendi sahte tablosunu çeviriyor ve kendi kopyasını
// doğruluyordu — ÜRETİM i18n'i hiç çalıştırmıyordu. Bu yüzden şu üç gerçek
// hiç görünmedi:
//   1. `index.html` 11 düğümde `data-i18n` taşıyordu,
//   2. `js/core/i18n/` altında 10 dilin tam tabloları vardı,
//   3. ve bu ikisini bağlayan HİÇBİR kod yoktu.
// Kullanıcı dili değiştiremiyordu; değiştirse bile arayüz değişmiyordu.
//
// Bu dosya YALNIZ üretim modüllerini kullanır — test-yerel i18n klonu YOKTUR.
// Çeviri değerleri `js/core/i18n/*.ts` altındaki 10 stable production tablosunun GERÇEK değerleridir.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

import { t, locale, setLocale, SUPPORTED_LOCALES, type Locale } from '../js/core/i18n/index.ts';
import { applyTranslations, initI18nDom, stopI18nDom } from '../js/core/i18n-dom.ts';
import AppearanceTab from '../js/core/settings/tabs/AppearanceTab.svelte';

const STORAGE_KEY = 'bridge_locale';

/** Modül seviyesi ilk tablo yüklemesi asenkrondur (i18n/index.ts:83). */
async function settleTables(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function node(key: string, text: string, tag = 'span'): HTMLElement {
  const el = document.createElement(tag);
  el.setAttribute('data-i18n', key);
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

beforeEach(async () => {
  document.body.innerHTML = '';
  await setLocale('tr');
  await settleTables();
});

afterEach(() => {
  stopI18nDom();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// Bu dosya dili gerçekten değiştirir ve `bridge_locale` anahtarını YAZAR.
// localStorage worker içinde dosyalar arasında paylaşılabildiği için, anahtar
// bırakılırsa sonraki test dosyaları `_detectLocale()` üzerinden yanlış dile
// düşer (ör. api-error.ts İngilizce metin döndürür). Anahtar dosya sonunda
// eski hâline getirilir.
const _localeBefore = localStorage.getItem(STORAGE_KEY);
afterAll(() => {
  if (_localeBefore === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, _localeBefore);
});

// ════════════════════════════════════════════════════════════════════════════
// Çeviri motoru
// ════════════════════════════════════════════════════════════════════════════
describe('i18n — çeviri motoru', () => {
  it('desteklenen diller gerçek tablolarla sınırlıdır', () => {
    // Seçici bu kaydı listeler; burada büyümesi testte görünür olmalı.
    expect(Object.keys(SUPPORTED_LOCALES)).toEqual(
      ['tr', 'en', 'es', 'ru', 'ja', 'ko', 'zh', 'pt', 'de', 'fr'],
    );
  });

  it('t() geçerli dilin GERÇEK çevirisini döndürür', () => {
    expect(locale.current).toBe('tr');
    expect(t('sign_in')).toBe('Giriş Yap');
    expect(t('create_account')).toBe('Hesap Oluştur');
  });

  it('bilinmeyen anahtar için ANAHTARIN KENDİSİ döner', () => {
    expect(t('__var_olmayan_anahtar__')).toBe('__var_olmayan_anahtar__');
  });

  it('bilinmeyen anahtarda verilen yedek metin kullanılır', () => {
    expect(t('__var_olmayan_anahtar__', 'Yedek')).toBe('Yedek');
  });

  it('anahtar VARSA yedek metin çeviriyi EZMEZ', () => {
    expect(t('sign_in', 'Yedek')).toBe('Giriş Yap');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Dil değişimi + kalıcılık
// ════════════════════════════════════════════════════════════════════════════
describe('i18n — dil değişimi', () => {
  it('setLocale çeviri tablosunu gerçekten değiştirir', async () => {
    await setLocale('en');

    expect(locale.current).toBe('en');
    expect(t('sign_in')).toBe('Sign In');
  });

  it('desteklenen HER locale gerçek lazy tabloyu yükler ve temel auth anahtarlarını sağlar', async () => {
    for (const loc of Object.keys(SUPPORTED_LOCALES) as Locale[]) {
      await setLocale(loc);
      expect(locale.current).toBe(loc);
      const signIn = t('sign_in');
      const create = t('create_account');
      expect(signIn.trim(), `${loc}: sign_in`).not.toBe('');
      expect(create.trim(), `${loc}: create_account`).not.toBe('');
      expect(signIn).not.toBe('sign_in');
      expect(create).not.toBe('create_account');
      expect(document.documentElement.getAttribute('lang')).toBe(loc);
    }
  });

  it('setLocale seçimi localStorage’a yazar', async () => {
    await setLocale('en');

    expect(localStorage.getItem(STORAGE_KEY)).toBe('en');
  });

  it('setLocale <html lang> niteliğini günceller (erişilebilirlik)', async () => {
    await setLocale('de');

    expect(document.documentElement.getAttribute('lang')).toBe('de');
  });

  it('aynı dile geçiş no-op’tur (gereksiz yeniden uygulama yok)', async () => {
    const seen: Locale[] = [];
    const stop = locale.subscribe(l => seen.push(l));
    seen.length = 0; // abonelikteki ilk anlık çağrıyı say

    await setLocale('tr'); // zaten tr

    expect(seen).toEqual([]);
    stop();
  });

  it('abone olurken dinleyici MEVCUT dille hemen çağrılır', () => {
    const seen: Locale[] = [];
    const stop = locale.subscribe(l => seen.push(l));

    expect(seen).toEqual(['tr']);
    stop();
  });

  it('abonelik bırakıldıktan sonra dinleyici ARTIK çağrılmaz', async () => {
    const seen: Locale[] = [];
    const stop = locale.subscribe(l => seen.push(l));
    stop();
    seen.length = 0;

    await setLocale('en');

    expect(seen).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Yeniden yükleme (kalıcılık gerçekten okunuyor mu?)
// ════════════════════════════════════════════════════════════════════════════
describe('i18n — yeniden yükleme davranışı', () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    vi.unstubAllGlobals();
  });

  it('kayıtlı dil YENİ oturumda geri yüklenir', async () => {
    localStorage.setItem(STORAGE_KEY, 'de');
    vi.resetModules();

    // Taze modül örneği = yeni sayfa yüklemesi.
    const fresh = await import('../js/core/i18n/index.ts');

    expect(fresh.locale.current).toBe('de');
  });

  it('kayıt yoksa tarayıcı dili kullanılır', async () => {
    localStorage.removeItem(STORAGE_KEY);
    vi.stubGlobal('navigator', { language: 'fr-FR' });
    vi.resetModules();

    const fresh = await import('../js/core/i18n/index.ts');

    expect(fresh.locale.current).toBe('fr');
  });

  it('desteklenmeyen tarayıcı dilinde varsayılan TR’dir', async () => {
    localStorage.removeItem(STORAGE_KEY);
    vi.stubGlobal('navigator', { language: 'sv-SE' });
    vi.resetModules();

    const fresh = await import('../js/core/i18n/index.ts');

    expect(fresh.locale.current).toBe('tr');
  });

  it('depodaki GEÇERSİZ değer sessizce yok sayılır', async () => {
    localStorage.setItem(STORAGE_KEY, 'klingon');
    vi.stubGlobal('navigator', { language: 'sv-SE' });
    vi.resetModules();

    const fresh = await import('../js/core/i18n/index.ts');

    expect(fresh.locale.current).toBe('tr');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DOM uygulayıcısı — Batch 2'de eklenen eksik halka
// ════════════════════════════════════════════════════════════════════════════
describe('i18n-dom — uygulayıcı', () => {
  it('[data-i18n] taşıyan düğümlerin metnini çevirir', () => {
    const el = node('sign_in', 'Sign In');

    applyTranslations();

    expect(el.textContent).toBe('Giriş Yap');
  });

  it('index.html’deki gerçek anahtarların tamamı çevrilebilir', () => {
    // Bu dokuz anahtar üretimde `index.html` içinde data-i18n olarak durur.
    const keys = [
      'tagline', 'sign_in', 'create_account', 'username', 'password',
      'display_name', 'select_channel', 'welcome_to_bridge', 'select_channel_left',
    ];
    const els = keys.map(k => node(k, 'ORIGINAL'));

    applyTranslations();

    for (const el of els) {
      expect(el.textContent).not.toBe('ORIGINAL');
      expect(el.textContent).not.toBe(el.getAttribute('data-i18n'));
    }
  });

  it('data-tip-i18n taşıyan tooltip metnini geçerli locale ile çevirir', () => {
    const button = document.createElement('button');
    button.setAttribute('data-tip-i18n', 'tip_settings');
    button.setAttribute('data-tip', 'Settings');
    document.body.appendChild(button);

    applyTranslations();

    expect(button.getAttribute('data-tip')).toBe('Ayarlar');
  });

  it('nitelik TAŞIMAYAN düğümlere dokunulmaz', () => {
    const plain = document.createElement('span');
    plain.textContent = 'Dokunma';
    document.body.appendChild(plain);

    applyTranslations();

    expect(plain.textContent).toBe('Dokunma');
  });

  it('ÇEVİRİSİ OLMAYAN anahtarda mevcut metin KORUNUR (ham anahtar sızmaz)', () => {
    const el = node('__var_olmayan_anahtar__', 'Existing English Text');

    applyTranslations();

    expect(el.textContent).toBe('Existing English Text');
  });

  it('uygulanan düğüm sayısını döndürür', () => {
    node('sign_in', 'a');
    node('password', 'b');

    expect(applyTranslations()).toBe(2);
  });

  it('verilen kök ile sınırlanabilir', () => {
    const scoped = document.createElement('div');
    const inside = document.createElement('span');
    inside.setAttribute('data-i18n', 'sign_in');
    inside.textContent = 'Sign In';
    scoped.appendChild(inside);
    document.body.appendChild(scoped);
    const outside = node('password', 'Password');

    applyTranslations(scoped);

    expect(inside.textContent).toBe('Giriş Yap');
    expect(outside.textContent).toBe('Password'); // kapsam dışı
  });

  it('GÜVENLİK: metin yalnız textContent ile yazılır, innerHTML’e ASLA dokunulmaz', () => {
    // Çeviri tabloları veri dosyalarıdır. innerHTML kullanılsaydı tablo bir
    // XSS yüzeyine dönüşürdü; bu testi kırmadan bunu yapmak mümkün olmamalı.
    const proto = Object.getPrototypeOf(document.createElement('span'));
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    const setter = vi.fn();
    Object.defineProperty(Element.prototype, 'innerHTML', {
      ...original,
      set: setter,
      configurable: true,
    });
    void proto;

    try {
      node('sign_in', 'Sign In');
      applyTranslations();
    } finally {
      Object.defineProperty(Element.prototype, 'innerHTML', original);
    }

    expect(setter).not.toHaveBeenCalled();
  });

  it('GÜVENLİK: çevrilen düğüm alt eleman üretmez', () => {
    const el = node('tagline', 'Connect with anyone, anywhere');

    applyTranslations();

    expect(el.children.length).toBe(0);
    expect(el.querySelector('script')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DOM uygulayıcısı — locale aboneliği (app.ts boot sözleşmesi)
// ════════════════════════════════════════════════════════════════════════════
describe('i18n-dom — locale aboneliği', () => {
  it('initI18nDom mevcut dili HEMEN uygular', () => {
    const el = node('sign_in', 'Sign In');

    initI18nDom();

    expect(el.textContent).toBe('Giriş Yap');
  });

  it('dil değişimi DOM’u YENİDEN çevirir', async () => {
    const el = node('sign_in', 'Sign In');
    initI18nDom();
    expect(el.textContent).toBe('Giriş Yap');

    await setLocale('en');

    expect(el.textContent).toBe('Sign In');
  });

  it('çifte initI18nDom ikinci bir abone oluşturmaz', async () => {
    initI18nDom();
    initI18nDom();
    stopI18nDom(); // tek sahip ise bu tek aboneliği bırakır

    const el = node('sign_in', 'Sign In');
    await setLocale('en');

    expect(el.textContent).toBe('Sign In'); // uygulayıcı sustu → dokunulmadı
  });

  it('stopI18nDom sonrası dil değişimi DOM’a YANSIMAZ', async () => {
    const el = node('sign_in', 'Sign In');
    initI18nDom();
    stopI18nDom();

    await setLocale('de');

    expect(el.textContent).toBe('Giriş Yap'); // son uygulanan değerde kalır
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Dil seçici — AppearanceTab (canlı SettingsModal sekmesi)
// ════════════════════════════════════════════════════════════════════════════
describe('Dil seçici — AppearanceTab', () => {
  let instance: ReturnType<typeof mount> | null = null;
  let host: HTMLDivElement;

  const select = (): HTMLSelectElement =>
    host.querySelector<HTMLSelectElement>('#locale-select')!;

  function mountTab(): void {
    host = document.createElement('div');
    document.body.appendChild(host);
    instance = mount(AppearanceTab, {
      target: host,
      // Sekme `store` prop'unu okumaz (AppearanceTab.svelte:23 — `_store`),
      // ama sözleşme gereği verilir.
      props: { store: { subscribe: () => () => {} } as never },
    });
    flushSync();
  }

  afterEach(() => {
    if (instance) unmount(instance);
    instance = null;
    host?.remove();
  });

  it('yalnızca GERÇEKTEN desteklenen dilleri listeler', () => {
    mountTab();

    const values = [...select().options].map(o => o.value);
    expect(values).toEqual(Object.keys(SUPPORTED_LOCALES));
  });

  it('dilleri kendi adlarıyla gösterir', () => {
    mountTab();

    const labels = [...select().options].map(o => o.textContent);
    expect(labels).toContain('Türkçe');
    expect(labels).toContain('日本語');
  });

  it('MEVCUT dili yansıtır', async () => {
    await setLocale('de');
    mountTab();

    expect(select().value).toBe('de');
  });

  it('seçim değişimi GERÇEK setLocale’i çağırır', async () => {
    mountTab();
    const el = select();

    el.value = 'en';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(locale.current).toBe('en'));

    expect(t('sign_in')).toBe('Sign In');
  });

  it('seçim değişimi seçimi KALICI yapar', async () => {
    mountTab();
    const el = select();

    el.value = 'fr';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(locale.current).toBe('fr'));

    expect(localStorage.getItem(STORAGE_KEY)).toBe('fr');
  });

  it('seçim değişimi GÖRÜNÜR çeviriyi günceller (uçtan uca)', async () => {
    const el = node('sign_in', 'Sign In');
    initI18nDom();
    expect(el.textContent).toBe('Giriş Yap');
    mountTab();

    const sel = select();
    sel.value = 'de';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(el.textContent).toBe('Anmelden'));
  });

  it('dil dışarıdan değişirse seçici senkron kalır', async () => {
    mountTab();
    expect(select().value).toBe('tr');

    await setLocale('en');
    flushSync();

    expect(select().value).toBe('en');
  });

  it('erişilebilir bir etiketi vardır', () => {
    mountTab();

    const label = host.querySelector<HTMLLabelElement>('label[for="locale-select"]');
    expect(label).not.toBeNull();
    expect(label!.textContent).toMatch(/Dil/);
  });
});
