// client/tests/badges.test.ts — Sprint 78
// core/badges.ts için unit testler
// Kapsam: renderUserBadges, injectBadgesIntoProfileCard,
//         loadMyBadgesSettings, adminAwardBadge, adminRevokeBadge

'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockApiFetch = jest.fn();
const mockGetAPI   = jest.fn(() => 'http://localhost:3000');
const mockGetMe    = jest.fn(() => null);
const mockEscHtml  = jest.fn((s: string) => s);

jest.mock('../js/core/api-fetch.js',       () => ({ apiFetch: mockApiFetch }), { virtual: true });
jest.mock('../js/core/globals.js',         () => ({ getMe: mockGetMe, getAPI: mockGetAPI }), { virtual: true });
jest.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn() },
}), { virtual: true });
jest.mock('../js/core/utils.js', () => ({ escHtml: mockEscHtml }), { virtual: true });

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function makeOkRes(data: unknown) {
  return { ok: true, json: jest.fn().mockResolvedValue(data) } as unknown as Response;
}
function makeErrRes() {
  return { ok: false, json: jest.fn().mockResolvedValue({ error: 'fail' }) } as unknown as Response;
}

function loadModule() {
  jest.resetModules();
  jest.mock('../js/core/api-fetch.js',       () => ({ apiFetch: mockApiFetch }), { virtual: true });
  jest.mock('../js/core/globals.js',         () => ({ getMe: mockGetMe, getAPI: mockGetAPI }), { virtual: true });
  jest.mock('../js/core/bridge-registry.js', () => ({
    BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn() },
  }), { virtual: true });
  jest.mock('../js/core/utils.js', () => ({ escHtml: mockEscHtml }), { virtual: true });
  return require('../js/core/badges.js');
}

// ── renderUserBadges ──────────────────────────────────────────────────────────

describe('renderUserBadges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEscHtml.mockImplementation((s: string) => s);
    document.body.innerHTML = '<div id="container"></div>';
  });

  test('boş rozet listesinde "henüz rozet yok" mesajı gösterir', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes([]));
    const { renderUserBadges } = loadModule();
    const container = document.getElementById('container') as HTMLElement;
    await renderUserBadges('user1', container);
    expect(container.innerHTML).toContain('Henüz rozet yok');
  });

  test('rozetleri chip olarak render eder', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes([
      { badge: 'contributor', label: 'Katkıcı', icon: '🏅', description: 'Açık kaynak katkısı' },
    ]));
    const { renderUserBadges } = loadModule();
    const container = document.getElementById('container') as HTMLElement;
    await renderUserBadges('user1', container);
    expect(container.innerHTML).toContain('badge-chip');
    expect(container.innerHTML).toContain('Katkıcı');
    expect(container.innerHTML).toContain('🏅');
  });

  test('API hatası durumunda container boşaltılır', async () => {
    mockApiFetch.mockResolvedValue(makeErrRes());
    const { renderUserBadges } = loadModule();
    const container = document.getElementById('container') as HTMLElement;
    container.innerHTML = 'önceki içerik';
    await renderUserBadges('user1', container);
    expect(container.innerHTML).toBe('');
  });

  test('network hatası durumunda container boşaltılır', async () => {
    mockApiFetch.mockRejectedValue(new Error('network error'));
    const { renderUserBadges } = loadModule();
    const container = document.getElementById('container') as HTMLElement;
    await renderUserBadges('user1', container);
    expect(container.innerHTML).toBe('');
  });

  test('container null ise hata fırlatmaz', async () => {
    const { renderUserBadges } = loadModule();
    await expect(renderUserBadges('user1', null as unknown as HTMLElement)).resolves.toBeUndefined();
  });

  test('yükleme sırasında "Yükleniyor" gösterir', async () => {
    let resolveFetch!: (v: Response) => void;
    mockApiFetch.mockReturnValue(new Promise(r => { resolveFetch = r; }));
    const { renderUserBadges } = loadModule();
    const container = document.getElementById('container') as HTMLElement;
    const prom = renderUserBadges('user1', container);
    expect(container.innerHTML).toContain('Yükleniyor');
    resolveFetch(makeOkRes([]));
    await prom;
  });

  test('description yoksa label title olarak kullanılır', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes([
      { badge: 'mod', label: 'Moderatör', icon: '🛡️' },
    ]));
    const { renderUserBadges } = loadModule();
    const container = document.getElementById('container') as HTMLElement;
    await renderUserBadges('user1', container);
    expect(container.innerHTML).toContain('Moderatör');
  });
});

// ── injectBadgesIntoProfileCard ───────────────────────────────────────────────

