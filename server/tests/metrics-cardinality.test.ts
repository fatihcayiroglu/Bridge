// server/tests/metrics-cardinality.test.ts
//
// METRİK KARDİNALİTESİ — İZLEMENİN KENDİSİ SALDIRI YÜZEYİ OLMAMALI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK (P2)
// ════════════════════════════════════════════════════════════════════════════
// `route` bir Prometheus ETİKETİDİR: her farklı değer KALICI olarak yeni bir
// zaman serisi yaratır. Eski `normalizeRoute`, Express hiçbir rotayı
// eşleştiremediğinde HAM YOLA düşüyor ve yalnızca UUID/uzun-sayı
// normalizasyonu uyguluyordu:
//
//     return (req.path || req.url || '/')
//       .replace(/\/[0-9a-f]{8}-.../gi, '/:id')
//       .replace(/\/\d{6,}/g, '/:id');
//
// SÖMÜRÜ — kimlik doğrulaması GEREKTİRMEZ, çünkü 404'ler herkese açıktır:
//     GET /api/aaaa   GET /api/aaab   GET /api/aaac   ...
// Her istek YENİ bir seri üretirdi. Ucuz isteklerle sunucu sürecinde sınırsız
// bellek büyümesi ve metrik arkasında kardinalite patlaması oluşurdu.
//
// DÜZELTME: yalnızca GERÇEKTEN eşleşen rota kalıpları etiket olur; eşleşmeyen
// her şey tek bir `<unmatched>` kovasına düşer. Sinyal kaybı yoktur — eşleşen
// rotalar tam ayrıntısını korur ve 404 hacmi zaten toplu izlenmek istenir.

import {
  __normalizeRouteForTest as normalizeRoute,
  __UNMATCHED_ROUTE as UNMATCHED,
  classifySql,
} from '../middleware/metrics';
import type { Request } from 'express';

/** Express'in rota EŞLEŞTİRDİĞİ istek. */
const matched = (baseUrl: string, path: string) =>
  ({ route: { path }, baseUrl, method: 'GET' } as unknown as Request);

/** Rota eşleşmeyen istek (404, statik dosya, middleware sonlandırması). */
const unmatched = (url: string) =>
  ({ path: url, url, method: 'GET' } as unknown as Request);

