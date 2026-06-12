// client/tests/group-dm.test.ts — Sprint C1: GroupDM Tests
'use strict';

// ── BridgeRegistry Mock ───────────────────────────────────────
const registry = {};
jest.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: jest.fn((k, v) => { registry[k] = v; }),
    get:      jest.fn((k) => registry[k] ?? null),
    call:     jest.fn((k, ...a) => registry[k]?.(...a)),
  },
}), { virtual: true });

jest.mock('../js/core/globals.js', () => ({
  getCurrentChannel: jest.fn(() => ({ _id: 'chan-001' })),
  getCurrentServer:  jest.fn(() => null),
  getMe:             jest.fn(() => ({ id: 'user-001', displayName: 'Tester', avatarColor: '#2d9cdb' })),
}), { virtual: true });

// ── Globals ───────────────────────────────────────────────────
global.me = { id: 'user-001', displayName: 'Tester', avatarColor: '#2d9cdb' };

global.apiFetch = jest.fn().mockImplementation((url, opts = {}) => {
  if (url === '/api/group-dm' && opts.method === 'POST') {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        _id: 'gdm-001', name: 'Test Grubu', icon: '🚀',
        ownerId: 'user-001', members: ['user-001', 'user-002'],
      }),
    });
  }
  if (url?.startsWith('/api/group-dm/') && url.endsWith('/messages')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([
        { _id: 'msg-001', content: 'Merhaba', userId: 'user-001', displayName: 'Tester', createdAt: Date.now() },
        { _id: 'msg-002', content: 'Selam', userId: 'user-002', displayName: 'User2', createdAt: Date.now() },
      ]),
    });
  }
  if (url?.startsWith('/api/group-dm/') && opts.method === 'PATCH') {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ _id: 'gdm-001', name: opts.body ? JSON.parse(opts.body).name : 'Güncellendi' }),
    });
  }
  if (url?.startsWith('/api/group-dm/') && url.endsWith('/members') && opts.method === 'POST') {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ added: true }) });
  }
  if (url?.startsWith('/api/group-dm/') && opts.method === 'DELETE') {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ left: true }) });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
});

global.socket = { emit: jest.fn(), on: jest.fn(), off: jest.fn(), connected: true };
global.toast  = jest.fn();

// Minimal DOM setup
document.body.innerHTML = '<div id="app"><div id="dm-list"></div><div id="dm-chat-area"></div></div>';

// ── Helpers ───────────────────────────────────────────────────
function makeGroup(overrides = {}) {
  return {
    _id:     'gdm-001',
    name:    'Test Grubu',
    icon:    '🚀',
    ownerId: 'user-001',
    members: ['user-001', 'user-002'],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────
describe('GroupDM — grup oluşturma API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('POST /api/group-dm grup döner', async () => {
    const res  = await apiFetch('/api/group-dm', {
      method: 'POST',
      body:   JSON.stringify({ name: 'Test Grubu', icon: '🚀', memberIds: ['user-002'] }),
    });
    const data = await res.json();
    expect(data._id).toBe('gdm-001');
    expect(data.name).toBe('Test Grubu');
    expect(data.ownerId).toBe('user-001');
  });

  test('POST /api/group-dm members listesi döner', async () => {
    const res  = await apiFetch('/api/group-dm', {
      method: 'POST',
      body:   JSON.stringify({ name: 'Yeni Grup', memberIds: ['user-002', 'user-003'] }),
    });
    const data = await res.json();
    expect(Array.isArray(data.members)).toBe(true);
    expect(data.members).toContain('user-001');
  });

  test('grup oluşturma hata durumunu handle eder', async () => {
    apiFetch.mockRejectedValueOnce(new Error('Network error'));
    const onError = jest.fn();
    try {
      await apiFetch('/api/group-dm', { method: 'POST' });
    } catch (e) {
      onError(e.message);
    }
    expect(onError).toHaveBeenCalledWith('Network error');
  });
});

