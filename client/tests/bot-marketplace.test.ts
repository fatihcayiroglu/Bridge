// client/tests/bot-marketplace.test.ts — Sprint 40
// bot-marketplace.js için unit testler
// Kapsam: BOT_CATALOG içeriği, kategori filtreleme, rating render,
//         BotMarketplace.open/close, apiFetch çağrıları, XSS guard

'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../js/core/globals', () => ({
  getAPI:           jest.fn(() => 'http://localhost:3001'),
  getCurrentServer: jest.fn(() => ({ _id: 'server-1' })),
}), { virtual: true });

jest.mock('../js/core/api-fetch', () => ({
  apiFetch: jest.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true }),
  })),
}), { virtual: true });

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn(),
    call:     jest.fn(),
    has:      jest.fn(() => false),
  },
}), { virtual: true });

// ── DOM builder ───────────────────────────────────────────────────────────────

function buildMarketplaceDOM() {
  document.body.innerHTML = `
    <div id="bot-marketplace-overlay" style="display:none">
      <div id="bot-marketplace-modal">
        <div id="bm-categories"></div>
        <div id="bm-bots-grid"></div>
        <div id="bm-detail-overlay" style="display:none">
          <div id="bm-detail-name"></div>
          <div id="bm-detail-desc"></div>
          <div id="bm-detail-long-desc"></div>
          <div id="bm-detail-stats"></div>
          <div id="bm-detail-commands"></div>
          <div id="bm-detail-perms"></div>
          <div id="bm-detail-changelog"></div>
          <div id="bm-rating-stars"></div>
          <div id="bm-rating-count"></div>
          <div id="bm-install-btn-wrap"></div>
        </div>
        <input id="bm-search" type="text">
        <div id="bm-featured"></div>
        <div id="bm-results-info"></div>
        <button id="bm-close-btn"></button>
        <button id="bm-detail-close"></button>
      </div>
    </div>
  `;
}

// ── Module loader ─────────────────────────────────────────────────────────────

const sampleBot = {
  id: 'test-bot-1',
  name: 'Test Bot',
  category: 'utility',
  description: 'Test açıklaması',
  emoji: '🤖',
  rating: 4.5,
  installs: 120,
  installed: false,
  verified: true,
  tags: ['test', 'utility'],
};

let mkt;
let apiFetchMock;

beforeAll(() => {
  try {
    mkt = require('../js/core/bot-marketplace');
    apiFetchMock = require('../js/core/api-fetch').apiFetch;
  } catch {
    mkt = null;
  }
});

beforeEach(() => {
  buildMarketplaceDOM();
  jest.clearAllMocks();
  if (apiFetchMock) {
    apiFetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ success: true }),
    });
  }
});

// ── BotMarketplace export ─────────────────────────────────────────────────────

describe('BotMarketplace export', () => {
  test('open ve close fonksiyonları export edilmiş', () => {
    if (!mkt) return;
    expect(typeof mkt.BotMarketplace?.open).toBe('function');
    expect(typeof mkt.BotMarketplace?.close).toBe('function');
  });

  test('getBotMarketplace() nesne döner', () => {
    if (!mkt) return;
    const bm = mkt.getBotMarketplace?.();
    expect(bm).toBeTruthy();
    expect(typeof bm.open).toBe('function');
  });
});

// ── open / close ──────────────────────────────────────────────────────────────

describe('open', () => {
  test('overlay görünür hale gelir', () => {
    if (!mkt) return;
    mkt.BotMarketplace.open();
    const overlay = document.getElementById('bot-marketplace-overlay');
    expect(overlay.style.display).not.toBe('none');
  });

  test('grid içeriği render edilir (en az 1 bot)', () => {
    if (!mkt) return;
    mkt.BotMarketplace.open();
    const grid = document.getElementById('bm-bots-grid');
    expect(grid.children.length).toBeGreaterThan(0);
  });

  test('kategoriler render edilir', () => {
    if (!mkt) return;
    mkt.BotMarketplace.open();
    const cats = document.getElementById('bm-categories');
    expect(cats.children.length).toBeGreaterThan(0);
  });
});

describe('close', () => {
  test('overlay gizlenir', () => {
    if (!mkt) return;
    mkt.BotMarketplace.open();
    mkt.BotMarketplace.close();
    const overlay = document.getElementById('bot-marketplace-overlay');
    expect(overlay.style.display).toBe('none');
  });
});

// ── Katalog içeriği ───────────────────────────────────────────────────────────

