// server/tests/search-context-sql.test.ts
//
// PLACEHOLDER ↔ PARAMETRE EŞLEŞMESİ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// PostgreSQL, sorgunun REFERANS VERDİĞİNDEN FAZLA parametre gönderilmesini
// REDDEDER:
//     bind message supplies 3 parameters, but prepared statement "" requires 2
//
// Bağlam modülünün ilk sürümü her kaynak için SABİT `[messageId, serverIds,
// userId]` gönderiyordu; oysa kanal ve thread sorguları kullanıcıyı hiç
// kullanmaz. Sonuç: kanal bağlamı HER ZAMAN başarısızdı, `catch` hatayı
// yutuyordu ve uç nokta YETKİLİ kullanıcıya bile 404 dönüyordu. Yetki
// testleri "404" beklediği için bu kusuru GÖRMEDİ — pozitif kontrol gerçek
// veritabanına karşı çalışana kadar sessiz kaldı.
//
// Bu AYNI SINIF kusur `fts.ts`te de olmuştu (kullanılmayan `$1` yüzünden
// sunucusuz kullanıcı kendi DM'lerini hiç arayamıyordu). İki kez olan şey
// üçüncü kez de olur; bu yüzden eşleşme artık testle sabitlenmiştir.
//
// Test SQL'i ÇALIŞTIRMAZ — metni okur. Sözleşme statiktir ve bu yüzden
// veritabanı olmadan da doğrulanabilir; asıl davranış `search-context.test.ts`
// ve `e2e/context-probe.mjs` ile ayrıca ölçülür.

process.env.NODE_ENV = 'test';

import {
  ANCHOR_SQL, ANCHOR_ROW_SQL, windowSql, anchorParams, windowParams,
  SERVER_SCOPED_SOURCES, type ContextSource,
} from '../db/postgres/search-context';

const SOURCES: ContextSource[] = ['channel', 'thread', 'dm', 'gdm'];

/** Sorgunun referans verdiği EN BÜYÜK `$N`. */
function maxPlaceholder(sql: string): number {
  const found = sql.match(/\$(\d+)/g) ?? [];
  return found.reduce((max, p) => Math.max(max, Number(p.slice(1))), 0);
}

/** Referans verilen TÜM `$N` kümesi — boşluk var mı diye. */
function placeholderSet(sql: string): Set<number> {
  return new Set((sql.match(/\$(\d+)/g) ?? []).map(p => Number(p.slice(1))));
}

const scope = { userId: 'u1', serverIds: ['s1', 's2'] };

