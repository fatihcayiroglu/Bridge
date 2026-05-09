// client/tests/messages.test.js — Bridge v74
// Mesaj render ve scroll logic testleri
// DOM-ağırlıklı: jsdom ortamında çalışır

'use strict';

const fs   = require('fs');
const path = require('path');

function loadClientModule(relPath) {
  const code = fs.readFileSync(
    path.resolve(__dirname, '../../js', relPath), 'utf8'
  );
  new Function('window', 'document', 'global', code)(global, global.document, global);
}

beforeAll(() => {
  // Temel DOM yapısı
  document.body.innerHTML = `
    <div id="messages-area"></div>
    <div id="toast-container"></div>
  `;
  loadClientModule('core/utils.js');
});

// ── _channelScrollPos mantığı ─────────────────────────────────
describe('Kanal scroll pozisyonu', () => {
  beforeEach(() => {
    // messages-area'yı sıfırla
    const area = document.getElementById('messages-area');
    area.innerHTML = '';
    Object.defineProperty(area, 'scrollHeight', { get: () => 1000, configurable: true });
    Object.defineProperty(area, 'scrollTop',    { get: () => 0, set: () => {}, configurable: true });
    Object.defineProperty(area, 'clientHeight', { get: () => 600, configurable: true });
  });

  test('_saveChannelScroll ve _restoreChannelScroll window\'a atanır', () => {
    loadClientModule('core/messages.js');
    expect(typeof window._saveChannelScroll).toBe('function');
    expect(typeof window._restoreChannelScroll).toBe('function');
  });
});

// ── renderMessage XSS koruması ────────────────────────────────
describe('renderMessage() XSS güvenliği', () => {
  test('escHtml çağrısı script tag\'i escape eder', () => {
    // escHtml doğrudan test et — render bağımlılıklarını izole et
    expect(global.escHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(global.escHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});
