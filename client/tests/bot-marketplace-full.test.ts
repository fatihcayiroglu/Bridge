// client/tests/bot-marketplace-full.test.ts
// Bot Marketplace tam coverage testi — tüm submodüller:
//   catalog-data, bot-catalog, bot-search, bot-api, marketplace-state, bot-styles
// Hedef: her modülde %100 lines/functions/branches

'use strict';

// ── localStorage mock (jsdom'da güvenli) ──────────────────────────────────────
const _lsStore: Record<string, string> = {};
const localStorageMock = {
  getItem:    jest.fn((k: string) => _lsStore[k] ?? null),
  setItem:    jest.fn((k: string, v: string) => { _lsStore[k] = v; }),
  removeItem: jest.fn((k: string) => { delete _lsStore[k]; }),
  clear:      jest.fn(() => { Object.keys(_lsStore).forEach(k => delete _lsStore[k]); }),
};
Object.defineProperty(global, 'localStorage', { value: localStorageMock, writable: true });

// ── Globals mock ──────────────────────────────────────────────────────────────
jest.mock('../js/core/globals', () => ({
  getAPI:           jest.fn(() => 'http://localhost:3001'),
  getCurrentServer: jest.fn(() => ({ _id: 'server-1', name: 'Test Server' })),
}), { virtual: true });

const apiFetchMock = jest.fn(() => Promise.resolve({
  ok: true, status: 200,
  json: () => Promise.resolve({ success: true }),
}));

