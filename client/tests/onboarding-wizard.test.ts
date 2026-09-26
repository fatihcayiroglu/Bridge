// client/tests/onboarding-wizard.test.ts
// Faz 8.1 — İlk giriş sihirbazı (OnboardingWizard) davranış testleri.
//
// Kaybolan davranış: OnboardingWizard.svelte 417 satırlık gerçek bir
// implementasyondu ama `onboarding-wizard-svelte.ts` shim'i hiç import
// edilmiyordu. Bağlarken iki ürün hatası da düzeltildi:
//   1) Sihirbaz oturum yokken (giriş ekranının üstünde) açılıyordu.
//   2) Tamamlanma durumu TEK global localStorage anahtarındaydı; aynı
//      tarayıcıda kullanıcı değişince eski kullanıcının durumu yenisine
//      sızıyor ve yeni kullanıcı sihirbazı hiç görmüyordu.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import OnboardingWizard from '../js/core/OnboardingWizard.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const STORAGE_PREFIX = 'bridge_onboarding_v3';
// Bileşendeki gecikme 800 → 1600 ms YÜKSELTİLDİ.
//
// NEDEN: `EmptyServerStart` de kimlik doğrulamadan ~800 ms sonra açılır.
// İkisi aynı anda tetiklenince yarışıyor, tur açılıp hemen ardından
// boş-sunucu modali üstüne biniyordu; odak tuzağı yığınının tepesi diğer
// ekran olduğu için tur, içinde odak tutulamayan ve faresi çalışmayan yarım
// bir diyalog haline geliyordu (Playwright'ta ölçüldü).
//
// Burada değer BÜYÜTÜLDÜ, iddia GEVŞETİLMEDİ: testler hâlâ turun gecikmeden
// ÖNCE görünmediğini ve gecikmeden SONRA göründüğünü doğruluyor.
const AUTO_SHOW_DELAY_MS = 1600;

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

const wizard = () => { flushSync(); return document.querySelector('.ow-backdrop'); };

/** Otomatik açılış gecikmesini geçir. */
const settle = () => { vi.advanceTimersByTime(AUTO_SHOW_DELAY_MS + 50); flushSync(); };

function login(userId: string): void {
  localStorage.setItem('token', `tok-${userId}`);
  BridgeRegistry.register('getMe', () => ({ _id: userId }));
}

function logout(): void {
  localStorage.removeItem('token');
  localStorage.removeItem('bridge_token');
  BridgeRegistry.unregister('getMe');
}

function mountWizard(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(OnboardingWizard, { target: host });
  flushSync();
}

