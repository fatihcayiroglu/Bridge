// client/tests/header-opener-shims.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BAŞLIK AÇICILARI — KABUK YOKSA KURULMAZ, VARSA TEK KEZ KURULUR
// ════════════════════════════════════════════════════════════════════════════
//
// Sunucu Ayarları ve Sticker açıcıları kanal başlığındaki MEVCUT araç
// çubuğuna yerleşir; kendi kökünü YARATMAZLAR. Bu, diğer mount köprülerinden
// farklı iki riski beraberinde getirir:
//
//   · Kabuk henüz yokken sessizce çıkmalıdır. Kendi kökünü yaratsaydı düğme
//     sayfanın en altında, başlıktan kopuk biçimde belirirdi.
//   · Kabuk sonradan hazır olduğunda (`bridge:socket-ready`) kurulum yine de
//     gerçekleşmelidir; aksi halde düğme HİÇ görünmez.
//
// Ayrıca Sunucu Ayarları açıcısı modalın TEK açılış sözleşmesini kaydeder;
// sekme parametresi güvenilmez bir kaynaktan gelebilir ve string olmayan bir
// değer 'general'a düşmelidir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mountModal, unmountModal } = vi.hoisted(() => ({
  mountModal: vi.fn(async () => undefined),
  unmountModal: vi.fn(),
}));

vi.mock('../js/core/server-settings/server-settings-svelte.ts', () => ({
  mountServerSettingsModal: mountModal,
  unmountServerSettingsModal: unmountModal,
}));

type SettingsShim = typeof import('../js/core/server-settings-opener-svelte.ts');
type StickerShim = typeof import('../js/core/stickers/sticker-opener-svelte.ts');
type Registry = typeof import('../js/core/bridge-registry.ts')['BridgeRegistry'];

const HEADER = '<div id="channel-header"><div class="channel-header-actions"></div></div>';
const actions = (): HTMLElement | null => document.querySelector('#channel-header .channel-header-actions');

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

async function loadSettingsShim(): Promise<{ shim: SettingsShim; registry: Registry }> {
  vi.resetModules();
  const registry = (await import('../js/core/bridge-registry.ts')).BridgeRegistry;
  const shim = await import('../js/core/server-settings-opener-svelte.ts');
  return { shim, registry };
}

async function loadStickerShim(): Promise<StickerShim> {
  vi.resetModules();
  return await import('../js/core/stickers/sticker-opener-svelte.ts');
}

function withReadyState(value: DocumentReadyState, run: () => Promise<void>): Promise<void> {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => value });
  return run().finally(() => { Reflect.deleteProperty(document, 'readyState'); });
}

let dispose: (() => void) | null = null;

beforeEach(() => {
  mountModal.mockClear();
  unmountModal.mockClear();
  document.body.innerHTML = '';
});

afterEach(async () => {
  dispose?.();
  dispose = null;
  await flush();
  document.body.innerHTML = '';
});

