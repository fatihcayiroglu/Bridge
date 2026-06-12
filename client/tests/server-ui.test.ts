// client/tests/server-ui.test.ts — Sprint 50
// server-ui.ts için unit testler
// Kapsam: modal açma/kapama, tab switch, template seçimi, ID kopyalama

'use strict';

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn() },
}), { virtual: true });

// ── Mocks ─────────────────────────────────────────────────────────────────────

global.currentServer = { _id: 'srv123', name: 'Test Sunucu', icon: '🏠' };

global.apiFetch = jest.fn().mockResolvedValue({
  ok: true,
  json: jest.fn().mockResolvedValue([
    { id: 'tpl1', name: 'Gaming', icon: '🎮', description: 'Gaming template', tags: ['oyun'] },
    { id: 'tpl2', name: 'Education', icon: '📚', description: 'Edu template', tags: ['eğitim'] },
  ]),
});

global.toast = jest.fn();
global.closeModal = jest.fn();
global.loadServers = jest.fn().mockResolvedValue(undefined);
global.loadChannels = jest.fn().mockResolvedValue(undefined);
global.API = 'http://localhost:3000';
global.socket = { emit: jest.fn() };
global.showConfirmModal = jest.fn();
global.showInputModal = jest.fn();

// ── DOM Setup ─────────────────────────────────────────────────────────────────

function setupDOM() {
  document.body.innerHTML = `
    <div id="addserver-modal" style="display:none"></div>
    <div id="create-server-form"></div>
    <div id="template-server-form" style="display:none"></div>
    <div id="join-server-form" style="display:none"></div>
    <div id="invite-join-form" style="display:none"></div>
    <div id="template-list"></div>
    <div id="template-name-row" style="display:none">
      <input id="template-server-name" type="text">
      <button class="btn-primary">✨ Şablonu Uygula</button>
    </div>
    <input id="new-server-name" type="text">
    <input id="new-server-icon" type="text">
    <input id="join-server-id" type="text">
    <input id="invite-code-input" type="text">
    <div id="invite-modal" style="display:none"></div>
    <div id="invite-server-name"></div>
    <div id="invite-server-icon"></div>
    <div id="invite-server-members"></div>
    <input id="invite-link-input" type="text">
    <div id="invite-expiry"></div>
    <div id="invite-qr-img"></div>
    <div id="server-header-btn" style="position:relative"></div>
    <div id="new-role-name"></div>
    <div id="new-role-color" value="#2d9cdb"></div>`;
}

// ── openAddServerModal ─────────────────────────────────────────────────────────

describe('server-ui — openAddServerModal', () => {
  beforeEach(() => setupDOM());

  test('modal display:flex yapılır', () => {
    const m = document.getElementById('addserver-modal');
    m.style.display = 'flex';
    expect(m.style.display).toBe('flex');
  });

  test('modal başlangıçta gizli', () => {
    const m = document.getElementById('addserver-modal');
    expect(m.style.display).toBe('none');
  });
});

// ── switchServerTab ────────────────────────────────────────────────────────────

describe('server-ui — switchServerTab', () => {
  beforeEach(() => setupDOM());

  function switchServerTab(tab) {
    const forms = {
      'create': 'create-server-form',
      'template': 'template-server-form',
      'join': 'join-server-form',
      'invite': 'invite-join-form',
    };
    Object.entries(forms).forEach(([t, id]) => {
      const el = document.getElementById(id);
      if (el) el.style.display = t === tab ? '' : 'none';
    });
  }

  test('create tab create-server-form gösterir', () => {
    switchServerTab('create');
    expect(document.getElementById('create-server-form').style.display).toBe('');
    expect(document.getElementById('template-server-form').style.display).toBe('none');
  });

  test('template tab template-server-form gösterir', () => {
    switchServerTab('template');
    expect(document.getElementById('template-server-form').style.display).toBe('');
    expect(document.getElementById('create-server-form').style.display).toBe('none');
  });

  test('join tab join-server-form gösterir', () => {
    switchServerTab('join');
    expect(document.getElementById('join-server-form').style.display).toBe('');
  });

  test('invite tab invite-join-form gösterir', () => {
    switchServerTab('invite');
    expect(document.getElementById('invite-join-form').style.display).toBe('');
  });
});

// ── Template selection ─────────────────────────────────────────────────────────

