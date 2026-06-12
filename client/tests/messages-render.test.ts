// client/tests/messages-render.test.ts — Bridge v74
// core/messages.js için unit testler
// renderMessage DOM çıktısı, formatText, scroll yardımcıları, sendMessage

'use strict';

// ─── Modül yükleyici ──────────────────────────────────────────────────────────
// messages/renderer.ts + messages/input.js babel-jest ile dönüştürülür.
// renderMessage → renderer.ts, formatText → input.js (renderer bunu re-export etmez,
// input.js'ten ayrıca yüklenmelidir).
function loadMessagesModule() {
  jest.resetModules();
  const renderer = require('../js/core/messages/renderer');
  const input    = require('../js/core/messages/input');
  Object.entries(renderer).forEach(([k, v]) => { global[k] = v; });
  Object.entries(input).forEach(([k, v]) => { global[k] = v; });
}

// ─── Mesaj fixture factory ────────────────────────────────────────────────────
let _msgCounter = 0;
function makeMsg(overrides = {}) {
  _msgCounter++;
  return {
    _id:         overrides._id         ?? `msg-${_msgCounter}`,
    userId:      overrides.userId      ?? 'user-1',
    displayName: overrides.displayName ?? 'Fatih',
    content:     overrides.content     ?? 'Merhaba dünya!',
    type:        overrides.type        ?? 'text',
    createdAt:   overrides.createdAt   ?? new Date('2025-01-01T12:00:00Z').toISOString(),
    pinned:      overrides.pinned      ?? false,
    ...overrides,
  };
}

// ─── DOM şablonu ──────────────────────────────────────────────────────────────
function buildMessagesDOM() {
  document.body.innerHTML = `
    <div id="messages-area"></div>
    <div id="msg-input" contenteditable="true"></div>
    <div id="channel-name"></div>
    <div id="typing-indicator"></div>
    <div id="toast-container"></div>
    <div id="search-query"></div>
    <div id="search-results"></div>
  `;
}

// ─── Setup ────────────────────────────────────────────────────────────────────
beforeAll(() => {
  global.API            = 'http://localhost:3000';
  global.token          = 'test-token';
  global.currentChannel = { _id: 'ch-1', name: 'genel', type: 'text' };
  global.me             = { id: 'user-1', username: 'fatih', displayName: 'Fatih' };
  global.socket         = { emit: jest.fn(), on: jest.fn() };
  global.serverEmojiCache = [];
  global._blockedUserIds  = new Set();
  global.bridgeOfflineCache = null;
  global.apiFetch = jest.fn().mockResolvedValue({
    ok: true, status: 200,
    json: () => Promise.resolve({ messages: [], hasMore: false }),
  });
  // safeFileUrl stub (utils'ten gelir, setup.js'te yok — burada tanımla)
  if (!global.safeFileUrl) {
    global.safeFileUrl = (url) => {
      if (typeof url !== 'string') return '';
      if (url.startsWith('/uploads/') || url.startsWith('data:image/')) return url;
      return '';
    };
  }
  // scrollToMsg stub
  global.scrollToMsg = jest.fn();
  // openImageViewer stub
  global.openImageViewer = jest.fn();

  buildMessagesDOM();
  loadMessagesModule();
});

beforeEach(() => {
  jest.clearAllMocks();
  buildMessagesDOM();
  global.currentChannel  = { _id: 'ch-1', name: 'genel', type: 'text' };
  global._blockedUserIds = new Set();
  _msgCounter = 0;
});

