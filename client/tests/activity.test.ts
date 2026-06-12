// client/tests/activity.test.ts — Sprint 78
// core/activity.ts için unit testler
// Kapsam: formatActivity, renderActivityBadge, handleUserActivity DOM,
//         openActivityModal toggle, updateActivityDisplay

'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetMe = jest.fn(() => null);

jest.mock('../js/core/globals.js', () => ({
  getMe: mockGetMe,
}), { virtual: true });

// escHtml global olarak tanımlanmış (window üzerinde)
(global as any).escHtml = (s: string) => s;
(global as any).toast   = jest.fn();

// ── Module loader ─────────────────────────────────────────────────────────────

function loadModule() {
  jest.resetModules();
  jest.mock('../js/core/globals.js', () => ({ getMe: mockGetMe }), { virtual: true });
  (global as any).escHtml = (s: string) => s;
  (global as any).toast   = jest.fn();
  return require('../js/core/activity.js');
}

// ── formatActivity ────────────────────────────────────────────────────────────

describe('formatActivity', () => {
  test('null aktivite için null döner', () => {
    const { formatActivity } = loadModule();
    expect(formatActivity(null)).toBeNull();
  });

  test('undefined aktivite için null döner', () => {
    const { formatActivity } = loadModule();
    expect(formatActivity(undefined)).toBeNull();
  });

  test('bilinen tip için doğru label döner', () => {
    const { formatActivity } = loadModule();
    const result = formatActivity({ type: 'playing', name: 'Minecraft' });
    expect(result).not.toBeNull();
    expect(result.label).toBe('Oynuyor');
    expect(result.name).toBe('Minecraft');
  });

  test('displayText name varken "Label: Name" formatında', () => {
    const { formatActivity } = loadModule();
    const result = formatActivity({ type: 'listening', name: 'Spotify' });
    expect(result.displayText).toBe('Dinliyor: Spotify');
  });

  test('displayText name yokken sadece label', () => {
    const { formatActivity } = loadModule();
    const result = formatActivity({ type: 'watching', name: '' });
    expect(result.displayText).toBe('İzliyor');
  });

  test('fullText detail varken "Name — Detail" formatında', () => {
    const { formatActivity } = loadModule();
    const result = formatActivity({ type: 'playing', name: 'CS2', detail: 'Competitive' });
    expect(result.fullText).toBe('CS2 — Competitive');
  });

  test('fullText detail yokken sadece name', () => {
    const { formatActivity } = loadModule();
    const result = formatActivity({ type: 'playing', name: 'Chess', detail: '' });
    expect(result.fullText).toBe('Chess');
  });

  test('bilinmeyen type için custom icon kullanılır', () => {
    const { formatActivity } = loadModule();
    const result = formatActivity({ type: 'bilinmeyen', name: 'Bir şey' });
    expect(result).not.toBeNull();
    expect(result.label).toBe('bilinmeyen');
  });

  test('coding ve reading tipleri tanınır', () => {
    const { formatActivity } = loadModule();
    expect(formatActivity({ type: 'coding', name: 'TypeScript' }).label).toBe('Kod yazıyor');
    expect(formatActivity({ type: 'reading', name: 'Kitap' }).label).toBe('Okuyor');
  });
});

// ── renderActivityBadge ───────────────────────────────────────────────────────

describe('renderActivityBadge', () => {
  test('null için boş string döner', () => {
    const { renderActivityBadge } = loadModule();
    expect(renderActivityBadge(null)).toBe('');
  });

  test('aktivite varken activity-badge span üretir', () => {
    const { renderActivityBadge } = loadModule();
    const html = renderActivityBadge({ type: 'playing', name: 'Minecraft' });
    expect(html).toContain('activity-badge');
    expect(html).toContain('activity-name');
  });

  test('name 40 karakterle kısaltılır', () => {
    const { renderActivityBadge } = loadModule();
    const uzunIsim = 'A'.repeat(50);
    const html = renderActivityBadge({ type: 'playing', name: uzunIsim });
    // displayText slice(0,40) uygulanır
    expect(html).toContain('A'.repeat(40));
    expect(html).not.toContain('A'.repeat(50));
  });
});

// ── openActivityModal toggle ──────────────────────────────────────────────────

