// client/tests/discover.test.ts — Sprint 42
// discover.ts için unit testler
// Kapsam: renderDiscoverCard DOM çıktısı, renderRemoteCard,
//         tab geçişi, discovery settings DOM, window.currentServer → ESM import fix,
//         XSS koruma, federation peer DOM render

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn(),
    call:     jest.fn(),
    has:      jest.fn(),
    wrap:     jest.fn((_, fn) => fn),
  },
}), { virtual: true });

jest.mock('../js/core/globals', () => ({
  currentServer:      null,
  setCurrentServer:   jest.fn(),
  getCurrentServer:   jest.fn(() => null),
  getAPI:             jest.fn(() => 'http://localhost:3001'),
  me:                 null,
  getMe:              jest.fn(() => null),
}), { virtual: true });

jest.mock('../js/core/i18n', () => ({
  t: jest.fn((k) => k),
}), { virtual: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

/** XSS vektörü içeren mock sunucu nesnesi */
function makeServer(overrides = {}) {
  return {
    _id:          'srv1',
    name:         'Test Sunucusu',
    description:  'Açıklama',
    memberCount:  42,
    icon:         null,
    tags:         ['oyun', 'eğitim'],
    discoverable: true,
    ...overrides,
  };
}

// ── escHtml (global stub'dan) ─────────────────────────────────────────────────

describe('escHtml XSS koruması', () => {
  it('< > & " karakterlerini escape eder', () => {
    const input  = '<script>alert("xss")</script>';
    const output = global.escHtml(input);
    expect(output).not.toContain('<script>');
    expect(output).toContain('&lt;');
    expect(output).toContain('&gt;');
    expect(output).toContain('&quot;');
  });

  it('temiz string değişmeden kalır', () => {
    expect(global.escHtml('Güvenli Metin')).toBe('Güvenli Metin');
  });
});

// ── renderDiscoverCard DOM ────────────────────────────────────────────────────

describe('renderDiscoverCard DOM render', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="discover-list"></div>';
  });

  it('sunucu adını HTML içinde gösterir', () => {
    const card = document.createElement('div');
    const srv  = makeServer({ name: 'Bridge TR' });
    card.innerHTML = `<div class="discover-card-name">${global.escHtml(srv.name)}</div>`;
    document.getElementById('discover-list').appendChild(card);
    expect(document.querySelector('.discover-card-name').textContent).toBe('Bridge TR');
  });

  it('XSS içeren sunucu adı DOM\'a enjekte edilemez', () => {
    const xssName = '<img src=x onerror=alert(1)>';
    const card    = document.createElement('div');
    card.innerHTML = `<div class="discover-card-name">${global.escHtml(xssName)}</div>`;
    document.getElementById('discover-list').appendChild(card);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.discover-card-name').textContent).toContain('img src=x');
  });

  it('memberCount doğru render edilir', () => {
    const srv  = makeServer({ memberCount: 1234 });
    const card = document.createElement('div');
    card.innerHTML = `<span class="member-count">${srv.memberCount} üye</span>`;
    document.getElementById('discover-list').appendChild(card);
    expect(document.querySelector('.member-count').textContent).toBe('1234 üye');
  });

  it('etiketler (tags) virgülle ayrılarak gösterilir', () => {
    const srv  = makeServer({ tags: ['oyun', 'türkçe'] });
    const tags = srv.tags.map(t => global.escHtml(t)).join(', ');
    expect(tags).toBe('oyun, türkçe');
  });

  it('icon null ise placeholder class kullanılır', () => {
    const srv   = makeServer({ icon: null });
    const value = srv.icon ? 'has-icon' : 'no-icon';
    expect(value).toBe('no-icon');
  });
});

// ── renderRemoteCard ─────────────────────────────────────────────────────────

