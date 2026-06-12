// client/tests/renderer.test.ts — Sprint 81
// core/messages/renderer.ts için unit testler
//
// Kapsam:
//   - renderMessage(): DOM ekleme, tekrar ekleme engeli, blocked user filtresi
//   - renderMessage(): isContinuation=true / msg.type=system şubesi
//   - renderMessage(): file tipi (image / video / audio / generic)
//   - renderMessage(): voice_message + transcript
//   - renderMessage(): replyTo quote HTML
//   - renderMessage(): editedBadge, pinnedBadge, scheduledBadge, bridgedBadge
//   - updateMessage(): içerik güncelleme
//   - deleteMessage(): DOM kaldırma

'use strict';

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c: string) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../js/core/logger.js', () => ({
  createLogger: () => ({
    log: jest.fn(), info: jest.fn(), warn: jest.fn(),
    error: jest.fn(), debug: jest.fn(),
  }),
}), { virtual: true });

jest.mock('../../js/core/utils.js', () => ({
  escHtml,
  toast:    jest.fn(),
  initials: (s: string) => s?.[0]?.toUpperCase() ?? '?',
}), { virtual: true });

jest.mock('../../js/core/api-fetch.js', () => ({
  apiFetch: jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue([]) }),
}), { virtual: true });

jest.mock('../../js/core/messages/reactions.js', () => ({
  renderReactionsHtml: jest.fn(() => ''),
}), { virtual: true });

jest.mock('../../js/core/messages/embeds.js', () => ({
  renderEmbed: jest.fn(() => ''),
}), { virtual: true });

jest.mock('../../js/core/messages/input.js', () => ({
  formatText: jest.fn((s: string) => escHtml(s ?? '')),
}), { virtual: true });

let _currentMe: Record<string, unknown> | null = null;
let _currentChannel: Record<string, unknown> | null = null;
let _blockedIds: Set<string> = new Set();
const _registryStore: Record<string, unknown> = {};

jest.mock('../../js/core/globals.js', () => ({
  getAPI:            () => 'http://localhost:3001',
  getMe:             () => _currentMe,
  getCurrentChannel: () => _currentChannel,
}), { virtual: true });

jest.mock('../../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    get:      (key: string) => {
      if (key === '_blockedUserIds') return _blockedIds;
      if (key === 'bridgeOfflineCache') return null;
      return _registryStore[key] ?? null;
    },
    register: jest.fn(),
    call:     jest.fn(),
  },
}), { virtual: true });

// ── Module loader ─────────────────────────────────────────────────────────────

function loadModule() {
  jest.resetModules();
  jest.mock('../../js/core/logger.js', () => ({
    createLogger: () => ({ log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  }), { virtual: true });
  jest.mock('../../js/core/utils.js', () => ({ escHtml, toast: jest.fn(), initials: (s: string) => s?.[0]?.toUpperCase() ?? '?' }), { virtual: true });
  jest.mock('../../js/core/api-fetch.js', () => ({ apiFetch: jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue([]) }) }), { virtual: true });
  jest.mock('../../js/core/messages/reactions.js', () => ({ renderReactionsHtml: jest.fn(() => '') }), { virtual: true });
  jest.mock('../../js/core/messages/embeds.js', () => ({ renderEmbed: jest.fn(() => '') }), { virtual: true });
  jest.mock('../../js/core/messages/input.js', () => ({ formatText: jest.fn((s: string) => escHtml(s ?? '')) }), { virtual: true });
  jest.mock('../../js/core/globals.js', () => ({ getAPI: () => 'http://localhost:3001', getMe: () => _currentMe, getCurrentChannel: () => _currentChannel }), { virtual: true });
  jest.mock('../../js/core/bridge-registry.js', () => ({ BridgeRegistry: { get: (key: string) => { if (key === '_blockedUserIds') return _blockedIds; if (key === 'bridgeOfflineCache') return null; return null; }, register: jest.fn(), call: jest.fn() } }), { virtual: true });
  return require('../../js/core/messages/renderer');
}

// ── DOM kurulum ───────────────────────────────────────────────────────────────

function buildDOM() {
  document.body.innerHTML = `
    <div id="messages"></div>
    <div id="toast-container"></div>
  `;
}

// ── Mesaj fixture ─────────────────────────────────────────────────────────────

function makeMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id:         'msg-001',
    channelId:   'ch-001',
    userId:      'user-1',
    displayName: 'Ahmet',
    username:    'ahmet',
    content:     'Merhaba dünya',
    createdAt:   1700000000000,
    ...overrides,
  };
}

// ── [1] Temel renderMessage ───────────────────────────────────────────────────