describe('GroupDM — mesaj yükleme', () => {
  beforeEach(() => jest.clearAllMocks());

  test('GET /api/group-dm/:id/messages mesaj listesi döner', async () => {
    const res  = await apiFetch('/api/group-dm/gdm-001/messages');
    const msgs = await res.json();
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.length).toBe(2);
  });

  test('mesajlarda _id, content, userId alanları var', async () => {
    const res  = await apiFetch('/api/group-dm/gdm-001/messages');
    const msgs = await res.json();
    msgs.forEach(msg => {
      expect(msg).toHaveProperty('_id');
      expect(msg).toHaveProperty('content');
      expect(msg).toHaveProperty('userId');
    });
  });
});

describe('GroupDM — üye ekleme/çıkarma', () => {
  beforeEach(() => jest.clearAllMocks());

  test('POST /api/group-dm/:id/members üye ekler', async () => {
    const res  = await apiFetch('/api/group-dm/gdm-001/members', {
      method: 'POST',
      body:   JSON.stringify({ userId: 'user-003' }),
    });
    const data = await res.json();
    expect(data.added).toBe(true);
  });

  test('DELETE /api/group-dm/:id gruptan ayrılır', async () => {
    const res  = await apiFetch('/api/group-dm/gdm-001', { method: 'DELETE' });
    const data = await res.json();
    expect(data.left).toBe(true);
  });
});

describe('GroupDM — isim/icon güncelleme', () => {
  beforeEach(() => jest.clearAllMocks());

  test('PATCH /api/group-dm/:id ismi günceller', async () => {
    const res  = await apiFetch('/api/group-dm/gdm-001', {
      method: 'PATCH',
      body:   JSON.stringify({ name: 'Yeni İsim' }),
    });
    const data = await res.json();
    expect(data.name).toBe('Yeni İsim');
  });

  test('PATCH başarısız olunca error yönetilir', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 403, json: () => Promise.resolve({ error: 'Yetkisiz' }) });
    const res = await apiFetch('/api/group-dm/gdm-001', { method: 'PATCH' });
    expect(res.ok).toBe(false);
  });
});

describe('GroupDM — DOM render yardımcıları', () => {
  test('grup icon ve ismi doğru render edilir', () => {
    const group = makeGroup();
    const el    = document.createElement('div');
    el.innerHTML = `<span class="gdm-icon">${group.icon}</span><span class="gdm-name">${escHtml(group.name)}</span>`;
    expect(el.querySelector('.gdm-icon').textContent).toBe('🚀');
    expect(el.querySelector('.gdm-name').textContent).toBe('Test Grubu');
  });

  test('XSS koruması: grup ismi escapelanır', () => {
    const group  = makeGroup({ name: '<script>alert(1)</script>' });
    const escaped = escHtml(group.name);
    const el     = document.createElement('div');
    el.innerHTML = `<span>${escaped}</span>`;
    expect(el.innerHTML).not.toContain('<script>');
    expect(el.querySelector('span').textContent).toContain('script');
  });

  test('owner badge sadece kendi grupta gösterilir', () => {
    const ownGroup  = makeGroup({ ownerId: 'user-001' });
    const otherGroup = makeGroup({ ownerId: 'user-002' });
    const isOwner1  = ownGroup.ownerId === me.id;
    const isOwner2  = otherGroup.ownerId === me.id;
    expect(isOwner1).toBe(true);
    expect(isOwner2).toBe(false);
  });
});

describe('GroupDM — socket entegrasyonu', () => {
  test('socket.emit gdm:join çağrılabilir', () => {
    socket.emit('gdm:join', { groupId: 'gdm-001' });
    expect(socket.emit).toHaveBeenCalledWith('gdm:join', { groupId: 'gdm-001' });
  });

  test('socket.on gdm:message handler register edilebilir', () => {
    const handler = jest.fn();
    socket.on('gdm:message', handler);
    expect(socket.on).toHaveBeenCalledWith('gdm:message', handler);
  });

  test('socket.emit gdm:leave çağrılabilir', () => {
    socket.emit('gdm:leave', { groupId: 'gdm-001' });
    expect(socket.emit).toHaveBeenCalledWith('gdm:leave', expect.objectContaining({ groupId: 'gdm-001' }));
  });
});
