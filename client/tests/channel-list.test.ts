// client/tests/channel-list.test.ts — Bridge v74
// core/channel-list.js için unit testler
// makeChannelEl DOM çıktısı, renderChannels gruplandırma, selectChannel akışı

'use strict';

import path from 'path';

// Svelte mount mock — renderChannels artık vanilla fallback kullanmıyor
jest.mock('../js/core/channel-list/channel-list-svelte.js', () => {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function mountOrUpdateChannelList(listEl, props) {
    listEl.innerHTML = '';
    const cats = props.categories ?? [];
    const collapsed = props.collapsedCategoryKeys ?? new Set();

    if (!cats.length) {
      const grouped = {};
      for (const ch of props.channels) {
        const cat = String(ch.category ?? 'Genel');
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(ch);
      }
      for (const [cat, chs] of Object.entries(grouped)) {
        const catEl = document.createElement('div');
        catEl.className = 'ch-category';
        catEl.textContent = cat;
        listEl.appendChild(catEl);
        if (collapsed.has(cat)) continue;
        for (const ch of chs) {
          const item = document.createElement('div');
          item.className = 'ch-item';
          item.dataset.id = String(ch._id);
          item.dataset.type = String(ch.type ?? 'text');
          item.innerHTML = `<span class="ch-icon">#</span><span class="ch-name">${esc(String(ch.name))}</span>`;
          listEl.appendChild(item);
        }
      }
      return true;
    }

    const grouped = {};
    const uncategorized = [];
    for (const ch of props.channels) {
      if (ch.categoryId) {
        const id = String(ch.categoryId);
        if (!grouped[id]) grouped[id] = [];
        grouped[id].push(ch);
      } else uncategorized.push(ch);
    }

    for (const ch of uncategorized) {
      const item = document.createElement('div');
      item.className = 'ch-item';
      item.dataset.id = String(ch._id);
      item.innerHTML = `<span class="ch-icon">#</span><span class="ch-name">${esc(String(ch.name))}</span>`;
      listEl.appendChild(item);
    }

    for (const cat of [...cats].sort((a, b) => a.position - b.position)) {
      const catEl = document.createElement('div');
      catEl.className = 'ch-category';
      catEl.textContent = cat.name;
      listEl.appendChild(catEl);

      const wrapper = document.createElement('div');
      wrapper.id = `cat-channels-${cat._id}`;
      wrapper.style.display = cat.collapsed ? 'none' : '';
      for (const ch of grouped[cat._id] ?? []) {
        const item = document.createElement('div');
        item.className = 'ch-item';
        item.dataset.id = String(ch._id);
        item.innerHTML = `<span class="ch-icon">#</span><span class="ch-name">${esc(String(ch.name))}</span>`;
        wrapper.appendChild(item);
      }
      listEl.appendChild(wrapper);
    }
    return true;
  }

  return { mountOrUpdateChannelList, unmountChannelList: jest.fn() };
});

// ─── Modül yükleyici ──────────────────────────────────────────────────────────
// channel-list.ts ESM kaynağı babel-jest ile CommonJS'e dönüştürülür.
// Named export'lar (loadChannels, renderChannels, selectChannel, makeChannelEl, …)
// global scope'a yayılır — testler global.makeChannelEl vb. üzerinden erişir.
function loadChannelListModule() {
  // Jest cache'i atlat — her test suite için temiz modül
  jest.resetModules();
  const mod = require('../js/core/channel-list');
  Object.entries(mod).forEach(([k, v]) => { global[k] = v; });
}

// ─── Channel fixture factory ──────────────────────────────────────────────────
function makeChannel(overrides = {}) {
  return {
    _id:      overrides._id      ?? 'ch-001',
    name:     overrides.name     ?? 'genel',
    type:     overrides.type     ?? 'text',
    category: overrides.category ?? 'Metin Kanalları',
    nsfw:     overrides.nsfw     ?? false,
    ...overrides,
  };
}

// ─── DOM şablonu ──────────────────────────────────────────────────────────────
function buildChannelDOM() {
  document.body.innerHTML = `
    <div id="channel-list"></div>
    <div id="messages-area"></div>
    <div id="channel-name"></div>
    <div id="channel-topic"></div>
    <div id="msg-input" contenteditable="true"></div>
    <div id="toast-container"></div>
  `;
}