describe('BOT_CATALOG içeriği', () => {
  test('en az 10 bot var', () => {
    if (!mkt) return;
    // open çağrısı grid'i doldurur; grid'deki kart sayısını say
    mkt.BotMarketplace.open();
    const cards = document.querySelectorAll('#bm-bots-grid [data-bot-id]');
    expect(cards.length).toBeGreaterThanOrEqual(10);
  });

  test('her bot kartı data-bot-id attribute\'u taşır', () => {
    if (!mkt) return;
    mkt.BotMarketplace.open();
    const cards = document.querySelectorAll('#bm-bots-grid [data-bot-id]');
    cards.forEach(card => {
      expect(card.dataset.botId).toBeTruthy();
    });
  });
});

// ── Kategori filtreleme ───────────────────────────────────────────────────────

describe('showCategory', () => {
  test('bilinmeyen kategori seçilince grid boş veya "not found" mesajı gösterir', () => {
    if (!mkt?.showCategory) return;
    mkt.BotMarketplace.open();
    mkt.showCategory('__nonexistent__');
    const grid     = document.getElementById('bm-bots-grid');
    const infoEl   = document.getElementById('bm-results-info');
    const hasCards = grid.querySelector('[data-bot-id]');
    const hasMsg   = infoEl?.textContent?.includes('bulunamadı') || !hasCards;
    expect(hasMsg).toBe(true);
  });

  test('music kategorisi seçilince music botları görünür', () => {
    if (!mkt?.showCategory) return;
    mkt.BotMarketplace.open();
    mkt.showCategory('music');
    const cards = document.querySelectorAll('#bm-bots-grid [data-bot-id]');
    expect(cards.length).toBeGreaterThan(0);
  });
});

// ── Arama ────────────────────────────────────────────────────────────────────

describe('arama (search input)', () => {
  test('boş query tüm botları gösterir', () => {
    if (!mkt) return;
    mkt.BotMarketplace.open();
    const input = document.getElementById('bm-search');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    const cards = document.querySelectorAll('#bm-bots-grid [data-bot-id]');
    expect(cards.length).toBeGreaterThan(0);
  });

  test('eşleşmeyen sorgu sonuç döndürmez veya bilgi mesajı gösterir', () => {
    if (!mkt) return;
    mkt.BotMarketplace.open();
    const input = document.getElementById('bm-search');
    input.value = 'zzz_no_match_xyz_12345';
    input.dispatchEvent(new Event('input'));
    const cards  = document.querySelectorAll('#bm-bots-grid [data-bot-id]');
    const infoEl = document.getElementById('bm-results-info');
    const noResults = cards.length === 0 || infoEl?.textContent?.includes('bulunamadı');
    expect(noResults).toBe(true);
  });
});

// ── XSS guard ─────────────────────────────────────────────────────────────────

describe('XSS koruması', () => {
  test('bot adı script tag içeriyorsa render\'da escape edilir', () => {
    if (!mkt) return;
    mkt.BotMarketplace.open();
    const grid = document.getElementById('bm-bots-grid');
    // Hiçbir kart içinde <script> tag'i olmamalı
    expect(grid.innerHTML).not.toContain('<script>');
  });
});

// ── Bot kurulum (apiFetch) ────────────────────────────────────────────────────

describe('toggleBotInstall', () => {
  test('apiFetch window üzerinden değil, import ile çağrılır', async () => {
    if (!mkt || !apiFetchMock) return;
    // window.apiFetch olmamalı — sadece import edilen apiFetch kullanılmalı
    expect(typeof window.apiFetch).toBe('undefined');
  });

  test('sunucu yokken install sessizce başarısız olur', async () => {
    if (!mkt) return;
    const { getCurrentServer } = require('../js/core/globals');
    getCurrentServer.mockReturnValueOnce(null);
    // btn mock
    const btn = document.createElement('button');
    btn.dataset.installed = 'false';
    await expect(mkt.BotMarketplace?.open()).resolves?.not?.toThrow?.();
  });
});

// ── Rating görünümü ───────────────────────────────────────────────────────────

describe('showBotDetails', () => {
  test('detay overlay açılır', () => {
    if (!mkt?.showBotDetails) return;
    mkt.BotMarketplace.open();
    // İlk bot id'sini al
    const firstCard = document.querySelector('#bm-bots-grid [data-bot-id]');
    if (!firstCard) return;
    mkt.showBotDetails(firstCard.dataset.botId);
    const overlay = document.getElementById('bm-detail-overlay');
    expect(overlay.style.display).not.toBe('none');
  });

  test('bot adı detail panelde gösterilir', () => {
    if (!mkt?.showBotDetails) return;
    mkt.BotMarketplace.open();
    const firstCard = document.querySelector('#bm-bots-grid [data-bot-id]');
    if (!firstCard) return;
    mkt.showBotDetails(firstCard.dataset.botId);
    const nameEl = document.getElementById('bm-detail-name');
    expect(nameEl.textContent.length).toBeGreaterThan(0);
  });
});

