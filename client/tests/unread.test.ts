// client/tests/unread.test.ts — Sprint 78
// core/unread.ts için unit testler
// Kapsam: incrementUnread, clearUnread, _renderUnreadBadge, 9+ cap

'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetCurrentChannel = jest.fn(() => null);

jest.mock('../js/core/globals.js', () => ({
  getCurrentChannel: mockGetCurrentChannel,
}), { virtual: true });

// ── Module loader ─────────────────────────────────────────────────────────────

function loadModule() {
  jest.resetModules();
  jest.mock('../js/core/globals.js', () => ({
    getCurrentChannel: mockGetCurrentChannel,
  }), { virtual: true });
  return require('../js/core/unread.js');
}

function buildChannelDOM(channelId: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ch-item';
  el.setAttribute('data-id', channelId);
  document.body.appendChild(el);
  return el;
}

// ── incrementUnread ───────────────────────────────────────────────────────────

describe('incrementUnread', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';
    mockGetCurrentChannel.mockReturnValue(null);
  });

  test('aktif kanalda sayaç artmaz', () => {
    mockGetCurrentChannel.mockReturnValue({ _id: 'ch-1' });
    const el = buildChannelDOM('ch-1');
    const { incrementUnread } = loadModule();
    incrementUnread('ch-1');
    expect(el.querySelector('.ch-unread')).toBeNull();
  });

  test('farklı kanalda sayaç artar ve badge oluşur', () => {
    mockGetCurrentChannel.mockReturnValue({ _id: 'ch-active' });
    const el = buildChannelDOM('ch-other');
    const { incrementUnread } = loadModule();
    incrementUnread('ch-other');
    const badge = el.querySelector('.ch-unread') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('1');
  });

  test('birden fazla çağrı sayacı biriktirir', () => {
    const el = buildChannelDOM('ch-2');
    const { incrementUnread } = loadModule();
    incrementUnread('ch-2');
    incrementUnread('ch-2');
    incrementUnread('ch-2');
    const badge = el.querySelector('.ch-unread') as HTMLElement;
    expect(badge?.textContent).toBe('3');
  });

  test('9 üzeri mesaj için "9+" gösterilir', () => {
    const el = buildChannelDOM('ch-3');
    const { incrementUnread } = loadModule();
    for (let i = 0; i < 12; i++) incrementUnread('ch-3');
    const badge = el.querySelector('.ch-unread') as HTMLElement;
    expect(badge?.textContent).toBe('9+');
  });

  test('DOM elementi yoksa hata fırlatmaz', () => {
    const { incrementUnread } = loadModule();
    expect(() => incrementUnread('ch-yok')).not.toThrow();
  });

  test('farklı kanallar birbirinden bağımsız sayılır', () => {
    const el1 = buildChannelDOM('ch-a');
    const el2 = buildChannelDOM('ch-b');
    const { incrementUnread } = loadModule();
    incrementUnread('ch-a');
    incrementUnread('ch-a');
    incrementUnread('ch-b');
    expect(el1.querySelector('.ch-unread')?.textContent).toBe('2');
    expect(el2.querySelector('.ch-unread')?.textContent).toBe('1');
  });
});

// ── clearUnread ───────────────────────────────────────────────────────────────

describe('clearUnread', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';
    mockGetCurrentChannel.mockReturnValue(null);
  });

  test('clearUnread badge\'i DOM\'dan kaldırır', () => {
    const el = buildChannelDOM('ch-4');
    const { incrementUnread, clearUnread } = loadModule();
    incrementUnread('ch-4');
    expect(el.querySelector('.ch-unread')).not.toBeNull();
    clearUnread('ch-4');
    expect(el.querySelector('.ch-unread')).toBeNull();
  });

  test('clearUnread sonrası increment sıfırdan başlar', () => {
    const el = buildChannelDOM('ch-5');
    const { incrementUnread, clearUnread } = loadModule();
    incrementUnread('ch-5');
    incrementUnread('ch-5');
    clearUnread('ch-5');
    incrementUnread('ch-5');
    expect(el.querySelector('.ch-unread')?.textContent).toBe('1');
  });

  test('badge yokken clearUnread hata fırlatmaz', () => {
    buildChannelDOM('ch-6');
    const { clearUnread } = loadModule();
    expect(() => clearUnread('ch-6')).not.toThrow();
  });

  test('DOM elementi yokken clearUnread hata fırlatmaz', () => {
    const { clearUnread } = loadModule();
    expect(() => clearUnread('ch-yok')).not.toThrow();
  });
});

// ── Badge güncelleme ──────────────────────────────────────────────────────────

describe('badge güncelleme', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';
    mockGetCurrentChannel.mockReturnValue(null);
  });

  test('mevcut badge güncellenir, yeni span oluşturulmaz', () => {
    const el = buildChannelDOM('ch-7');
    const { incrementUnread } = loadModule();
    incrementUnread('ch-7');
    incrementUnread('ch-7');
    const badges = el.querySelectorAll('.ch-unread');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toBe('2');
  });

  test('tam olarak 9 mesajda "9" gösterilir, "9+" değil', () => {
    const el = buildChannelDOM('ch-8');
    const { incrementUnread } = loadModule();
    for (let i = 0; i < 9; i++) incrementUnread('ch-8');
    expect(el.querySelector('.ch-unread')?.textContent).toBe('9');
  });

  test('10. mesajda "9+" gösterilmeye başlar', () => {
    const el = buildChannelDOM('ch-9');
    const { incrementUnread } = loadModule();
    for (let i = 0; i < 10; i++) incrementUnread('ch-9');
    expect(el.querySelector('.ch-unread')?.textContent).toBe('9+');
  });
});
