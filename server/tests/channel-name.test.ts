// server/tests/channel-name.test.ts
//
// KANAL ADI — TÜRKÇE HARFLER KORUNUR
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Görsel inceleme sırasında kenar çubuğunda ölçüldü:
//
//     "çok-uzun-bir-kanal-adı-örneği"  →  "-ok-uzun-bir-kanal-ad--rne-i"
//     "sohbet-odası"                   →  "sohbet-odas-"
//
// Normalizasyon `replace(/[^a-z0-9\-_]/g, '-')` idi ve TÜRKÇE HARFLERİN
// HEPSİNİ tireye çeviriyordu. Türkçe öncelikli bir üründe kullanıcı kanalını
// Türkçe adlandıramıyordu.
//
// Sistem kendi kendisiyle de çelişiyordu: `lib/security.ts` kanal adı
// doğrulayıcısı Türkçe harfleri AÇIKÇA kabul ediyor.

process.env.NODE_ENV = 'test';

import { normalizeChannelName } from '../lib/channelName';

describe('kanal adı — Türkçe korunur', () => {
  it('Türkçe harfler SİLİNMEZ', () => {
    expect(normalizeChannelName('sohbet-odası')).toBe('sohbet-odası');
    expect(normalizeChannelName('çay-molası')).toBe('çay-molası');
    expect(normalizeChannelName('güncellemeler')).toBe('güncellemeler');
    expect(normalizeChannelName('şikayetler')).toBe('şikayetler');
    expect(normalizeChannelName('öneriler')).toBe('öneriler');
    expect(normalizeChannelName('ğ-testi')).toBe('ğ-testi');
  });

  it('ÖLÇÜLEN kusur örneği artık doğru', () => {
    expect(normalizeChannelName('çok-uzun-bir-kanal-adı')).toBe('çok-uzun-bir-kanal-adı');
  });

  it('boşluk tireye dönüşür', () => {
    expect(normalizeChannelName('genel sohbet')).toBe('genel-sohbet');
    expect(normalizeChannelName('  çok   boşluk  ')).toBe('çok-boşluk');
  });
});

describe('kanal adı — güvenlik niyeti KORUNUR', () => {
  it('tehlikeli karakterler elenir', () => {
    // Yol ayracı, protokol, HTML/etiket karakterleri kanal adında olmamalı.
    expect(normalizeChannelName('a/b')).toBe('a-b');
    // Ters bolu: kaynakta KACIS olarak yazilir; aksi halde dosyaya gercek
    // bir backspace karakteri girer (ilk yazimda oyle olmustu).
    expect(normalizeChannelName(`a${String.fromCharCode(92)}b`)).toBe('a-b');
    expect(normalizeChannelName('<script>')).toBe('script');
    expect(normalizeChannelName('a@b#c')).toBe('a-b-c');
    expect(normalizeChannelName('../../etc')).toBe('etc');
  });

  it('ard arda tireler sadeleşir', () => {
    expect(normalizeChannelName('a!!!b')).toBe('a-b');
  });

  it('baştaki ve sondaki tireler atılır', () => {
    // Görsel incelemede "-ok-uzun..." diye baştan tireyle başlıyordu.
    expect(normalizeChannelName('!!!genel!!!')).toBe('genel');
    expect(normalizeChannelName('---a---')).toBe('a');
  });

  it('uzunluk sınırlanır', () => {
    expect(normalizeChannelName('a'.repeat(80)).length).toBeLessThanOrEqual(32);
  });

  it('küçük harfe indirilir', () => {
    expect(normalizeChannelName('GENEL')).toBe('genel');
  });

  it('boş/bozuk girdi çökertmez', () => {
    expect(normalizeChannelName('')).toBe('');
    expect(normalizeChannelName('   ')).toBe('');
    expect(normalizeChannelName(undefined as unknown as string)).toBe('');
  });
});

describe('normalizasyon DOĞRULAYICIYLA çelişmez', () => {
  it('doğrulayıcının kabul ettiği Türkçe ad normalizasyondan sağ çıkar', () => {
    // `lib/security.ts` → /^[a-z0-9\-_ğüşöçıİĞÜŞÖÇ ]+$/i
    const accepted = ['ğüşöçı', 'genel sohbet', 'proje_1'];
    for (const name of accepted) {
      const out = normalizeChannelName(name);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
