// client/tests/slow-mode-logic.test.ts
// Sprint 69 — core/slow-mode.ts (BridgeSlowMode) için logic testleri
// Kapsam:
//   - renderSlowModeBadge: saniye/dakika/saat label, slowmode=0 badge göstermez,
//     mevcut badge'i kaldırır, channel-topic sonrasına ekler
//   - startCooldown: input+btn disable, badge countdown, expire sonrası re-enable
//   - BridgeSlowMode export'u

'use strict';

// ── Bağımlılık mock'ları ──────────────────────────────────────────────────────

const mockApiFetch = jest.fn().mockResolvedValue({});
const mockGetAPI   = jest.fn().mockReturnValue('http://localhost:3000');
const mockGetCurrentChannel = jest.fn().mockReturnValue(null);

jest.mock('../js/core/api-fetch.js',   () => ({ apiFetch: mockApiFetch }));
jest.mock('../js/core/globals.js',     () => ({
  getAPI:             mockGetAPI,
  getCurrentChannel:  mockGetCurrentChannel,
}));
jest.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    get:      jest.fn().mockReturnValue(undefined),
    register: jest.fn(),
  },
}));

// ── Modül yükleyici ───────────────────────────────────────────────────────────

function loadSlowModeModule() {
  jest.resetModules();

  jest.mock('../js/core/api-fetch.js',   () => ({ apiFetch: mockApiFetch }));
  jest.mock('../js/core/globals.js',     () => ({
    getAPI:            mockGetAPI,
    getCurrentChannel: mockGetCurrentChannel,
  }));
  jest.mock('../js/core/bridge-registry.js', () => ({
    BridgeRegistry: {
      get:      jest.fn().mockReturnValue(undefined),
      register: jest.fn(),
    },
  }));

  const mod = require('../js/core/slow-mode');
  return mod.BridgeSlowMode as {
    renderSlowModeBadge: (ch: object) => void;
    startCooldown:       (seconds: number) => void;
    saveSlowMode:        (channelId: string, serverId: string, seconds: number) => Promise<void>;
  };
}

// ── DOM yardımcıları ─────────────────────────────────────────────────────────

