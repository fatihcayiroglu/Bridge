// server/tests/security.test.ts
// lib/security — sanitizasyon, anti-spam, URL doğrulama
// Sprint 50: JS → TypeScript dönüşümü

process.env.NODE_ENV = 'test';

import {
  sanitizeMessage,
  sanitizeUsername,
  sanitizeDisplayName,
  isSafeUrl,
  checkSpam,
  checkSpamAsync,
} from '../lib/security';

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

  it('null / undefined / number için boş string döner', () => {
    expect(sanitizeMessage(null as never)).toBe('');
    expect(sanitizeMessage(undefined as never)).toBe('');
    expect(sanitizeMessage(123 as never)).toBe('');
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

  it('null için boş string döner', () => {
    expect(sanitizeUsername(null as never)).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════
// DISPLAY NAME SANİTİZASYONU
// ══════════════════════════════════════════════════════════════
describe('sanitizeDisplayName', () => {
  it('normal ismi değiştirmez', () => {
    expect(sanitizeDisplayName('Ali Veli')).toBe('Ali Veli');
  });

  it('Türkçe karakter ve boşluğu korur', () => {
    expect(sanitizeDisplayName('Çağrı Şen')).toBe('Çağrı Şen');
  });

  it('HTML tag kaldırır', () => {
    expect(sanitizeDisplayName('<b>Ali</b>')).toBe('Ali');
  });

  it('script tag temizler', () => {
    const result = sanitizeDisplayName('<script>alert(1)</script>Ali');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).toContain('Ali');
  });

  it('javascript: protokolünü temizler', () => {
    expect(sanitizeDisplayName('javascript:alert(1)')).not.toContain('javascript:');
  });

  it('büyük/küçük harf ve boşluklu javascript: temizler', () => {
    expect(sanitizeDisplayName('Javascript : alert(1)')).not.toMatch(/javascript\s*:/i);
  });

  it('data: URI temizler', () => {
    expect(sanitizeDisplayName('data:text/html,<h1>x</h1>')).not.toContain('data:');
  });

  it('event handler temizler', () => {
    expect(sanitizeDisplayName('Ali onerror=x')).not.toContain('onerror=');
    expect(sanitizeDisplayName('onclick=hack()')).not.toContain('onclick=');
  });

  it('null byte temizler', () => {
    expect(sanitizeDisplayName('Ali\u0000Veli')).not.toContain('\u0000');
  });

  it('zero-width karakter temizler', () => {
    expect(sanitizeDisplayName('Ali\u200BVeli')).not.toContain('\u200B');
    expect(sanitizeDisplayName('Ali\uFEFFVeli')).not.toContain('\uFEFF');
  });

  it('32 karakterde kırpar', () => {
    expect(sanitizeDisplayName('a'.repeat(50)).length).toBeLessThanOrEqual(32);
  });

  it('null / undefined için boş string döner', () => {
    expect(sanitizeDisplayName(null as never)).toBe('');
    expect(sanitizeDisplayName(undefined as never)).toBe('');
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
// ANTİ-SPAM — sync (in-memory fallback)
// ══════════════════════════════════════════════════════════════
describe('checkSpam (sync)', () => {
  const userId = 'spam-test-user-' + Date.now();

  it('normal kullanımda blocked: false döner', () => {
    const result = checkSpam(userId + '-normal', 'Merhaba');
    expect(result.blocked).toBe(false);
  });

  it('hızlı mesajlar spam tespiti yapar', () => {
    const uid = 'spam-fast-' + Date.now();
    let result: ReturnType<typeof checkSpam> = { blocked: false };
    for (let i = 0; i < 10; i++) {
      result = checkSpam(uid, `Mesaj ${i}`);
    }
    expect(result.blocked).toBe(true);
  });

  it('aynı içerik tekrarı spam tespiti yapar', () => {
    const uid = 'spam-dup-' + Date.now();
    let result: ReturnType<typeof checkSpam> = { blocked: false };
    for (let i = 0; i < 5; i++) {
      result = checkSpam(uid, 'AYNI MESAJ');
    }
    expect(result.blocked).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// ANTİ-SPAM — async (Redis-backed, in-memory fallback ile)
// Redis test ortamında olmayabilir; her iki durumda da doğru çalışmalı
// ══════════════════════════════════════════════════════════════
describe('checkSpamAsync (Redis-backed)', () => {
  it('normal kullanımda blocked: false döner', async () => {
    const uid = 'spam-async-normal-' + Date.now();
    const result = await checkSpamAsync(uid, 'Merhaba');
    expect(result.blocked).toBe(false);
  });

  it('hızlı mesajlar spam tespiti yapar', async () => {
    const uid = 'spam-async-fast-' + Date.now();
    let result: Awaited<ReturnType<typeof checkSpamAsync>> = { blocked: false };
    for (let i = 0; i < 10; i++) {
      result = await checkSpamAsync(uid, `Mesaj ${i}`);
    }
    expect(result.blocked).toBe(true);
  });

  it('aynı içerik tekrarı spam tespiti yapar', async () => {
    const uid = 'spam-async-dup-' + Date.now();
    let result: Awaited<ReturnType<typeof checkSpamAsync>> = { blocked: false };
    for (let i = 0; i < 5; i++) {
      result = await checkSpamAsync(uid, 'AYNI MESAJ');
    }
    expect(result.blocked).toBe(true);
  });

  it('mute sonrası blocked: true + remainingMs döner', async () => {
    const uid = 'spam-async-mute-' + Date.now();
    // Önce mute'u tetikle
    for (let i = 0; i < 12; i++) {
      await checkSpamAsync(uid, `hız-${i}`);
    }
    const result = await checkSpamAsync(uid, 'sonraki mesaj');
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe('spam_muted');
      expect(result.remainingMs).toBeGreaterThan(0);
    }
  });
});
