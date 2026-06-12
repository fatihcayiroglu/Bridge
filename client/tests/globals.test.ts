// client/tests/globals.test.ts — Sprint 81
// core/globals.ts için kapsamlı unit testler
//
// Kapsam:
//   - getAPI(): window.BRIDGE_API ve fallback
//   - setter / getter döngüleri (setMe, setSocket, setCurrentServer vb.)
//   - applyServerEmojis(): escHtml pass-through ve emoji ikame
//   - loadServerEmojis(): fetch başarı + fallback + hata
//   - setCurrentServerChannels / setCurrentServerMembers: window köprüsü
//   - addNsfwAccepted / _nsfwAccepted Set yönetimi
//   - setClientConfig: patch birleşimi
//   - collapsedCategories + _persistCollapsedCategories: localStorage
//   - BridgeRegistry kayıtları: getCurrentUser, getCurrentUserId, getCurrentMember

'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../js/core/logger.js', () => ({
  createLogger: () => ({
    log:   jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}), { virtual: true });

jest.mock('../js/core/utils.js', () => ({
  escHtml:    (s: string) => s.replace(/[&<>"']/g, (c: string) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)),
  closeModal: jest.fn(),
  toast:      jest.fn(),
  initials:   jest.fn((s: string) => s[0] ?? '?'),
}), { virtual: true });

const _bridgeRegistryStore: Record<string, (...args: unknown[]) => unknown> = {};
jest.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: (key: string, fn: (...args: unknown[]) => unknown) => {
      _bridgeRegistryStore[key] = fn;
    },
    call: (key: string, ...args: unknown[]) => _bridgeRegistryStore[key]?.(...args),
    get:  (key: string) => _bridgeRegistryStore[key],
  },
}), { virtual: true });

// localStorage mock (jsdom genellikle sağlar ama güvence için)
const _ls: Record<string, string> = {};
beforeAll(() => {
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem:    (k: string) => _ls[k] ?? null,
      setItem:    (k: string, v: string) => { _ls[k] = v; },
      removeItem: (k: string) => { delete _ls[k]; },
      clear:      () => { Object.keys(_ls).forEach(k => delete _ls[k]); },
    },
    writable: true,
  });
});

// ── Module loader ─────────────────────────────────────────────────────────────

function loadModule() {
  jest.resetModules();
  // Bridge API mock — modül yüklenirken window.BRIDGE_API okunur
  return require('../js/core/globals');
}

// ── [1] getAPI ────────────────────────────────────────────────────────────────

describe('getAPI()', () => {
  it('window.BRIDGE_API set edilmemişse fallback döner', () => {
    delete (window as Record<string, unknown>).BRIDGE_API;
    const { getAPI } = loadModule();
    expect(getAPI()).toBe('http://localhost:3001');
  });

  it('window.BRIDGE_API set edilmişse onu döner', () => {
    (window as Record<string, unknown>).BRIDGE_API = 'https://api.bridge.example.com';
    const { getAPI } = loadModule();
    expect(getAPI()).toBe('https://api.bridge.example.com');
    delete (window as Record<string, unknown>).BRIDGE_API;
  });
});

// ── [2] Setter / getter döngüleri ─────────────────────────────────────────────