describe('Sunucu Ayarları açıcısı köprüsü', () => {
  it('başlık kabuğu yokken hiçbir şey kurmaz ve sayfaya kök eklemez', async () => {
    const { shim } = await loadSettingsShim();
    dispose = shim.unmountServerSettingsOpener;

    expect(document.body.children).toHaveLength(0);

    shim.mountOpener();
    expect(document.body.children).toHaveLength(0);
  });

  it('kabuk varken araç çubuğuna kurulur ve ikinci çağrı çiftlemez', async () => {
    document.body.innerHTML = HEADER;
    const { shim } = await loadSettingsShim();
    dispose = shim.unmountServerSettingsOpener;

    const host = actions()!;
    expect(host.childNodes.length).toBeGreaterThan(0);
    const once = host.innerHTML;

    shim.mountOpener();
    shim.mountOpener();

    expect(host.innerHTML).toBe(once);
  });

  it('söküm araç çubuğunu boşaltır, ikinci söküm sessizdir ve yeniden kurulabilir', async () => {
    document.body.innerHTML = HEADER;
    const { shim } = await loadSettingsShim();
    dispose = shim.unmountServerSettingsOpener;
    const host = actions()!;

    shim.unmountServerSettingsOpener();
    await flush();
    expect(host.childNodes).toHaveLength(0);

    expect(() => shim.unmountServerSettingsOpener()).not.toThrow();

    shim.mountOpener();
    expect(host.childNodes.length).toBeGreaterThan(0);
  });

  it('belge yükleniyorken kurulum DOMContentLoaded olayına ertelenir', async () => {
    await withReadyState('loading', async () => {
      document.body.innerHTML = HEADER;
      const { shim } = await loadSettingsShim();
      dispose = shim.unmountServerSettingsOpener;

      expect(actions()!.childNodes).toHaveLength(0);

      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(actions()!.childNodes.length).toBeGreaterThan(0);
    });
  });

  it('kabuk sonradan hazır olursa soket olayı kurulumu tamamlar', async () => {
    const { shim } = await loadSettingsShim();
    dispose = shim.unmountServerSettingsOpener;
    // Import anında kabuk yoktu: açıcı kurulmadı.
    expect(document.body.children).toHaveLength(0);

    document.body.innerHTML = HEADER;
    document.dispatchEvent(new Event('bridge:socket-ready'));

    expect(actions()!.childNodes.length).toBeGreaterThan(0);
  });

  it('modalın tek açılış sözleşmesi kayıt defterinden sürülür', async () => {
    const { shim, registry } = await loadSettingsShim();
    dispose = shim.unmountServerSettingsOpener;

    expect(registry.has('openServerSettings')).toBe(true);
    expect(registry.has('closeServerSettings')).toBe(true);

    await registry.call<Promise<void>>('openServerSettings', 'roles');
    expect(mountModal).toHaveBeenCalledWith('roles');

    // Guvenilmez sekme degeri: string olmayan her sey 'general'a duser.
    await registry.call<Promise<void>>('openServerSettings', { evil: true });
    expect(mountModal).toHaveBeenLastCalledWith('general');
    await registry.call<Promise<void>>('openServerSettings');
    expect(mountModal).toHaveBeenLastCalledWith('general');

    await registry.call<Promise<void>>('closeServerSettings');
    expect(unmountModal).toHaveBeenCalledTimes(1);
  });
});

describe('Sticker açıcısı köprüsü', () => {
  it('başlık kabuğu yokken hiçbir şey kurmaz', async () => {
    const shim = await loadStickerShim();
    dispose = shim.unmountStickerOpener;

    expect(document.body.children).toHaveLength(0);
    shim.mountStickerOpener();
    expect(document.body.children).toHaveLength(0);
  });

  it('kabuk varken kurulur, çiftlenmez ve sökülebilir', async () => {
    document.body.innerHTML = HEADER;
    const shim = await loadStickerShim();
    dispose = shim.unmountStickerOpener;
    const host = actions()!;

    expect(host.childNodes.length).toBeGreaterThan(0);
    const once = host.innerHTML;
    shim.mountStickerOpener();
    expect(host.innerHTML).toBe(once);

    shim.unmountStickerOpener();
    await flush();
    expect(host.childNodes).toHaveLength(0);
    expect(() => shim.unmountStickerOpener()).not.toThrow();
  });

  it('belge yükleniyorken kurulum ertelenir, kabuk sonradan gelirse soket olayı tamamlar', async () => {
    await withReadyState('loading', async () => {
      const shim = await loadStickerShim();
      dispose = shim.unmountStickerOpener;
      document.body.innerHTML = HEADER;

      expect(actions()!.childNodes).toHaveLength(0);
      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(actions()!.childNodes.length).toBeGreaterThan(0);
    });
  });

  it('soket hazır olayı, kabuk geç geldiğinde açıcıyı kurar', async () => {
    const shim = await loadStickerShim();
    dispose = shim.unmountStickerOpener;
    expect(document.body.children).toHaveLength(0);

    document.body.innerHTML = HEADER;
    document.dispatchEvent(new Event('bridge:socket-ready'));

    expect(actions()!.childNodes.length).toBeGreaterThan(0);
  });
});