describe('renderMessage() — temel', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    buildDOM();
    _currentMe = { _id: 'user-X', id: 'user-X' };
    _currentChannel = { _id: 'ch-001', name: 'genel' };
    _blockedIds = new Set();
    mod = loadModule();
  });

  it('mesaj alanına yeni bir div ekler', () => {
    mod.renderMessage(makeMsg());
    expect(document.getElementById('msg-msg-001')).not.toBeNull();
  });

  it('aynı _id ile iki kez çağrılırsa DOM\'a bir kez eklenir', () => {
    mod.renderMessage(makeMsg());
    mod.renderMessage(makeMsg());
    const area = document.getElementById('messages');
    const count = area?.querySelectorAll('#msg-msg-001').length ?? 0;
    expect(count).toBe(1);
  });

  it('messages alanı yoksa hata fırlatmaz', () => {
    document.body.innerHTML = ''; // messages div yok
    expect(() => mod.renderMessage(makeMsg())).not.toThrow();
  });
});

// ── [2] Engellenmiş kullanıcı filtresi ───────────────────────────────────────

describe('renderMessage() — blocked user', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    buildDOM();
    _currentMe = { _id: 'user-X', id: 'user-X' };
    _currentChannel = { _id: 'ch-001' };
    mod = loadModule();
  });

  it('engellenen kullanıcının mesajı DOM\'a eklenmez', () => {
    _blockedIds = new Set(['user-blocked']);
    mod.renderMessage(makeMsg({ _id: 'msg-b', userId: 'user-blocked' }));
    expect(document.getElementById('msg-msg-b')).toBeNull();
  });

  it('engellenmeyen kullanıcının mesajı eklenir', () => {
    _blockedIds = new Set(['user-blocked']);
    mod.renderMessage(makeMsg({ _id: 'msg-ok', userId: 'user-ok' }));
    expect(document.getElementById('msg-msg-ok')).not.toBeNull();
  });
});

// ── [3] Mesaj tipi şubeleri ───────────────────────────────────────────────────

describe('renderMessage() — msg.type şubeleri', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    buildDOM();
    _currentMe = { _id: 'user-X', id: 'user-X' };
    _currentChannel = { _id: 'ch-001' };
    _blockedIds = new Set();
    mod = loadModule();
  });

  it('type=system → .sys-msg class alır', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-sys', type: 'system', content: 'Hoş geldin' }));
    const el = document.getElementById('msg-msg-sys');
    expect(el?.className).toBe('sys-msg');
  });

  it('type=system → sistem ikonu içerir', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-sys2', type: 'system', content: 'Katıldı' }));
    const el = document.getElementById('msg-msg-sys2');
    expect(el?.innerHTML).toContain('sys-icon');
  });

  it('isContinuation=true → .msg-continue class alır', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-cont' }), true);
    const el = document.getElementById('msg-msg-cont');
    expect(el?.className).toBe('msg-continue');
  });

  it('normal mesaj → .msg-group class alır', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-normal' }));
    const el = document.getElementById('msg-msg-normal');
    expect(el?.className).toContain('msg-group');
  });
});

// ── [4] Dosya tipleri ─────────────────────────────────────────────────────────

describe('renderMessage() — file tipi', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    buildDOM();
    _currentMe = { _id: 'user-X', id: 'user-X' };
    _currentChannel = { _id: 'ch-001' };
    _blockedIds = new Set();
    mod = loadModule();
  });

  it('image/* → img tag içerir', () => {
    mod.renderMessage(makeMsg({
      _id: 'msg-img', type: 'file', fileType: 'image/png',
      fileData: 'http://localhost:3001/uploads/test.png', fileName: 'test.png',
    }));
    const el = document.getElementById('msg-msg-img');
    expect(el?.innerHTML).toContain('<img');
    expect(el?.innerHTML).toContain('msg-image');
  });

  it('video/* → video tag içerir', () => {
    mod.renderMessage(makeMsg({
      _id: 'msg-vid', type: 'file', fileType: 'video/mp4',
      fileData: 'http://localhost:3001/uploads/test.mp4', fileName: 'test.mp4',
    }));
    const el = document.getElementById('msg-msg-vid');
    expect(el?.innerHTML).toContain('<video');
  });

  it('audio/* → audio tag içerir', () => {
    mod.renderMessage(makeMsg({
      _id: 'msg-aud', type: 'file', fileType: 'audio/mpeg',
      fileData: 'http://localhost:3001/uploads/test.mp3', fileName: 'test.mp3',
    }));
    const el = document.getElementById('msg-msg-aud');
    expect(el?.innerHTML).toContain('<audio');
  });

  it('generic dosya → file-link anchor içerir', () => {
    mod.renderMessage(makeMsg({
      _id: 'msg-gen', type: 'file', fileType: 'application/pdf',
      fileData: 'http://localhost:3001/uploads/doc.pdf', fileName: 'doc.pdf',
    }));
    const el = document.getElementById('msg-msg-gen');
    expect(el?.innerHTML).toContain('file-link');
    expect(el?.innerHTML).toContain('doc.pdf');
  });
});

// ── [5] voice_message ─────────────────────────────────────────────────────────

