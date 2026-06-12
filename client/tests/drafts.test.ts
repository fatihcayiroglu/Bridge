// client/tests/drafts.test.ts — Sprint 78
// core/drafts.ts için unit testler
// Kapsam: saveDraft / restoreDraft localStorage, TTL temizleme,
//         draft indicator gösterimi, channel-selected event, autosave

'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetCurrentChannel = jest.fn(() => null);
const mockBridgeRegistry = {
  get:      jest.fn(() => undefined),
  register: jest.fn(),
  call:     jest.fn(),
  has:      jest.fn(),
};

jest.mock('../js/core/globals.js', () => ({
  getCurrentChannel: mockGetCurrentChannel,
}), { virtual: true });

jest.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: mockBridgeRegistry,
}), { virtual: true });

// ── localStorage mock ─────────────────────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear:      () => { store = {}; },
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// ── Module loader ─────────────────────────────────────────────────────────────

function loadModule() {
  jest.resetModules();
  localStorageMock.clear();
  mockBridgeRegistry.get.mockReturnValue(undefined);
  mockBridgeRegistry.call.mockReturnValue(null);

  jest.mock('../js/core/globals.js', () => ({
    getCurrentChannel: mockGetCurrentChannel,
  }), { virtual: true });
  jest.mock('../js/core/bridge-registry.js', () => ({
    BridgeRegistry: mockBridgeRegistry,
  }), { virtual: true });

  return require('../js/core/drafts.js');
}

// ── saveDraft / restoreDraft ──────────────────────────────────────────────────

describe('saveDraft / restoreDraft', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();
    document.body.innerHTML = '';
  });

  test('saveDraft kaydeder, restoreDraft geri döndürür', () => {
    const { saveDraft, restoreDraft } = loadModule();
    saveDraft('ch-1', 'merhaba dünya');
    expect(restoreDraft('ch-1')).toBe('merhaba dünya');
  });

  test('boş string kaydedilmez, mevcut taslak silinir', () => {
    const { saveDraft, restoreDraft } = loadModule();
    saveDraft('ch-1', 'bir şeyler');
    saveDraft('ch-1', '');
    expect(restoreDraft('ch-1')).toBe('');
  });

  test('sadece boşluk içeren string taslak olarak kaydedilmez', () => {
    const { saveDraft, restoreDraft } = loadModule();
    saveDraft('ch-1', '   ');
    expect(restoreDraft('ch-1')).toBe('');
  });

  test('farklı kanalların taslakları birbirinden bağımsız', () => {
    const { saveDraft, restoreDraft } = loadModule();
    saveDraft('ch-1', 'kanal 1 taslak');
    saveDraft('ch-2', 'kanal 2 taslak');
    expect(restoreDraft('ch-1')).toBe('kanal 1 taslak');
    expect(restoreDraft('ch-2')).toBe('kanal 2 taslak');
  });

  test('bilinmeyen kanal için boş string döner', () => {
    const { restoreDraft } = loadModule();
    expect(restoreDraft('bilinmeyen-kanal')).toBe('');
  });

  test('localStorage bozuksa hata fırlatmaz', () => {
    const orig = localStorageMock.getItem;
    localStorageMock.getItem = () => { throw new Error('storage error'); };
    const { restoreDraft } = loadModule();
    expect(() => restoreDraft('ch-1')).not.toThrow();
    localStorageMock.getItem = orig;
  });
});

// ── TTL temizleme ─────────────────────────────────────────────────────────────

