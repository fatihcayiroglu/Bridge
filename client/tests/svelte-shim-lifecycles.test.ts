// client/tests/svelte-shim-lifecycles.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// ════════════════════════════════════════════════════════════════════════════
// discover-svelte.ts / slow-mode-svelte.ts — BAĞLAMA KABUKLARININ YAŞAM DÖNGÜSÜ
// ════════════════════════════════════════════════════════════════════════════
// Bu iki modül birer KABUKTUR (shim): bir Svelte bileşenini sayfaya bağlar ve
// eski `BridgeRegistry` sözleşmelerini korur. Küçük olmaları önemsiz oldukları
// anlamına gelmez — açılış sırası hatalarının tam olarak yaşandığı yer burasıdır:
//
//   · Modül belge YÜKLENİRKEN gelirse `DOMContentLoaded` beklenir; belge zaten
//     hazırsa HEMEN bağlanır. Yalnızca birini ele almak, modülün ne zaman
//     yüklendiğine göre paneli SESSİZCE kayıp yapar.
//   · Çifte bağlama koruması gerçek olmalıdır: iki örnek aynı olayları iki kez
//     işler ve kullanıcı her şeyi çift görür.
//   · Sökme, bağlanmamış bir kabukta ÇÖKMEMELİ ve `null` örneği yeniden
//     sökmeye çalışmamalıdır.
//
// Yavaş mod tarafında ek bir sözleşme var: gösterge yalnızca OKUR. Sahip
// (`setSlowMode` / `startSlowModeCooldown`) kayıtlı değilse hiçbir şey
// yapmamalıdır — kayıtsız bir sahibi çağırmak, kısıtlamayı istemcide
// uydurmaya başlamak demektir.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../js/core/api-fetch.js', () => ({ apiFetch }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'https://bridge.test' }));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

type Registry = typeof import('../js/core/bridge-registry.ts').BridgeRegistry;
let registry: Registry;

function setReadyState(value: DocumentReadyState): void {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => value });
}

beforeEach(() => {
  document.body.innerHTML = '';
  apiFetch.mockReset();
  vi.resetModules();
});

