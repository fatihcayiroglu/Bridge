// client/tests/toast-and-theme-edge-paths.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ApiErrorToast + ThemeManager — TAŞMA, ÇİFT KAPATMA VE SİSTEM TERCİHİ
// ════════════════════════════════════════════════════════════════════════════
// TOAST kuyruğu SINIRLIDIR. Sınırsız olsaydı bir hata döngüsü (yeniden bağlanma
// denemeleri, toplu bir istek dizisi) ekranı tamamen kaplar ve altındaki
// uygulamayı kullanılamaz hâle getirirdi. Taşma yolunun ölçülmesi gerekir:
// EN ESKİLER düşer, en yenisi KALIR — tersi olsaydı kullanıcı en güncel
// hatayı hiç görmezdi.
//
// Kapatma İDEMPOTENTTİR: solmakta olan bir bildirimi ikinci kez kapatmak
// ikinci bir zamanlayıcı kurmamalıdır; kurulsaydı, o sırada aynı kimliği
// almış yeni bir bildirim erkenden silinirdi.
//
// TEMA tarafında ölçülen sözleşme şudur: kullanıcının AÇIK seçimi işletim
// sistemi tercihini EZER. Kullanıcı "koyu" dediyse, sistem aydınlığa geçtiğinde
// arayüz aydınlanmamalıdır. Ayrıca geçersiz bir tema adı SESSİZCE
// uygulanmamalı — depolanan/çağrılan değer bir uzantıdan da gelebilir.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ApiErrorToast from '../js/core/ApiErrorToast.svelte';
import ThemeManager from '../js/core/ThemeManager.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { THEME_STORAGE_KEY, currentTheme } from '../js/core/theme-store.ts';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

const toasts = () => { flushSync(); return [...host.querySelectorAll('.toast')]; };
// `.toast` metni simge ve kapatma karakterini de içerir; ölçülen şey KULLANICI
// METNİDİR, bu yüzden yalnızca metin düğümü okunur.
const texts = () => toasts().map(node => node.querySelector('.toast-text')?.textContent?.trim() ?? '');
const advance = (ms: number) => { vi.advanceTimersByTime(ms); flushSync(); };
const show = (message: unknown, type?: unknown, timeout?: unknown) =>
  BridgeRegistry.call('toast', message, type, timeout);

describe('toast queue stays bounded and dismissal is idempotent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    instance = mount(ApiErrorToast, { target: host });
    flushSync();
  });

  afterEach(() => {
    if (instance) unmount(instance);
    instance = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('drops the oldest entries and always keeps the newest', () => {
    for (let index = 1; index <= 6; index += 1) show(`hata ${index}`, 'error');
    // Görünür tavan 4'tür; taşanlar SOLDURULARAK düşer.
    const visible = texts();
    expect(visible.some(text => text.includes('hata 6'))).toBe(true);

    advance(600);   // solma tamamlanır
    const settled = texts();
    expect(settled).toHaveLength(4);
    expect(settled.some(text => text.includes('hata 1'))).toBe(false);
    expect(settled.some(text => text.includes('hata 2'))).toBe(false);
    expect(settled.some(text => text.includes('hata 6'))).toBe(true);
  });

  it('ignores a second dismissal of an already fading toast', () => {
    show('kapanıyor', 'info');
    flushSync();
    const close = host.querySelector<HTMLButtonElement>('.toast-close');
    expect(close).not.toBeNull();

    close!.click(); flushSync();
    close!.click(); flushSync();   // ikinci kapatma HİÇBİR ŞEY yapmaz

    advance(600);
    expect(toasts()).toHaveLength(0);

    // İkinci bir zamanlayıcı kurulmuş olsaydı, aynı kimliği alan yeni bildirim
    // erkenden silinirdi. Yenisi tam ömrünü yaşamalıdır.
    show('yeni', 'info');
    advance(400);
    expect(texts().some(text => text.includes('yeni'))).toBe(true);
  });

  it('ignores messages that carry no text at all', () => {
    show(null); show(undefined); show('   '); show('');
    expect(toasts()).toHaveLength(0);
  });

  it('honours an explicit lifetime and falls back for an unusable one', () => {
    show('kısa', 'info', 1_000);
    advance(1_100 + 600);
    expect(texts().some(text => text.includes('kısa'))).toBe(false);

    // Sayı olmayan / sıfır / negatif süreler VARSAYILANA düşer; anında
    // kaybolan ya da hiç kaybolmayan bir bildirim üretmezler.
    show('varsayılan-a', 'info', 'çok uzun');
    show('varsayılan-b', 'info', 0);
    show('varsayılan-c', 'info', -5);
    advance(2_000);
    expect(texts().filter(text => text.startsWith('varsayılan'))).toHaveLength(3);
    advance(1_100 + 600);
    expect(texts().filter(text => text.startsWith('varsayılan'))).toHaveLength(0);
  });

  it('truncates an over-long message rather than letting it fill the screen', () => {
    show('ç'.repeat(500), 'error');
    const text = texts()[0] ?? '';
    expect(text.length).toBeLessThanOrEqual(210);
    expect(text.endsWith('…')).toBe(true);
  });

  it('marks only errors as assertive alerts', () => {
    show('bir hata', 'error');
    show('bir bilgi', 'bilinmeyen-tip');
    const nodes = toasts();
    expect(nodes.find(n => n.textContent?.includes('bir hata'))?.getAttribute('role')).toBe('alert');
    const info = nodes.find(n => n.textContent?.includes('bir bilgi'));
    expect(info?.getAttribute('role')).toBe('status');
    // Tanınmayan tip 'info' sayılır; sınıf adı da öyle olmalı.
    expect(info?.getAttribute('data-toast-type')).toBe('info');
  });
});

