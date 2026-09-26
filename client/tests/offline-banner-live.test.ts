// client/tests/offline-banner-live.test.ts
// OfflineBanner — CANLI bağlanma sözleşmesi (gerçek bileşen).
//
// ════════════════════════════════════════════════════════════════════════════
// BATCH 2 — OFFLINE BANNER WIRE_NOW
// ════════════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: `OfflineBanner.svelte` (121 satır) gerçek bir uygulamaydı —
// window online/offline dinleyicileri, service-worker köprüsü, yeniden
// bağlanma sayacı, onDestroy temizliği — ama shim'ini HİÇBİR ŞEY import
// etmiyordu. Kullanıcı bağlantı kaybında hiçbir gösterge görmüyordu.
// Bu turda `app.ts` içine bağlandı.
//
// Emekliye ayrılan eski `offline-banner.test.ts` kendi `simulateSetOffline()`
// yardımcılarını çağırıp kendi DOM mutasyonlarını doğruluyordu; ÜRETİMİ hiç
// çalıştırmıyordu. Burada GERÇEK bileşen mount edilir; yalnız logger/registry
// sınırları taklit edilir.
//
// Üretim bileşeni bu turda DEĞİŞTİRİLMEDİ — yalnız erişilebilir kılındı.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import OfflineBanner from '../js/core/OfflineBanner.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

const banner = (): HTMLElement | null => host.querySelector('.offline-banner');

/** navigator.onLine üretimde onMount'ta okunur (OfflineBanner:63). */
function setNavigatorOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
}