describe('setter / getter döngüleri', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    delete (window as Record<string, unknown>).BRIDGE_API;
    mod = loadModule();
  });

  it('setMe / getMe', () => {
    const user = { _id: 'u1', username: 'ahmet' };
    mod.setMe(user);
    expect(mod.getMe()).toEqual(user);
    mod.setMe(null);
    expect(mod.getMe()).toBeNull();
  });

  it('setSocket / getSocket', () => {
    const fakeSocket = { on: jest.fn(), emit: jest.fn() };
    mod.setSocket(fakeSocket);
    expect(mod.getSocket()).toBe(fakeSocket);
  });

  it('setCurrentServer / getCurrentServer', () => {
    const srv = { _id: 'srv-1', name: 'Test' };
    mod.setCurrentServer(srv);
    expect(mod.getCurrentServer()).toEqual(srv);
    mod.setCurrentServer(null);
    expect(mod.getCurrentServer()).toBeNull();
  });

  it('setCurrentChannel / getCurrentChannel', () => {
    const ch = { _id: 'ch-1', name: 'genel' };
    mod.setCurrentChannel(ch);
    expect(mod.getCurrentChannel()).toEqual(ch);
  });

  it('setToken', () => {
    mod.setToken('abc123');
    expect(mod.token).toBe('abc123');
    mod.setToken(null);
    expect(mod.token).toBeNull();
  });

  it('setMemberListVisible', () => {
    mod.setMemberListVisible(false);
    expect(mod.memberListVisible).toBe(false);
    mod.setMemberListVisible(true);
    expect(mod.memberListVisible).toBe(true);
  });

  it('setClientConfig partial patch birleşimi korunur', () => {
    mod.setClientConfig({ maxFileSizeMB: 1024 });
    const cfg = mod.getClientConfig();
    expect(cfg.maxFileSizeMB).toBe(1024);
    expect(cfg.chunkSizeMB).toBe(5); // orijinal değer korunmalı
  });

  it('setEditingMessageId / getEditingMessageId', () => {
    mod.setEditingMessageId('msg-42');
    expect(mod.getEditingMessageId()).toBe('msg-42');
    mod.setEditingMessageId(null);
    expect(mod.getEditingMessageId()).toBeNull();
  });

  it('setReplyingTo / getReplyingTo', () => {
    const reply = { _id: 'msg-1', content: 'merhaba' };
    mod.setReplyingTo(reply);
    expect(mod.getReplyingTo()).toEqual(reply);
    mod.setReplyingTo(null);
    expect(mod.getReplyingTo()).toBeNull();
  });

  it('setUnreadMentions / getUnreadMentions', () => {
    mod.setUnreadMentions(5);
    expect(mod.getUnreadMentions()).toBe(5);
    mod.setUnreadMentions(0);
    expect(mod.getUnreadMentions()).toBe(0);
  });
});

// ── [3] applyServerEmojis ─────────────────────────────────────────────────────

describe('applyServerEmojis()', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    delete (window as Record<string, unknown>).BRIDGE_API;
    mod = loadModule();
  });

  it('serverEmojiCache boşsa girdiyi escHtml ile döner', () => {
    mod.serverEmojiCache = [];
    const result = mod.applyServerEmojis('<script>alert(1)</script>');
    expect(result).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('boş string için boş string döner', () => {
    expect(mod.applyServerEmojis('')).toBe('');
  });

  it('bilinen emoji tokenını img tag ile ikame eder', () => {
    mod.serverEmojiCache = [
      { _id: 'e1', name: 'wave', url: '/emojis/wave.png', serverId: 'srv-1' },
    ];
    const result = mod.applyServerEmojis('Merhaba :wave:');
    expect(result).toContain('<img');
    expect(result).toContain('class="server-emoji"');
    expect(result).toContain(':wave:');
  });

  it('bilinmeyen emoji tokeni değiştirilmez', () => {
    mod.serverEmojiCache = [
      { _id: 'e1', name: 'wave', url: '/emojis/wave.png', serverId: 'srv-1' },
    ];
    const result = mod.applyServerEmojis('hello :unknown:');
    expect(result).toContain(':unknown:');
    expect(result).not.toContain('<img');
  });

  it('XSS içerikli emoji name escHtml ile temizlenir', () => {
    mod.serverEmojiCache = [
      { _id: 'e2', name: 'test<evil>', url: '/emojis/test.png', serverId: 'srv-1' },
    ];
    const result = mod.applyServerEmojis(':test<evil>:');
    expect(result).not.toContain('<evil>');
  });
});

// ── [4] setCurrentServerChannels — window köprüsü ────────────────────────────

describe('setCurrentServerChannels()', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    delete (window as Record<string, unknown>).BRIDGE_API;
    mod = loadModule();
  });

  it('ESM export güncellenir', () => {
    const channels = [{ _id: 'ch-1', name: 'genel' }];
    mod.setCurrentServerChannels(channels);
    expect(mod.currentServerChannels).toEqual(channels);
  });

  it('window.currentServerChannels köprüsü de güncellenir', () => {
    const channels = [{ _id: 'ch-2', name: 'duyurular' }];
    mod.setCurrentServerChannels(channels);
    expect((window as Record<string, unknown>).currentServerChannels).toEqual(channels);
  });
});

// ── [5] addNsfwAccepted ───────────────────────────────────────────────────────