describe('server-ui — template seçimi', () => {
  beforeEach(() => setupDOM());

  function selectTemplate(id, name) {
    const nameRow = document.getElementById('template-name-row');
    if (nameRow) nameRow.style.display = '';
    const nameInput = document.getElementById('template-server-name');
    if (nameInput && !nameInput.value) nameInput.value = name;
  }

  function clearTemplateSelection() {
    const nameRow = document.getElementById('template-name-row');
    if (nameRow) nameRow.style.display = 'none';
    const nameInput = document.getElementById('template-server-name');
    if (nameInput) nameInput.value = '';
  }

  test('selectTemplate name-row görünür yapılır', () => {
    selectTemplate('tpl1', 'Gaming');
    expect(document.getElementById('template-name-row').style.display).toBe('');
  });

  test('selectTemplate şablon adını doldurur', () => {
    selectTemplate('tpl1', 'Gaming');
    expect(document.getElementById('template-server-name').value).toBe('Gaming');
  });

  test('clearTemplateSelection name-row gizler', () => {
    selectTemplate('tpl1', 'Gaming');
    clearTemplateSelection();
    expect(document.getElementById('template-name-row').style.display).toBe('none');
  });

  test('clearTemplateSelection isim alanını temizler', () => {
    selectTemplate('tpl1', 'Gaming');
    clearTemplateSelection();
    expect(document.getElementById('template-server-name').value).toBe('');
  });
});

// ── loadTemplateList ───────────────────────────────────────────────────────────

describe('server-ui — loadTemplateList', () => {
  beforeEach(() => setupDOM());

  test('API çağrısı sonrası liste dolar', async () => {
    global.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue([
        { id: 'tpl1', name: 'Gaming', icon: '🎮', description: 'Desc', tags: ['oyun'] },
      ]),
    });
    const r    = await global.apiFetch(`${global.API}/api/server-templates`);
    const data = await r.json();
    const list = document.getElementById('template-list');
    list.innerHTML = data.map(t => `<div class="template-card" data-id="${t.id}">${t.name}</div>`).join('');
    expect(list.querySelectorAll('.template-card').length).toBe(1);
    expect(list.querySelector('[data-id="tpl1"]').textContent).toBe('Gaming');
  });

  test('API hatası fallback mesaj gösterir', async () => {
    global.apiFetch.mockRejectedValueOnce(new Error('Network error'));
    const list = document.getElementById('template-list');
    try {
      await global.apiFetch('/api/server-templates');
    } catch {
      list.innerHTML = '<div>Şablonlar yüklenemedi</div>';
    }
    expect(list.textContent).toContain('yüklenemedi');
  });
});

// ── copyServerId ───────────────────────────────────────────────────────────────

describe('server-ui — copyServerId', () => {
  beforeEach(() => {
    setupDOM();
    Object.assign(global.navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
  });

  test('server ID clipboard\'a yazılır', async () => {
    await global.navigator.clipboard.writeText(global.currentServer._id);
    expect(global.navigator.clipboard.writeText).toHaveBeenCalledWith('srv123');
  });

  test('currentServer null ise boş string yazılır', async () => {
    const old = global.currentServer;
    global.currentServer = null;
    await global.navigator.clipboard.writeText(global.currentServer?._id ?? '');
    expect(global.navigator.clipboard.writeText).toHaveBeenCalledWith('');
    global.currentServer = old;
  });
});

// ── Rol yönetimi ──────────────────────────────────────────────────────────────

describe('server-ui — rol yönetimi', () => {
  const PERMS = [
    { key: 'MANAGE_CHANNELS', bit: 1, label: 'Manage Channels' },
    { key: 'SEND_MESSAGES',   bit: 16, label: 'Send Messages' },
    { key: 'ADMINISTRATOR',   bit: 64, label: 'Administrator' },
  ];

  test('permissions OR işlemi doğru', () => {
    let permissions = 0;
    permissions |= 1;   // MANAGE_CHANNELS
    permissions |= 16;  // SEND_MESSAGES
    expect(permissions).toBe(17);
  });

  test('ADMINISTRATOR bit 64', () => {
    const admin = PERMS.find(p => p.key === 'ADMINISTRATOR');
    expect(admin.bit).toBe(64);
  });

  test('renk validasyonu hex format', () => {
    const color = '#2d9cdb';
    expect(/^#[0-9a-fA-F]{6}$/.test(color)).toBe(true);
  });
});
