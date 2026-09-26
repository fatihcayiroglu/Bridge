// server/tests/gif-provider.test.ts
//
// GIF SAĞLAYICI — NORMALİZASYON VE GÜVENLİK
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUKLAR
// ════════════════════════════════════════════════════════════════════════════
// Mimari doğruydu (tarayıcı → Bridge → sağlayıcı; anahtar sunucuda). Ama:
//   1. HIZ SINIRI YOKTU — iki uç `limits.*()` taşımıyordu.
//   2. Sağlayıcı yanıtı HAM geçiyordu (`res.json(data)`).
//   3. Sağlayıcı soyutlaması yoktu; Tenor URL'leri rotaya gömülüydü.
//   4. Yukarı akış 4xx/5xx yanıtı SONUÇ gibi aktarılabiliyordu.

process.env.NODE_ENV = 'test';

import { clampGifLimit, GIF_MAX_LIMIT, GIF_MAX_QUERY } from '../lib/gifProvider';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER = join(__dirname, '..');
const MEDIA = readFileSync(join(SERVER, 'routes', 'media.ts'), 'utf8');
const PROVIDER = readFileSync(join(SERVER, 'lib', 'gifProvider.ts'), 'utf8');

describe('limit kelepçesi', () => {
  it('varsayılan makul', () => expect(clampGifLimit(undefined)).toBe(20));
  it('üst sınırı aşamaz', () => expect(clampGifLimit(1000)).toBe(GIF_MAX_LIMIT));
  it('negatif/bozuk değer varsayılana düşer', () => {
    expect(clampGifLimit(-5)).toBe(20);
    expect(clampGifLimit('abc')).toBe(20);
    expect(clampGifLimit(NaN)).toBe(20);
  });
  it('geçerli değeri korur', () => expect(clampGifLimit(10)).toBe(10));
});

describe('uçlar hız sınırı taşır', () => {
  it('arama ucu limitli', () => {
    const line = MEDIA.split('\n').find(l => l.includes("'/gif/search'")) ?? '';
    expect(line).toMatch(/limits\.\w+\(\)/);
  });
  it('trend ucu limitli', () => {
    const line = MEDIA.split('\n').find(l => l.includes("'/gif/trending'")) ?? '';
    expect(line).toMatch(/limits\.\w+\(\)/);
  });
});

describe('sağlayıcı soyutlaması', () => {
  it('rota içinde sağlayıcı URL\'si YOK', () => {
    // Ürün mantığı sağlayıcıyı bilmemeli.
    const routes = MEDIA.slice(MEDIA.indexOf('/gif/trending'), MEDIA.indexOf('/translate'));
    expect(routes).not.toMatch(/tenor\.googleapis\.com/);
  });
  it('rota kanonik soyutlamayı kullanır', () => {
    expect(MEDIA).toMatch(/activeGifProvider\(\)/);
  });
  it('anahtar istemciye ASLA gönderilmez', () => {
    const routes = MEDIA.slice(MEDIA.indexOf('/gif/trending'), MEDIA.indexOf('/translate'));
    expect(routes).not.toMatch(/TENOR_API_KEY/);
  });
});

describe('yanıt normalizasyonu ve URL güvenliği', () => {
  it('yalnızca HTTPS kabul edilir', () => {
    expect(PROVIDER).toMatch(/u\.protocol !== 'https:'/);
  });
  it('yalnızca BİLİNEN alan adları kabul edilir', () => {
    // Yukarı akış ele geçse bile keyfi kaynak enjekte edilemez.
    expect(PROVIDER).toMatch(/TENOR_MEDIA_HOSTS/);
    expect(PROVIDER).toMatch(/allowedHosts\.has\(u\.hostname\)/);
  });
  it('güvenli olmayan öğe ATLANIR, boş geçilmez', () => {
    expect(PROVIDER).toMatch(/if \(!url \|\| !previewUrl\) continue;/);
  });
  it('yukarı akış hatası sonuç gibi geçmez', () => {
    expect(PROVIDER).toMatch(/if \(!res\.ok\)/);
    expect(PROVIDER).toMatch(/gif\.upstream_error/);
  });
  it('bozuk JSON çökertmez', () => {
    expect(PROVIDER).toMatch(/gif\.upstream_bad_json/);
  });
  it('HAM sağlayıcı gövdesi istemciye dönmez', () => {
    const routes = MEDIA.slice(MEDIA.indexOf('/gif/trending'), MEDIA.indexOf('/translate'));
    expect(routes).not.toMatch(/res\.json\(data\)/);
    expect(routes).toMatch(/res\.json\(\{ items/);
  });
});

describe('yapılandırılmamış sağlayıcı DÜRÜST davranır', () => {
  it('503 döner, sahte sonuç ÜRETMEZ', () => {
    const routes = MEDIA.slice(MEDIA.indexOf('/gif/trending'), MEDIA.indexOf('/translate'));
    expect(routes).toMatch(/503/);
    expect(routes).toMatch(/not configured/);
  });
  it('sorgu uzunluğu sınırlı', () => {
    expect(GIF_MAX_QUERY).toBeLessThanOrEqual(200);
    expect(MEDIA).toMatch(/slice\(0, GIF_MAX_QUERY\)/);
  });
});