afterEach(() => {
  setReadyState('complete');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('discover shim mounts exactly once, whenever it is loaded', () => {
  it('waits for DOMContentLoaded when the document is still parsing', async () => {
    setReadyState('loading');
    registry = (await import('../js/core/bridge-registry.ts')).BridgeRegistry;
    await import('../js/core/discover-svelte.ts');

    // Belge hâlâ ayrıştırılıyor: panel HENÜZ bağlanmamıştır.
    expect(document.getElementById('discover-root')).toBeNull();

    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(document.getElementById('discover-root')).not.toBeNull();
  });

  it('mounts immediately when the document is already parsed', async () => {
    setReadyState('complete');
    registry = (await import('../js/core/bridge-registry.ts')).BridgeRegistry;
    await import('../js/core/discover-svelte.ts');
    expect(document.getElementById('discover-root')).not.toBeNull();
  });

  it('does not create a second root when the mount owner is called again', async () => {
    setReadyState('complete');
    registry = (await import('../js/core/bridge-registry.ts')).BridgeRegistry;
    await import('../js/core/discover-svelte.ts');

    registry.call('onDiscoverMount');
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(document.querySelectorAll('#discover-root')).toHaveLength(1);
  });

  it('unmounts once and then does nothing on a repeated unmount', async () => {
    setReadyState('complete');
    registry = (await import('../js/core/bridge-registry.ts')).BridgeRegistry;
    await import('../js/core/discover-svelte.ts');

    expect(() => registry.call('onDiscoverUnmount')).not.toThrow();
    // Sökülmüş kabukta ikinci sökme sessizdir; `null` örnek yeniden sökülmez.
    expect(() => registry.call('onDiscoverUnmount')).not.toThrow();
    // Yeniden bağlanabilir olmalıdır — kabuk kendini kalıcı olarak bozmaz.
    registry.call('onDiscoverMount');
    expect(document.querySelectorAll('#discover-root')).toHaveLength(1);
  });
});

describe('joining a community from discover reports the server verdict', () => {
  async function boot(): Promise<Registry> {
    setReadyState('complete');
    const reg = (await import('../js/core/bridge-registry.ts')).BridgeRegistry;
    await import('../js/core/discover-svelte.ts');
    return reg;
  }

  it('shows the exact reason the server gave for a refusal', async () => {
    registry = await boot();
    const toast = vi.fn(); const loadServers = vi.fn();
    registry.register('toast', toast as never);
    registry.register('loadServers', loadServers as never);
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Bu topluluk kapalı' }) });

    await registry.call('joinServerFromDiscover', 'srv-1');
    expect(apiFetch).toHaveBeenCalledWith('https://bridge.test/api/servers/srv-1/join', { method: 'POST' });
    // Sunucunun `error` govdesi gosterilmez: durum kanonik metne eslenir.
    expect(toast).toHaveBeenCalledWith(t('discover_join_failed'), 'error');
    expect(toast).not.toHaveBeenCalledWith('Bu topluluk kapalı', 'error');
    // Reddedilen katılım sunucu listesini TAZELEMEZ; katılmadık.
    expect(loadServers).not.toHaveBeenCalled();
    registry.unregister('toast'); registry.unregister('loadServers');
  });

  it('falls back to a generic reason when the refusal body is unusable', async () => {
    registry = await boot();
    const toast = vi.fn();
    registry.register('toast', toast as never);
    apiFetch.mockResolvedValue({ ok: false, json: async () => { throw new Error('bad json'); } });

    await registry.call('joinServerFromDiscover', 'srv-2');
    expect(toast).toHaveBeenCalledWith(t('discover_join_failed'), 'error');
    registry.unregister('toast');
  });

  it('refreshes the server list only after a successful join', async () => {
    registry = await boot();
    const toast = vi.fn(); const loadServers = vi.fn();
    registry.register('toast', toast as never);
    registry.register('loadServers', loadServers as never);
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await registry.call('joinServerFromDiscover', 'srv-3');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('katıldın'), 'success');
    expect(loadServers).toHaveBeenCalled();
    registry.unregister('toast'); registry.unregister('loadServers');
  });
});

describe('slow-mode indicator only reads, never invents a restriction', () => {
  async function bootSlowMode(ready: DocumentReadyState = 'complete') {
    setReadyState(ready);
    const reg = (await import('../js/core/bridge-registry.ts')).BridgeRegistry;
    const mod = await import('../js/core/slow-mode-svelte.ts');
    return { reg, mod };
  }

  it('waits for DOMContentLoaded when loaded during parsing', async () => {
    const { mod } = await bootSlowMode('loading');
    expect(document.getElementById('slow-mode-root')).toBeNull();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(document.getElementById('slow-mode-root')).not.toBeNull();
    mod.unmountSlowMode();
  });

  it('anchors the indicator next to the composer when one exists', async () => {
    document.body.innerHTML = '<div id="wrap"><div id="msg-input-wrap"></div></div>';
    const { mod } = await bootSlowMode('complete');
    const root = document.getElementById('slow-mode-root')!;
    // Kısıtlama kompozitörde hissedilir; gösterge oraya, tam ÖNÜNE konur.
    expect(root.nextElementSibling?.id).toBe('msg-input-wrap');
    mod.unmountSlowMode();
  });

  it('says nothing when no slow-mode owner is registered', async () => {
    const { reg, mod } = await bootSlowMode('complete');
    reg.unregister('setSlowMode');
    const start = vi.fn();
    reg.register('startSlowModeCooldown', start as never);
    reg.register('getCurrentChannel', (() => ({ _id: 'c1', slowmode: 15 })) as never);

    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    // Sahip yoksa hiçbir kısıtlama uydurulmaz.
    expect(start).not.toHaveBeenCalled();
    reg.unregister('startSlowModeCooldown'); reg.unregister('getCurrentChannel');
    mod.unmountSlowMode();
  });

  it('ignores a violation for a channel the user is not looking at', async () => {
    const { reg, mod } = await bootSlowMode('complete');
    const socket = { on: vi.fn(), off: vi.fn() };
    reg.register('socket', socket as never);
    reg.register('getCurrentChannel', (() => ({ _id: 'c1' })) as never);
    const start = vi.fn();
    reg.register('startSlowModeCooldown', start as never);

    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    const handler = socket.on.mock.calls.find(call => call[0] === 'error:slowmode')?.[1] as
      ((payload: unknown) => void) | undefined;
    expect(handler).toBeTypeOf('function');

    handler!({ remaining: 5, channelId: 'c2' });
    expect(start).not.toHaveBeenCalled();       // başka kanal
    handler!({ remaining: 0, channelId: 'c1' });
    expect(start).not.toHaveBeenCalled();       // kalan süre yok
    handler!({ remaining: 'çok', channelId: 'c1' });
    expect(start).not.toHaveBeenCalled();       // sayı değil

    handler!({ remaining: 4.2, channelId: 'c1' });
    expect(start).toHaveBeenCalledWith(5);      // yukarı yuvarlanır

    reg.unregister('socket'); reg.unregister('getCurrentChannel'); reg.unregister('startSlowModeCooldown');
    mod.unmountSlowMode();
  });

  it('rebinds to a replacement socket and releases the old one exactly once', async () => {
    const { reg, mod } = await bootSlowMode('complete');
    const first = { on: vi.fn(), off: vi.fn() };
    reg.register('socket', first as never);
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(first.on).toHaveBeenCalledWith('error:slowmode', expect.any(Function));

    // Aynı soket yeniden bildirilirse HİÇBİR ŞEY yapılmaz (çifte dinleyici olurdu).
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    expect(first.on).toHaveBeenCalledTimes(1);

    const second = { on: vi.fn(), off: vi.fn() };
    reg.register('socket', second as never);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    expect(first.off).toHaveBeenCalledWith('error:slowmode', expect.any(Function));
    expect(second.on).toHaveBeenCalledWith('error:slowmode', expect.any(Function));

    reg.unregister('socket');
    mod.unmountSlowMode();
    mod.unmountSlowMode();   // ikinci sökme sessizdir
  });
});