// ─── Setup ────────────────────────────────────────────────────────────────────
beforeAll(() => {
  global.API             = 'http://localhost:3000';
  global.token           = 'test-token';
  global.currentServer   = { _id: 'srv-1', name: 'Test Server' };
  global.currentChannel  = null;
  global.currentUser     = null;
  global.me              = { id: 'user-1', username: 'fatih' };
  global.socket          = { emit: jest.fn(), on: jest.fn() };
  global.collapsedCategories = new Set();
  global.serverEmojiCache    = [];

  // loadCategories stub — kategorisiz test senaryosu için boş döner
  global.loadCategories = jest.fn().mockResolvedValue([]);
  // loadMessages stub
  global.loadMessages   = jest.fn().mockResolvedValue(undefined);
  // apiFetch stub (setup.js'teki, ama burada da garanti olsun)
  global.apiFetch       = jest.fn().mockResolvedValue({
    ok: true, status: 200,
    json: () => Promise.resolve([]),
  });

  buildChannelDOM();
  loadChannelListModule();
});

beforeEach(() => {
  jest.clearAllMocks();
  buildChannelDOM();
  global.collapsedCategories.clear();
  global.currentChannel = null;
  global.loadCategories.mockResolvedValue([]);
});

// ══════════════════════════════════════════════════════════════════════════════
// makeChannelEl()
// ══════════════════════════════════════════════════════════════════════════════
describe('makeChannelEl()', () => {
  test('metin kanalı için # ikonu içerir', () => {
    const el = global.makeChannelEl(makeChannel({ type: 'text', name: 'genel' }));
    expect(el.querySelector('.ch-icon').textContent).toBe('#');
  });

  test('ses kanalı için 🔊 ikonu içerir', () => {
    const el = global.makeChannelEl(makeChannel({ type: 'voice', name: 'sesli' }));
    expect(el.querySelector('.ch-icon').textContent).toBe('🔊');
  });

  test('forum kanalı için 📋 ikonu içerir', () => {
    const el = global.makeChannelEl(makeChannel({ type: 'forum', name: 'forum' }));
    expect(el.querySelector('.ch-icon').textContent).toBe('📋');
  });

  test('duyuru kanalı için 📣 ikonu içerir', () => {
    const el = global.makeChannelEl(makeChannel({ type: 'announcement', name: 'duyurular' }));
    expect(el.querySelector('.ch-icon').textContent).toBe('📣');
  });

  test('kanal adı doğru render edilir', () => {
    const el = global.makeChannelEl(makeChannel({ name: 'test-kanal' }));
    expect(el.querySelector('.ch-name').textContent).toBe('test-kanal');
  });

  test('XSS: kanal adında <script> escape edilir', () => {
    const el = global.makeChannelEl(makeChannel({ name: '<script>alert(1)</script>' }));
    expect(el.innerHTML).not.toContain('<script>');
    expect(el.innerHTML).toContain('&lt;script&gt;');
  });

  test('nsfw=true ise 18+ badge gösterilir', () => {
    const el = global.makeChannelEl(makeChannel({ nsfw: true }));
    expect(el.innerHTML).toContain('18+');
  });

  test('nsfw=false ise 18+ badge gösterilmez', () => {
    const el = global.makeChannelEl(makeChannel({ nsfw: false }));
    expect(el.innerHTML).not.toContain('18+');
  });

  test('data-id ve data-type dataset\'e atanır', () => {
    const el = global.makeChannelEl(makeChannel({ _id: 'ch-42', type: 'voice' }));
    expect(el.dataset.id).toBe('ch-42');
    expect(el.dataset.type).toBe('voice');
  });

  test('vc ve unread span\'leri başlangıçta gizlidir', () => {
    const el = global.makeChannelEl(makeChannel({ _id: 'ch-99' }));
    const vc = el.querySelector('#vc-ch-99');
    const ur = el.querySelector('#unread-ch-99');
    expect(vc.style.display).toBe('none');
    expect(ur.style.display).toBe('none');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// renderChannels() — kategorisiz (fallback)
// ══════════════════════════════════════════════════════════════════════════════
describe('renderChannels() — kategorisiz fallback', () => {
  const channels = [
    makeChannel({ _id: 'ch-1', name: 'genel',    category: 'Metin' }),
    makeChannel({ _id: 'ch-2', name: 'sesli',    category: 'Ses',   type: 'voice' }),
    makeChannel({ _id: 'ch-3', name: 'duyurular',category: 'Metin', type: 'announcement' }),
  ];

  test('kanallar DOM\'a eklenir', async () => {
    await global.renderChannels(channels);
    const items = document.querySelectorAll('.ch-item');
    expect(items.length).toBe(3);
  });

  test('kategori başlıkları oluşturulur', async () => {
    await global.renderChannels(channels);
    const cats = document.querySelectorAll('.ch-category');
    expect(cats.length).toBeGreaterThanOrEqual(1);
  });

  test('collapsed kategori içindeki kanallar gizlenir', async () => {
    global.collapsedCategories.add('Metin');
    await global.renderChannels(channels);
    // ch-1 ve ch-3 Metin kategorisinde → collapse sonrası ch-item sayısı azalır
    const items = document.querySelectorAll('.ch-item');
    expect(items.length).toBe(1); // sadece Ses/sesli görünür
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// renderChannels() — DB kategori sistemi (v15)
// ══════════════════════════════════════════════════════════════════════════════
describe('renderChannels() — DB kategori sistemi', () => {
  const dbCats = [
    { _id: 'cat-A', name: 'Metin',   position: 0, collapsed: false },
    { _id: 'cat-B', name: 'Medya',   position: 1, collapsed: false },
  ];
  const channels = [
    makeChannel({ _id: 'ch-10', name: 'genel',    categoryId: 'cat-A' }),
    makeChannel({ _id: 'ch-11', name: 'video',    categoryId: 'cat-B', type: 'voice' }),
    makeChannel({ _id: 'ch-12', name: 'uncatego', categoryId: undefined }),
  ];

  beforeEach(() => {
    global.loadCategories.mockResolvedValue(dbCats);
  });

  test('kategori sıralaması position\'a göre yapılır', async () => {
    await global.renderChannels(channels);
    const catEls = [...document.querySelectorAll('.ch-category')];
    const names  = catEls.map(el => el.textContent);
    const metin  = names.findIndex(n => n.includes('Metin'));
    const medya  = names.findIndex(n => n.includes('Medya'));
    expect(metin).toBeLessThan(medya);
  });

  test('kategorisiz kanallar listenin başında eklenir', async () => {
    await global.renderChannels(channels);
    const list    = document.getElementById('channel-list');
    const firstEl = list.firstChild;
    // Uncategorized kanal → ilk ch-item olmalı
    expect(firstEl.classList.contains('ch-item')).toBe(true);
    expect(firstEl.dataset.id).toBe('ch-12');
  });

  test('collapsed=true kategori kanallarını gizler', async () => {
    global.loadCategories.mockResolvedValue([
      { _id: 'cat-A', name: 'Gizli', position: 0, collapsed: true },
    ]);
    await global.renderChannels([makeChannel({ _id: 'ch-20', categoryId: 'cat-A' })]);
    const wrapper = document.getElementById('cat-channels-cat-A');
    expect(wrapper.style.display).toBe('none');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// loadChannels()
// ══════════════════════════════════════════════════════════════════════════════
describe('loadChannels()', () => {
  test('apiFetch doğru endpoint ile çağrılır', async () => {
    const channels = [makeChannel()];
    global.apiFetch.mockResolvedValueOnce({
      ok: true, json: () => Promise.resolve(channels),
    });

    await global.loadChannels('srv-abc');

    expect(global.apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/servers/srv-abc/channels')
    );
  });

  test('kanallar window.currentServerChannels\'a atanır', async () => {
    const channels = [makeChannel({ _id: 'ch-1', type: 'text' })];
    global.apiFetch.mockResolvedValueOnce({
      ok: true, json: () => Promise.resolve(channels),
    });

    await global.loadChannels('srv-1');
    expect(window.currentServerChannels).toEqual(channels);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// showInputModal / showConfirmModal — DOM injection
// ══════════════════════════════════════════════════════════════════════════════
describe('showInputModal()', () => {
  test('modal DOM\'a eklenir', () => {
    global.showInputModal({
      title:        'Kanal Adı',
      label:        'Ad',
      defaultValue: 'eski-ad',
      confirmText:  'Kaydet',
      onConfirm:    jest.fn(),
    });
    expect(document.getElementById('temp-modal')).not.toBeNull();
  });

  test('Escape tuşu modalı kapatır', () => {
    global.showInputModal({ title: 'Test', label: 'Gir', onConfirm: jest.fn() });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('temp-modal')).toBeNull();
  });
});

describe('showConfirmModal()', () => {
  test('başlık ve mesaj DOM\'a yazılır', () => {
    global.showConfirmModal({
      title:   'Sil?',
      message: 'Bu kanalı silmek istediğine emin misin?',
      onConfirm: jest.fn(),
    });
    const modal = document.getElementById('temp-modal');
    expect(modal).not.toBeNull();
    expect(modal.textContent).toContain('Sil?');
    expect(modal.textContent).toContain('Bu kanalı silmek istediğine emin misin?');
  });
});
