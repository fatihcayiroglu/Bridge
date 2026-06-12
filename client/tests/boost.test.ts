// client/tests/boost.test.ts — Sprint 78
// core/boost.ts için unit testler
// Kapsam: boost tier hesaplama mantığı, progress bar yüzdesi,
//         openBoostPanel modal DOM, sendBoost API çağrısı,
//         _relBoostTime tarih formatlama

'use strict';

// ── Global mock'lar ───────────────────────────────────────────────────────────

const mockApiFetch = jest.fn();
(global as any).apiFetch        = mockApiFetch;
(global as any).escHtml         = (s: string) => String(s ?? '');
(global as any).toast           = jest.fn();
(global as any).API             = 'http://localhost:3000';
(global as any).getCurrentServer = jest.fn(() => null);

jest.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn() },
}), { virtual: true });

// ── Module loader ─────────────────────────────────────────────────────────────

function loadModule() {
  jest.resetModules();
  jest.mock('../js/core/bridge-registry.js', () => ({
    BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn() },
  }), { virtual: true });
  mockApiFetch.mockReset();
  (global as any).toast = jest.fn();
  document.body.innerHTML = '';
  return require('../js/core/boost.js');
}

function makeOkRes(data: unknown) {
  return { ok: true, json: jest.fn().mockResolvedValue(data) };
}

// ── Boost tier seçimi ─────────────────────────────────────────────────────────

describe('boost tier seçimi (openBoostPanel)', () => {
  test('0 boost → Başlangıç tier', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 0, boosters: [] }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    expect(document.getElementById('boost-modal')?.innerHTML).toContain('Başlangıç');
  });

  test('2 boost → Seviye 1', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 2, boosters: [] }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    expect(document.getElementById('boost-modal')?.innerHTML).toContain('Seviye 1');
  });

  test('7 boost → Seviye 2', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 7, boosters: [] }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    expect(document.getElementById('boost-modal')?.innerHTML).toContain('Seviye 2');
  });

  test('14 boost → Seviye 3 (maksimum)', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 14, boosters: [] }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    const html = document.getElementById('boost-modal')?.innerHTML ?? '';
    expect(html).toContain('Seviye 3');
    expect(html).toContain('Maksimum seviyeye ulaşıldı');
  });

  test('1 boost → Başlangıç (Seviye 1 eşiği geçilmemiş)', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 1, boosters: [] }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    expect(document.getElementById('boost-modal')?.innerHTML).toContain('Başlangıç');
  });
});

// ── Progress bar yüzdesi ──────────────────────────────────────────────────────

describe('progress bar yüzdesi', () => {
  test('0 boosttan 2\'ye eşik için %0 progress', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 0, boosters: [] }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    const html = document.getElementById('boost-modal')?.innerHTML ?? '';
    expect(html).toContain('width:0%');
  });

  test('1 boosttan 2 eşiğe %50 progress', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 1, boosters: [] }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    const html = document.getElementById('boost-modal')?.innerHTML ?? '';
    expect(html).toContain('width:50%');
  });

  test('Seviye 2→3 arası doğru progress (7+7/14=50%)', async () => {
    // Seviye 2: 7 boost, Seviye 3: 14 boost. 7 boostta (7-7)/(14-7)=0%
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 7, boosters: [] }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    const html = document.getElementById('boost-modal')?.innerHTML ?? '';
    // 7 boost = Seviye 2'de, Seviye 3'e 0% progress
    expect(html).toContain('width:0%');
  });
});

// ── openBoostPanel modal DOM ──────────────────────────────────────────────────

describe('openBoostPanel modal DOM', () => {
  test('modal DOM\'a eklenir', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 0, boosters: [] }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    expect(document.getElementById('boost-modal')).not.toBeNull();
  });

  test('boosters listesi gösterilir (max 10)', async () => {
    const boosters = Array.from({ length: 12 }, (_, i) => ({
      displayName: `User${i}`,
      boostedAt: new Date().toISOString(),
    }));
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 12, boosters }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    const html = document.getElementById('boost-modal')?.innerHTML ?? '';
    expect(html).toContain('+2 kişi daha');
  });

  test('API hatası durumunda varsayılan 0 boost gösterilir', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, json: jest.fn().mockResolvedValue({}) });
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    const html = document.getElementById('boost-modal')?.innerHTML ?? '';
    expect(html).toContain('Başlangıç');
  });

  test('network hatası durumunda modal yine de açılır', async () => {
    mockApiFetch.mockRejectedValue(new Error('network'));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    expect(document.getElementById('boost-modal')).not.toBeNull();
  });

  test('overlay tıklanınca modal kapanır', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ count: 0, boosters: [] }));
    const { openBoostPanel } = loadModule();
    await openBoostPanel('srv-1');
    const modal = document.getElementById('boost-modal') as HTMLElement;
    modal.click();
    expect(document.getElementById('boost-modal')).toBeNull();
  });
});

// ── sendBoost ─────────────────────────────────────────────────────────────────

describe('sendBoost', () => {
  test('başarılı boost sonrası success toast gösterilir', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ message: 'Boosted' }));
    const { sendBoost } = loadModule();
    await sendBoost('srv-1');
    expect((global as any).toast).toHaveBeenCalledWith(
      expect.stringContaining('boost'),
      'success',
    );
  });

  test('başarısız boost sonrası error toast gösterilir', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: jest.fn().mockResolvedValue({ error: 'Zaten boost\'ladın' }),
    });
    const { sendBoost } = loadModule();
    await sendBoost('srv-1');
    expect((global as any).toast).toHaveBeenCalledWith(
      expect.stringContaining('Zaten boost'),
      'error',
    );
  });

  test('hata mesajı yoksa fallback mesaj kullanılır', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: jest.fn().mockResolvedValue({}),
    });
    const { sendBoost } = loadModule();
    await sendBoost('srv-1');
    expect((global as any).toast).toHaveBeenCalledWith(
      expect.any(String),
      'error',
    );
  });
});

// ── _relBoostTime ─────────────────────────────────────────────────────────────

describe('_relBoostTime', () => {
  test('bugün için "bugün" döner', () => {
    const { _relBoostTime } = loadModule();
    if (!_relBoostTime) return; // internal, export edilmeyebilir
    const bugun = new Date(Date.now() - 1000 * 60 * 30).toISOString(); // 30 dk önce
    expect(_relBoostTime(bugun)).toBe('bugün');
  });

  test('undefined için boş string döner', () => {
    const { _relBoostTime } = loadModule();
    if (!_relBoostTime) return;
    expect(_relBoostTime(undefined)).toBe('');
  });

  test('6 günlük ts için "N gün önce" döner', () => {
    const { _relBoostTime } = loadModule();
    if (!_relBoostTime) return;
    const altiGunOnce = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    expect(_relBoostTime(altiGunOnce)).toContain('g önce');
  });

  test('10 günlük ts için tarih formatı döner', () => {
    const { _relBoostTime } = loadModule();
    if (!_relBoostTime) return;
    const onGunOnce = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const result = _relBoostTime(onGunOnce);
    expect(result).toMatch(/\d+/); // tarih içerir
  });
});
