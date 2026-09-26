// server/tests/pgcollection-column-whitelist.test.ts
// PgCollection ALLOWED_COLUMNS — GERÇEK sınıf, mockDb YOK.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// `ALLOWED_COLUMNS`, kolon ADLARI için SQL-injection savunmasıdır: pg sürücüsü
// identifier'ları parametreleyemez, bu yüzden whitelist zorunludur
// (pgCollection.ts:80-93).
//
// SESSİZ ÜRETİM HATASI: şemada TANIMLI olduğu hâlde listeye eklenmemiş
// sütunlar vardı. `insert()` her anahtarı `assertValidColumn`'dan geçirdiği
// için (pgCollection.ts:336) bu yollar GERÇEK PostgreSQL'de
// `Unknown column name` fırlatıyordu — ama tüm sunucu testleri `db/loader`'ı
// mockDb ile değiştirdiğinden ve mockDb böyle bir doğrulama YAPMADIĞINDAN
// testler yeşil kalıyordu. Özel emoji / sunucu GIF / soundboard yüklemeleri
// üretimde bu yüzden başarısız oluyordu.
//
// Bu dosya mockDb'yi BİLEREK kullanmaz: gerçek PgCollection örneklenir ve
// sahte bir pool verilir. `assertValidColumn` her sorgudan ÖNCE çalıştığı
// için veritabanına hiç ihtiyaç yoktur.

import { PgCollection } from '../db/postgres/pgCollection';

/** Sorgu çalıştırılırsa yakalayan sahte pool — DB'ye asla bağlanılmaz. */
function makePool(): { pool: never; sql: string[] } {
  const sql: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (text: string) => {
        sql.push(text);
        return { rows: /^INSERT\s/i.test(text) ? [{ _id: 'inserted-fixture' }] : [], rowCount: 1 };
      },
      release: () => {},
    }),
  } as unknown as never;
  return { pool, sql };
}

function col(table: string) {
  const { pool, sql } = makePool();
  return { col: new PgCollection(pool, table), sql };
}