describe('injectBadgesIntoProfileCard', () => {
  beforeEach(() => jest.clearAllMocks());

  test('profile-badges-row zaten varsa tekrar eklemez', async () => {
    document.body.innerHTML = '<div id="card"><div class="profile-badges-row"></div></div>';
    mockApiFetch.mockResolvedValue(makeOkRes([]));
    const { injectBadgesIntoProfileCard } = loadModule();
    const card = document.getElementById('card') as HTMLElement;
    await injectBadgesIntoProfileCard('user1', card);
    expect(document.querySelectorAll('.profile-badges-row').length).toBe(1);
  });

  test('profile-bio sonrasına rozet satırı ekler', async () => {
    document.body.innerHTML = '<div id="card"><div class="profile-bio">Bio</div></div>';
    mockApiFetch.mockResolvedValue(makeOkRes([]));
    const { injectBadgesIntoProfileCard } = loadModule();
    const card = document.getElementById('card') as HTMLElement;
    await injectBadgesIntoProfileCard('user1', card);
    const row = card.querySelector('.profile-badges-row');
    expect(row).not.toBeNull();
  });

  test('profile-bio yoksa card sonuna ekler', async () => {
    document.body.innerHTML = '<div id="card"><span>içerik</span></div>';
    mockApiFetch.mockResolvedValue(makeOkRes([]));
    const { injectBadgesIntoProfileCard } = loadModule();
    const card = document.getElementById('card') as HTMLElement;
    await injectBadgesIntoProfileCard('user1', card);
    expect(card.lastElementChild?.className).toBe('profile-badges-row');
  });
});

// ── loadMyBadgesSettings ──────────────────────────────────────────────────────

describe('loadMyBadgesSettings', () => {
  beforeEach(() => jest.clearAllMocks());

  test('container yoksa hata fırlatmaz', async () => {
    document.body.innerHTML = '';
    const { loadMyBadgesSettings } = loadModule();
    await expect(loadMyBadgesSettings()).resolves.toBeUndefined();
  });

  test('kullanıcı giriş yapmamışsa apiFetch çağrılmaz', async () => {
    document.body.innerHTML = '<div id="my-badges-container"></div>';
    mockGetMe.mockReturnValue(null);
    const { loadMyBadgesSettings } = loadModule();
    await loadMyBadgesSettings();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  test('giriş yapmış kullanıcı için rozetleri yükler', async () => {
    document.body.innerHTML = '<div id="my-badges-container"></div>';
    mockGetMe.mockReturnValue({ _id: 'user42' });
    mockApiFetch.mockResolvedValue(makeOkRes([]));
    const { loadMyBadgesSettings } = loadModule();
    await loadMyBadgesSettings();
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('user42/badges'),
    );
  });
});

// ── adminAwardBadge ───────────────────────────────────────────────────────────

describe('adminAwardBadge', () => {
  function buildAdminDOM() {
    document.body.innerHTML = `
      <input id="ab-userid" value="user1" />
      <select id="ab-badge"><option value="contributor">Katkıcı</option></select>
      <div id="ab-result"></div>
    `;
  }

  beforeEach(() => { jest.clearAllMocks(); buildAdminDOM(); });

  test('başarılı badge verme sonucunu gösterir', async () => {
    mockApiFetch.mockResolvedValue(makeOkRes({ label: 'Katkıcı' }));
    const { adminAwardBadge } = loadModule();
    buildAdminDOM();
    await adminAwardBadge();
    expect(document.getElementById('ab-result')!.textContent).toContain('Rozet verildi');
  });

  test('başarısız badge verme hata mesajı gösterir', async () => {
    mockApiFetch.mockResolvedValue(makeErrRes());
    const { adminAwardBadge } = loadModule();
    buildAdminDOM();
    await adminAwardBadge();
    expect(document.getElementById('ab-result')!.textContent).toContain('❌');
  });

  test('userId boşsa apiFetch çağrılmaz', async () => {
    const { adminAwardBadge } = loadModule();
    document.body.innerHTML = `
      <input id="ab-userid" value="" />
      <select id="ab-badge"><option value="x">X</option></select>
      <div id="ab-result"></div>
    `;
    await adminAwardBadge();
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(document.getElementById('ab-result')!.textContent).toBeTruthy();
  });
});

// ── adminRevokeBadge ──────────────────────────────────────────────────────────

describe('adminRevokeBadge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = `
      <input id="ab-userid" value="user1" />
      <select id="ab-badge"><option value="contributor">Katkıcı</option></select>
      <div id="ab-result"></div>
    `;
  });

  test('başarılı geri alma sonucunu gösterir', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) } as unknown as Response);
    const { adminRevokeBadge } = loadModule();
    await adminRevokeBadge();
    expect(document.getElementById('ab-result')!.textContent).toContain('✅');
  });

  test('başarısız geri alma hata mesajı gösterir', async () => {
    mockApiFetch.mockResolvedValue(makeErrRes());
    const { adminRevokeBadge } = loadModule();
    await adminRevokeBadge();
    expect(document.getElementById('ab-result')!.textContent).toContain('❌');
  });
});