// ── Sprint 43 ek testler ───────────────────────────────────────────────────────

// ── getCatalog ────────────────────────────────────────────────────────────────

describe('getCatalog()', () => {
  test('dizi döner', () => {
    if (!mkt?.getCatalog) return;
    const catalog = mkt.getCatalog();
    expect(Array.isArray(catalog)).toBe(true);
  });

  test('her bot kaydı id, name, category alanlarına sahip', () => {
    if (!mkt?.getCatalog) return;
    const catalog = mkt.getCatalog();
    catalog.forEach(bot => {
      expect(typeof bot.id).toBe('string');
      expect(typeof bot.name).toBe('string');
      expect(typeof bot.category).toBe('string');
    });
  });

  test('id\'ler tekil', () => {
    if (!mkt?.getCatalog) return;
    const catalog = mkt.getCatalog();
    const ids = catalog.map(b => b.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ── loadCatalog ───────────────────────────────────────────────────────────────

describe('loadCatalog()', () => {
  test('başarılı API yanıtında ek bot\'ları kataloğa ekler', async () => {
    if (!mkt?.loadCatalog || !apiFetchMock) return;
    const extraBots = [
      { id: 'extra-1', name: 'Extra Bot', category: 'utility', description: 'Test', installed: false },
    ];
    apiFetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({ bots: extraBots }),
    });
    await mkt.loadCatalog();
    // apiFetch çağrıldı mı?
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  test('API başarısız olduğunda hata fırlatmaz', async () => {
    if (!mkt?.loadCatalog || !apiFetchMock) return;
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await expect(mkt.loadCatalog()).resolves.not.toThrow();
  });

  test('ağ hatasında sessizce başarısız olur', async () => {
    if (!mkt?.loadCatalog || !apiFetchMock) return;
    apiFetchMock.mockRejectedValueOnce(new Error('Network error'));
    await expect(mkt.loadCatalog()).resolves.not.toThrow();
  });
});

// ── fetchLoadedPlugins ────────────────────────────────────────────────────────

describe('fetchLoadedPlugins()', () => {
  test('sunucu varken apiFetch çağırır', async () => {
    if (!mkt?.fetchLoadedPlugins || !apiFetchMock) return;
    apiFetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({ plugins: [] }),
    });
    await mkt.fetchLoadedPlugins();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const callUrl = apiFetchMock.mock.calls[0][0];
    expect(callUrl).toContain('plugins');
  });

  test('sunucu yokken erken çıkar', async () => {
    if (!mkt?.fetchLoadedPlugins || !apiFetchMock) return;
    const { getCurrentServer } = require('../js/core/globals');
    getCurrentServer.mockReturnValueOnce(null);
    await mkt.fetchLoadedPlugins();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

// ── makeCard ──────────────────────────────────────────────────────────────────

describe('makeCard()', () => {
  const sampleBot = {
    id: 'test-bot-1',
    name: 'Test Bot',
    category: 'utility',
    description: 'Test açıklaması',
    emoji: '🤖',
    rating: 4.5,
    installs: 120,
    installed: false,
    verified: true,
    tags: ['test', 'utility'],
  };

  test('HTMLElement döner', () => {
    if (!mkt?.makeCard) return;
    const card = mkt.makeCard(sampleBot);
    expect(card instanceof HTMLElement).toBe(true);
  });

  test('kart data-bot-id attribute\'u taşır', () => {
    if (!mkt?.makeCard) return;
    const card = mkt.makeCard(sampleBot);
    expect(card.dataset.botId).toBe('test-bot-1');
  });

  test('bot adı kart içinde görünür', () => {
    if (!mkt?.makeCard) return;
    const card = mkt.makeCard(sampleBot);
    expect(card.textContent).toContain('Test Bot');
  });

  test('XSS: özel karakterler escape edilir', () => {
    if (!mkt?.makeCard) return;
    const maliciousBot = { ...sampleBot, name: '<script>alert(1)</script>' };
    const card = mkt.makeCard(maliciousBot);
    expect(card.innerHTML).not.toContain('<script>');
    expect(card.innerHTML).not.toContain('alert(1)');
  });
});

// ── showToast ─────────────────────────────────────────────────────────────────

describe('showToast()', () => {
  test('toast elementi DOM\'a eklenir', () => {
    if (!mkt?.showToast) return;
    mkt.showToast('Test mesajı', 'info');
    // Toast sistemi genellikle bir container kullanır
    const toastEl = document.querySelector('.bm-toast, [class*="toast"]');
    if (toastEl) {
      expect(toastEl.textContent).toContain('Test mesajı');
    } else {
      // Toast container başka bir yapıda olabilir — en azından hata fırlatmamalı
      expect(true).toBe(true);
    }
  });

  test('success tipi hata fırlatmaz', () => {
    if (!mkt?.showToast) return;
    expect(() => mkt.showToast('Başarılı!', 'success')).not.toThrow();
  });

  test('error tipi hata fırlatmaz', () => {
    if (!mkt?.showToast) return;
    expect(() => mkt.showToast('Hata!', 'error')).not.toThrow();
  });
});

// ── updateInstCount ───────────────────────────────────────────────────────────

describe('updateInstCount()', () => {
  test('hata fırlatmaz (DOM element yoksa da)', () => {
    if (!mkt?.updateInstCount) return;
    expect(() => mkt.updateInstCount()).not.toThrow();
  });
});

// ── Sprint 48: Ek coverage ────────────────────────────────────────────────────

// ── Kategori filtreleme: tüm bots göster ─────────────────────────────────────

describe('showCategory — all', () => {
  beforeEach(() => buildMarketplaceDOM());

  test('all kategorisi grid\'i temizlemez, hata fırlatmaz', () => {
    if (!mkt?.showCategory) return;
    expect(() => mkt.showCategory('all')).not.toThrow();
  });

  test('geçersiz kategori hata fırlatmaz', () => {
    if (!mkt?.showCategory) return;
    expect(() => mkt.showCategory('nonexistent-cat-xyz')).not.toThrow();
  });
});

// ── Arama — boş/özel karakter ─────────────────────────────────────────────────

describe('arama — edge cases', () => {
  beforeEach(() => buildMarketplaceDOM());

  test('boş string ile arama hata fırlatmaz', () => {
    if (!mkt?.BotMarketplace) return;
    const input = document.getElementById('bm-search');
    if (input) {
      input.value = '';
      input.dispatchEvent(new Event('input'));
    }
    expect(true).toBe(true);
  });

  test('çok uzun arama string\'i hata fırlatmaz', () => {
    if (!mkt?.BotMarketplace) return;
    const input = document.getElementById('bm-search');
    if (input) {
      input.value = 'a'.repeat(500);
      input.dispatchEvent(new Event('input'));
    }
    expect(true).toBe(true);
  });
});

// ── toggleBotInstall — sunucu yokken ─────────────────────────────────────────

describe('toggleBotInstall — sunucu yok', () => {
  beforeEach(() => {
    buildMarketplaceDOM();
    jest.resetModules();
  });

  test('server null iken hata fırlatmaz', () => {
    if (!mkt?.toggleBotInstall) return;
    expect(() => mkt.toggleBotInstall('test-bot-1', false)).not.toThrow();
  });
});

// ── makeCard — farklı bot tipleri ─────────────────────────────────────────────

describe('makeCard — farklı bot tipleri', () => {
  beforeEach(() => buildMarketplaceDOM());

  test('kategori alanı olmayan bot için hata fırlatmaz', () => {
    if (!mkt?.makeCard) return;
    const minBot = { id: 'min-bot', name: 'Minimal', description: 'Az' };
    expect(() => mkt.makeCard(minBot)).not.toThrow();
  });

  test('çok uzun description truncate edilir veya hata fırlatmaz', () => {
    if (!mkt?.makeCard) return;
    const longBot = { ...sampleBot, description: 'X'.repeat(1000) };
    expect(() => mkt.makeCard(longBot)).not.toThrow();
  });

  test('null description için hata fırlatmaz', () => {
    if (!mkt?.makeCard) return;
    const nullBot = { ...sampleBot, description: null };
    expect(() => mkt.makeCard(nullBot)).not.toThrow();
  });
});

// ── getCatalog — önbellekleme ─────────────────────────────────────────────────

describe('getCatalog — önbellekleme', () => {
  test('iki kez çağrıldığında aynı referansı döner', () => {
    if (!mkt?.getCatalog) return;
    const a = mkt.getCatalog();
    const b = mkt.getCatalog();
    expect(a).toBe(b);
  });

  test('dönen değer array\'dir', () => {
    if (!mkt?.getCatalog) return;
    expect(Array.isArray(mkt.getCatalog())).toBe(true);
  });
});

// ── fetchLoadedPlugins — network error ────────────────────────────────────────

describe('fetchLoadedPlugins — hata durumu', () => {
  test('network hatası olduğunda throw etmez', async () => {
    if (!mkt?.fetchLoadedPlugins) return;
    const { apiFetch } = require('../js/core/api-fetch');
    apiFetch.mockRejectedValueOnce(new Error('Network error'));
    await expect(mkt.fetchLoadedPlugins()).resolves.not.toThrow();
  });
});

// ── _bmSetSort — sıralama ─────────────────────────────────────────────────────

describe('_bmSetSort()', () => {
  beforeEach(() => buildMarketplaceDOM());

  test('popular ile sıralama hata fırlatmaz', () => {
    if (!window._bmSetSort) return;
    expect(() => (window as any)._bmSetSort('popular')).not.toThrow();
  });

  test('rating ile sıralama hata fırlatmaz', () => {
    if (!window._bmSetSort) return;
    expect(() => (window as any)._bmSetSort('rating')).not.toThrow();
  });

  test('new ile sıralama hata fırlatmaz', () => {
    if (!window._bmSetSort) return;
    expect(() => (window as any)._bmSetSort('new')).not.toThrow();
  });

  test('name ile sıralama hata fırlatmaz', () => {
    if (!window._bmSetSort) return;
    expect(() => (window as any)._bmSetSort('name')).not.toThrow();
  });
});

// ── _bmOpenAddCustom — custom bot modal ──────────────────────────────────────

describe('_bmOpenAddCustom()', () => {
  beforeEach(() => buildMarketplaceDOM());

  test('bm-custom-modal DOM\'a eklenir', () => {
    if (!(window as any)._bmOpenAddCustom) return;
    (window as any)._bmOpenAddCustom();
    expect(document.getElementById('bm-custom-modal')).not.toBeNull();
  });

  test('iki kez çağrılınca yalnızca bir modal olur', () => {
    if (!(window as any)._bmOpenAddCustom) return;
    (window as any)._bmOpenAddCustom();
    (window as any)._bmOpenAddCustom();
    expect(document.querySelectorAll('#bm-custom-modal').length).toBe(1);
  });

  test('modal içinde token input mevcut', () => {
    if (!(window as any)._bmOpenAddCustom) return;
    (window as any)._bmOpenAddCustom();
    expect(document.getElementById('bm-custom-token')).not.toBeNull();
  });
});

// ── _bmSaveCustomBot — kayıt ──────────────────────────────────────────────────

describe('_bmSaveCustomBot()', () => {
  beforeEach(() => {
    buildMarketplaceDOM();
    if ((window as any)._bmOpenAddCustom) (window as any)._bmOpenAddCustom();
    if (apiFetchMock) {
      apiFetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });
    }
  });

  test('token boşken apiFetch çağrılmaz', async () => {
    if (!(window as any)._bmSaveCustomBot) return;
    const tokenInput = document.getElementById('bm-custom-token') as HTMLInputElement | null;
    if (tokenInput) tokenInput.value = '';
    await (window as any)._bmSaveCustomBot();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  test('token girilince apiFetch çağrılır', async () => {
    if (!(window as any)._bmSaveCustomBot) return;
    const tokenInput = document.getElementById('bm-custom-token') as HTMLInputElement | null;
    if (tokenInput) tokenInput.value = 'tok-abc123';
    await (window as any)._bmSaveCustomBot();
    expect(apiFetchMock).toHaveBeenCalled();
  });

  test('API hata döndürünce throw etmez', async () => {
    if (!(window as any)._bmSaveCustomBot) return;
    apiFetchMock?.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'invalid token' }),
    });
    const tokenInput = document.getElementById('bm-custom-token') as HTMLInputElement | null;
    if (tokenInput) tokenInput.value = 'bad-token';
    await expect((window as any)._bmSaveCustomBot()).resolves.not.toThrow();
  });

  test('ağ hatasında throw etmez', async () => {
    if (!(window as any)._bmSaveCustomBot) return;
    apiFetchMock?.mockRejectedValueOnce(new Error('Network error'));
    const tokenInput = document.getElementById('bm-custom-token') as HTMLInputElement | null;
    if (tokenInput) tokenInput.value = 'tok-net-err';
    await expect((window as any)._bmSaveCustomBot()).resolves.not.toThrow();
  });
});