// ════════════════════════════════════════════════════════════════════════════
// SÖMÜRÜ — gerileme kilidi
// ════════════════════════════════════════════════════════════════════════════
describe('kardinalite sınırı', () => {
  it('SÖMÜRÜ: 10 000 farklı eşleşmeyen yol TEK etiket üretir', () => {
    // Duzeltmeden ONCE bu 10 000 kalici zaman serisi demekti.
    const etiketler = new Set<string>();
    for (let i = 0; i < 10_000; i++) etiketler.add(normalizeRoute(unmatched(`/api/${i}-rastgele`)));
    expect({ farkliEtiket: etiketler.size }).toEqual({ farkliEtiket: 1 });
  });

  it('saldırgan tarafından seçilen metin ETİKETE sızmaz', () => {
    const kotu = '/api/' + 'x'.repeat(500) + '?q=' + 'y'.repeat(500);
    const etiket = normalizeRoute(unmatched(kotu));
    expect(etiket).toBe(UNMATCHED);
    expect(etiket.includes('x')).toBe(false);
  });

  it('UUID / uzun sayı / Unicode yollarının hepsi aynı kovaya düşer', () => {
    const yollar = [
      '/api/550e8400-e29b-41d4-a716-446655440000',
      '/api/1234567890',
      '/api/ünicode-yol-çğışü',
      '/api/../../etc/passwd',
      '/api/%00null',
    ];
    expect(new Set(yollar.map(y => normalizeRoute(unmatched(y)))).size).toBe(1);
  });

  it('etiket değeri KISA ve sabittir', () => {
    expect(normalizeRoute(unmatched('/herhangi/bir/yol')).length).toBeLessThan(24);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POZİTİF KONTROL — gerçek sinyal KORUNUR
// ════════════════════════════════════════════════════════════════════════════
describe('POZİTİF KONTROL: eşleşen rotalar ayrıntısını korur', () => {
  it('eşleşen rota KALIBI etiket olur', () => {
    // Bu olmadan yukaridaki testler "her seyi <unmatched> yap" gibi asiri
    // genis bir yamada da yesil kalirdi — ve tum HTTP metrikleri olurdu.
    expect(normalizeRoute(matched('/api/servers', '/:serverId/channels')))
      .toBe('/api/servers/:serverId/channels');
  });

  it('FARKLI rotalar FARKLI etiket üretir (ayrım korunur)', () => {
    const a = normalizeRoute(matched('/api/servers', '/:id'));
    const b = normalizeRoute(matched('/api/messages', '/:id'));
    expect({ ayni: a === b }).toEqual({ ayni: false });
  });

  it('kalıp parametreleri KİMLİK İÇERMEZ — kalıp olarak kalır', () => {
    // Ayni rota farkli kimliklerle cagrildiginda TEK seri olmali.
    const x = normalizeRoute(matched('/api/servers', '/:serverId'));
    const y = normalizeRoute(matched('/api/servers', '/:serverId'));
    expect({ x, y, ayni: x === y }).toEqual({ x: '/api/servers/:serverId', y: '/api/servers/:serverId', ayni: true });
  });

  it('rota kalıbı sayısı UYGULAMA tarafından SINIRLIDIR', () => {
    // Kalip sayisi kod tarafindan belirlenir; istemci onu secemez.
    const kaliplar = ['/:id', '/:id/members', '/:id/channels', '/'];
    const etiketler = new Set(kaliplar.map(p => normalizeRoute(matched('/api/servers', p))));
    expect(etiketler.size).toBe(kaliplar.length);
  });
});


// ============================================================================
// ETIKET DEGERI BOS OLMAMALI
// ============================================================================
// Bu test bir mutasyon kampanyasi bulgusundan dogdu. `UNMATCHED_ROUTE`
// sabitini `''` yapmak bu dosyadaki testlerin HICBIRINI bozmuyordu.
//
// ── DURUST DEGERLENDIRME ────────────────────────────────────────────────────
// O mutasyon GUVENLIK acisindan ESDEGERDIR: bos dize de tek bir sabittir,
// yani kardinalite yine 1'de sinirli kalir. Sinirsiz etiket uretimi OLMAZ.
// Bu yuzden "test bosluğu" olarak degil, ESDEGER MUTANT olarak siniflandi.
//
// Yine de bos etiketin GERCEK bir maliyeti var: Prometheus'ta `route=""`,
// etiketin HIC BULUNMAMASI ile ayni sekilde eslesir. Bu durumda eslesmeyen
// rotalar, route etiketi tasimayan baska serilerle SESSIZCE birlesir ve
// "eslesmeyen istek" sinyali gozlemlenemez hale gelir. Asagidaki iddia
// yalnizca bu ozelligi tutar — fazlasini degil.
describe('eslesmeyen rota etiketi gozlemlenebilir', () => {
  it('sentinel BOS DEGILDIR', () => {
    // Bos etiket "etiket yok" ile birlesir; sinyal kaybolur.
    expect(UNMATCHED).not.toBe('');
    expect(String(UNMATCHED).length).toBeGreaterThan(0);
  });

  it('eslesmeyen istekler bos olmayan tek bir etikete duser', () => {
    const a = normalizeRoute(unmatched('/rastgele/' + Math.random()));
    const b = normalizeRoute(unmatched('/baska/' + Math.random()));
    expect(a).toBe(b);
    expect(a).not.toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Final21 Phase 17 — SQL SINIFLANDIRMASI DA BIR ETIKET KAYNAGIDIR
// ════════════════════════════════════════════════════════════════════════════
// `classifySql` iki Prometheus etiketi uretir. Yanlis siniflandirma yavas sorguyu
// YANLIS seride saklar; sinirsiz `collection` ise ayni kardinalite patlamasini
// veritabani tarafindan geri getirir. Mevcut kapsam tek bir duman testiydi
// (BEGIN/INSERT/UPDATE/select); tx, ddl, other ve tablo cikarimi olculmemisti.
describe('classifySql — etiket kumesi sinirli ve dogru', () => {
  it.each([
    ['BEGIN', 'tx'],
    ['COMMIT', 'tx'],
    ['ROLLBACK', 'tx'],
    ['SAVEPOINT sp1', 'tx'],
    ['RELEASE sp1', 'tx'],
    ['CREATE TABLE t (a int)', 'ddl'],
    ['ALTER TABLE t ADD COLUMN b int', 'ddl'],
    ['DROP TABLE t', 'ddl'],
    ['VACUUM ANALYZE', 'other'],
    ['EXPLAIN SELECT 1', 'other'],
    ['', 'other'],
    ['-- yalnizca yorum\n', 'other'],
  ])('%s → operation %s', (sql, operation) => {
    expect(classifySql(sql).operation).toBe(operation);
  });

  it('bir islem ifadesi tablo adi TASIMAZ — etiket `other` kalir', () => {
    expect(classifySql('BEGIN')).toEqual({ operation: 'tx', collection: 'other' });
    expect(classifySql('DROP TABLE messages')).toEqual({ operation: 'ddl', collection: 'other' });
  });

  it('tablo adi INSERT/UPDATE/DELETE/WITH bicimlerinden cikarilir', () => {
    expect(classifySql('INSERT INTO ONLY voice_messages (a) VALUES ($1)').collection).toBe('voice_messages');
    expect(classifySql('UPDATE ONLY "members" SET nickname = $1').collection).toBe('members');
    expect(classifySql('DELETE FROM sessions WHERE id = $1').collection).toBe('sessions');
    expect(classifySql('WITH t AS (SELECT 1) SELECT * FROM threads').operation).toBe('with');
  });

  it('bir tablo adi gibi GORUNMEYEN her sey tek kovaya duser', () => {
    // Uzun/garip adlar seri sayisini buyutmemeli.
    expect(classifySql(`SELECT * FROM ${'a'.repeat(80)}`).collection).toBe('other');
    expect(classifySql('SELECT * FROM (VALUES (1)) v').collection).toBe('other');
  });
});