describe('openActivityModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';
    mockGetMe.mockReturnValue(null);
  });

  test('modal DOM\'a eklenir', () => {
    const { openActivityModal } = loadModule();
    openActivityModal();
    expect(document.getElementById('activity-modal')).not.toBeNull();
  });

  test('zaten açıkken tekrar çağırınca kapanır (toggle)', () => {
    const { openActivityModal } = loadModule();
    openActivityModal();
    expect(document.getElementById('activity-modal')).not.toBeNull();
    openActivityModal();
    expect(document.getElementById('activity-modal')).toBeNull();
  });

  test('mevcut aktivite varken modal gösterir', () => {
    mockGetMe.mockReturnValue({ activity: { type: 'playing', name: 'Chess', detail: '' } });
    const { openActivityModal } = loadModule();
    openActivityModal();
    const modal = document.getElementById('activity-modal');
    expect(modal).not.toBeNull();
    expect(modal!.innerHTML).toContain('Temizle');
  });

  test('overlay tıklanınca modal kapanır', () => {
    const { openActivityModal } = loadModule();
    openActivityModal();
    const modal = document.getElementById('activity-modal') as HTMLElement;
    modal.click();
    expect(document.getElementById('activity-modal')).toBeNull();
  });
});

// ── handleUserActivity DOM güncellemesi ───────────────────────────────────────

describe('handleUserActivity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';
  });

  test('üye listesindeki satırı aktivite badge\'i ile günceller', () => {
    document.body.innerHTML = `
      <div class="member-row" data-uid="user42">
        <span class="member-name">Kullanıcı</span>
      </div>
    `;
    const { handleUserActivity } = loadModule();
    handleUserActivity({ userId: 'user42', activity: { type: 'playing', name: 'Dota 2', detail: '' } });
    const row = document.querySelector('.member-row[data-uid="user42"]') as HTMLElement;
    expect(row.querySelector('.activity-badge')).not.toBeNull();
  });

  test('aktivite null gelince badge kaldırılır', () => {
    document.body.innerHTML = `
      <div class="member-row" data-uid="user42">
        <span class="member-name">Kullanıcı</span>
        <span class="activity-badge">eski aktivite</span>
      </div>
    `;
    const { handleUserActivity } = loadModule();
    handleUserActivity({ userId: 'user42', activity: null });
    const row = document.querySelector('.member-row[data-uid="user42"]') as HTMLElement;
    expect(row.querySelector('.activity-badge')).toBeNull();
  });

  test('üye DOM\'da yoksa hata fırlatmaz', () => {
    const { handleUserActivity } = loadModule();
    expect(() => handleUserActivity({ userId: 'yok', activity: { type: 'playing', name: 'X', detail: '' } })).not.toThrow();
  });

  test('birden fazla üye satırı güncellenir', () => {
    document.body.innerHTML = `
      <div class="member-row" data-uid="user1"><span class="member-name">A</span></div>
      <div class="member-row" data-uid="user1"><span class="member-name">A</span></div>
    `;
    const { handleUserActivity } = loadModule();
    handleUserActivity({ userId: 'user1', activity: { type: 'coding', name: 'VS Code', detail: '' } });
    const badges = document.querySelectorAll('.activity-badge');
    expect(badges.length).toBe(2);
  });
});

// ── updateActivityDisplay ─────────────────────────────────────────────────────

describe('updateActivityDisplay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '<div id="my-activity-badge" style="display:none"></div>';
  });

  test('aktivite varken badge görünür ve HTML doldurulur', () => {
    mockGetMe.mockReturnValue({ activity: { type: 'listening', name: 'Spotify', detail: '' } });
    const { updateActivityDisplay } = loadModule();
    updateActivityDisplay();
    const badge = document.getElementById('my-activity-badge') as HTMLElement;
    expect(badge.style.display).not.toBe('none');
    expect(badge.innerHTML).not.toBe('');
  });

  test('aktivite yokken badge gizlenir', () => {
    mockGetMe.mockReturnValue({ activity: null });
    const { updateActivityDisplay } = loadModule();
    const badge = document.getElementById('my-activity-badge') as HTMLElement;
    badge.innerHTML = 'eski içerik';
    badge.style.display = 'flex';
    updateActivityDisplay();
    expect(badge.style.display).toBe('none');
    expect(badge.innerHTML).toBe('');
  });

  test('badge DOM elementi yoksa hata fırlatmaz', () => {
    document.body.innerHTML = '';
    mockGetMe.mockReturnValue({ activity: { type: 'playing', name: 'X', detail: '' } });
    const { updateActivityDisplay } = loadModule();
    expect(() => updateActivityDisplay()).not.toThrow();
  });
});