function mountBanner(): void {
  instance = mount(OfflineBanner, { target: host });
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  setNavigatorOnline(true);
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  BridgeRegistry.unregister('setOffline');
  BridgeRegistry.unregister('setOnline');
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ════════════════════════════════════════════════════════════════════════════
// Görünürlük sözleşmesi
// ════════════════════════════════════════════════════════════════════════════
describe('OfflineBanner — görünürlük', () => {
  it('çevrimiçi başlangıçta banner GİZLİDİR', () => {
    mountBanner();

    expect(banner()).toBeNull();
  });

  it('window offline olayı banner’ı GÖSTERİR', async () => {
    mountBanner();

    window.dispatchEvent(new Event('offline'));
    flushSync();

    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain(t('ui_offline_waiting'));
  });

  it('window online olayı banner’ı GİZLER', () => {
    mountBanner();
    window.dispatchEvent(new Event('offline'));
    flushSync();
    expect(banner()).not.toBeNull();

    window.dispatchEvent(new Event('online'));
    flushSync();

    expect(banner()).toBeNull();
  });

  it('mount anında zaten çevrimdışıysa banner hemen görünür', () => {
    // OfflineBanner:63 — onMount içinde navigator.onLine kontrolü.
    setNavigatorOnline(false);

    mountBanner();

    expect(banner()).not.toBeNull();
  });

  it('yeniden bağlanma sonrası YANLIŞ çevrimdışı durumu kalmaz', () => {
    mountBanner();
    window.dispatchEvent(new Event('offline'));
    flushSync();

    window.dispatchEvent(new Event('online'));
    flushSync();
    // Sayaç çalışmaya devam edip banner'ı geri getirmemeli.
    vi.advanceTimersByTime(10_000);
    flushSync();

    expect(banner()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Yeniden bağlanma sayacı
// ════════════════════════════════════════════════════════════════════════════
describe('OfflineBanner — yeniden bağlanma durumu', () => {
  // ── İSTEMCİ İÇİ GERİ SAYIM KALDIRILDI ────────────────────────────────────
  // Banner eskiden kendi "5s… sonra yeniden deneniyor" sayacını çalıştırıyordu.
  // O sayaç hiçbir şeyi tetiklemiyordu: yeniden bağlanmanın sahibi Socket.IO
  // ve tarayıcının ağ olaylarıdır. Sayaç yalnızca kullanıcıya, ürünün
  // yapmadığı bir zamanlama SÖZÜ veriyordu (auth ekranındaki kaldırılan
  // "kilit geri sayımı" ile aynı kusur). Bugünkü sözleşme, gösterilen metnin
  // GERÇEK sinyale bağlı olmasıdır.
  it('ağ yokken "bağlantı bekleniyor" metnini gösterir ve kendi sayacını çalıştırmaz', () => {
    mountBanner();
    setNavigatorOnline(false);
    window.dispatchEvent(new Event('offline'));
    flushSync();

    expect(banner()!.textContent).toContain(t('ui_offline_waiting'));
    // Sahte bir geri sayım YOKTUR: bileşen bu durumda hiçbir zamanlayıcı kurmaz.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ağ varken soket düşerse "yeniden bağlanılıyor" durumuna geçer', () => {
    mountBanner();
    setNavigatorOnline(true);
    document.dispatchEvent(new CustomEvent('bridge:socket-disconnected'));
    flushSync();

    expect(banner()!.textContent).toContain(t('ui_realtime_reconnecting'));
    expect(vi.getTimerCount()).toBe(0);

    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    flushSync();
    expect(banner()).toBeNull();
  });

  it('ağ YOKKEN gelen soket-düştü sinyali "yeniden bağlanılıyor" DEMEZ', () => {
    // Yanlış olurdu: ağ yokken yeniden bağlanma denemesi yapılamaz.
    mountBanner();
    setNavigatorOnline(false);
    document.dispatchEvent(new CustomEvent('bridge:socket-disconnected'));
    flushSync();

    expect(banner()!.textContent).toContain(t('ui_offline_waiting'));
    expect(banner()!.textContent).not.toContain(t('ui_realtime_reconnecting'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Registry sözleşmesi (webrtc/socket katmanları bunları çağırabilir)
// ════════════════════════════════════════════════════════════════════════════
describe('OfflineBanner — registry kancaları', () => {
  it('setOffline / setOnline registry’ye kaydedilir', () => {
    mountBanner();

    expect(BridgeRegistry.get('setOffline')).toBeTypeOf('function');
    expect(BridgeRegistry.get('setOnline')).toBeTypeOf('function');
  });

  it('registry üzerinden setOffline banner’ı gösterir', () => {
    mountBanner();

    BridgeRegistry.call('setOffline');
    flushSync();

    expect(banner()).not.toBeNull();
  });

  it('setOnline bekleyen outbox sayısını gösterir ve dört saniye sonra temizler', () => {
    mountBanner();
    BridgeRegistry.call('setOnline', 3);
    flushSync();

    expect(banner()).toHaveClass('syncing');
    expect(banner()).toHaveTextContent('3 bekleyen mesaj');
    BridgeRegistry.call('setOnline', 2);
    flushSync();
    expect(banner()).toHaveTextContent('2 bekleyen mesaj');
    vi.advanceTimersByTime(4000);
    flushSync();
    expect(banner()).toBeNull();
  });
});

describe('OfflineBanner — service worker köprüsü', () => {
  let serviceWorker: EventTarget;
  let originalDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'serviceWorker');
    serviceWorker = new EventTarget();
    Object.defineProperty(window.navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  });

  afterEach(() => {
    if (originalDescriptor) Object.defineProperty(window.navigator, 'serviceWorker', originalDescriptor);
    else delete (window.navigator as unknown as Record<string, unknown>).serviceWorker;
  });

  it('network status çevrimdışı/çevrimiçi ve varsayılan pending değerlerini uygular', () => {
    mountBanner();
    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'SW_NETWORK_STATUS', online: false } }));
    flushSync();
    expect(banner()).toHaveClass('offline');

    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'SW_NETWORK_STATUS', online: true } }));
    flushSync();
    expect(banner()).toBeNull();

    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'SW_NETWORK_STATUS', online: true, pendingCount: 2 } }));
    flushSync();
    expect(banner()).toHaveTextContent('2 bekleyen mesaj');
  });

  it('outbox flushed durumunu temizler; ilgisiz ve şekilsiz mesajları yok sayar', () => {
    mountBanner();
    BridgeRegistry.call('setOnline', 4);
    serviceWorker.dispatchEvent(new MessageEvent('message', { data: null }));
    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'OTHER' } }));
    flushSync();
    expect(banner()).toHaveTextContent('4 bekleyen mesaj');

    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'SW_OUTBOX_FLUSHED' } }));
    flushSync();
    expect(banner()).toBeNull();
  });

  it('unmount service-worker listenerını aynı callback ile söker', () => {
    const remove = vi.spyOn(serviceWorker, 'removeEventListener');
    mountBanner();
    unmount(instance!);
    instance = null;
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Temizlik — bayat dinleyici bırakılmamalı
// ════════════════════════════════════════════════════════════════════════════
describe('OfflineBanner — yaşam döngüsü temizliği', () => {
  it('unmount sonrası offline olayı ARTIK banner üretmez', () => {
    mountBanner();
    unmount(instance!);
    instance = null;
    flushSync();

    window.dispatchEvent(new Event('offline'));
    flushSync();

    expect(host.querySelector('.offline-banner')).toBeNull();
  });

  it('unmount dinleyicileri gerçekten kaldırır (removeEventListener çağrılır)', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    mountBanner();

    unmount(instance!);
    instance = null;

    const events = remove.mock.calls.map(c => c[0]);
    expect(events).toContain('online');
    expect(events).toContain('offline');
  });

  it('unmount bekleyen-mesaj zamanlayıcısını durdurur', () => {
    // Geri sayım `setInterval`ı kaldırıldı; bileşenin kurduğu TEK zamanlayıcı
    // "bekleyen mesaj" rozetini 4 sn sonra temizleyen `setTimeout`tur.
    mountBanner();
    BridgeRegistry.call('setOnline', 2);
    flushSync();
    expect(vi.getTimerCount()).toBe(1);

    const clear = vi.spyOn(globalThis, 'clearTimeout');
    unmount(instance!);
    instance = null;

    expect(clear).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('registry sahipliği sonradan değişmişse yeni sahibin kaydını silmez', () => {
    const newerOffline = vi.fn();
    const newerOnline = vi.fn();
    mountBanner();
    BridgeRegistry.register('setOffline', newerOffline);
    BridgeRegistry.register('setOnline', newerOnline);

    unmount(instance!);
    instance = null;

    expect(BridgeRegistry.get('setOffline')).toBe(newerOffline);
    expect(BridgeRegistry.get('setOnline')).toBe(newerOnline);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Erişilebilirlik — bileşenin BUGÜNKÜ sahip olduğu semantik
// ════════════════════════════════════════════════════════════════════════════
describe('OfflineBanner — erişilebilirlik', () => {
  it('durum bölgesi olarak duyurulur', () => {
    mountBanner();
    window.dispatchEvent(new Event('offline'));
    flushSync();

    const el = banner()!;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('assertive');
    expect(el.getAttribute('aria-atomic')).toBe('true');
  });

  it('GÜVENLİK: durum metni düz metindir (enjekte edilmiş DOM yok)', () => {
    mountBanner();
    window.dispatchEvent(new Event('offline'));
    flushSync();

    expect(banner()!.querySelector('script')).toBeNull();
  });
});
