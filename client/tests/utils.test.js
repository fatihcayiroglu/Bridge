// client/tests/utils.test.js — Bridge v74
// client/js/core/utils.js için unit testler

'use strict';

// utils.js global fonksiyon tanımlar — eval ile jsdom ortamına yükle
const fs   = require('fs');
const path = require('path');

function loadClientModule(relPath) {
  const code = fs.readFileSync(
    path.resolve(__dirname, '../../js', relPath), 'utf8'
  );
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'global', code)(global, global.document, global);
}

beforeAll(() => {
  // toast için container DOM'u kur
  document.body.innerHTML = '<div id="toast-container"></div>';
  loadClientModule('core/utils.js');
});

// ── escHtml ───────────────────────────────────────────────────
describe('escHtml()', () => {
  test('< > & " karakterlerini escape eder', () => {
    expect(global.escHtml('<script>')).toBe('&lt;script&gt;');
    expect(global.escHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(global.escHtml('a & b')).toBe('a &amp; b');
  });

  test('sayıları string\'e çevirir', () => {
    expect(global.escHtml(42)).toBe('42');
  });

  test('boş string\'i boş döndürür', () => {
    expect(global.escHtml('')).toBe('');
  });
});

// ── cssColor ──────────────────────────────────────────────────
describe('cssColor()', () => {
  test('geçerli hex rengi olduğu gibi döndürür', () => {
    expect(global.cssColor('#fff')).toBe('#fff');
    expect(global.cssColor('#aabbcc')).toBe('#aabbcc');
    expect(global.cssColor('#12345678')).toBe('#12345678');
  });

  test('geçersiz değer için fallback döndürür', () => {
    expect(global.cssColor('red')).toBe('#808080');
    expect(global.cssColor('javascript:evil')).toBe('#808080');
    expect(global.cssColor(null)).toBe('#808080');
    expect(global.cssColor(123)).toBe('#808080');
  });
});

// ── initials ──────────────────────────────────────────────────
describe('initials()', () => {
  test('iki kelimeden ilk harfleri alır', () => {
    expect(global.initials('Ali Veli')).toBe('AV');
    expect(global.initials('john doe')).toBe('JD');
  });

  test('tek kelime için ilk iki harfi alır', () => {
    expect(global.initials('Alice')).toBe('AL');
  });

  test('boş/undefined için ? döndürür', () => {
    expect(global.initials('')).toBe('?');
    expect(global.initials(null)).toBe('?');
    expect(global.initials(undefined)).toBe('?');
  });
});

// ── safeFileUrl ───────────────────────────────────────────────
describe('safeFileUrl()', () => {
  test('/uploads/ ile başlayan URL\'ye izin verir', () => {
    expect(global.safeFileUrl('/uploads/img.png')).toBe('/uploads/img.png');
  });

  test('data:image/ ile başlayan URL\'ye izin verir', () => {
    const dataUrl = 'data:image/png;base64,abc';
    expect(global.safeFileUrl(dataUrl)).toBe(dataUrl);
  });

  test('harici URL için boş string döndürür', () => {
    expect(global.safeFileUrl('https://evil.com/xss')).toBe('');
  });

  test('string olmayan için boş string döndürür', () => {
    expect(global.safeFileUrl(null)).toBe('');
    expect(global.safeFileUrl(42)).toBe('');
  });
});

// ── toast ─────────────────────────────────────────────────────
describe('toast()', () => {
  beforeEach(() => {
    document.getElementById('toast-container').innerHTML = '';
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('toast elementini DOM\'a ekler', () => {
    global.toast('Test mesajı', 'success');
    const el = document.querySelector('.toast');
    expect(el).not.toBeNull();
    expect(el.textContent).toBe('Test mesajı');
    expect(el.classList.contains('success')).toBe(true);
  });

  test('süre dolunca DOM\'dan kaldırır', () => {
    global.toast('Geçici', '', 1000);
    expect(document.querySelector('.toast')).not.toBeNull();
    jest.advanceTimersByTime(1100);
    expect(document.querySelector('.toast')).toBeNull();
  });
});

// ── closeModal ────────────────────────────────────────────────
describe('closeModal()', () => {
  test('elementi gizler', () => {
    document.body.innerHTML += '<div id="test-modal" style="display:block"></div>';
    global.closeModal('test-modal');
    const el = document.getElementById('test-modal');
    expect(el.style.display).toBe('none');
  });

  test('olmayan id için hata vermez', () => {
    expect(() => global.closeModal('non-existent')).not.toThrow();
  });
});
