// client/tests/scheduled-ui.test.ts — Sprint 52
// scheduled-ui.ts için unit testler
// Kapsam: modal oluşturma/kapatma, form validasyonu, pending list, cancel

'use strict';

// ── API mock ──────────────────────────────────────────────────────────────────

const mockApi = {
  get:    jest.fn(),
  post:   jest.fn(),
  delete: jest.fn(),
};

const mockRegistry = {
  register: jest.fn(),
  get:      jest.fn((key) => {
    if (key === 'BridgeAPI' || key === 'api') return mockApi;
    return null;
  }),
  call:     jest.fn(),
  has:      jest.fn(() => false),
};

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: mockRegistry,
}), { virtual: true });

jest.mock('../js/core/utils', () => ({
  escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}), { virtual: true });

// ── Helpers ────────────────────────────────────────────────────────────────────

const sampleMessages = [
  { _id: 'm1', content: 'Merhaba!', sendAt: Date.now() + 60_000 },
  { _id: 'm2', content: 'Toplantı hatırlatma', sendAt: Date.now() + 3_600_000 },
];

function loadAndGetUI() {
  jest.resetModules();
  require('../js/core/scheduled-ui');
  // ScheduledUI kaydedilmiş olmalı
  const calls = mockRegistry.register.mock.calls;
  const uiCall = calls.find(c => c[0] === 'ScheduledUI');
  return uiCall?.[1] ?? null;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Modül yükleme', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockRegistry.register.mockClear();
  });

  test('BridgeRegistry.register çağırır ScheduledUI ile', () => {
    loadAndGetUI();
    const keys = mockRegistry.register.mock.calls.map(c => c[0]);
    expect(keys).toContain('ScheduledUI');
  });

  test('register edilen ScheduledUI open ve close metodlarına sahip', () => {
    const ui = loadAndGetUI();
    expect(typeof ui?.open).toBe('function');
    expect(typeof ui?.close).toBe('function');
  });
});

describe('openModal() — modal oluşturma', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockRegistry.register.mockClear();
    mockApi.get.mockResolvedValue([]);
  });

  test('modal DOM\'a eklenir', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    expect(document.getElementById('schedule-modal')).not.toBeNull();
  });

  test('modal başlığı "Zamanlı Mesaj" içerir', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    expect(document.body.innerHTML).toContain('Zamanlı Mesaj');
  });

  test('modal hidden class\'ı kaldırır', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    expect(document.getElementById('schedule-modal').classList.contains('hidden')).toBe(false);
  });

  test('iki kez açılınca iki modal oluşturmaz', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    await ui.open('ch1', 'srv1');
    expect(document.querySelectorAll('#schedule-modal').length).toBe(1);
  });
});

describe('closeModal()', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockApi.get.mockResolvedValue([]);
  });

  test('modal hidden class ekler', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    ui.close();
    expect(document.getElementById('schedule-modal').classList.contains('hidden')).toBe(true);
  });

  test('modal yokken hata vermez', () => {
    const ui = loadAndGetUI();
    expect(() => ui.close()).not.toThrow();
  });

  test('kapatma butonu tıklanınca kapanır', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    document.getElementById('schedule-close').click();
    expect(document.getElementById('schedule-modal').classList.contains('hidden')).toBe(true);
  });
});

describe('loadPending() — bekleyen mesajlar', () => {
  beforeEach(() => document.body.innerHTML = '');

  test('mesajlar varsa liste render edilir', async () => {
    mockApi.get.mockResolvedValue(sampleMessages);
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    await new Promise(r => setTimeout(r, 0));
    expect(document.querySelectorAll('.scheduled-item').length).toBe(2);
  });

  test('mesaj içeriği escHtml ile render edilir', async () => {
    mockApi.get.mockResolvedValue([
      { _id: 'm1', content: '<b>XSS</b>', sendAt: Date.now() + 60_000 },
    ]);
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    await new Promise(r => setTimeout(r, 0));
    const list = document.getElementById('scheduled-list');
    expect(list.innerHTML).not.toContain('<b>XSS</b>');
    expect(list.innerHTML).toContain('&lt;b&gt;XSS');
  });

  test('mesaj yoksa boş durum gösterilir', async () => {
    mockApi.get.mockResolvedValue([]);
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    await new Promise(r => setTimeout(r, 0));
    expect(document.getElementById('scheduled-list').innerHTML).toContain('Bekleyen mesaj yok');
  });

  test('API hatası olunca yüklenemedi mesajı gösterilir', async () => {
    mockApi.get.mockRejectedValue(new Error('Ağ hatası'));
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    await new Promise(r => setTimeout(r, 0));
    expect(document.getElementById('scheduled-list').innerHTML).toContain('Yüklenemedi');
  });
});

describe('submitScheduled() — form validasyonu', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue(undefined);
  });

  test('içerik boşken hata mesajı gösterir', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    document.getElementById('schedule-content').value = '';
    document.getElementById('schedule-submit').click();
    expect(document.getElementById('schedule-error').textContent).toContain('boş');
  });

  test('zaman seçilmemişken hata mesajı gösterir', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    document.getElementById('schedule-content').value = 'test';
    document.getElementById('schedule-at').value = '';
    document.getElementById('schedule-submit').click();
    expect(document.getElementById('schedule-error').textContent).toContain('zaman');
  });

  test('geçmiş tarih seçilince hata mesajı gösterir', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    document.getElementById('schedule-content').value = 'test';
    document.getElementById('schedule-at').value = '2020-01-01T10:00';
    document.getElementById('schedule-submit').click();
    expect(document.getElementById('schedule-error').textContent).toContain('Gelecekte');
  });

  test('geçerli form ile api.post çağırır', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    document.getElementById('schedule-content').value = 'Toplantı';
    const futureDate = new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 16);
    document.getElementById('schedule-at').value = futureDate;
    document.getElementById('schedule-submit').click();
    await new Promise(r => setTimeout(r, 0));
    expect(mockApi.post).toHaveBeenCalledWith('/api/scheduled', expect.objectContaining({ content: 'Toplantı' }));
  });
});

describe('cancelScheduled()', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockApi.get.mockResolvedValue(sampleMessages);
    mockApi.delete.mockResolvedValue(undefined);
  });

  test('iptal butonuna tıklanınca api.delete çağırır', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    await new Promise(r => setTimeout(r, 0));
    const cancelBtn = document.querySelector('.btn-cancel-scheduled');
    cancelBtn?.click();
    await new Promise(r => setTimeout(r, 0));
    expect(mockApi.delete).toHaveBeenCalledWith(expect.stringContaining('/api/scheduled/'));
  });

  test('iptal edilen item DOM\'dan kaldırılır', async () => {
    const ui = loadAndGetUI();
    await ui.open('ch1', 'srv1');
    await new Promise(r => setTimeout(r, 0));
    const cancelBtn = document.querySelector('[data-id="m1"].btn-cancel-scheduled');
    cancelBtn?.click();
    await new Promise(r => setTimeout(r, 0));
    expect(document.querySelector('.scheduled-item[data-id="m1"]')).toBeNull();
  });
});