// ════════════════════════════════════════════════════════════════════════════
// Daha önce üretimde patlayan gerçek yollar
// ════════════════════════════════════════════════════════════════════════════
describe('ALLOWED_COLUMNS — gerçek şema sütunları kabul edilir', () => {
  it('server_emojis: uploadedBy ile insert BAŞARILI (özel emoji yükleme)', async () => {
    const { col: emojis, sql } = col('server_emojis');

    await expect(emojis.insert({
      _id: 'e1', serverId: 's1', name: 'kek', url: '/uploads/e.png',
      uploadedBy: 'u1', createdAt: 1,
    } as never)).resolves.toBeDefined();

    expect(sql[0]).toContain('INSERT INTO "server_emojis"');
    expect(sql[0]).toContain('"uploadedBy"');
  });

  it('server_gifs: uploadedBy ile insert BAŞARILI', async () => {
    const { col: gifs } = col('server_gifs');

    await expect(gifs.insert({
      _id: 'g1', serverId: 's1', name: 'gif', url: '/uploads/g.gif',
      uploadedBy: 'u1', createdAt: 1,
    } as never)).resolves.toBeDefined();
  });

  it('soundboard: uploadedBy ile insert BAŞARILI', async () => {
    const { col: sounds } = col('soundboard');

    await expect(sounds.insert({
      _id: 'sb1', serverId: 's1', name: 'ses', url: '/uploads/s.mp3',
      uploadedBy: 'u1', createdAt: 1,
    } as never)).resolves.toBeDefined();
  });

  it('onboarding_completions: completedAt ile insert BAŞARILI', async () => {
    const { col: c } = col('onboarding_completions');

    await expect(c.insert({
      _id: 'u1_s1', userId: 'u1', serverId: 's1', completedAt: 1,
    } as never)).resolves.toBeDefined();
  });

  it('messages: deletedAt ile update BAŞARILI (yumuşak silme)', async () => {
    const { col: msgs } = col('messages');

    await expect(msgs.update(
      { _id: 'm1' } as never,
      { $set: { content: '[Mesaj silindi]', deletedAt: 1 } } as never,
    )).resolves.toBeDefined();
  });

  it('outgoing_webhooks: enabled ile sorgu BAŞARILI', async () => {
    const { col: hooks, sql } = col('outgoing_webhooks');

    await expect(hooks.find({ serverId: 's1', enabled: true } as never)).resolves.toBeDefined();
    expect(sql[0]).toContain('"enabled"');
  });

  it('ap_delivery_queue: nextAt aralık sorgusu BAŞARILI', async () => {
    const { col: q } = col('ap_delivery_queue');

    await expect(q.find({ nextAt: { $lte: 99 } } as never)).resolves.toBeDefined();
  });

  it('saved_messages: kanonik hedef kimlikleriyle insert BAŞARILI', async () => {
    const { col: saved, sql } = col('saved_messages');

    await expect(saved.insert({
      _id: 'saved-1', userId: 'u1', destinationType: 'channel',
      destinationId: 'c1', messageId: 'm1', createdAt: 1,
    } as never)).resolves.toBeDefined();

    expect(sql[0]).toContain('INSERT INTO "saved_messages"');
    expect(sql[0]).toContain('"destinationType"');
    expect(sql[0]).toContain('"destinationId"');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Koruma HÂLÂ ayakta olmalı — bu bir gevşetme değildir
// ════════════════════════════════════════════════════════════════════════════
describe('ALLOWED_COLUMNS — enjeksiyon savunması korunur', () => {
  it('GÜVENLİK: bilinmeyen kolon adı REDDEDİLİR', async () => {
    const { col: emojis } = col('server_emojis');

    await expect(emojis.insert({ _id: 'x', uydurma_kolon: 1 } as never))
      .rejects.toThrow(/Unknown column name/);
  });

  it('GÜVENLİK: SQL enjeksiyon denemesi kolon adı olarak REDDEDİLİR', async () => {
    const { col: emojis, sql } = col('server_emojis');

    await expect(emojis.insert({
      _id: 'x', 'name"; DROP TABLE users; --': 'kotu',
    } as never)).rejects.toThrow(/Unknown column name/);

    expect(sql).toHaveLength(0);   // hiçbir sorgu ÇALIŞTIRILMADI
  });

  it('GÜVENLİK: WHERE koşulunda da bilinmeyen kolon REDDEDİLİR', async () => {
    const { col: emojis, sql } = col('server_emojis');

    // `find()` bir zincir (thenable) döndürür ve doğrulama `.then` içinde
    // SENKRON çalışır; bu yüzden `.rejects` yerine sarmalayıcı kullanılır.
    await expect(
      (async () => { await emojis.find({ uydurma_kolon: 1 } as never); })(),
    ).rejects.toThrow(/Unknown column name/);

    expect(sql).toHaveLength(0);   // sorgu hiç kurulmadı
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SINIFI KAPATAN DEĞİŞMEZ (v1.123)
// ════════════════════════════════════════════════════════════════════════════
// Yukarıdaki testler sütunları TEK TEK sayar. Bu, hatayı ancak biri o sütunu
// hatırlayıp test yazdığında yakalar — ve tam olarak burada başarısız oldu:
// v1.123 gerçek ortam doğrulamasında şemada TANIMLI ama listede OLMAYAN
// 6 sütun bulundu. İkisi canlı 500 üretiyordu:
//
//   POST  /api/threads                     → 500  ("locked")
//   PATCH /api/podcast/:channelId/settings → 500  ("language", "explicit")
//
// Bu testler yeşildi, çünkü hiçbiri o sütunlara dokunmuyordu.
//
// Bu yüzden aşağıdaki test tek tek saymaz: şema kaynağını OKUR ve listeyle
// karşılaştırır. Yeni bir `CREATE TABLE` sütunu ya da `ADD COLUMN` göçü
// listeye eklenmeden gelirse, o sütuna dokunan bir test yazılmasa bile bu
// test kırmızıya döner.
//
// GÜVENLİK: değişmez yalnızca "şemada VAR ama listede YOK" yönünde çalışır.
// Listeyi genişletmek için şemada gerçekten tanımlı olmak gerekir; koruma
// gevşetilmez, yalnızca şemayla hizada tutulur.
describe('ALLOWED_COLUMNS şemayla hizalıdır (sınıf değişmezi)', () => {
  const readSource = (relative: string): string =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('fs') as typeof import('fs'))
      .readFileSync((require('path') as typeof import('path')).join(__dirname, '..', relative), 'utf8');

  /** `ALLOWED_COLUMNS` Set'indeki adlar — yorum satırları ATILIR. */
  function allowedColumns(): Set<string> {
    const src = readSource('db/postgres/pgCollection.ts');
    const start = src.indexOf('const ALLOWED_COLUMNS');
    const end = src.indexOf(']);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Türkçe kesme işareti ("Set'ini", "122'si") tırnak eşliğini bozduğu için
    // yorumlar ayıklanmadan yapılan bir eşleme YANLIŞ sonuç verir.
    const body = src.slice(start, end)
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    return new Set([...body.matchAll(/'([^']+)'/g)].map(m => m[1]));
  }

  /** `CREATE TABLE` gövdelerinde ve `ADD COLUMN` göçlerinde geçen sütun adları. */
  function declaredColumns(): Map<string, string> {
    const found = new Map<string, string>();   // sütun → nerede tanımlandığı

    const schema = readSource('db/postgres/schema.ts');
    for (const table of schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
      const [, tableName, columns] = table;
      for (const line of columns.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('--')) continue;
        // Sütun tanımı: `"adı" TİP …` ya da `adı TİP …`. Tablo kısıtları atlanır.
        const match = /^"?([A-Za-z_][A-Za-z0-9_]*)"?\s+[A-Za-z]/.exec(trimmed);
        if (!match) continue;
        const name = match[1];
        // Tablo kisitlari ve (cok satirli CHECK/fonksiyon govdelerinden gelen)
        // SQL anahtar sozcukleri sutun DEGILDIR.
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|AND|OR|NOT|SELECT|FROM|WHERE|RETURN|IF|LOOP|END|CASE|WHEN|THEN|ELSE|BEGIN|DECLARE|EXCEPTION)$/i.test(name)) continue;
        if (!found.has(name)) found.set(name, `schema.ts → ${tableName}`);
      }
    }

    const migrations = readSource('db/postgres/migrations.ts');
    for (const add of migrations.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS "?([A-Za-z_][A-Za-z0-9_]*)"?/g))
      if (!found.has(add[2])) found.set(add[2], `migrations.ts → ${add[1]}`);

    return found;
  }

  it('şemada tanımlı HER sütun listede vardır', () => {
    const allowed = allowedColumns();
    const declared = declaredColumns();

    // Ayrıştırma gerçekten çalıştı mı? Boş bir sonuç testi sessizce
    // anlamsızlaştırırdı.
    expect(allowed.size).toBeGreaterThan(300);
    expect(declared.size).toBeGreaterThan(200);

    const missing = [...declared.entries()]
      .filter(([name]) => !allowed.has(name))
      .map(([name, origin]) => `${name}  (${origin})`)
      .sort();

    expect(missing).toEqual([]);
  });

  it('v1.123 üretim 500\'lerine yol açan sütunlar listededir', () => {
    const allowed = allowedColumns();
    // Gerileme koruması: bunlar ölçülmüş canlı hatalardır, varsayım değil.
    for (const column of ['locked', 'language', 'explicit', 'bridgeMessageId', 'crosspostedAt', 'lastPlayedAt'])
      expect(allowed.has(column)).toBe(true);
  });
});