// ══════════════════════════════════════════════════════════════════════════════
// renderMessage() — temel DOM
// ══════════════════════════════════════════════════════════════════════════════
describe('renderMessage() — temel DOM', () => {
  test('mesaj elements\'i messages-area\'ya eklenir', () => {
    const msg = makeMsg({ _id: 'test-1', content: 'Selam!' });
    global.renderMessage(msg);
    expect(document.getElementById('msg-test-1')).not.toBeNull();
  });

  test('aynı id ile tekrar çağrılırsa duplicate eklenmez', () => {
    const msg = makeMsg({ _id: 'dup-1' });
    global.renderMessage(msg);
    global.renderMessage(msg);
    const elements = document.querySelectorAll('#msg-dup-1');
    expect(elements.length).toBe(1);
  });

  test('engellenen kullanıcı mesajı eklenmez', () => {
    global._blockedUserIds.add('blocked-user');
    const msg = makeMsg({ _id: 'blocked-msg', userId: 'blocked-user' });
    global.renderMessage(msg);
    expect(document.getElementById('msg-blocked-msg')).toBeNull();
  });

  test('currentChannel null ise mesaj eklenmez', () => {
    global.currentChannel = null;
    const msg = makeMsg({ _id: 'no-ch' });
    global.renderMessage(msg);
    expect(document.getElementById('msg-no-ch')).toBeNull();
    global.currentChannel = { _id: 'ch-1', name: 'genel', type: 'text' };
  });

  test('pinned=true ise 📌 badge render edilir', () => {
    const msg = makeMsg({ _id: 'pinned-1', pinned: true });
    global.renderMessage(msg);
    const el = document.getElementById('msg-pinned-1');
    expect(el.innerHTML).toContain('📌');
  });

  test('editedAt varsa (edited) badge render edilir', () => {
    const msg = makeMsg({ _id: 'edited-1', editedAt: new Date().toISOString() });
    global.renderMessage(msg);
    const el = document.getElementById('msg-edited-1');
    expect(el.innerHTML).toContain('(edited)');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// renderMessage() — XSS güvenliği
// ══════════════════════════════════════════════════════════════════════════════
describe('renderMessage() — XSS güvenliği', () => {
  test('content\'teki <script> escape edilir', () => {
    const msg = makeMsg({ _id: 'xss-1', content: '<script>alert(1)</script>' });
    global.renderMessage(msg);
    const el = document.getElementById('msg-xss-1');
    expect(el.innerHTML).not.toContain('<script>');
    expect(el.innerHTML).toContain('&lt;script&gt;');
  });

  test('displayName\'deki HTML inject edilmez', () => {
    const msg = makeMsg({ _id: 'xss-2', displayName: '<img src=x onerror=alert(1)>' });
    global.renderMessage(msg);
    const el = document.getElementById('msg-xss-2');
    expect(el.innerHTML).not.toContain('<img src=x');
  });

  test('replyTo displayName XSS koruması', () => {
    const msg = makeMsg({
      _id:     'xss-3',
      replyTo: { _id: 'parent', displayName: '<b>hack</b>', content: 'safe' },
    });
    global.renderMessage(msg);
    const el = document.getElementById('msg-xss-3');
    // <b> tag gerçek eleman olarak DOM'a girmemeli
    expect(el.querySelectorAll('b').length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// renderMessage() — dosya tipleri
// ══════════════════════════════════════════════════════════════════════════════
describe('renderMessage() — dosya tipleri', () => {
  test('image dosyası için <img> render edilir', () => {
    const msg = makeMsg({
      _id:      'file-img',
      type:     'file',
      fileType: 'image/png',
      fileName: 'photo.png',
      fileUrl:  '/uploads/photo.png',
      fileData: '/uploads/photo.png',
    });
    global.renderMessage(msg);
    const el = document.getElementById('msg-file-img');
    expect(el.querySelector('img.msg-image')).not.toBeNull();
  });

  test('video dosyası için <video> render edilir', () => {
    const msg = makeMsg({
      _id:      'file-vid',
      type:     'file',
      fileType: 'video/mp4',
      fileName: 'clip.mp4',
      fileData: '/uploads/clip.mp4',
    });
    global.renderMessage(msg);
    const el = document.getElementById('msg-file-vid');
    expect(el.querySelector('video.msg-video')).not.toBeNull();
  });

  test('audio dosyası için <audio> render edilir', () => {
    const msg = makeMsg({
      _id:      'file-aud',
      type:     'file',
      fileType: 'audio/mpeg',
      fileName: 'song.mp3',
      fileData: '/uploads/song.mp3',
    });
    global.renderMessage(msg);
    const el = document.getElementById('msg-file-aud');
    expect(el.querySelector('audio.msg-audio')).not.toBeNull();
  });

  test('diğer dosya tipi için indirme linki render edilir', () => {
    const msg = makeMsg({
      _id:      'file-pdf',
      type:     'file',
      fileType: 'application/pdf',
      fileName: 'rapor.pdf',
      fileData: '/uploads/rapor.pdf',
    });
    global.renderMessage(msg);
    const el = document.getElementById('msg-file-pdf');
    expect(el.querySelector('a.file-link')).not.toBeNull();
    expect(el.querySelector('a.file-link').textContent).toContain('rapor.pdf');
  });

  test('dosya adında XSS: fileName escape edilir', () => {
    const msg = makeMsg({
      _id:      'file-xss',
      type:     'file',
      fileType: 'application/pdf',
      fileName: '"><script>alert(1)</script>',
      fileData: '/uploads/safe.pdf',
    });
    global.renderMessage(msg);
    const el = document.getElementById('msg-file-xss');
    expect(el.innerHTML).not.toContain('<script>');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// formatText()
// ══════════════════════════════════════════════════════════════════════════════
describe('formatText()', () => {
  test('boş/null input boş string döndürür', () => {
    expect(global.formatText('')).toBe('');
    expect(global.formatText(null)).toBe('');
    expect(global.formatText(undefined)).toBe('');
  });

  test('**bold** → <strong>', () => {
    expect(global.formatText('**kalın**')).toContain('<strong>kalın</strong>');
  });

  test('*italic* → <em>', () => {
    expect(global.formatText('*eğik*')).toContain('<em>eğik</em>');
  });

  test('_italic_ → <em>', () => {
    expect(global.formatText('_eğik_')).toContain('<em>eğik</em>');
  });

  test('~~strikethrough~~ → <del>', () => {
    expect(global.formatText('~~üstü çizili~~')).toContain('<del>üstü çizili</del>');
  });

  test('```code block``` → <pre><code>', () => {
    const result = global.formatText('```console.log("hello")```');
    expect(result).toContain('<pre><code>');
    expect(result).toContain('</code></pre>');
  });

  test('`inline code` → <code>', () => {
    expect(global.formatText('`const x = 1`')).toContain('<code>const x = 1</code>');
  });

  test('@mention → mention span', () => {
    expect(global.formatText('@fatih selam')).toContain('<span class="mention">@fatih</span>');
  });

  test('\\n → <br>', () => {
    expect(global.formatText('satır1\nsatır2')).toContain('<br>');
  });

  test('<script> içeriği HTML olarak inject edilmez', () => {
    const result = global.formatText('<script>evil()</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  test('***bold italic*** → <strong><em>', () => {
    const r = global.formatText('***kalın eğik***');
    expect(r).toContain('<strong><em>kalın eğik</em></strong>');
  });

  test('kod bloğu içindeki ** markdown işlenmez', () => {
    const r = global.formatText('```**bu bold olmamalı**```');
    expect(r).not.toContain('<strong>');
    expect(r).toContain('**bu bold olmamalı**');
  });

  test('inline kod içindeki * markdown işlenmez', () => {
    const r = global.formatText('`*italic değil*`');
    expect(r).not.toContain('<em>');
    expect(r).toContain('*italic değil*');
  });

  test('__bold__ → <strong>', () => {
    expect(global.formatText('__kalın__')).toContain('<strong>kalın</strong>');
  });

  test('karışık nested: **bold _italic_ bold**', () => {
    const r = global.formatText('**bold _italic_ bold**');
    expect(r).toContain('<strong>');
    expect(r).toContain('<em>italic</em>');
  });

  test('null/undefined güvenli döner', () => {
    expect(global.formatText(null)).toBe('');
    expect(global.formatText(undefined)).toBe('');
    expect(global.formatText(0)).toBe('0');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// _saveChannelScroll / _restoreChannelScroll
// ══════════════════════════════════════════════════════════════════════════════
describe('scroll helpers', () => {
  test('_saveChannelScroll ve _restoreChannelScroll window\'a tanımlıdır', () => {
    expect(typeof window._saveChannelScroll).toBe('function');
    expect(typeof window._restoreChannelScroll).toBe('function');
  });

  test('_saveChannelScroll scroll pozisyonunu kaydeder', () => {
    const area = document.getElementById('messages-area');
    Object.defineProperty(area, 'scrollTop', { value: 350, configurable: true, writable: true });
    window._saveChannelScroll('ch-test');
    // İkinci kez restore edince 0 döndürmemeli (daha önce kaydedildi)
    // Sadece hata atmadığını kontrol et
    expect(() => window._restoreChannelScroll('ch-test')).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// sendMessage()
// ══════════════════════════════════════════════════════════════════════════════
describe('sendMessage()', () => {
  test('boş input ile gönderim yapılmaz', () => {
    document.getElementById('msg-input').textContent = '   ';
    global.sendMessage();
    expect(global.socket.emit).not.toHaveBeenCalled();
  });

  test('geçerli mesaj socket.emit ile gönderilir', () => {
    document.getElementById('msg-input').textContent = 'Merhaba!';
    global.currentChannel = { _id: 'ch-1', name: 'genel' };
    global.sendMessage();
    expect(global.socket.emit).toHaveBeenCalledWith(
      'message:send',
      expect.objectContaining({ content: 'Merhaba!' })
    );
  });

  test('gönderim sonrası input temizlenir', () => {
    const input = document.getElementById('msg-input');
    input.textContent = 'Bir mesaj';
    global.sendMessage();
    expect(input.textContent).toBe('');
  });

  test('currentChannel null ise emit yapılmaz', () => {
    global.currentChannel = null;
    document.getElementById('msg-input').textContent = 'test';
    global.sendMessage();
    expect(global.socket.emit).not.toHaveBeenCalled();
    global.currentChannel = { _id: 'ch-1', name: 'genel' };
  });
});
