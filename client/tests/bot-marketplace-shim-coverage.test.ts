import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyFn } from '../js/core/bridge-registry.ts';

const { loadCatalogMock, fetchPluginsMock, injectStylesMock, errorLog } = vi.hoisted(() => ({
  loadCatalogMock: vi.fn(async () => undefined),
  fetchPluginsMock: vi.fn(async () => undefined),
  injectStylesMock: vi.fn(),
  errorLog: vi.fn(),
}));

vi.mock('../js/core/bot-marketplace/bot-catalog.js', () => ({ getCatalog: () => [], loadCatalog: loadCatalogMock }));
vi.mock('../js/core/bot-marketplace/bot-api.js', () => ({ fetchLoadedPlugins: fetchPluginsMock, getLoadedPlugins: () => [] }));
vi.mock('../js/core/bot-marketplace/bot-styles.js', () => ({ injectStyles: injectStylesMock }));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: errorLog }),
}));

const COMPONENT = '../js/core/bot-marketplace/BotMarketplace.svelte';
type Shim = typeof import('../js/core/bot-marketplace/bot-marketplace-svelte.ts');
type Registry = typeof import('../js/core/bridge-registry.ts')['BridgeRegistry'];

/**
 * `vi.resetModules()` kayit defterini de tazeler; kabuk ile testin AYNI
 * ornegi gormesi icin defter de taze graftan alinir.
 */
async function loadShim(): Promise<{ shim: Shim; registry: Registry }> {
  vi.resetModules();
  const registry = (await import('../js/core/bridge-registry.ts')).BridgeRegistry;
  const shim = await import('../js/core/bot-marketplace/bot-marketplace-svelte.ts');
  return { shim, registry };
}

/** Uzak parca yuklenemeyen dagitimi modeller. */
async function loadShimWithBrokenChunk(): Promise<{ shim: Shim; registry: Registry }> {
  vi.resetModules();
  vi.doMock(COMPONENT, () => { throw new Error('chunk 404'); });
  const registry = (await import('../js/core/bridge-registry.ts')).BridgeRegistry;
  const shim = await import('../js/core/bot-marketplace/bot-marketplace-svelte.ts');
  return { shim, registry };
}

const root = (): HTMLElement | null => document.getElementById('bot-marketplace-root');

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const REGISTERED = ['openMarketplacePage', 'openBotMarketplace', 'closeBotMarketplace'] as const;

beforeEach(() => {
  errorLog.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.doUnmock(COMPONENT);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('bot marketplace mount shim', () => {
  it('registers the canonical open/close owners at import time', async () => {
    const { shim, registry } = await loadShim();

    for (const key of REGISTERED) expect(registry.has(key)).toBe(true);
    expect(registry.get('openBotMarketplace')).toBe(shim.openBotMarketplace);
    expect(registry.get('openMarketplacePage')).toBe(shim.openBotMarketplace);
    expect(registry.get('closeBotMarketplace')).toBe(shim.closeBotMarketplace);
    for (const key of REGISTERED) expect(typeof registry.get<AnyFn>(key)).toBe('function');
  });

  it('opening mounts a single host, closes exclusive peers, and lazily loads the component', async () => {
    const { shim, registry } = await loadShim();
    const closeInbox = vi.fn();
    registry.register('closeInbox', closeInbox);

    await shim.openBotMarketplace();

    expect(errorLog).not.toHaveBeenCalled();
    expect(root()).not.toBeNull();
    expect(root()!.childElementCount).toBeGreaterThan(0);
    // Esler odagi calmadan kapatilir.
    expect(closeInbox).toHaveBeenCalledWith(false);
  });

  it('a second open toggles the surface closed instead of stacking a second host', async () => {
    const { shim } = await loadShim();
    await shim.openBotMarketplace();
    expect(document.querySelectorAll('#bot-marketplace-root')).toHaveLength(1);

    await shim.openBotMarketplace();

    expect(root()).toBeNull();
    expect(document.querySelectorAll('#bot-marketplace-root')).toHaveLength(0);
  });

  it('closing restores focus to the opener, and can be told not to', async () => {
    const { shim } = await loadShim();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    // Monte edilen yuzeyin KENDI odak tuzagi da soktugu odagi geri verir; o
    // is `close()` icinde SENKRON biter. Kabugun kendi geri verisi ise bir
    // mikrogorevdedir. Kapatmanin hemen ardindan odagi baska bir ogeye
    // tasiyarak ikisi ayrilir: yalnizca kabuk kuyruga girmisse odak geri alinir.
    const elsewhere = document.createElement('button');
    elsewhere.id = 'next-surface';
    document.body.append(elsewhere);

    await shim.openBotMarketplace();
    shim.closeBotMarketplace();
    elsewhere.focus();
    await settle();
    expect(document.activeElement).toBe(opener);

    opener.focus();
    await shim.openBotMarketplace();
    // Es yuzey devri: odak siradaki yuzeyden CALINMAZ.
    shim.closeBotMarketplace(false);
    elsewhere.focus();
    await settle();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('a detached opener is not focused back and does not throw', async () => {
    const { shim } = await loadShim();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    await shim.openBotMarketplace();
    opener.remove();
    expect(() => shim.closeBotMarketplace()).not.toThrow();
    await settle();
    expect(root()).toBeNull();
  });

  it('closing while the lazy import is in flight cancels the mount instead of leaking a host', async () => {
    const { shim } = await loadShim();

    const opening = shim.openBotMarketplace();
    // Ic-ice import cozulmeden once kapat: eski nesil monte edilmemeli.
    shim.closeBotMarketplace();
    expect(root()).toBeNull();
    await opening;
    await settle();

    expect(root()).toBeNull();
    expect(document.querySelectorAll('#bot-marketplace-root')).toHaveLength(0);
  });

  it('closing with nothing open is a no-op', async () => {
    const { shim } = await loadShim();

    expect(() => shim.closeBotMarketplace()).not.toThrow();
    expect(root()).toBeNull();
  });

  it('the registered owners drive the surface through the registry', async () => {
    const { registry } = await loadShim();

    await registry.call<Promise<void>>('openMarketplacePage');
    expect(root()).not.toBeNull();

    // Es yuzey sozlesmesi: odagi geri vermeden kapat.
    registry.call<void>('closeBotMarketplace', false);
    expect(root()).toBeNull();

    await registry.call<Promise<void>>('openBotMarketplace');
    expect(root()).not.toBeNull();
  });
});

describe('bot marketplace shim chunk failure', () => {
  it('a failed chunk load tears the host down, logs, and tells the user', async () => {
    const { shim, registry } = await loadShimWithBrokenChunk();
    const toast = vi.fn();
    registry.register('toast', toast);

    await shim.openBotMarketplace();

    expect(root()).toBeNull();
    expect(errorLog).toHaveBeenCalledWith('Bot Marketplace yüklenemedi', expect.any(Error));
    expect(toast).toHaveBeenCalledWith('Bot Marketplace yüklenemedi. Tekrar deneyin.', 'error');
  });

  it('a load failure for a superseded generation stays silent', async () => {
    const { shim, registry } = await loadShimWithBrokenChunk();
    const toast = vi.fn();
    registry.register('toast', toast);

    const opening = shim.openBotMarketplace();
    shim.closeBotMarketplace();
    await opening;
    await settle();

    expect(errorLog).toHaveBeenCalledWith('Bot Marketplace yüklenemedi', expect.any(Error));
    // Kullanici zaten kapatti: eskimis basarisizlik icin uyari gosterilmez.
    expect(toast).not.toHaveBeenCalled();
    expect(root()).toBeNull();
  });
});