function unmountWizard(): void {
  if (instance) unmount(instance);
  instance = null;
  host?.remove();
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  logout();
  // Sunucuya tamamlanma bildirimi ağ çağrısı yapar — testte izole edilir.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

afterEach(() => {
  unmountWizard();
  localStorage.clear();
  BridgeRegistry.unregister('getMe');
  BridgeRegistry.unregister('showOnboardingWizard');
  BridgeRegistry.unregister('hideOnboardingWizard');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('onboarding — uygunluk (eligibility)', () => {
  it('oturum YOKKEN otomatik açılmaz (giriş ekranının üstüne çıkmaz)', () => {
    mountWizard();
    settle();

    expect(wizard()).toBeNull();
  });

  it('oturum varken ilk kez otomatik açılır', () => {
    login('user-a');
    mountWizard();
    settle();

    expect(wizard()).not.toBeNull();
  });

  it('oturum sonradan açılırsa (bridge:auth-success) sihirbaz gösterilir', () => {
    mountWizard();
    settle();
    expect(wizard()).toBeNull(); // henüz giriş yok

    login('user-a');
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    settle();

    expect(wizard()).not.toBeNull();
  });

  it('token identity hazır olmadan geri yüklenirse anonim anahtarla zamanlayıcı kurmaz', () => {
    localStorage.setItem('token', 'restored-token');
    mountWizard();
    settle();
    expect(wizard()).toBeNull();

    BridgeRegistry.register('getMe', () => ({ _id: 'restored-user' }));
    localStorage.setItem(`${STORAGE_PREFIX}:restored-user`, 'done');
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    settle();

    expect(wizard()).toBeNull();
  });

  it('daha önce tamamlayan kullanıcıya tekrar gösterilmez', () => {
    login('user-a');
    localStorage.setItem(`${STORAGE_PREFIX}:user-a`, 'done');
    mountWizard();
    settle();

    expect(wizard()).toBeNull();
  });

  it('mount tek başına sihirbazı ANINDA açmaz (gecikme öncesi görünmez)', () => {
    login('user-a');
    mountWizard();

    expect(wizard()).toBeNull(); // henüz gecikme dolmadı
    settle();
    expect(wizard()).not.toBeNull();
  });
});

describe('onboarding — kullanıcı bazlı durum izolasyonu', () => {
  it('A kullanıcısının tamamlaması B kullanıcısına SIZMAZ', async () => {
    // A giriş yapar, sihirbazı tamamlar
    login('user-a');
    mountWizard();
    settle();
    expect(wizard()).not.toBeNull();

    await BridgeRegistry.call('hideOnboardingWizard');
    flushSync();
    expect(localStorage.getItem(`${STORAGE_PREFIX}:user-a`)).toBe('done');

    unmountWizard();

    // Aynı tarayıcıda B giriş yapar — sihirbazı GÖRMELİ
    logout();
    login('user-b');
    mountWizard();
    settle();

    expect(wizard()).not.toBeNull();
    expect(localStorage.getItem(`${STORAGE_PREFIX}:user-b`)).toBeNull();
  });

  it('tamamlanma anahtarı kullanıcı kimliğiyle isimlendirilir (global anahtar değil)', async () => {
    login('user-a');
    mountWizard();
    settle();

    await BridgeRegistry.call('hideOnboardingWizard');
    flushSync();

    expect(localStorage.getItem(`${STORAGE_PREFIX}:user-a`)).toBe('done');
    expect(localStorage.getItem(STORAGE_PREFIX)).toBeNull(); // eski global anahtar yazılmaz
  });
});

describe('onboarding — kayıt ve yaşam döngüsü', () => {
  it('mount registry sözleşmesini kurar', () => {
    mountWizard();

    expect(BridgeRegistry.has('showOnboardingWizard')).toBe(true);
    expect(BridgeRegistry.has('hideOnboardingWizard')).toBe(true);
  });

  it('registry üzerinden elle açılabilir (oturum durumundan bağımsız)', () => {
    mountWizard();
    expect(wizard()).toBeNull();

    BridgeRegistry.call('showOnboardingWizard');

    expect(wizard()).not.toBeNull();
  });

  it('Escape sihirbazı kapatır', async () => {
    login('user-a');
    mountWizard();
    settle();
    expect(wizard()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();

    expect(wizard()).toBeNull();
  });

  it('unmount kayıtları ve dinleyicileri temizler', () => {
    login('user-a');
    mountWizard();

    unmountWizard();

    expect(BridgeRegistry.has('showOnboardingWizard')).toBe(false);
    expect(BridgeRegistry.has('hideOnboardingWizard')).toBe(false);

    // Yok edilmiş bileşen artık olaylara tepki vermemeli
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    vi.advanceTimersByTime(AUTO_SHOW_DELAY_MS + 50);
    expect(document.querySelector('.ow-backdrop')).toBeNull();
  });

  it('bekleyen otomatik açılış zamanlayıcısı unmount\'ta iptal edilir', () => {
    // NOT: vi.getTimerCount() burada kullanılamaz — jsdom/vitest ortamı mount
    // öncesinde de zamanlayıcı tutuyor, mutlak sayı gürültülü. Bunun yerine
    // kurulan zamanlayıcı kimliğinin gerçekten temizlendiği doğrulanır.
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    login('user-a');
    mountWizard(); // otomatik açılış zamanlayıcısı kuruldu

    const scheduled = setSpy.mock.results.map(r => r.value);
    expect(scheduled.length).toBeGreaterThan(0);

    unmountWizard();

    const cleared = clearSpy.mock.calls.map(c => c[0]);
    expect(scheduled.some(id => cleared.includes(id))).toBe(true);
  });

  it('oturum yokken otomatik açılış zamanlayıcısı hiç kurulmaz', () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');

    mountWizard(); // giriş yok

    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('onboarding — ürün turu ile sunucu onboarding ayrımı', () => {
  it('ürün turu tamamlanınca ağ çağrısı yapılmaz', async () => {
    login('user-a');
    mountWizard();
    settle();

    await BridgeRegistry.call('hideOnboardingWizard');

    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem(`${STORAGE_PREFIX}:user-a`)).toBe('done'); // yerel durum yine yazılır
  });

  it('serverId olsa bile sunucu onboarding sözleşmesi atlanmaz', async () => {
    login('user-a');
    (window as unknown as Record<string, unknown>).__BRIDGE_SERVER_ID__ = 'srv-1';
    mountWizard();
    settle();

    await BridgeRegistry.call('hideOnboardingWizard');

    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem(`${STORAGE_PREFIX}:user-a`)).toBe('done');
    delete (window as unknown as Record<string, unknown>).__BRIDGE_SERVER_ID__;
  });

});

describe('onboarding — oturum ve zamanlayıcı yarışları', () => {
  it('logout bekleyen otomatik açılışı iptal eder; sonraki kullanıcı bağımsız zamanlanır', () => {
    login('user-a');
    mountWizard();

    logout();
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    settle();
    expect(wizard()).toBeNull();
    expect(localStorage.getItem(`${STORAGE_PREFIX}:user-a`)).toBeNull();

    login('user-b');
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    settle();
    expect(wizard()).not.toBeNull();
  });

  it('zamanlayıcı kurulurkenki kullanıcı değişirse eski uygunluk kararı yeni kullanıcıya taşınmaz', () => {
    login('user-a');
    mountWizard();

    login('user-b');
    localStorage.setItem(`${STORAGE_PREFIX}:user-b`, 'done');
    settle();

    expect(wizard()).toBeNull();
  });

  it('logout adım animasyonunu iptal eder; gecikmiş callback yeni oturumun adımını ilerletmez', () => {
    login('user-a');
    mountWizard();
    BridgeRegistry.call('showOnboardingWizard');
    flushSync();
    document.querySelector<HTMLButtonElement>('.ow-btn-primary')!.click();

    logout();
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    vi.advanceTimersByTime(500);
    flushSync();

    login('user-b');
    BridgeRegistry.call('showOnboardingWizard');
    flushSync();
    expect(document.querySelector('.ow-counter')?.textContent).toContain('1 / 6');
  });

  it('başka modal içindeki etkileşim dinleyiciyi tüketmez; sonraki gerçek kabuk eylemi turu bastırır', () => {
    login('user-a');
    const otherModal = document.createElement('div');
    otherModal.setAttribute('role', 'dialog');
    otherModal.setAttribute('aria-modal', 'true');
    const modalButton = document.createElement('button');
    otherModal.appendChild(modalButton);
    document.body.appendChild(otherModal);
    mountWizard();

    modalButton.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    settle(); // tur diğer modal yüzünden bir kez ertelenir
    expect(wizard()).toBeNull();

    otherModal.remove();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    settle();
    expect(wizard()).toBeNull();
  });

  it('ileri, geri ve doğrudan adım geçişleri tamamlanınca yalnız kullanıcı kapsamını işaretler', async () => {
    login('user-a');
    mountWizard();
    BridgeRegistry.call('showOnboardingWizard');
    flushSync();

    document.querySelector<HTMLButtonElement>('.ow-btn-primary')!.click();
    vi.advanceTimersByTime(180);
    flushSync();
    expect(document.querySelector('.ow-counter')?.textContent).toContain('2 / 6');

    document.querySelector<HTMLButtonElement>('.ow-btn-secondary')!.click();
    vi.advanceTimersByTime(180);
    flushSync();
    expect(document.querySelector('.ow-counter')?.textContent).toContain('1 / 6');

    document.querySelectorAll<HTMLButtonElement>('.ow-dot')[5]!.click();
    vi.advanceTimersByTime(120);
    flushSync();
    expect(document.querySelector('.ow-counter')?.textContent).toContain('6 / 6');

    document.querySelector<HTMLButtonElement>('.ow-btn-primary')!.click();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(wizard()).toBeNull();
    expect(localStorage.getItem(`${STORAGE_PREFIX}:user-a`)).toBe('done');
    expect(localStorage.getItem(STORAGE_PREFIX)).toBeNull();
  });
});
