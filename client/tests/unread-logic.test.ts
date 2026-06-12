// client/tests/unread-logic.test.ts
// Sprint 69 — core/unread.ts için logic testleri
// Kapsam:
//   - incrementUnread: sayacı artırma, aktif kanal skip, _renderUnreadBadge tetikleme
//   - clearUnread: sayacı sıfırlama, badge DOM kaldırma
//   - _renderUnreadBadge: badge oluşturma, güncelleme, 9+ cap
//   - incrementUnread: getCurrentChannel null iken

'use strict';

// ── Globals & Mock kurulumu ───────────────────────────────────────────────────

let _currentChannelId: string | null = null;

jest.mock('../js/core/globals.js', () => ({
  getCurrentChannel: jest.fn(() =>
    _currentChannelId ? { _id: _currentChannelId } : null
  ),
}));

// unread.ts'i her testten önce temiz yükle
function loadUnreadModule() {
  jest.resetModules();

  // globals mock'unu yeniden tesis et (resetModules sonrası)
  jest.mock('../js/core/globals.js', () => ({
    getCurrentChannel: jest.fn(() =>
      _currentChannelId ? { _id: _currentChannelId } : null
    ),
  }));

  // Module side-effect yok, fonksiyonlar export edilmiş
  const mod = require('../js/core/unread');
  return mod as {
    incrementUnread: (id: string) => void;
    clearUnread: (id: string) => void;
  };
}

// ── DOM yardımcıları ─────────────────────────────────────────────────────────

function makeChannelItem(channelId: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ch-item';
  el.dataset.id = channelId;
  document.body.appendChild(el);
  return el;
}

function getUnreadBadge(channelId: string): HTMLElement | null {
  return document.querySelector(
    `.ch-item[data-id="${channelId}"] .ch-unread`
  ) as HTMLElement | null;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
  _currentChannelId = null;
});

// ════════════════════════════════════════════════════════════════
// incrementUnread
// ════════════════════════════════════════════════════════════════

describe('incrementUnread', () => {
  it('badge oluşturur ve "1" gösterir', () => {
    const { incrementUnread } = loadUnreadModule();
    makeChannelItem('ch-1');

    incrementUnread('ch-1');

    const badge = getUnreadBadge('ch-1');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('1');
  });

  it('birden fazla çağrıda sayacı artırır', () => {
    const { incrementUnread } = loadUnreadModule();
    makeChannelItem('ch-2');

    incrementUnread('ch-2');
    incrementUnread('ch-2');
    incrementUnread('ch-2');

    const badge = getUnreadBadge('ch-2');
    expect(badge!.textContent).toBe('3');
  });

  it('aktif kanal için sayaç artırılmaz (getCurrentChannel eşleşiyor)', () => {
    _currentChannelId = 'ch-active';
    const { incrementUnread } = loadUnreadModule();
    makeChannelItem('ch-active');

    incrementUnread('ch-active');
    incrementUnread('ch-active');

    const badge = getUnreadBadge('ch-active');
    // Badge oluşturulmamalı
    expect(badge).toBeNull();
  });

  it('farklı aktif kanal iken diğer kanal sayacı artar', () => {
    _currentChannelId = 'ch-other';
    const { incrementUnread } = loadUnreadModule();
    makeChannelItem('ch-target');

    incrementUnread('ch-target');

    const badge = getUnreadBadge('ch-target');
    expect(badge!.textContent).toBe('1');
  });

  it('getCurrentChannel null iken sayaç artar', () => {
    _currentChannelId = null;
    const { incrementUnread } = loadUnreadModule();
    makeChannelItem('ch-3');

    incrementUnread('ch-3');

    const badge = getUnreadBadge('ch-3');
    expect(badge!.textContent).toBe('1');
  });

  it('9 okunmamış mesaj "9" olarak gösterilir', () => {
    const { incrementUnread } = loadUnreadModule();
    makeChannelItem('ch-9');

    for (let i = 0; i < 9; i++) incrementUnread('ch-9');

    const badge = getUnreadBadge('ch-9');
    expect(badge!.textContent).toBe('9');
  });

  it('10+ okunmamış mesaj "9+" olarak gösterilir (cap)', () => {
    const { incrementUnread } = loadUnreadModule();
    makeChannelItem('ch-over');

    for (let i = 0; i < 15; i++) incrementUnread('ch-over');

    const badge = getUnreadBadge('ch-over');
    expect(badge!.textContent).toBe('9+');
  });

  it('ch-item DOM\'da yoksa hata fırlatmaz', () => {
    const { incrementUnread } = loadUnreadModule();
    // DOM\'da ch-item yok

    expect(() => incrementUnread('ch-missing')).not.toThrow();
  });

  it('farklı kanallar bağımsız sayaçlara sahip', () => {
    const { incrementUnread } = loadUnreadModule();
    makeChannelItem('ch-a');
    makeChannelItem('ch-b');

    incrementUnread('ch-a');
    incrementUnread('ch-a');
    incrementUnread('ch-b');

    expect(getUnreadBadge('ch-a')!.textContent).toBe('2');
    expect(getUnreadBadge('ch-b')!.textContent).toBe('1');
  });
});

