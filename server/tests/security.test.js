// server/tests/security.test.js
// lib/security.js — sanitizasyon, anti-spam, URL doğrulama
process.env.NODE_ENV = 'test';

const {
  sanitizeMessage,
  sanitizeUsername,
  sanitizeDisplayName,
  isSafeUrl,
  checkSpam,
} = require('../lib/security');

// ══════════════════════════════════════════════════════════════
// MESAJ SANİTİZASYONU
// ══════════════════════════════════════════════════════════════
describe('sanitizeMessage', () => {
  it('normal metni değiştirmez', () => {
    expect(sanitizeMessage('Merhaba dünya!')).toBe('Merhaba dünya!');
  });

  it('HTML tag\'lerini siler', () => {
    expect(sanitizeMessage('<script>alert(1)</script>mesaj')).toBe('mesaj');
    expect(sanitizeMessage('<b>kalın</b>')).toBe('kalın');
  });

  it('javascript: protokolünü temizler', () => {
    expect(sanitizeMessage('javascript:alert(1)')).not.toContain('javascript:');
  });

  it('data: URI\'lerini temizler', () => {
    expect(sanitizeMessage('data:text/html,<script>alert(1)</script>')).not.toContain('data:');
  });

  it('event handler\'ları temizler', () => {
    expect(sanitizeMessage('onerror=alert(1)')).not.toContain('onerror=');
    expect(sanitizeMessage('onclick=hack()')).not.toContain('onclick=');
  });

  it('2000 karakterde kırpar', () => {
    const long = 'a'.repeat(3000);
    expect(sanitizeMessage(long).length).toBeLessThanOrEqual(2000);
  });

  it('boş string döner string değilse', () => {
    expect(sanitizeMessage(null)).toBe('');
    expect(sanitizeMessage(undefined)).toBe('');
    expect(sanitizeMessage(123)).toBe('');
  });

  it('markdown karakterleri korunur', () => {
    const md = '**kalın** *italik* `kod` ~~üstü çizili~~';
    expect(sanitizeMessage(md)).toBe(md);
  });
});

// ══════════════════════════════════════════════════════════════
// KULLANICI ADI SANİTİZASYONU
// ══════════════════════════════════════════════════════════════
describe('sanitizeUsername', () => {
  it('geçerli kullanıcı adını değiştirmez', () => {
    expect(sanitizeUsername('john_doe')).toBe('john_doe');
    expect(sanitizeUsername('test123')).toBe('test123');
    expect(sanitizeUsername('Türkçe')).toBe('Türkçe');
  });

  it('özel karakterleri kaldırır', () => {
    expect(sanitizeUsername('h<script>')).not.toContain('<');
    expect(sanitizeUsername('user@email')).not.toContain('@');
  });

  it('32 karakterde kırpar', () => {
    expect(sanitizeUsername('a'.repeat(50)).length).toBeLessThanOrEqual(32);
  });

  it('boş string döner string değilse', () => {
    expect(sanitizeUsername(null)).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════
// DISPLAY NAME SANİTİZASYONU
// ══════════════════════════════════════════════════════════════
describe('sanitizeDisplayName', () => {
  it('normal ismi değiştirmez', () => {
    expect(sanitizeDisplayName('Ali Veli')).toBe('Ali Veli');
  });

  it('HTML kaldırır ama boşluk ve özel char bırakır', () => {
    expect(sanitizeDisplayName('<b>Ali</b>')).toBe('Ali');
  });

  it('32 karakterde kırpar', () => {
    expect(sanitizeDisplayName('a'.repeat(50)).length).toBeLessThanOrEqual(32);
  });
});

// ══════════════════════════════════════════════════════════════
// URL DOĞRULAMA
// ══════════════════════════════════════════════════════════════
describe('isSafeUrl', () => {
  it('http URL kabul eder', () => {
    expect(isSafeUrl('http://example.com')).toBe(true);
  });

  it('https URL kabul eder', () => {
    expect(isSafeUrl('https://example.com/path?q=1')).toBe(true);
  });

  it('javascript: reddeder', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('data: reddeder', () => {
    expect(isSafeUrl('data:text/html,test')).toBe(false);
  });

  it('ftp: reddeder', () => {
    expect(isSafeUrl('ftp://files.example.com')).toBe(false);
  });

  it('geçersiz URL reddeder', () => {
    expect(isSafeUrl('not a url')).toBe(false);
    expect(isSafeUrl('')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// ANTİ-SPAM
// ══════════════════════════════════════════════════════════════
describe('checkSpam', () => {
  const userId = 'spam-test-user-' + Date.now();

  it('normal kullanımda blocked: false döner', () => {
    const result = checkSpam(userId + '-normal', 'Merhaba');
    expect(result.blocked).toBe(false);
  });

  it('hızlı mesajlar spam tespiti yapar', () => {
    const uid = 'spam-fast-' + Date.now();
    let result;
    for (let i = 0; i < 10; i++) {
      result = checkSpam(uid, `Mesaj ${i}`);
    }
    expect(result.blocked).toBe(true);
  });

  it('aynı içerik tekrarı spam tespiti yapar', () => {
    const uid = 'spam-dup-' + Date.now();
    let result;
    for (let i = 0; i < 5; i++) {
      result = checkSpam(uid, 'AYNI MESAJ');
    }
    expect(result.blocked).toBe(true);
  });
});