function buildDOM(opts: { withTopic?: boolean; withInput?: boolean; withBadge?: boolean } = {}) {
  document.body.innerHTML = '';

  if (opts.withTopic) {
    const topic = document.createElement('div');
    topic.id = 'channel-topic';
    document.body.appendChild(topic);
  }

  if (opts.withInput) {
    const input = document.createElement('textarea');
    input.id = 'msg-input';
    document.body.appendChild(input);

    const btn = document.createElement('button');
    btn.id = 'send-btn';
    document.body.appendChild(btn);
  }

  if (opts.withBadge) {
    const badge = document.createElement('span');
    badge.id = 'slow-mode-badge';
    badge.textContent = '🐢 10s';
    document.body.appendChild(badge);
  }
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ════════════════════════════════════════════════════════════════
// renderSlowModeBadge
// ════════════════════════════════════════════════════════════════

describe('renderSlowModeBadge', () => {
  it('slowmode=0 iken badge gösterilmez', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: 0 });

    expect(document.getElementById('slow-mode-badge')).toBeNull();
  });

  it('slowmode negatif iken badge gösterilmez', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: -5 });

    expect(document.getElementById('slow-mode-badge')).toBeNull();
  });

  it('slowmode undefined iken badge gösterilmez', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({});

    expect(document.getElementById('slow-mode-badge')).toBeNull();
  });

  it('30 saniye → "🐢 30s" label', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: 30 });

    const badge = document.getElementById('slow-mode-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('30s');
  });

  it('59 saniye → "59s" (dakikaya dönüşmez)', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: 59 });

    expect(document.getElementById('slow-mode-badge')!.textContent).toContain('59s');
  });

  it('60 saniye → "1dk" (dakika birimi)', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: 60 });

    expect(document.getElementById('slow-mode-badge')!.textContent).toContain('1dk');
  });

  it('90 saniye → "1dk" (tam dakika aşağı yuvarlar)', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: 90 });

    expect(document.getElementById('slow-mode-badge')!.textContent).toContain('1dk');
  });

  it('3600 saniye → "1sa" (saat birimi)', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: 3600 });

    expect(document.getElementById('slow-mode-badge')!.textContent).toContain('1sa');
  });

  it('7200 saniye → "2sa"', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: 7200 });

    expect(document.getElementById('slow-mode-badge')!.textContent).toContain('2sa');
  });

  it('mevcut badge kaldırılır, yeni oluşturulur', () => {
    buildDOM({ withTopic: true, withBadge: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: 15 });

    // Sadece 1 badge olmalı
    const badges = document.querySelectorAll('#slow-mode-badge');
    expect(badges.length).toBe(1);
    expect((badges[0] as HTMLElement).textContent).toContain('15s');
  });

  it('badge "slow-mode-badge" class\'ına sahip', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: 5 });

    const badge = document.getElementById('slow-mode-badge');
    expect(badge!.className).toBe('slow-mode-badge');
  });

  it('title tooltip Türkçe açıklama içerir', () => {
    buildDOM({ withTopic: true });
    const sm = loadSlowModeModule();

    sm.renderSlowModeBadge({ slowmode: 10 });

    const badge = document.getElementById('slow-mode-badge') as HTMLElement;
    expect(badge.title).toContain('Yavaş mod');
    expect(badge.title).toContain('bekleme');
  });

  it('channel-topic yoksa hata fırlatmaz', () => {
    buildDOM(); // topic yok
    const sm = loadSlowModeModule();

    expect(() => sm.renderSlowModeBadge({ slowmode: 10 })).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// startCooldown
// ════════════════════════════════════════════════════════════════

describe('startCooldown', () => {
  it('msg-input ve send-btn\'i disable eder', () => {
    buildDOM({ withInput: true, withBadge: true });
    const sm = loadSlowModeModule();

    sm.startCooldown(5);

    const input = document.getElementById('msg-input') as HTMLTextAreaElement;
    const btn   = document.getElementById('send-btn')  as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(btn.disabled).toBe(true);
  });

  it('süre dolunca input ve btn yeniden aktif olur', () => {
    buildDOM({ withInput: true, withBadge: true });
    const sm = loadSlowModeModule();

    sm.startCooldown(3);

    // 3 saniye geçsin
    jest.advanceTimersByTime(4000);

    const input = document.getElementById('msg-input') as HTMLTextAreaElement;
    const btn   = document.getElementById('send-btn')  as HTMLButtonElement;
    expect(input.disabled).toBe(false);
    expect(btn.disabled).toBe(false);
  });

  it('badge countdown metni güncellenir', () => {
    buildDOM({ withInput: true, withBadge: true });
    const badge = document.getElementById('slow-mode-badge')!;
    const sm = loadSlowModeModule();

    sm.startCooldown(5);

    // tick() hemen çağrılır — badge "X bekleniyor" içermeli
    expect(badge.textContent).toContain('bekleniyor');
  });

  it('input/btn yoksa hata fırlatmaz', () => {
    buildDOM(); // no input elements
    const sm = loadSlowModeModule();

    expect(() => sm.startCooldown(5)).not.toThrow();
  });

  it('aktif timer varken ikinci startCooldown çağrısı yeni timer başlatmaz', () => {
    buildDOM({ withInput: true, withBadge: true });
    const sm = loadSlowModeModule();

    sm.startCooldown(10);
    sm.startCooldown(5); // ikinci çağrı — ignore edilmeli

    // 6 saniye geçsin → 5 saniyelik timer bitmiş olurdu ama 10 saniyelik hâlâ devam
    jest.advanceTimersByTime(6000);

    const input = document.getElementById('msg-input') as HTMLTextAreaElement;
    // input hâlâ disabled olmalı (10 saniyelik timer devam ediyor)
    expect(input.disabled).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// BridgeSlowMode export
// ════════════════════════════════════════════════════════════════

describe('BridgeSlowMode export', () => {
  it('renderSlowModeBadge, startCooldown, saveSlowMode fonksiyon olarak export edilmiş', () => {
    const sm = loadSlowModeModule();

    expect(typeof sm.renderSlowModeBadge).toBe('function');
    expect(typeof sm.startCooldown).toBe('function');
    expect(typeof sm.saveSlowMode).toBe('function');
  });
});