describe.each(SOURCES)('kaynak: %s', (source) => {
  it('ÇAPA sorgusu tam olarak gönderilen parametre sayısını ister', () => {
    const params = anchorParams(source, 'm1', scope);
    expect(maxPlaceholder(ANCHOR_SQL[source])).toBe(params.length);
  });

  it('ÇAPA GÖVDESİ sorgusu tam olarak gönderilen parametre sayısını ister', () => {
    const params = anchorParams(source, 'm1', scope);
    expect(maxPlaceholder(ANCHOR_ROW_SQL[source])).toBe(params.length);
  });

  it('PENCERE sorguları tam olarak gönderilen parametre sayısını ister', () => {
    const params = windowParams(source, 'scope-1', scope, 1000, 2);
    for (const dir of ['before', 'after'] as const) {
      expect(maxPlaceholder(windowSql(source, dir))).toBe(params.length);
    }
  });

  it('placeholder numaralarında BOŞLUK yok ($1..$N kesintisiz)', () => {
    // `$1, $3` gibi bir dizilim de aynı hatayı üretir: $2 gönderilir ama
    // kullanılmaz.
    for (const sql of [ANCHOR_SQL[source], ANCHOR_ROW_SQL[source],
                       windowSql(source, 'before'), windowSql(source, 'after')]) {
      const used = placeholderSet(sql);
      for (let i = 1; i <= maxPlaceholder(sql); i++) {
        expect(used.has(i)).toBe(true);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('parametre içeriği doğru kapsamı taşır', () => {
  it('sunucuya bağlı kaynaklar SUNUCU listesini alır', () => {
    for (const source of SERVER_SCOPED_SOURCES) {
      expect(anchorParams(source, 'm1', scope)).toEqual(['m1', ['s1', 's2']]);
    }
  });

  it('kullanıcıya bağlı kaynaklar KULLANICI kimliğini alır', () => {
    for (const source of ['dm', 'gdm'] as ContextSource[]) {
      expect(anchorParams(source, 'm1', scope)).toEqual(['m1', 'u1']);
    }
  });

  it('DM/grup DM sorgusuna sunucu listesi HİÇ girmez', () => {
    // Sunucu kimliklerini kullanıcıya bağlı bir sorguya sızdırmak anlamsız
    // olurdu ve yukarıdaki bind hatasını geri getirirdi.
    for (const source of ['dm', 'gdm'] as ContextSource[]) {
      const params = windowParams(source, 'dm-1', scope, 1000, 2);
      expect(params).not.toContainEqual(['s1', 's2']);
      expect(params).toEqual(['dm-1', 'u1', 1000, 2]);
    }
  });

  it('pencere sınırı SON parametredir (LIMIT $N)', () => {
    for (const source of SOURCES) {
      const params = windowParams(source, 'x', scope, 1000, 4);
      const sql = windowSql(source, 'before');
      expect(sql).toMatch(new RegExp(`LIMIT \\$${params.length}`));
      expect(params[params.length - 1]).toBe(4);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('yetki yüklemleri her sorguda TEKRARLANIR', () => {
  it('DM sorguları katılımcılık şart koşar', () => {
    for (const sql of [ANCHOR_SQL.dm, ANCHOR_ROW_SQL.dm,
                       windowSql('dm', 'before'), windowSql('dm', 'after')]) {
      expect(sql).toMatch(/c\.participants \?/);
    }
  });

  it('grup DM sorguları üyelik JOIN\'i şart koşar', () => {
    for (const sql of [ANCHOR_SQL.gdm, ANCHOR_ROW_SQL.gdm,
                       windowSql('gdm', 'before'), windowSql('gdm', 'after')]) {
      expect(sql).toMatch(/JOIN group_dm_members/);
    }
  });

  it('kanal/thread sorguları sunucu üyeliği şart koşar', () => {
    for (const source of SERVER_SCOPED_SOURCES) {
      for (const sql of [ANCHOR_SQL[source], ANCHOR_ROW_SQL[source],
                         windowSql(source, 'before'), windowSql(source, 'after')]) {
        expect(sql).toMatch(/"serverId" = ANY\(\$\d\)/);
      }
    }
  });

  it('şifreli içerik HER kanal ve DM sorgusunda dışarıdadır', () => {
    for (const sql of [ANCHOR_SQL.channel, ANCHOR_ROW_SQL.channel,
                       windowSql('channel', 'before'), windowSql('channel', 'after')]) {
      expect(sql).toMatch(/type <> 'e2ee'/);
    }
    for (const sql of [ANCHOR_SQL.dm, ANCHOR_ROW_SQL.dm,
                       windowSql('dm', 'before'), windowSql('dm', 'after')]) {
      expect(sql).toMatch(/"isEncrypted" = FALSE/);
      expect(sql).toMatch(/e2e = FALSE/);
    }
  });

  it('silinmiş kanal mesajları HER sorguda dışarıdadır', () => {
    for (const sql of [ANCHOR_SQL.channel, ANCHOR_ROW_SQL.channel,
                       windowSql('channel', 'before'), windowSql('channel', 'after')]) {
      expect(sql).toMatch(/"deletedAt" IS NULL/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('pencere yönü', () => {
  it('ÖNCE sorgusu geriye, SONRA sorgusu ileriye bakar', () => {
    for (const source of SOURCES) {
      expect(windowSql(source, 'before')).toMatch(/"createdAt" < \$\d/);
      expect(windowSql(source, 'after')).toMatch(/"createdAt" > \$\d/);
    }
  });

  it('ÖNCE sorgusu çapaya EN YAKIN satırları alır (DESC)', () => {
    // ASC olsaydı kanalın EN ESKİ mesajları dönerdi — çapayla ilgisiz.
    for (const source of SOURCES) {
      expect(windowSql(source, 'before')).toMatch(/ORDER BY .*DESC/);
      expect(windowSql(source, 'after')).toMatch(/ORDER BY .*ASC/);
    }
  });

  it('çapa pencerelerin DIŞINDADIR (kesin karşılaştırma)', () => {
    // `<=` / `>=` olsaydı çapa üç kez dönerdi.
    for (const source of SOURCES) {
      expect(windowSql(source, 'before')).not.toMatch(/"createdAt" <= /);
      expect(windowSql(source, 'after')).not.toMatch(/"createdAt" >= /);
    }
  });
});