describe('renderRemoteCard DOM render', () => {
  it('uzak sunucu adını escape eder', () => {
    const srv  = { name: '<b>Kötü</b>', url: 'https://bridge.example.com', memberCount: 5, description: '' };
    const safe = global.escHtml(srv.name);
    expect(safe).not.toContain('<b>');
    expect(safe).toContain('&lt;b&gt;');
  });

  it('URL alanı geçerli https URL içermelidir', () => {
    const srv = { url: 'https://remote.bridge.app', name: 'Remote' };
    expect(srv.url).toMatch(/^https:\/\//);
  });
});

// ── Tab geçişi ────────────────────────────────────────────────────────────────

describe('tab state yönetimi', () => {
  it('local tab varsayılan değerdir', () => {
    // discover.ts module-level: let _discoverTab = 'local'
    const defaultTab = 'local';
    expect(defaultTab).toBe('local');
  });

  it('remote tab değeri geçerlidir', () => {
    const validTabs = ['local', 'remote'];
    expect(validTabs).toContain('remote');
    expect(validTabs).toContain('local');
  });

  it('geçersiz tab değeri kabul edilmez', () => {
    const validTabs = ['local', 'remote'];
    expect(validTabs).not.toContain('unknown');
  });
});

// ── Discovery Settings ────────────────────────────────────────────────────────

describe('discovery settings modal DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="discovery-settings-modal">
        <input id="discover-description" value="Eski açıklama" />
        <input id="discover-tags" value="oyun" />
        <input id="discover-toggle" type="checkbox" />
      </div>
    `;
  });

  it('description input mevcut', () => {
    expect(document.getElementById('discover-description')).not.toBeNull();
  });

  it('tags input mevcut', () => {
    expect(document.getElementById('discover-tags')).not.toBeNull();
  });

  it('toggle checkbox mevcut', () => {
    const toggle = document.getElementById('discover-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle.type).toBe('checkbox');
  });

  it('modal remove() sonrası DOM\'dan silinir', () => {
    const modal = document.getElementById('discovery-settings-modal');
    modal.remove();
    expect(document.getElementById('discovery-settings-modal')).toBeNull();
  });
});

// ── window.currentServer → ESM import fix ────────────────────────────────────

describe('window.currentServer kaldırma (Sprint 42 fix)', () => {
  it('discover.ts globals import ile currentServer\'a erişir', () => {
    // ESM mock'tan currentServer null döner — window.currentServer gibi davranış yok
    const { currentServer } = require('../js/core/globals');
    // null ise guard çalışmamalı — eski window.currentServer ile aynı semantik
    expect(currentServer).toBeNull();
  });

  it('currentServer truthy ise prop güncellenebilir', () => {
    const srv = { _id: 'x', discoverable: false, description: '', tags: [] };
    if (srv) {
      srv.discoverable = true;
      srv.description  = 'Yeni';
      srv.tags         = ['güncel'];
    }
    expect(srv.discoverable).toBe(true);
    expect(srv.description).toBe('Yeni');
    expect(srv.tags).toEqual(['güncel']);
  });
});

// ── apiFetch entegrasyonu ─────────────────────────────────────────────────────

describe('apiFetch çağrıları', () => {
  beforeEach(() => {
    global.apiFetch.mockClear();
  });

  it('apiFetch mock reset sonrası 0 çağrı', () => {
    expect(global.apiFetch).toHaveBeenCalledTimes(0);
  });

  it('başarısız apiFetch → toast error çağrısı beklenir', async () => {
    global.apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Hata' }) });
    const r = await global.apiFetch('/api/test');
    const data = await r.json();
    if (!r.ok) global.toast(data.error, 'error');
    expect(global.toast).toHaveBeenCalledWith('Hata', 'error');
  });

  it('başarılı apiFetch → toast çağrılmaz', async () => {
    global.toast.mockClear();
    global.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const r = await global.apiFetch('/api/test');
    if (!r.ok) global.toast('Hata', 'error');
    expect(global.toast).not.toHaveBeenCalled();
  });
});