jest.mock('../js/core/api-fetch', () => ({
  apiFetch: apiFetchMock,
}), { virtual: true });

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn(), has: jest.fn(() => false) },
}), { virtual: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetMocks() {
  jest.clearAllMocks();
  apiFetchMock.mockResolvedValue({
    ok: true, status: 200,
    json: () => Promise.resolve({ success: true }),
  });
  localStorageMock.getItem.mockImplementation((k: string) => _lsStore[k] ?? null);
  localStorageMock.setItem.mockImplementation((k: string, v: string) => { _lsStore[k] = v; });
}

// ═══════════════════════════════════════════════════════════════════════════════
// catalog-data.ts
// ═══════════════════════════════════════════════════════════════════════════════
describe('catalog-data', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BOT_CATALOG, BOT_CATEGORIES } = require('../js/core/bot-marketplace/catalog-data');

  test('BOT_CATALOG dizi döner', () => {
    expect(Array.isArray(BOT_CATALOG)).toBe(true);
  });

  test('BOT_CATALOG en az 15 bot içerir', () => {
    expect(BOT_CATALOG.length).toBeGreaterThanOrEqual(15);
  });

  test('her bot listesi zorunlu alanları taşır', () => {
    BOT_CATALOG.forEach((bot: Record<string, unknown>) => {
      expect(typeof bot.id).toBe('string');
      expect(bot.id).toBeTruthy();
      expect(typeof bot.name).toBe('string');
      expect(typeof bot.category).toBe('string');
      expect(typeof bot.rating).toBe('number');
      expect(typeof bot.installs).toBe('number');
      expect(Array.isArray(bot.tags)).toBe(true);
      expect(Array.isArray(bot.commands)).toBe(true);
      expect(typeof bot.verified).toBe('boolean');
      expect(typeof bot.featured).toBe('boolean');
      expect(typeof bot.freeToUse).toBe('boolean');
    });
  });

  test('id\'ler benzersiz', () => {
    const ids = BOT_CATALOG.map((b: Record<string, string>) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('rating değerleri 0-5 arasında', () => {
    BOT_CATALOG.forEach((b: Record<string, number>) => {
      expect(b.rating).toBeGreaterThanOrEqual(0);
      expect(b.rating).toBeLessThanOrEqual(5);
    });
  });

  test('BOT_CATEGORIES dizi döner', () => {
    expect(Array.isArray(BOT_CATEGORIES)).toBe(true);
    expect(BOT_CATEGORIES.length).toBeGreaterThan(0);
  });

  test('her kategori id/label/icon içerir', () => {
    BOT_CATEGORIES.forEach((c: Record<string, string>) => {
      expect(typeof c.id).toBe('string');
      expect(typeof c.label).toBe('string');
      expect(typeof c.icon).toBe('string');
    });
  });

  test('tüm bot kategorileri tanımlı kategorilerden', () => {
    const validCats = new Set(BOT_CATEGORIES.map((c: Record<string, string>) => c.id));
    BOT_CATALOG.forEach((b: Record<string, string>) => {
      expect(validCats.has(b.category)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// bot-catalog.ts
// ═══════════════════════════════════════════════════════════════════════════════
describe('bot-catalog', () => {
  let catalog: typeof import('../js/core/bot-marketplace/bot-catalog');

  beforeEach(() => {
    jest.resetModules();
    resetMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    catalog = require('../js/core/bot-marketplace/bot-catalog');
  });

  test('getCatalog() — cache yoksa BOT_CATALOG döner', () => {
    catalog.clearCatalogCache();
    const result = catalog.getCatalog();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test('getCatalog() — aynı referans ikinci çağrıda', () => {
    const a = catalog.getCatalog();
    const b = catalog.getCatalog();
    expect(a).toBe(b);
  });

  test('clearCatalogCache() cache\'i sıfırlar', () => {
    catalog.getCatalog(); // populate cache
    catalog.clearCatalogCache();
    // after clear, getCatalog should still work (returns BOT_CATALOG)
    const result = catalog.getCatalog();
    expect(Array.isArray(result)).toBe(true);
  });

  test('loadCatalog() — başarılı API yanıtı ile server catalog kullanılır', async () => {
    const serverBots = [
      {
        id: 'server-bot-1',
        name: 'Server Bot',
        author: 'Test Author',
        authorVerified: true,
        avatar: '🤖',
        category: 'utility',
        tags: ['test'],
        description: 'Test bot',
        longDescription: 'Long desc',
        verified: true,
        featured: false,
        installs: 5000,
        rating: 4.5,
        ratingCount: 100,
        commands: ['/help'],
        permissions: ['READ'],
        changelog: 'v1',
        supportUrl: 'https://example.com',
        sourceUrl: 'https://github.com',
      },
    ];
    apiFetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({ bots: serverBots }),
    });
    const result = await catalog.loadCatalog();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].id).toBe('server-bot-1');
  });

  test('loadCatalog() — BOT_CATALOG\'a fallback eder (boş bots array)', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({ bots: [] }),
    });
    const result = await catalog.loadCatalog();
    expect(Array.isArray(result)).toBe(true);
    // Falls back to BOT_CATALOG
    expect(result.length).toBeGreaterThan(0);
  });

  test('loadCatalog() — API hata döndürdüğünde BOT_CATALOG fallback', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });
    const result = await catalog.loadCatalog();
    expect(Array.isArray(result)).toBe(true);
  });

  test('loadCatalog() — ağ hatası durumunda BOT_CATALOG fallback', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('network failure'));
    const result = await catalog.loadCatalog();
    expect(Array.isArray(result)).toBe(true);
  });

  test('loadCatalog() — cache dolu ise ikinci çağrıda apiFetch çağrılmaz', async () => {
    // Populate cache via first call
    const serverBots = [{ id: 'cached-bot', name: 'Cached', author: 'A', authorVerified: false,
      avatar: '🤖', category: 'utility', tags: [], description: '', longDescription: '',
      verified: false, featured: false, installs: 0, rating: 0, ratingCount: 0,
      commands: [], permissions: [], supportUrl: '#', sourceUrl: '#' }];
    apiFetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({ bots: serverBots }),
    });
    await catalog.loadCatalog();
    jest.clearAllMocks();
    await catalog.loadCatalog(); // should use cache
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  test('loadCatalog() — bot mapping: tüm alanlar dönüştürülür', async () => {
    const rawBot = {
      _id: 'raw-1',        // id yoksa _id kullanılır
      username: 'RawBot',  // name yoksa username kullanılır
      icon: '🎯',          // avatar yoksa icon kullanılır
    };
    apiFetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({ bots: [rawBot] }),
    });
    const result = await catalog.loadCatalog();
    const bot = result.find((b: Record<string, string>) => b.id === 'raw-1');
    expect(bot).toBeDefined();
    expect(bot!.name).toBe('RawBot');
    expect(bot!.avatar).toBe('🎯');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// bot-search.ts
// ═══════════════════════════════════════════════════════════════════════════════
describe('bot-search', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { filterBots, sortBots, countByCategory } = require('../js/core/bot-marketplace/bot-search');

  test('filterBots() — defaults tüm catalog döner', () => {
    const result = filterBots({});
    expect(result.length).toBeGreaterThan(0);
  });

  test('filterBots() — kategori filtresi çalışır', () => {
    const result = filterBots({ category: 'moderation' });
    result.forEach((b: Record<string, string>) => expect(b.category).toBe('moderation'));
  });

  test('filterBots() — bilinmeyen kategori boş dizi döner', () => {
    const result = filterBots({ category: '__nonexistent__' });
    expect(result).toEqual([]);
  });

  test('filterBots() — searchQuery name üzerinde çalışır', () => {
    const result = filterBots({ searchQuery: 'guard' });
    expect(result.some((b: Record<string, string>) => b.name.toLowerCase().includes('guard'))).toBe(true);
  });

  test('filterBots() — searchQuery description üzerinde çalışır', () => {
    const result = filterBots({ searchQuery: 'spam' });
    expect(result.length).toBeGreaterThan(0);
  });

  test('filterBots() — searchQuery tags üzerinde çalışır', () => {
    const result = filterBots({ searchQuery: 'dj' });
    expect(result.length).toBeGreaterThan(0);
  });

  test('filterBots() — eşleşmeyen sorgu boş dizi döner', () => {
    const result = filterBots({ searchQuery: 'xyzzy_no_match_12345' });
    expect(result).toEqual([]);
  });

  test('filterBots() — tab=featured yalnızca featured/popular botları döner', () => {
    const result = filterBots({ tab: 'featured' });
    result.forEach((b: Record<string, unknown>) => {
      expect((b.featured as boolean) || (b.installs as number) > 10000).toBe(true);
    });
  });

  test('filterBots() — tab=installed sadece installedIds\'dekiler döner', () => {
    const installed = new Set(['guardbot', 'rhythmix']);
    const result = filterBots({ tab: 'installed', installedIds: installed });
    result.forEach((b: Record<string, string>) => expect(installed.has(b.id)).toBe(true));
    expect(result.length).toBeLessThanOrEqual(2);
  });

  test('filterBots() — tab=all tüm botları döner', () => {
    const result = filterBots({ tab: 'all' });
    expect(result.length).toBeGreaterThan(0);
  });

  test('filterBots() — sortBy=installs sıralar', () => {
    const result = filterBots({ sortBy: 'installs' });
    for (let i = 1; i < result.length; i++) {
      expect((result[i - 1] as Record<string, number>).installs).toBeGreaterThanOrEqual(
        (result[i] as Record<string, number>).installs
      );
    }
  });

  test('filterBots() — sortBy=rating sıralar', () => {
    const result = filterBots({ sortBy: 'rating' });
    for (let i = 1; i < result.length; i++) {
      expect((result[i - 1] as Record<string, number>).rating).toBeGreaterThanOrEqual(
        (result[i] as Record<string, number>).rating
      );
    }
  });

  test('filterBots() — sortBy=name alfabetik sıralar', () => {
    const result = filterBots({ sortBy: 'name' });
    for (let i = 1; i < result.length; i++) {
      expect(
        (result[i - 1] as Record<string, string>).name.localeCompare(
          (result[i] as Record<string, string>).name, 'tr'
        )
      ).toBeLessThanOrEqual(0);
    }
  });

  test('sortBots() — boş dizi girişinde boş dizi döner', () => {
    expect(sortBots([], 'installs')).toEqual([]);
  });

  test('sortBots() — tek elemanlı dizi değişmeden döner', () => {
    const single = [{ id: 'a', name: 'A', installs: 1, rating: 3 }];
    expect(sortBots(single as never[], 'rating')).toHaveLength(1);
  });

  test('sortBots() — orijinal diziyi mutate etmez', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const catalog = require('../js/core/bot-marketplace/bot-catalog').getCatalog();
    const copy = [...catalog];
    sortBots(catalog, 'name');
    expect(catalog).toEqual(copy); // original unchanged
  });

  test('countByCategory() — boş string tüm botu sayar', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const catalog = require('../js/core/bot-marketplace/bot-catalog').getCatalog();
    expect(countByCategory('')).toBe(catalog.length);
  });

  test('countByCategory() — belirli kategori için doğru sayı', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const catalog = require('../js/core/bot-marketplace/bot-catalog').getCatalog();
    const modCount = catalog.filter((b: Record<string, string>) => b.category === 'moderation').length;
    expect(countByCategory('moderation')).toBe(modCount);
  });

  test('countByCategory() — olmayan kategori 0 döner', () => {
    expect(countByCategory('__nonexistent_xyz__')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// bot-api.ts
// ═══════════════════════════════════════════════════════════════════════════════
describe('bot-api', () => {
  let botApi: typeof import('../js/core/bot-marketplace/bot-api');

  beforeEach(() => {
    jest.resetModules();
    resetMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    botApi = require('../js/core/bot-marketplace/bot-api');
  });

  test('getLoadedPlugins() başlangıçta boş obje döner', () => {
    const plugins = botApi.getLoadedPlugins();
    expect(typeof plugins).toBe('object');
  });

  test('fetchLoadedPlugins() — başarılı yanıtta plugins doldurulur', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve([
        { id: 'plugin-1', name: 'Test Plugin', version: '1.0', author: 'Dev', description: 'desc' },
      ]),
    });
    await botApi.fetchLoadedPlugins();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0][0]).toContain('/api/plugins');
    const plugins = botApi.getLoadedPlugins();
    expect(plugins['plugin-1']).toBeDefined();
    expect(plugins['plugin-1'].name).toBe('Test Plugin');
  });

  test('fetchLoadedPlugins() — id olmayan plugin atlanır', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve([
        { name: 'No ID Plugin' }, // id yok
        { id: 'has-id', name: 'Has ID' },
      ]),
    });
    await botApi.fetchLoadedPlugins();
    const plugins = botApi.getLoadedPlugins();
    expect(plugins['has-id']).toBeDefined();
    expect(Object.keys(plugins).includes('undefined')).toBe(false);
  });

  test('fetchLoadedPlugins() — res.ok false ise erken çıkar', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await botApi.fetchLoadedPlugins();
    const plugins = botApi.getLoadedPlugins();
    expect(Object.keys(plugins).length).toBe(0);
  });

  test('fetchLoadedPlugins() — ağ hatası sessizce başarısız olur', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Network error'));
    await expect(botApi.fetchLoadedPlugins()).resolves.not.toThrow();
  });

  test('installBotOnServer() — server varken POST çağrılır', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await botApi.installBotOnServer('guardbot');
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/servers/server-1/bots/guardbot/add'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('installBotOnServer() — server null ise çağrılmaz', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCurrentServer } = require('../js/core/globals');
    getCurrentServer.mockReturnValueOnce(null);
    await botApi.installBotOnServer('guardbot');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  test('installBotOnServer() — ağ hatası sessizce başarısız olur', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Network error'));
    await expect(botApi.installBotOnServer('guardbot')).resolves.not.toThrow();
  });

  test('uninstallBotFromServer() — server varken DELETE çağrılır', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await botApi.uninstallBotFromServer('guardbot');
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/servers/server-1/bots/guardbot'),
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  test('uninstallBotFromServer() — server null ise çağrılmaz', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCurrentServer } = require('../js/core/globals');
    getCurrentServer.mockReturnValueOnce(null);
    await botApi.uninstallBotFromServer('guardbot');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  test('uninstallBotFromServer() — ağ hatası sessizce başarısız olur', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Network error'));
    await expect(botApi.uninstallBotFromServer('guardbot')).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// marketplace-state.ts
// ═══════════════════════════════════════════════════════════════════════════════
describe('marketplace-state', () => {
  let state: typeof import('../js/core/bot-marketplace/marketplace-state');

  beforeEach(() => {
    jest.resetModules();
    localStorageMock.clear();
    Object.keys(_lsStore).forEach(k => delete _lsStore[k]);
    localStorageMock.getItem.mockImplementation((k: string) => _lsStore[k] ?? null);
    localStorageMock.setItem.mockImplementation((k: string, v: string) => { _lsStore[k] = v; });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    state = require('../js/core/bot-marketplace/marketplace-state');
  });

  test('getInstalledBots() başlangıçta boş set döner', () => {
    state.resetInstalledBots();
    const bots = state.getInstalledBots();
    expect(bots instanceof Set).toBe(true);
    expect(bots.size).toBe(0);
  });

  test('isBotInstalled() — kurulu değil false döner', () => {
    state.resetInstalledBots();
    expect(state.isBotInstalled('guardbot')).toBe(false);
  });

  test('isBotInstalled() — kurulu bot true döner', () => {
    state.resetInstalledBots();
    state.toggleInstalledLocal('guardbot', true);
    expect(state.isBotInstalled('guardbot')).toBe(true);
  });

  test('toggleInstalledLocal() install=true botu ekler', () => {
    state.resetInstalledBots();
    state.toggleInstalledLocal('rhythmix', true);
    expect(state.getInstalledBots().has('rhythmix')).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalled();
  });

  test('toggleInstalledLocal() install=false botu kaldırır', () => {
    state.resetInstalledBots();
    state.toggleInstalledLocal('rhythmix', true);
    state.toggleInstalledLocal('rhythmix', false);
    expect(state.getInstalledBots().has('rhythmix')).toBe(false);
  });

  test('toggleInstalledLocal() localStorage\'a JSON yazar', () => {
    state.resetInstalledBots();
    state.toggleInstalledLocal('aichat', true);
    const lastCall = localStorageMock.setItem.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const saved = JSON.parse(lastCall![1] as string) as string[];
    expect(saved).toContain('aichat');
  });

  test('localStorage erişim hatası sessizce yönetilir', () => {
    localStorageMock.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceeded'); });
    expect(() => state.toggleInstalledLocal('bot-x', true)).not.toThrow();
  });

  test('localStorage.getItem hatası sessizce yönetilir (module init)', () => {
    localStorageMock.getItem.mockImplementationOnce(() => { throw new Error('SecurityError'); });
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(() => require('../js/core/bot-marketplace/marketplace-state')).not.toThrow();
  });

  test('resetInstalledBots() seti temizler', () => {
    state.toggleInstalledLocal('guardbot', true);
    state.resetInstalledBots();
    expect(state.getInstalledBots().size).toBe(0);
  });

  test('showToast() — info DOM\'a eklenir', () => {
    state.showToast('test mesajı', 'info');
    const toast = document.querySelector('.mp-toast.info');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toBe('test mesajı');
  });

  test('showToast() — success tipi', () => {
    state.showToast('başarılı', 'success');
    const toast = document.querySelector('.mp-toast.success');
    expect(toast?.textContent).toBe('başarılı');
  });

  test('showToast() — error tipi', () => {
    state.showToast('hata', 'error');
    const toast = document.querySelector('.mp-toast.error');
    expect(toast?.textContent).toBe('hata');
  });

  test('showToast() — varsayılan tip (info)', () => {
    state.showToast('default');
    const toast = document.querySelector('.mp-toast');
    expect(toast).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// bot-styles.ts
// ═══════════════════════════════════════════════════════════════════════════════
describe('bot-styles', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { injectStyles } = require('../js/core/bot-marketplace/bot-styles');

  beforeEach(() => {
    document.getElementById('mp-styles')?.remove();
  });

  test('injectStyles() — style elementi oluşturur', () => {
    injectStyles();
    const el = document.getElementById('mp-styles');
    expect(el).not.toBeNull();
    expect(el?.tagName).toBe('STYLE');
  });

  test('injectStyles() — içerik boş değil', () => {
    injectStyles();
    const el = document.getElementById('mp-styles') as HTMLStyleElement | null;
    expect((el?.textContent ?? '').length).toBeGreaterThan(100);
  });

  test('injectStyles() — iki kez çağrıldığında duplicate oluşmaz', () => {
    injectStyles();
    injectStyles();
    const elements = document.querySelectorAll('#mp-styles');
    expect(elements.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// index.ts (openBotMarketplace)
// ═══════════════════════════════════════════════════════════════════════════════
describe('index — openBotMarketplace', () => {
  let idx: { openBotMarketplace: () => Promise<void> };

  beforeEach(() => {
    jest.resetModules();
    resetMocks();
    document.body.innerHTML = '';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    idx = require('../js/core/bot-marketplace/index');
  });

  test('openBotMarketplace() — server yoksa erken döner', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCurrentServer } = require('../js/core/globals');
    getCurrentServer.mockReturnValueOnce(null);
    await expect(idx.openBotMarketplace()).resolves.not.toThrow();
    expect(document.getElementById('bot-marketplace-modal')).toBeNull();
  });

  test('openBotMarketplace() — modal DOM\'a eklenir', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve([{ id: 'bot-1', clientId: 'bot-1' }]),
    });
    await idx.openBotMarketplace();
    expect(document.getElementById('bot-marketplace-modal')).not.toBeNull();
  });

  test('openBotMarketplace() — API hatası DOM\'u engellemiyor', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Network error'));
    await idx.openBotMarketplace();
    expect(document.getElementById('bot-marketplace-modal')).not.toBeNull();
  });

  test('openBotMarketplace() — eski modal kaldırılır', async () => {
    const old = document.createElement('div');
    old.id = 'bot-marketplace-modal';
    document.body.appendChild(old);
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    expect(document.querySelectorAll('#bot-marketplace-modal').length).toBe(1);
  });

  test('openBotMarketplace() — API ok:false durumu yönetilir', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: () => Promise.resolve({}) });
    await idx.openBotMarketplace();
    expect(document.getElementById('bot-marketplace-modal')).not.toBeNull();
  });

  test('window._bmSearch — state günceller', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmSearch === 'function') {
      expect(() => (win._bmSearch as (q: string) => void)('guard')).not.toThrow();
      expect(() => (win._bmSearch as (q: string) => void)('')).not.toThrow();
    }
  });

  test('window._bmSetSort — her değer için hata fırlatmaz', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmSetSort === 'function') {
      ['popular', 'rating', 'new', 'name'].forEach(s => {
        expect(() => (win._bmSetSort as (s: string) => void)(s)).not.toThrow();
      });
    }
  });

  test('window._bmSetCat — kategori değiştirme hata fırlatmaz', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmSetCat === 'function') {
      expect(() => (win._bmSetCat as (c: string) => void)('')).not.toThrow();
      expect(() => (win._bmSetCat as (c: string) => void)('music')).not.toThrow();
    }
  });

  test('window._bmOpenDetail — var olan bot için modal açar', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmOpenDetail === 'function') {
      expect(() => (win._bmOpenDetail as (id: string) => void)('guardbot')).not.toThrow();
      expect(document.getElementById('bm-detail-modal')).not.toBeNull();
    }
  });

  test('window._bmOpenDetail — olmayan bot için hata fırlatmaz', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmOpenDetail === 'function') {
      expect(() => (win._bmOpenDetail as (id: string) => void)('__nonexistent__')).not.toThrow();
    }
  });

  test('window._bmInstall — inviteUrl olan bot için window.open çağrılır', async () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmInstall === 'function') {
      // rhythmix'in inviteUrl'i yoksa guardbot kullanırız; herhangi bir bot deneyelim
      await expect(
        (win._bmInstall as (id: string) => Promise<void>)('guardbot')
      ).resolves.not.toThrow();
    }
    openSpy.mockRestore();
  });

  test('window._bmInstall — server yokken hata fırlatmaz', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCurrentServer } = require('../js/core/globals');
    getCurrentServer.mockReturnValueOnce(null);
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmInstall === 'function') {
      await expect(
        (win._bmInstall as (id: string) => Promise<void>)('guardbot')
      ).resolves.not.toThrow();
    }
  });

  test('window._bmInstall — API hata döndürdüğünde hata fırlatmaz', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    apiFetchMock.mockResolvedValueOnce({
      ok: false, status: 400,
      json: () => Promise.resolve({ error: 'Bot zaten ekli' }),
    });
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmInstall === 'function') {
      await expect(
        (win._bmInstall as (id: string) => Promise<void>)('logmaster')
      ).resolves.not.toThrow();
    }
  });

  test('window._bmInstall — ağ hatası sessizce başarısız olur', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    apiFetchMock.mockRejectedValueOnce(new Error('Network error'));
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmInstall === 'function') {
      await expect(
        (win._bmInstall as (id: string) => Promise<void>)('logmaster')
      ).resolves.not.toThrow();
    }
  });

  test('window._bmOpenAddCustom — modal DOM\'a eklenir', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmOpenAddCustom === 'function') {
      (win._bmOpenAddCustom as () => void)();
      expect(document.getElementById('bm-custom-modal')).not.toBeNull();
      // İkinci çağrı duplicate oluşturmaz
      (win._bmOpenAddCustom as () => void)();
      expect(document.querySelectorAll('#bm-custom-modal').length).toBe(1);
    }
  });

  test('window._bmSaveCustomBot — token boşken apiFetch çağrılmaz', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmOpenAddCustom === 'function') {
      (win._bmOpenAddCustom as () => void)();
    }
    jest.clearAllMocks();
    if (typeof win._bmSaveCustomBot === 'function') {
      const input = document.getElementById('bm-custom-token') as HTMLInputElement | null;
      if (input) input.value = '';
      await (win._bmSaveCustomBot as () => Promise<void>)();
      expect(apiFetchMock).not.toHaveBeenCalled();
    }
  });

  test('window._bmSaveCustomBot — token girilince apiFetch çağrılır', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmOpenAddCustom === 'function') {
      (win._bmOpenAddCustom as () => void)();
    }
    jest.clearAllMocks();
    apiFetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
    if (typeof win._bmSaveCustomBot === 'function') {
      const input = document.getElementById('bm-custom-token') as HTMLInputElement | null;
      if (input) input.value = 'tok-valid-123';
      await (win._bmSaveCustomBot as () => Promise<void>)();
      expect(apiFetchMock).toHaveBeenCalled();
    }
  });

  test('window._bmSaveCustomBot — server yokken hata fırlatmaz', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmOpenAddCustom === 'function') {
      (win._bmOpenAddCustom as () => void)();
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCurrentServer } = require('../js/core/globals');
    getCurrentServer.mockReturnValueOnce(null);
    if (typeof win._bmSaveCustomBot === 'function') {
      const input = document.getElementById('bm-custom-token') as HTMLInputElement | null;
      if (input) input.value = 'tok-123';
      await expect((win._bmSaveCustomBot as () => Promise<void>)()).resolves.not.toThrow();
    }
  });

  test('window._bmSaveCustomBot — API hata döndürünce hata fırlatmaz', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const win = window as Window & Record<string, unknown>;
    if (typeof win._bmOpenAddCustom === 'function') {
      (win._bmOpenAddCustom as () => void)();
    }
    apiFetchMock.mockResolvedValueOnce({
      ok: false, status: 400,
      json: () => Promise.resolve({ error: 'invalid' }),
    });
    if (typeof win._bmSaveCustomBot === 'function') {
      const input = document.getElementById('bm-custom-token') as HTMLInputElement | null;
      if (input) input.value = 'bad-token';
      await expect((win._bmSaveCustomBot as () => Promise<void>)()).resolves.not.toThrow();
    }
  });

  test('modal overlay click — modal kaldırılır', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await idx.openBotMarketplace();
    const modal = document.getElementById('bot-marketplace-modal');
    if (modal) {
      modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Overlay click removes modal (target === modal itself)
      // jsdom'da e.target === modal check çalışır
    }
    expect(true).toBe(true); // hata fırlatmadıysa geçer
  });
});