describe('TTL temizleme', () => {
  test('7 günden eski taslaklar yeni kayıtta temizlenir', () => {
    const DRAFT_KEY = 'bridge_drafts_v1';
    const oldTs     = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 gün önce
    localStorageMock.setItem(DRAFT_KEY, JSON.stringify({
      'old-ch': { text: 'eski taslak', savedAt: oldTs },
    }));

    const { saveDraft, restoreDraft } = loadModule();
    saveDraft('new-ch', 'yeni taslak'); // TTL temizliği tetiklenir
    expect(restoreDraft('old-ch')).toBe('');
    expect(restoreDraft('new-ch')).toBe('yeni taslak');
  });

  test('7 günden genç taslaklar korunur', () => {
    const DRAFT_KEY = 'bridge_drafts_v1';
    const recentTs  = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 gün önce
    localStorageMock.setItem(DRAFT_KEY, JSON.stringify({
      'recent-ch': { text: 'güncel taslak', savedAt: recentTs },
    }));

    const { saveDraft, restoreDraft } = loadModule();
    saveDraft('other-ch', 'diğer');
    expect(restoreDraft('recent-ch')).toBe('güncel taslak');
  });
});

// ── Draft indicator ───────────────────────────────────────────────────────────

describe('draft indicator DOM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();
    jest.useFakeTimers();
  });

  afterEach(() => jest.useRealTimers());

  test('metin var iken indicator visible class alır', () => {
    document.body.innerHTML = '<div id="msg-input-wrapper"></div>';
    const { saveDraft } = loadModule();
    saveDraft('ch-1', 'test mesajı');
    const indicator = document.getElementById('draft-indicator');
    expect(indicator?.classList.contains('visible')).toBe(true);
  });

  test('metin temizlenince indicator visible class kaybeder', () => {
    document.body.innerHTML = '<div id="msg-input-wrapper"></div>';
    const { saveDraft } = loadModule();
    saveDraft('ch-1', 'bir şeyler');
    saveDraft('ch-1', '');
    const indicator = document.getElementById('draft-indicator');
    expect(indicator?.classList.contains('visible')).toBe(false);
  });

  test('2 saniye sonra indicator otomatik gizlenir', () => {
    document.body.innerHTML = '<div id="msg-input-wrapper"></div>';
    const { saveDraft } = loadModule();
    saveDraft('ch-1', 'test');
    jest.advanceTimersByTime(2001);
    const indicator = document.getElementById('draft-indicator');
    expect(indicator?.classList.contains('visible')).toBe(false);
  });
});

// ── bridge:channel-selected event ────────────────────────────────────────────

describe('channel-selected event', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();
    document.body.innerHTML = '<textarea id="msg-input"></textarea>';
  });

  test('kanal değişince kaydedilmiş taslak input\'a yazılır', () => {
    const DRAFT_KEY = 'bridge_drafts_v1';
    localStorageMock.setItem(DRAFT_KEY, JSON.stringify({
      'ch-5': { text: 'taslak içerik', savedAt: Date.now() },
    }));
    mockBridgeRegistry.call.mockImplementation((name: string, channelId: string) => {
      if (name === 'restoreDraft') {
        const data = JSON.parse(localStorageMock.getItem(DRAFT_KEY) ?? '{}');
        return data[channelId]?.text ?? '';
      }
      return null;
    });

    loadModule();
    const inp = document.getElementById('msg-input') as HTMLTextAreaElement;
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: 'ch-5' } }));
    expect(inp.value).toBe('taslak içerik');
  });

  test('taslak yoksa input temizlenir', () => {
    mockBridgeRegistry.call.mockReturnValue('');
    loadModule();
    const inp = document.getElementById('msg-input') as HTMLTextAreaElement;
    inp.value = 'eski içerik';
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: 'bos-kanal' } }));
    expect(inp.value).toBe('');
  });

  test('channelId yoksa input dokunulmaz', () => {
    loadModule();
    const inp = document.getElementById('msg-input') as HTMLTextAreaElement;
    inp.value = 'korunsun';
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: {} }));
    expect(inp.value).toBe('korunsun');
  });
});

// ── BridgeRegistry entegrasyonu ───────────────────────────────────────────────

describe('BridgeRegistry entegrasyonu', () => {
  test('saveDraft ve restoreDraft BridgeRegistry\'ye kayıt edilir', () => {
    loadModule();
    const registered = mockBridgeRegistry.register.mock.calls.map((c: unknown[]) => c[0]);
    expect(registered).toContain('saveDraft');
    expect(registered).toContain('restoreDraft');
  });
});
