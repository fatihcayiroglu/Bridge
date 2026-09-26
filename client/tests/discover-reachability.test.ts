// client/tests/discover-reachability.test.ts
// KEŞFET — CANLI ERİŞİLEBİLİRLİK SÖZLEŞMESİ.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// `DiscoverPanel.svelte` 798 satırlık gerçek bir uygulamaydı ve kendi test
// paketi 19/19 geçiyordu — ama özellik KULLANICIYA ULAŞMIYORDU:
//   • `discover-svelte.ts` shim'i hiçbir yerden import edilmiyordu (app.ts=0)
//   • shim yalnız var olan `#discover-root`'u arıyordu; böyle bir eleman
//     index.html'de HİÇ yoktu → mount sessizce hiçbir şey yapmıyordu
//   • paneli açacak tek bir kontrol bile yoktu
//
// Mevcut paket "mount EDİLİRSE doğru davranır" der. Bu dosya bir adım
// öncesini kanıtlar: AÇICI GERÇEKTEN VAR ve paneli gerçekten açıyor.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ServerSwitcher from '../js/core/ServerSwitcher.svelte';
import DiscoverPanel from '../js/core/DiscoverPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

// Sunucu rail'i açılışta sunucu listesini çeker — ağ sınırı taklit edilir.
vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
}));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://test' }));

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

const discoverButton = (): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('button[aria-label="Toplulukları Keşfet"]');

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  BridgeRegistry.unregister('showDiscoverPanel');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountRail(): void {
  instance = mount(ServerSwitcher, { target: host });
  flushSync();
}