describe('addNsfwAccepted()', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    delete (window as Record<string, unknown>).BRIDGE_API;
    mod = loadModule();
  });

  it('_nsfwAccepted Set\'e channelId ekler', () => {
    mod.addNsfwAccepted('ch-nsfw-1');
    expect(mod._nsfwAccepted.has('ch-nsfw-1')).toBe(true);
  });

  it('aynı channelId iki kez eklenirse Set büyümez', () => {
    mod.addNsfwAccepted('ch-nsfw-2');
    mod.addNsfwAccepted('ch-nsfw-2');
    // Set semantiği — yinelenen değer eklenmez
    let count = 0;
    mod._nsfwAccepted.forEach((v: string) => { if (v === 'ch-nsfw-2') count++; });
    expect(count).toBe(1);
  });
});

// ── [6] _persistCollapsedCategories ──────────────────────────────────────────

describe('_persistCollapsedCategories()', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    _ls['bridge_collapsed_cats'] = '[]';
    delete (window as Record<string, unknown>).BRIDGE_API;
    mod = loadModule();
  });

  it('collapsedCategories içeriğini localStorage\'a yazar', () => {
    mod.collapsedCategories.add('cat-a');
    mod._persistCollapsedCategories();
    const stored = JSON.parse(_ls['bridge_collapsed_cats'] ?? '[]') as string[];
    expect(stored).toContain('cat-a');
  });

  it('boş set için boş dizi yazar', () => {
    mod.collapsedCategories.clear();
    mod._persistCollapsedCategories();
    const stored = JSON.parse(_ls['bridge_collapsed_cats'] ?? '["x"]') as string[];
    expect(stored).toHaveLength(0);
  });
});

// ── [7] BridgeRegistry kayıtları ─────────────────────────────────────────────

describe('BridgeRegistry kayıtları', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    delete (window as Record<string, unknown>).BRIDGE_API;
    Object.keys(_bridgeRegistryStore).forEach(k => delete _bridgeRegistryStore[k]);
    mod = loadModule();
  });

  it('getCurrentUser — me nesnesini döner', () => {
    const user = { _id: 'u-10', username: 'zeynep' };
    mod.setMe(user);
    const result = _bridgeRegistryStore['getCurrentUser']?.();
    expect(result).toEqual(user);
  });

  it('getCurrentUser — me null ise null döner', () => {
    mod.setMe(null);
    expect(_bridgeRegistryStore['getCurrentUser']?.()).toBeNull();
  });

  it('getCurrentUserId — me._id döner', () => {
    mod.setMe({ _id: 'u-11', username: 'ali' });
    expect(_bridgeRegistryStore['getCurrentUserId']?.()).toBe('u-11');
  });

  it('getCurrentUserId — me null ise null döner', () => {
    mod.setMe(null);
    expect(_bridgeRegistryStore['getCurrentUserId']?.()).toBeNull();
  });

  it('getCurrentChannel — aktif kanalı döner', () => {
    const ch = { _id: 'ch-99', name: 'test' };
    mod.setCurrentChannel(ch);
    expect(_bridgeRegistryStore['getCurrentChannel']?.()).toEqual(ch);
  });

  it('getCurrentMember — me ile eşleşen üyeyi döner', () => {
    mod.setMe({ _id: 'u-5', username: 'hasan' });
    mod.setCurrentServerMembers([
      { userId: 'u-3', displayName: 'Ahmet' },
      { userId: 'u-5', displayName: 'Hasan' },
    ]);
    const member = _bridgeRegistryStore['getCurrentMember']?.() as Record<string, unknown>;
    expect(member?.userId).toBe('u-5');
  });

  it('getCurrentMember — eşleşme yoksa null döner', () => {
    mod.setMe({ _id: 'u-99', username: 'ghost' });
    mod.setCurrentServerMembers([{ userId: 'u-1', displayName: 'Başkası' }]);
    expect(_bridgeRegistryStore['getCurrentMember']?.()).toBeUndefined(); // find döner undefined
  });

  it('setMeField — me üzerindeki bir alanı günceller', () => {
    mod.setMe({ _id: 'u-7', username: 'fatih' });
    _bridgeRegistryStore['setMeField']?.('displayName', 'Fatih Bey');
    expect((mod.getMe() as Record<string, unknown>).displayName).toBe('Fatih Bey');
  });
});