describe('an explicit theme choice outranks the operating system', () => {
  let mediaListeners: Array<() => void>;
  let matches: boolean;

  beforeEach(() => {
    localStorage.clear();
    mediaListeners = [];
    matches = false;
    // `matches` CANLI okunmalıdır: bileşen mount anında bir kez sorgular ve
    // sonra aynı nesneyi dinler. Donmuş bir değer sistem değişimini ölçemezdi.
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() { return matches; },
      addEventListener: (_event: string, fn: () => void) => { mediaListeners.push(fn); },
      removeEventListener: () => {},
      get media() { return '(prefers-color-scheme: light)'; },
    })));
    document.body.innerHTML = '<button id="btn-theme" type="button"><svg viewBox="0 0 24 24"></svg></button>';
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (instance) unmount(instance);
    instance = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  function mountManager(): void {
    instance = mount(ThemeManager, { target: host });
    flushSync();
  }

  it('follows the system while the user has made no choice', () => {
    mountManager();
    localStorage.removeItem(THEME_STORAGE_KEY);

    matches = true;
    mediaListeners.forEach(fn => fn());
    flushSync();
    expect(currentTheme()).toBe('light');

    matches = false;
    mediaListeners.forEach(fn => fn());
    flushSync();
    expect(currentTheme()).toBe('dark');
  });

  it('stops following the system once the user picks a theme', () => {
    mountManager();
    BridgeRegistry.call('setTheme', 'dark');
    flushSync();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    // Sistem aydınlığa geçer ama kullanıcının AÇIK seçimi kazanır.
    matches = true;
    mediaListeners.forEach(fn => fn());
    flushSync();
    expect(currentTheme()).toBe('dark');
  });

  it('refuses a theme name it does not recognise', () => {
    mountManager();
    BridgeRegistry.call('setTheme', 'dark');
    flushSync();

    BridgeRegistry.call('setTheme', 'rainbow');
    BridgeRegistry.call('setTheme', null);
    BridgeRegistry.call('setTheme', 42);
    flushSync();
    // Geçersiz istekler yok sayılır; hiçbiri depolanmaz.
    expect(currentTheme()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('cycles through the themes from the existing header control', () => {
    mountManager();
    const button = document.getElementById('btn-theme')!;
    const before = BridgeRegistry.call('getTheme');

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();
    expect(BridgeRegistry.call('getTheme')).not.toBe(before);
    // Düğmenin kendi SVG simgesi KORUNUR; erişilebilir ad güncellenir.
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.getAttribute('aria-label')).toContain('sıradaki');
  });

  it('mounts without a theme control on the page at all', () => {
    document.getElementById('btn-theme')!.remove();
    expect(() => mountManager()).not.toThrow();
    expect(() => BridgeRegistry.call('cycleTheme')).not.toThrow();
  });
});