// ════════════════════════════════════════════════════════════════════════════
// A/B — açıcı var ve gerçek paneli açıyor
// ════════════════════════════════════════════════════════════════════════════
describe('Keşfet — canlı açıcı', () => {
  it('A: sunucu rail’inde Keşfet düğmesi VARDIR', () => {
    mountRail();

    expect(discoverButton()).not.toBeNull();
  });

  it('A2: düğme erişilebilir ad ve ipucu taşır', () => {
    mountRail();

    const btn = discoverButton()!;
    expect(btn.getAttribute('aria-label')).toBe('Toplulukları Keşfet');
    expect(btn.getAttribute('data-tip')).toBe('Toplulukları Keşfet');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('B: tıklama GERÇEK panel açma sözleşmesini çağırır', () => {
    const open = vi.fn();
    BridgeRegistry.register('showDiscoverPanel', open);
    mountRail();

    discoverButton()!.click();
    flushSync();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('C: iki kez tıklamak açıcıyı iki kez çağırır ama panel sahibi TEK kalır', () => {
    // Panel `open()` içinde `if (isVisible) return` ile ikinci yüklemeyi
    // engeller; rail tarafında ek bir durum tutulmaz.
    const open = vi.fn();
    BridgeRegistry.register('showDiscoverPanel', open);
    mountRail();

    discoverButton()!.click();
    discoverButton()!.click();
    flushSync();

    expect(open).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('button[aria-label="Toplulukları Keşfet"]')).toHaveLength(1);
  });

  it('GÜVENLİK: açıcı satır içi string handler kullanmaz', () => {
    mountRail();

    const btn = discoverButton()!;
    expect(btn.getAttribute('onclick')).toBeNull();
  });

  it('kayıt yoksa tıklama ÇÖKMEZ (registry yumuşak başarısızlık)', () => {
    mountRail();

    expect(() => discoverButton()!.click()).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Shim — konteyner ve tek örnek
// ════════════════════════════════════════════════════════════════════════════
describe('Keşfet — mount shim', () => {
  beforeEach(() => { vi.resetModules(); });

  it('shim `#discover-root` konteynerini kendisi oluşturur', async () => {
    expect(document.getElementById('discover-root')).toBeNull();

    await import('../js/core/discover-svelte.ts');

    expect(document.getElementById('discover-root')).not.toBeNull();
  });

  it('mount edilmiş panel VARSAYILAN OLARAK görünmez (kendiliğinden açılmaz)', async () => {
    await import('../js/core/discover-svelte.ts');

    // Panel mount edilir ama `isVisible=false` olduğu için hiçbir şey çizmez.
    const root = document.getElementById('discover-root')!;
    expect(root.querySelector('.discover-root')).toBeNull();
  });

  /**
   * `vi.resetModules()` TAZE bir modül grafiği kurar; shim o grafikteki
   * registry örneğine kaydeder. Dosyanın üstündeki import ESKİ grafiğe aittir,
   * bu yüzden doğrulama aynı taze grafikten okunmalıdır.
   */
  async function loadShim() {
    await import('../js/core/discover-svelte.ts');
    // Svelte'in zamanlayıcı durumu da modül grafiğine BAĞLIdır: eski grafikten
    // gelen flushSync taze grafikteki efektleri temizlemez.
    const { flushSync: freshFlush } = await import('svelte');
    freshFlush();   // kayıtlar bileşenin $effect'i içinde yapılır
    const { BridgeRegistry: Fresh } = await import('../js/core/bridge-registry.js');
    return { Fresh, freshFlush };
  }

  it('shim panel açma/kapama sözleşmesini registry’ye kaydeder', async () => {
    const { Fresh } = await loadShim();

    expect(Fresh.get('showDiscoverPanel')).toBeTypeOf('function');
    expect(Fresh.get('hideDiscoverPanel')).toBeTypeOf('function');
  });

  it('registry’den açmak paneli GERÇEKTEN görünür yapar (uçtan uca)', async () => {
    const { Fresh, freshFlush } = await loadShim();
    const root = document.getElementById('discover-root')!;
    expect(root.querySelector('.discover-root')).toBeNull();

    Fresh.call('showDiscoverPanel');
    freshFlush();

    const panel = root.querySelector('.discover-root');
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute('role')).toBe('dialog');

    // Kapatma da gerçekten çalışmalı.
    Fresh.call('hideDiscoverPanel');
    freshFlush();
    expect(root.querySelector('.discover-root')).toBeNull();
  });
});


// ════════════════════════════════════════════════════════════════════════════
// Realtime ownership — panel may coexist with other socket consumers/nodes
// ════════════════════════════════════════════════════════════════════════════

type Handler = (payload: unknown) => void;
class FakeDiscoverSocket {
  listeners = new Map<string, Set<Handler>>();
  emitted: Array<[string, unknown?]> = [];

  on<T>(event: string, cb: (payload: T) => void): void {
    const set = this.listeners.get(event) ?? new Set<Handler>();
    set.add(cb as Handler);
    this.listeners.set(event, set);
  }

  off<T>(event: string, cb?: (payload: T) => void): void {
    if (!cb) {
      this.listeners.delete(event);
      return;
    }
    const set = this.listeners.get(event);
    set?.delete(cb as Handler);
    if (set?.size === 0) this.listeners.delete(event);
  }

  emit(event: string, payload?: unknown): void {
    this.emitted.push([event, payload]);
  }

  fire(event: string, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload);
  }

  count(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

async function settleDiscover(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  flushSync();
}

describe('Keşfet — realtime listener ownership', () => {
  let panelHost: HTMLDivElement;
  let panel: ReturnType<typeof mount> | null;

  beforeEach(() => {
    panelHost = document.createElement('div');
    document.body.appendChild(panelHost);
    panel = null;
  });

  afterEach(() => {
    if (panel) unmount(panel);
    panel = null;
    panelHost.remove();
    for (const key of ['socket', 'showDiscoverPanel', 'openDiscoverPanel', 'hideDiscoverPanel']) {
      BridgeRegistry.unregister(key);
    }
  });

  it('cleanup yalnız kendi socket listenerlarını söker; unrelated consumer hayatta kalır', async () => {
    const socket = new FakeDiscoverSocket();
    const unrelated = vi.fn();
    socket.on('discover:memberCount', unrelated);
    BridgeRegistry.register('socket', socket as never);

    panel = mount(DiscoverPanel, { target: panelHost });
    flushSync();
    BridgeRegistry.call('showDiscoverPanel');
    await settleDiscover();

    expect(socket.count('discover:memberCount')).toBe(2);
    expect(socket.count('discover:online_update')).toBe(1);
    expect(socket.emitted.filter(([event]) => event === 'discover:subscribe')).toHaveLength(1);

    BridgeRegistry.call('hideDiscoverPanel');
    flushSync();

    expect(socket.count('discover:memberCount')).toBe(1);
    expect(socket.count('discover:online_update')).toBe(0);
    socket.fire('discover:memberCount', { serverId: 'other', memberCount: 9, onlineCount: 2 });
    expect(unrelated).toHaveBeenCalledTimes(1);
    expect(socket.emitted.filter(([event]) => event === 'discover:unsubscribe')).toHaveLength(1);
  });

  it('visible panel socket değişince eski ownerdan çıkar ve yeni sockete tam bir kez bağlanır', async () => {
    const first = new FakeDiscoverSocket();
    const second = new FakeDiscoverSocket();
    BridgeRegistry.register('socket', first as never);

    panel = mount(DiscoverPanel, { target: panelHost });
    flushSync();
    BridgeRegistry.call('showDiscoverPanel');
    await settleDiscover();
    expect(first.count('discover:memberCount')).toBe(1);

    BridgeRegistry.register('socket', second as never);
    document.dispatchEvent(new Event('bridge:socket-reconnected'));
    flushSync();

    expect(first.count('discover:memberCount')).toBe(0);
    expect(first.emitted.filter(([event]) => event === 'discover:unsubscribe')).toHaveLength(1);
    expect(second.count('discover:memberCount')).toBe(1);
    expect(second.count('discover:online_update')).toBe(1);
    expect(second.emitted.filter(([event]) => event === 'discover:subscribe')).toHaveLength(1);

    // Duplicate ready events on the same socket must not duplicate handlers.
    document.dispatchEvent(new Event('bridge:socket-ready'));
    flushSync();
    expect(second.count('discover:memberCount')).toBe(1);
  });

  it('component destroy realtime ve registry ownershipını tamamen bırakır', async () => {
    const socket = new FakeDiscoverSocket();
    BridgeRegistry.register('socket', socket as never);
    panel = mount(DiscoverPanel, { target: panelHost });
    flushSync();
    BridgeRegistry.call('showDiscoverPanel');
    await settleDiscover();

    const mounted = panel;
    panel = null;
    unmount(mounted!);
    flushSync();

    expect(socket.count('discover:memberCount')).toBe(0);
    expect(socket.count('discover:online_update')).toBe(0);
    expect(BridgeRegistry.get('showDiscoverPanel')).toBeNull();
    expect(BridgeRegistry.get('openDiscoverPanel')).toBeNull();
    expect(BridgeRegistry.get('hideDiscoverPanel')).toBeNull();
  });
});