// ════════════════════════════════════════════════════════════════
// clearUnread
// ════════════════════════════════════════════════════════════════

describe('clearUnread', () => {
  it('sayacı sıfırlar ve badge\'i kaldırır', () => {
    const { incrementUnread, clearUnread } = loadUnreadModule();
    makeChannelItem('ch-clear-1');

    incrementUnread('ch-clear-1');
    incrementUnread('ch-clear-1');
    expect(getUnreadBadge('ch-clear-1')!.textContent).toBe('2');

    clearUnread('ch-clear-1');

    // Badge DOM'dan kalkmış olmalı
    expect(getUnreadBadge('ch-clear-1')).toBeNull();
  });

  it('clearUnread sonrası incrementUnread yeniden badge oluşturur', () => {
    const { incrementUnread, clearUnread } = loadUnreadModule();
    makeChannelItem('ch-clear-2');

    incrementUnread('ch-clear-2');
    clearUnread('ch-clear-2');
    incrementUnread('ch-clear-2');

    const badge = getUnreadBadge('ch-clear-2');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('1');
  });

  it('sayaç 0 iken clearUnread hata fırlatmaz', () => {
    const { clearUnread } = loadUnreadModule();
    makeChannelItem('ch-clear-empty');

    expect(() => clearUnread('ch-clear-empty')).not.toThrow();
  });

  it('DOM\'da ch-item olmadan clearUnread hata fırlatmaz', () => {
    const { clearUnread } = loadUnreadModule();

    expect(() => clearUnread('ch-no-dom')).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// _renderUnreadBadge (dolaylı — incrementUnread üzerinden)
// ════════════════════════════════════════════════════════════════

describe('_renderUnreadBadge (dolaylı)', () => {
  it('badge span\'ı "ch-unread" class\'ıyla oluşturulur', () => {
    const { incrementUnread } = loadUnreadModule();
    const el = makeChannelItem('ch-badge-cls');

    incrementUnread('ch-badge-cls');

    const badge = el.querySelector('.ch-unread');
    expect(badge).not.toBeNull();
    expect(badge!.tagName).toBe('SPAN');
  });

  it('ikinci increment yeni span oluşturmaz, mevcut güncellenir', () => {
    const { incrementUnread } = loadUnreadModule();
    const el = makeChannelItem('ch-badge-upd');

    incrementUnread('ch-badge-upd');
    incrementUnread('ch-badge-upd');

    const badges = el.querySelectorAll('.ch-unread');
    expect(badges.length).toBe(1);
    expect((badges[0] as HTMLElement).textContent).toBe('2');
  });
});