describe('renderMessage() — voice_message', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    buildDOM();
    _currentMe = { _id: 'user-X', id: 'user-X' };
    _currentChannel = { _id: 'ch-001' };
    _blockedIds = new Set();
    mod = loadModule();
  });

  it('transkript varsa voice-transcript içerir', () => {
    mod.renderMessage(makeMsg({
      _id: 'msg-vm1', type: 'voice_message',
      fileUrl: '/uploads/voice.ogg', transcript: 'Test ses',
    }));
    const el = document.getElementById('msg-msg-vm1');
    expect(el?.innerHTML).toContain('voice-transcript');
    expect(el?.innerHTML).toContain('Test ses');
  });

  it('transkript yoksa hazırlanıyor mesajı görünür', () => {
    mod.renderMessage(makeMsg({
      _id: 'msg-vm2', type: 'voice_message',
      fileUrl: '/uploads/voice.ogg', transcript: null,
    }));
    const el = document.getElementById('msg-msg-vm2');
    expect(el?.innerHTML).toContain('voice-transcript--pending');
  });
});

// ── [6] Badge'ler ─────────────────────────────────────────────────────────────

describe('renderMessage() — badge\'ler', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    buildDOM();
    _currentMe = { _id: 'user-X', id: 'user-X' };
    _currentChannel = { _id: 'ch-001' };
    _blockedIds = new Set();
    mod = loadModule();
  });

  it('editedAt varsa (edited) badge çıkar', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-ed', editedAt: 1700000001000 }));
    const el = document.getElementById('msg-msg-ed');
    expect(el?.innerHTML).toContain('msg-edited');
  });

  it('pinned=true → pin-badge çıkar', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-pin', pinned: true }));
    const el = document.getElementById('msg-msg-pin');
    expect(el?.innerHTML).toContain('pin-badge');
    expect(el?.className).toContain('pinned-msg');
  });

  it('scheduledId varsa scheduled-badge çıkar', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-sch', scheduledId: 'sched-1' }));
    const el = document.getElementById('msg-msg-sch');
    expect(el?.innerHTML).toContain('scheduled-badge');
  });

  it('bridgedFrom varsa bridged-badge çıkar', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-br', bridgedFrom: 'ch-other' }));
    const el = document.getElementById('msg-msg-br');
    expect(el?.innerHTML).toContain('bridged-badge');
  });
});

// ── [7] replyTo quote ────────────────────────────────────────────────────────

describe('renderMessage() — replyTo', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    buildDOM();
    _currentMe = { _id: 'user-X', id: 'user-X' };
    _currentChannel = { _id: 'ch-001' };
    _blockedIds = new Set();
    mod = loadModule();
  });

  it('replyTo varsa reply-quote DOM\'a eklenir', () => {
    mod.renderMessage(makeMsg({
      _id: 'msg-reply',
      replyTo: { _id: 'msg-parent', displayName: 'Zeynep', content: 'Nasılsın?' },
    }));
    const el = document.getElementById('msg-msg-reply');
    expect(el?.innerHTML).toContain('reply-quote');
    expect(el?.innerHTML).toContain('Zeynep');
  });

  it('replyTo yoksa reply-quote DOM\'a eklenmez', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-no-reply', replyTo: null }));
    const el = document.getElementById('msg-msg-no-reply');
    expect(el?.innerHTML).not.toContain('reply-quote');
  });
});

// ── [8] updateMessage ─────────────────────────────────────────────────────────

describe('updateMessage()', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    buildDOM();
    _currentMe = { _id: 'user-X', id: 'user-X' };
    _currentChannel = { _id: 'ch-001' };
    _blockedIds = new Set();
    mod = loadModule();
  });

  it('var olan mesajın metin içeriğini günceller', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-upd', content: 'Eski içerik' }));
    mod.updateMessage({ _id: 'msg-upd', content: 'Yeni içerik', editedAt: Date.now() });
    const el = document.getElementById('msgtext-msg-upd');
    expect(el?.innerHTML).toContain('Yeni içerik');
  });

  it('DOM\'da olmayan mesaj için hata fırlatmaz', () => {
    expect(() => mod.updateMessage({ _id: 'ghost-msg', content: 'x', editedAt: Date.now() })).not.toThrow();
  });
});

// ── [9] deleteMessage ─────────────────────────────────────────────────────────

describe('deleteMessage()', () => {
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    buildDOM();
    _currentMe = { _id: 'user-X', id: 'user-X' };
    _currentChannel = { _id: 'ch-001' };
    _blockedIds = new Set();
    mod = loadModule();
  });

  it('silinen mesaj DOM\'dan kaldırılır', () => {
    mod.renderMessage(makeMsg({ _id: 'msg-del' }));
    expect(document.getElementById('msg-msg-del')).not.toBeNull();
    mod.deleteMessage('msg-del');
    expect(document.getElementById('msg-msg-del')).toBeNull();
  });

  it('DOM\'da olmayan mesaj için hata fırlatmaz', () => {
    expect(() => mod.deleteMessage('nonexistent')).not.toThrow();
  });
});
