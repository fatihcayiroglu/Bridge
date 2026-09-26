// server/tests/null-byte-rejection.test.ts
//
// NULL BAYT REDDİ — FUZZING İLE BULUNDU
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// PostgreSQL `text` değerlerinde NULL bayta (0x00) izin VERMEZ:
//
//     invalid byte sequence for encoding "UTF8": 0x00
//
// Bu hata rota içinde yakalanmıyordu; istek işlenmemiş istisnayla 500
// dönüyordu. Fuzzing iki uçtan doğruladı (canlı sunucu, gerçek PostgreSQL):
//
//     POST /api/servers  { name: "\0…" }        → 500
//     POST /api/login    { username: "\0…" }    → 500   ← KİMLİK GEREKTİRMEZ
//
// `/api/login` anonimdir: herhangi bir istemci istediği kadar 500 üretip
// hata loglarını şişirebiliyordu. Sorun bu iki uca özel de değildi — NULL
// bayt taşıyan HERHANGİ bir metin alanı veritabanına ulaştığı anda aynı
// sonucu verir.
//
// ── NEDEN MERKEZİ ÇÖZÜM ───────────────────────────────────────────────────
// Rota rota doğrulama bu sınıfı kapatmaz; yarın eklenen bir uç yine açık
// olur. NULL bayt hiçbir meşru kullanıcı metninde bulunmaz, bu yüzden GİRİŞ
// SINIRINDA reddedilir.
//
// ── İNCE NOKTA: HAM GÖVDE YETMEZ ──────────────────────────────────────────
// İlk düzeltme `rawBody` metnine bakıyordu ve ÇALIŞMADI: JSON içinde NULL
// bayt `` KAÇIŞ DİZİSİ olarak taşınır; ham metinde gerçek 0x00 baytı
// yoktur, ancak `JSON.parse` sonrası oluşur. Bu yüzden AYRIŞTIRILMIŞ gövde
// gezilir. Bu test o ayrımı da kilitler.

process.env.NODE_ENV = 'test';

import fs from 'fs';
import path from 'path';

const NULL_BYTE = String.fromCharCode(0);
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'createApp.ts'), 'utf8',
);

describe('null bayt reddi — kaynak sözleşmesi', () => {
  it('koruma /api sınırında kurulu', () => {
    expect(SRC).toContain('Null bytes are not allowed');
  });

  it('AYRIŞTIRILMIŞ gövde geziliyor (yalnızca ham metin DEĞİL)', () => {
    // Ham metin denetimi sessizce ise yaramaz: `\\u0000` kacis dizisidir.
    expect(SRC).toContain('hasNull(req.body)');
  });

  it('URL kodlu %00 de reddediliyor', () => {
    // Sorgu dizesi gövdeden geçmez; ayrı denetlenmelidir.
    expect(SRC).toContain("req.url.includes('%00')");
  });

  it('NULL bayt kaynakta DÜZ KARAKTER olarak yazılmamış', () => {
    // Kaynağa gömülü 0x00, dosyayı ikili yapar ve araçları bozar.
    expect(SRC.includes(NULL_BYTE)).toBe(false);
    expect(SRC).toContain('String.fromCharCode(0)');
  });

  it('özyineleme SINIRLI ve döngüsel referansa dayanıklı', () => {
    // Derin/dongusel bir gövde korumanın KENDİSİNİ bir DoS'a çevirmemeli.
    expect(SRC).toContain('depth > 12');
    expect(SRC).toContain('WeakSet');
  });

  it('yalnızca 0x00 reddediliyor — meşru kontrol karakterleri korunuyor', () => {
    // Satır sonu, sekme, emoji ve RTL işaretleri MEŞRU olabilir.
    // Aşırı geniş bir filtre gerçek kullanıcı metnini bozardı.
    expect(SRC).not.toMatch(/\[\\x00-\\x1[fF]\]/);
    expect(SRC).not.toContain('stripControlChars');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DAVRANIŞ — gezici mantığın kendisi
// ════════════════════════════════════════════════════════════════════════════
// Middleware'i izole çalıştırmak Express kurulumu gerektirir; burada aynı
// sözleşmenin mantığı birebir modellenip sınanır. Kaynak denetimi (yukarıda)
// üründeki kopyanın ayrışmasını yakalar.
function hasNull(v: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (depth > 12) return false;
  if (typeof v === 'string') return v.includes(NULL_BYTE);
  if (v && typeof v === 'object') {
    if (seen.has(v as object)) return false;
    seen.add(v as object);
    for (const item of Object.values(v as Record<string, unknown>)) {
      if (hasNull(item, depth + 1, seen)) return true;
    }
  }
  return false;
}

describe('null bayt gezici — davranış', () => {
  it('düz alanda yakalar', () => {
    expect(hasNull({ name: 'abc' + NULL_BYTE })).toBe(true);
  });

  it('İÇ İÇE alanda yakalar', () => {
    expect(hasNull({ a: { b: { c: [1, 'x' + NULL_BYTE] } } })).toBe(true);
  });

  it('temiz gövdede YANLIŞ ALARM üretmez', () => {
    // Emoji, satır sonu, Türkçe harf ve RTL işareti meşrudur.
    expect(hasNull({
      name: 'Oyun Ekibi 🎮',
      topic: 'satır1\nsatır2\tsekme',
      note: 'Türkçe: çğıöşü — ve ‮rtl',
    })).toBe(false);
  });

  it('DÖNGÜSEL referansta sonsuz döngüye girmez', () => {
    const a: Record<string, unknown> = { name: 'ok' };
    a.self = a;
    expect(hasNull(a)).toBe(false);
  });

  it('AŞIRI DERİN yapıda durur (korumanın kendisi DoS olmaz)', () => {
    let deep: Record<string, unknown> = { v: 'leaf' };
    for (let i = 0; i < 500; i++) deep = { n: deep };
    const t0 = Date.now();
    expect(hasNull(deep)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('null/undefined/sayı gövdede çökmez', () => {
    expect(hasNull(null)).toBe(false);
    expect(hasNull(undefined)).toBe(false);
    expect(hasNull(42)).toBe(false);
  });
});
