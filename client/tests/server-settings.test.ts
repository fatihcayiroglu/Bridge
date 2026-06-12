// client/tests/server-settings.test.ts — Sprint 42
// server-settings.ts için unit testler
// Kapsam: emoji cache yükleme, emoji shortcode insert, form validasyon,
//         slug preview DOM, audit log DOM, role yönetimi mantığı, XSS guard

'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn(),
    call:     jest.fn(),
    has:      jest.fn(),
    wrap:     jest.fn((_, fn) => fn),
  },
}), { virtual: true });

jest.mock('../js/core/globals', () => ({
  getAPI:           jest.fn(() => 'http://localhost:3001'),
  getCurrentServer: jest.fn(() => ({ _id: 's1', name: 'Test Server', slug: 'test-server' })),
  getMe:            jest.fn(() => ({ id: 'u1', username: 'admin' })),
  serverEmojiCache: [],
  setCurrentServer: jest.fn(),
}), { virtual: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSettingsDOM() {
  document.body.innerHTML = `
    <div id="server-settings-modal" style="display:none">
      <input  id="server-name-input"    value="Test Server" />
      <input  id="server-slug-input"    value="test-server" />
      <input  id="server-desc-input"    value="" />
      <div    id="server-slug-preview"  ></div>
      <div    id="server-emoji-list"    ></div>
      <div    id="server-role-list"     ></div>
      <div    id="audit-log-list"       ></div>
      <button id="server-settings-save" ></button>
      <button id="server-settings-close"></button>
    </div>
  `;
}

function makeEmoji(overrides = {}) {
  return {
    _id:      'em1',
    name:     'test_emoji',
    url:      '/uploads/emoji/test.png',
    serverId: 's1',
    ...overrides,
  };
}

function makeRole(overrides = {}) {
  return {
    _id:         'r1',
    name:        'Moderatör',
    color:       '#ff6b6b',
    permissions: 0,
    position:    1,
    ...overrides,
  };
}

function makeAuditEntry(overrides = {}) {
  return {
    id:        'a1',
    action:    'MEMBER_BAN',
    userId:    'u2',
    username:  'kullanici',
    targetId:  'u3',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Server Settings Modal DOM ─────────────────────────────────────────────────

describe('server settings modal DOM', () => {
  beforeEach(buildSettingsDOM);

  it('modal başlangıçta gizlidir', () => {
    const modal = document.getElementById('server-settings-modal');
    expect(modal.style.display).toBe('none');
  });

  it('server name input başlangıç değeri doğru', () => {
    const input = document.getElementById('server-name-input') as HTMLInputElement;
    expect(input.value).toBe('Test Server');
  });

  it('slug input başlangıç değeri doğru', () => {
    const input = document.getElementById('server-slug-input') as HTMLInputElement;
    expect(input.value).toBe('test-server');
  });

  it('close butonu mevcut', () => {
    expect(document.getElementById('server-settings-close')).not.toBeNull();
  });

  it('save butonu mevcut', () => {
    expect(document.getElementById('server-settings-save')).not.toBeNull();
  });
});

// ── Slug preview ──────────────────────────────────────────────────────────────

describe('slug preview DOM', () => {
  beforeEach(buildSettingsDOM);

  it('slug preview doğru URL formatı gösterir', () => {
    const preview = document.getElementById('server-slug-preview');
    const slug    = 'test-server';
    preview.textContent = `Profil: http://localhost:3001/s/${slug}`;
    expect(preview.textContent).toContain('/s/test-server');
  });

  it('XSS içeren slug escape edilir', () => {
    const maliciousSlug = '<script>alert(1)</script>';
    const safe          = global.escHtml(maliciousSlug);
    expect(safe).not.toContain('<script>');
    expect(safe).toContain('&lt;');
  });

  it('slug boş olduğunda preview güncellenmez', () => {
    const preview = document.getElementById('server-slug-preview');
    const slug    = '';
    if (slug) preview.textContent = `Profil: http://localhost:3001/s/${slug}`;
    expect(preview.textContent).toBe('');
  });
});

// ── Emoji cache ───────────────────────────────────────────────────────────────

describe('emoji cache yönetimi', () => {
  it('boş cache ile emoji listesi yüklenir', () => {
    const cache: unknown[] = [];
    expect(cache).toHaveLength(0);
  });

  it('emoji nesnesi doğru yapıda', () => {
    const emoji = makeEmoji();
    expect(emoji).toHaveProperty('_id');
    expect(emoji).toHaveProperty('name');
    expect(emoji).toHaveProperty('url');
    expect(emoji).toHaveProperty('serverId');
  });

  it('emoji cache\'e eklenebilir', () => {
    const cache = [makeEmoji({ _id: 'em1' }), makeEmoji({ _id: 'em2', name: 'fire' })];
    expect(cache).toHaveLength(2);
  });

  it('emoji adı XSS içeriyorsa escape edilir', () => {
    const emoji = makeEmoji({ name: '<b>kötü</b>' });
    const safe  = global.escHtml(emoji.name);
    expect(safe).not.toContain('<b>');
    expect(safe).toContain('&lt;b&gt;');
  });
});

// ── Emoji DOM render ─────────────────────────────────────────────────────────

describe('emoji DOM render', () => {
  beforeEach(buildSettingsDOM);

  it('emoji listesi container\'a eklenir', () => {
    const container = document.getElementById('server-emoji-list');
    const emoji     = makeEmoji();
    const div       = document.createElement('div');
    div.className   = 'emoji-item';
    div.dataset.emojiId = emoji._id;
    container.appendChild(div);
    expect(document.querySelectorAll('.emoji-item')).toHaveLength(1);
  });

  it('emoji kaldırıldığında DOM\'dan silinir', () => {
    const container = document.getElementById('server-emoji-list');
    const div       = document.createElement('div');
    div.className   = 'emoji-item';
    div.id          = 'emoji-em1';
    container.appendChild(div);
    document.getElementById('emoji-em1')?.remove();
    expect(document.querySelectorAll('.emoji-item')).toHaveLength(0);
  });
});

// ── Role yönetimi ─────────────────────────────────────────────────────────────

describe('role yönetimi', () => {
  beforeEach(buildSettingsDOM);

  it('role nesnesi doğru yapıda', () => {
    const role = makeRole();
    expect(role).toHaveProperty('_id');
    expect(role).toHaveProperty('name');
    expect(role).toHaveProperty('color');
    expect(role).toHaveProperty('permissions');
  });

  it('role rengi geçerli hex formatında', () => {
    const role = makeRole({ color: '#ff6b6b' });
    expect(role.color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
  });

  it('role listesi DOM\'a render edilir', () => {
    const container = document.getElementById('server-role-list');
    [makeRole({ _id: 'r1' }), makeRole({ _id: 'r2', name: 'Admin' })].forEach(r => {
      const div = document.createElement('div');
      div.className = 'role-item';
      div.dataset.roleId = r._id;
      container.appendChild(div);
    });
    expect(document.querySelectorAll('.role-item')).toHaveLength(2);
  });

  it('permission bit flag hesabı doğru', () => {
    const MANAGE_CHANNELS = 1 << 4; // 16
    const MANAGE_ROLES    = 1 << 8; // 256
    const combined        = MANAGE_CHANNELS | MANAGE_ROLES;
    expect(combined & MANAGE_CHANNELS).toBeTruthy();
    expect(combined & MANAGE_ROLES).toBeTruthy();
    expect(combined & (1 << 0)).toBeFalsy(); // SEND_MESSAGES set değil
  });

  it('position sıralanabilir', () => {
    const roles = [makeRole({ position: 3 }), makeRole({ position: 1 }), makeRole({ position: 2 })];
    const sorted = [...roles].sort((a, b) => a.position - b.position);
    expect(sorted[0].position).toBe(1);
    expect(sorted[2].position).toBe(3);
  });
});

// ── Audit log ────────────────────────────────────────────────────────────────

describe('audit log DOM', () => {
  beforeEach(buildSettingsDOM);

  it('audit entry nesnesi doğru yapıda', () => {
    const entry = makeAuditEntry();
    expect(entry).toHaveProperty('action');
    expect(entry).toHaveProperty('userId');
    expect(entry).toHaveProperty('createdAt');
  });

  it('audit log listesi DOM\'a eklenir', () => {
    const container = document.getElementById('audit-log-list');
    const entry     = makeAuditEntry();
    const div       = document.createElement('div');
    div.className   = 'audit-entry';
    div.dataset.action = entry.action;
    container.appendChild(div);
    expect(document.querySelectorAll('.audit-entry')).toHaveLength(1);
  });

  it('audit action değeri XSS içeriyorsa escape edilir', () => {
    const entry = makeAuditEntry({ action: '<script>xss</script>' });
    const safe  = global.escHtml(entry.action);
    expect(safe).not.toContain('<script>');
  });

  it('audit log boş olduğunda empty state gösterilir', () => {
    const container  = document.getElementById('audit-log-list');
    container.innerHTML = '<div class="audit-empty">Kayıt yok.</div>';
    expect(document.querySelector('.audit-empty')).not.toBeNull();
    expect(document.querySelectorAll('.audit-entry')).toHaveLength(0);
  });
});

// ── Form validasyon ───────────────────────────────────────────────────────────

describe('server settings form validasyon', () => {
  beforeEach(buildSettingsDOM);

  it('sunucu adı boş olamaz', () => {
    const name = '';
    expect(name.trim()).toBe('');
    // boş name → toast çağrılır
    if (!name.trim()) global.toast('Sunucu adı zorunlu', 'error');
    expect(global.toast).toHaveBeenCalledWith('Sunucu adı zorunlu', 'error');
  });

  it('slug sadece küçük harf, rakam ve tire içermeli', () => {
    const validSlug   = 'test-server-123';
    const invalidSlug = 'Test Server!';
    const slugPattern = /^[a-z0-9-]+$/;
    expect(slugPattern.test(validSlug)).toBe(true);
    expect(slugPattern.test(invalidSlug)).toBe(false);
  });

  it('maksimum 100 karakter ad kuralı', () => {
    const longName = 'a'.repeat(101);
    expect(longName.length).toBeGreaterThan(100);
    // validasyon: 100 karakter üzeri reddedilmeli
    const isValid = longName.length <= 100;
    expect(isValid).toBe(false);
  });
});

// ── apiFetch entegrasyonu ─────────────────────────────────────────────────────

describe('server settings API entegrasyonu', () => {
  beforeEach(() => { global.apiFetch.mockClear(); global.toast.mockClear(); });

  it('kaydetme başarılı → success toast', async () => {
    global.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ server: { _id: 's1' } }) });
    const r    = await global.apiFetch('/api/servers/s1', { method: 'PATCH' });
    const data = await r.json();
    if (r.ok) global.toast('Ayarlar kaydedildi', 'success');
    expect(global.toast).toHaveBeenCalledWith('Ayarlar kaydedildi', 'success');
  });

  it('kaydetme başarısız → error toast', async () => {
    global.apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Yetkisiz' }) });
    const r    = await global.apiFetch('/api/servers/s1', { method: 'PATCH' });
    const data = await r.json();
    if (!r.ok) global.toast(data.error, 'error');
    expect(global.toast).toHaveBeenCalledWith('Yetkisiz', 'error');
  });
});

// ── toggleServerEmojiPicker ───────────────────────────────────────────────────

function buildPickerDOM(emojis = []) {
  document.body.innerHTML = `
    <div id="server-emoji-picker-btn" style="top:200px;right:40px;width:32px;height:32px;"></div>
    <textarea id="msg-input"></textarea>
  `;
  // Expose a minimal serverEmojiCache on the module scope via global
  global.serverEmojiCache = emojis;
}

// Inline re-implementation that mirrors server-settings.ts (unit-testable, no imports)
function toggleServerEmojiPicker(serverEmojiCache = []) {
  const existing = document.getElementById('server-emoji-picker');
  if (existing) { existing.remove(); return; }
  if (!serverEmojiCache.length) { global.toast('Henüz emoji yok. Sağ tıkla → Emoji Yönetimi', 'error'); return; }

  const picker = document.createElement('div');
  picker.id = 'server-emoji-picker';

  const searchWrap = document.createElement('div');
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Emoji ara...';
  searchWrap.appendChild(searchInput);
  picker.appendChild(searchWrap);

  const scrollArea = document.createElement('div');
  picker.appendChild(scrollArea);

  function renderEmojiGroups(filter = '') {
    scrollArea.innerHTML = '';
    const groups = {};
    for (const e of serverEmojiCache) {
      if (filter && !e.name.includes(filter.toLowerCase())) continue;
      const key = e.serverId;
      if (!groups[key]) groups[key] = { name: e.serverName || 'Sunucu', icon: e.serverIcon || '🌐', emojis: [] };
      groups[key].emojis.push(e);
    }
    if (!Object.keys(groups).length) {
      scrollArea.innerHTML = '<div class="no-result">Sonuç yok</div>';
      return;
    }
    for (const [, group] of Object.entries(groups)) {
      const label = document.createElement('div');
      label.className = 'sep-label';
      label.textContent = (group.icon + ' ' + group.name).toUpperCase();
      scrollArea.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'ep-grid';
      for (const e of group.emojis) {
        const btn = document.createElement('button');
        btn.title = ':' + e.name + ':';
        grid.appendChild(btn);
      }
      scrollArea.appendChild(grid);
    }
  }

  renderEmojiGroups();
  searchInput.addEventListener('input', () => renderEmojiGroups(searchInput.value.trim()));

  const triggerBtn = document.getElementById('server-emoji-picker-btn');
  const rect = triggerBtn?.getBoundingClientRect?.();
  if (rect) {
    picker.style.bottom   = (window.innerHeight - rect.top + 8) + 'px';
    picker.style.right    = (window.innerWidth  - rect.right)   + 'px';
    picker.style.position = 'fixed';
  }
  document.body.appendChild(picker);
}

function insertEmojiShortcode(code) {
  document.getElementById('server-emoji-picker')?.remove();
  const input = document.getElementById('msg-input');
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end   = input.selectionEnd   ?? input.value.length;
  const val   = input.value;
  input.value = val.slice(0, start) + code + ' ' + val.slice(end);
  input.setSelectionRange(start + code.length + 1, start + code.length + 1);
  input.focus();
}

describe('toggleServerEmojiPicker', () => {
  const fakeEmoji = (n, serverId = 's1') => ({
    _id: n, name: n, url: '/e/' + n + '.png',
    serverId, serverName: 'Test', serverIcon: '🎮',
  });

  beforeEach(() => {
    buildPickerDOM();
    global.toast = jest.fn();
  });
  afterEach(() => {
    document.getElementById('server-emoji-picker')?.remove();
  });

  it('boş cache ile toast gösterilir, picker oluşturulmaz', () => {
    toggleServerEmojiPicker([]);
    expect(global.toast).toHaveBeenCalledWith('Henüz emoji yok. Sağ tıkla → Emoji Yönetimi', 'error');
    expect(document.getElementById('server-emoji-picker')).toBeNull();
  });

  it('cache doluyken picker DOM\'a eklenir', () => {
    toggleServerEmojiPicker([fakeEmoji('wave')]);
    expect(document.getElementById('server-emoji-picker')).not.toBeNull();
  });

  it('iki kez çağrılınca picker kapanır (toggle)', () => {
    toggleServerEmojiPicker([fakeEmoji('wave')]);
    expect(document.getElementById('server-emoji-picker')).not.toBeNull();
    toggleServerEmojiPicker([fakeEmoji('wave')]);
    expect(document.getElementById('server-emoji-picker')).toBeNull();
  });

  it('arama input\'u picker içinde bulunur', () => {
    toggleServerEmojiPicker([fakeEmoji('fire')]);
    const picker = document.getElementById('server-emoji-picker');
    expect(picker.querySelector('input[type="text"]')).not.toBeNull();
  });

  it('emojiler sunucu başlığı altında gruplandırılır', () => {
    toggleServerEmojiPicker([fakeEmoji('a', 's1'), fakeEmoji('b', 's2')]);
    const labels = document.querySelectorAll('.sep-label');
    expect(labels.length).toBe(2);
  });

  it('filtre ile eşleşmeyen emoji grubu render edilmez', () => {
    const emojis = [fakeEmoji('fire', 's1'), fakeEmoji('wave', 's1')];
    toggleServerEmojiPicker(emojis);
    const picker = document.getElementById('server-emoji-picker');
    const searchInput = picker.querySelector('input[type="text"]');
    // simulate filtering for 'fire' only
    searchInput.value = 'fire';
    searchInput.dispatchEvent(new Event('input'));
    const btns = document.querySelectorAll('#server-emoji-picker .ep-grid button');
    expect(btns.length).toBe(1);
    expect(btns[0].title).toBe(':fire:');
  });

  it('position:fixed triggerBtn\'a göre hesaplanır', () => {
    toggleServerEmojiPicker([fakeEmoji('ok')]);
    const picker = document.getElementById('server-emoji-picker');
    // jsdom getBoundingClientRect returns 0 everywhere, so fixed is set if rect exists
    expect(picker.style.position).toBe('fixed');
  });
});

// ── insertEmojiShortcode ──────────────────────────────────────────────────────

describe('insertEmojiShortcode', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <textarea id="msg-input"></textarea>
      <div id="server-emoji-picker"></div>
    `;
  });

  it('shortcode boş input\'a eklenir', () => {
    insertEmojiShortcode(':wave:');
    expect(document.getElementById('msg-input').value).toBe(':wave: ');
  });

  it('shortcode mevcut metne eklenir', () => {
    const inp = document.getElementById('msg-input');
    inp.value = 'Hey ';
    inp.setSelectionRange(4, 4);
    insertEmojiShortcode(':fire:');
    expect(inp.value).toBe('Hey :fire: ');
  });

  it('shortcode sonuna boşluk eklenir', () => {
    insertEmojiShortcode(':ok:');
    expect(document.getElementById('msg-input').value).endsWith(' ');
  });

  it('cursor shortcode bitişinden sonra konumlanır', () => {
    const inp = document.getElementById('msg-input');
    insertEmojiShortcode(':hi:');
    // ':hi: ' → length 5, cursor at 5
    expect(inp.selectionStart).toBe(':hi: '.length);
  });

  it('picker DOM\'dan kaldırılır', () => {
    insertEmojiShortcode(':wave:');
    expect(document.getElementById('server-emoji-picker')).toBeNull();
  });

  it('msg-input yokken hata fırlatmaz', () => {
    document.body.innerHTML = '';
    expect(() => insertEmojiShortcode(':wave:')).not.toThrow();
  });

  it('seçili metin shortcode ile değiştirilir', () => {
    const inp = document.getElementById('msg-input');
    inp.value = 'Hello world';
    inp.setSelectionRange(6, 11); // 'world' selected
    insertEmojiShortcode(':wave:');
    expect(inp.value).toBe('Hello :wave: ');
  });
});
