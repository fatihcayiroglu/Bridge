// server/tests/pg-integration/first-unread-scan-window.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK PostgreSQL — "İLK OKUNMAMIŞ" AYRACI TARAMASI SINIRLI MI?
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN KUSUR (Final21, Faz 8 — F21-8-03) ─────────────────────────────
// `Messages.findFirstUnreadAfter` her kanal açılışında beklenerek koşar.
// `userId != me` filtresi indeks sırasında satır satır uygulanır; okuma
// konumundan sonraki mesajların HEPSİ okuyucuya aitse tarama kanalın sonuna
// kadar yürür. 1.000.000 mesajlı bir kanalda ÖLÇÜLDÜ:
//
//     sınırsız : 18 813 ms   Rows Removed by Filter 999 999
//     sınırlı  :     19 ms   (tam FIRST_UNREAD_SCAN_WINDOW indeks satırı)
//
// Bu dosya ürünün ÇALIŞTIRDIĞI SQL'i yakalar, aynısını EXPLAIN ANALYZE ile
// koşar ve hem SINIRI hem ANLAMI doğrular. Yalnızca `PG_TEST_URL` ile çalışır;
// kendi satırlarını siler, şemaya dokunmaz.

const db = require('../../db/loader').default;
import { Messages } from '../../db/repositories';
import { FIRST_UNREAD_SCAN_WINDOW } from '../../db/repositories/MessageRepository';

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const CHANNEL = 'pgt-first-unread-ch';
const SERVER = 'pgt-first-unread-srv';
const READER = 'pgt-reader';
const OTHER = 'pgt-other';
const OWN_AFTER = FIRST_UNREAD_SCAN_WINDOW * 3;    // pencerenin çok ötesi
const BASE_TS = 1_700_000_000_000;

interface PlanNode {
  'Node Type': string;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

RUN('gerçek PostgreSQL — ilk okunmamış ayracı taraması sınırlı', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;

  beforeAll(async () => {
    await q('DELETE FROM messages WHERE "channelId" = $1 OR "channelId" LIKE $2', [CHANNEL, 'pgt-fu-bg-%']);

    // ── TEMSİLİ PLAN İÇİN ARKA PLAN HACMİ ────────────────────────────────
    // İlk sürüm yalnızca test kanalının ~3 000 satırını yazıyordu. O boyutta
    // planlayıcı ÜRETİMDEKİ planı SEÇMİYOR: kanal imleç indeksi yerine global
    // `createdAt` indeksi + Incremental Sort ya da Seq Scan + Sort kullanıyor.
    // Sort düğümü tembel çekmeyi bozar ve — daha kötüsü — negatif kontrolde
    // sınırsız sorgu Seq Scan'e düşüp YALNIZCA İndeks düğümlerini sayan ilk
    // ölçer hiçbir şey saymadan GEÇTİ. Üretimde tablo pek çok kanalın
    // mesajını taşır ve `channelId` seçicidir; 300 kanal × 1 000 satırlık arka
    // plan bu şekli yeniden kurar.
    await q(
      `INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")
       SELECT 'pgt-fu-bg-' || g, 'pgt-fu-bg-' || (g % 300), $1, 'bg-user', 'u', 'U', 'bg', $2::bigint + g
       FROM generate_series(1, 300000) AS g`,
      [SERVER, BASE_TS],
    );
    // g = 0          : okuma konumu (başkasının mesajı)
    // g = 1..OWN     : okuyucunun KENDİ mesajları
    // g = OWN + 1    : başkasının mesajı — pencerenin çok ötesinde
    await q(
      `INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")
       SELECT 'pgt-fu-' || lpad(g::text, 7, '0'), $1, $2,
              CASE WHEN g = 0 OR g = ${OWN_AFTER + 1} THEN $4 ELSE $3 END,
              'u', 'U', 'm' || g, $5::bigint + g
       FROM generate_series(0, ${OWN_AFTER + 1}) AS g`,
      [CHANNEL, SERVER, READER, OTHER, BASE_TS],
    );
    await q('ANALYZE messages');
  }, 300_000);

  afterAll(async () => {
    await q('DELETE FROM messages WHERE "channelId" = $1 OR "channelId" LIKE $2', [CHANNEL, 'pgt-fu-bg-%']);
    try { await db._pool.end(); } catch { /* zaten kapali */ }
  });

  /** Ürünün çalıştırdığı SQL'i yakalar ve aynısının planını döndürür. */
  async function planOf(run: () => Promise<unknown>): Promise<PlanNode> {
    const calls: Array<[string, unknown[]]> = [];
    const original = db._pool.query.bind(db._pool);
    const spy = jest.spyOn(db._pool, 'query').mockImplementation((sql: string, params: unknown[]) => {
      calls.push([sql, params]);
      return original(sql, params);
    });
    try { await run(); } finally { spy.mockRestore(); }
    const call = calls.find(([sql]) => /FROM messages/.test(sql) && /<>/.test(sql));
    if (!call) throw new Error('urun sorgusu yakalanamadi');
    const rows = await q(`EXPLAIN (ANALYZE, FORMAT JSON) ${call[0]}`, call[1]);
    return (rows[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0].Plan;
  }

  /**
   * Tabloyu OKUYAN her tarama düğümünün incelediği satır (döndürülen + filtrede
   * atılan). Yalnızca İndeks düğümlerini saymak YANLIŞTI: Seq Scan'e düşen bir
   * plan sıfır sayılıyor ve sınırsız sorgu testi geçiyordu.
   * `Subquery Scan`/`CTE Scan` tabloyu okumaz, dışarıda bırakılır.
   */
  function rowsExamined(root: PlanNode): number {
    let max = 0;
    const walk = (n: PlanNode) => {
      const type = n['Node Type'];
      if (/Scan/.test(type) && !/^(Subquery|CTE) Scan$/.test(type)) {
        max = Math.max(max, (n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0));
      }
      (n.Plans ?? []).forEach(walk);
    };
    walk(root);
    return max;
  }

  it('en kötü durum: okuyucunun kendi mesajları pencereyi aşınca tarama SINIRLI kalır', async () => {
    const plan = await planOf(() => Messages.findFirstUnreadAfter(CHANNEL, READER, BASE_TS, 'pgt-fu-0000000'));
    // ASIL İDDİA: 3.000 kendi mesajı var ama indeksten en fazla pencere kadar satır okunur.
    expect(rowsExamined(plan)).toBeLessThanOrEqual(FIRST_UNREAD_SCAN_WINDOW);
  }, 120_000);

  it('anlam: pencerenin ötesindeki okunmamış için ayraç YERLEŞTİRİLMEZ (en-iyi-çaba sözleşmesi)', async () => {
    const row = await Messages.findFirstUnreadAfter(CHANNEL, READER, BASE_TS, 'pgt-fu-0000000');
    expect(row).toBeNull();
  }, 120_000);

  it('anlam: pencere İÇİNDEKİ ilk yabancı mesaj DOĞRU bulunur', async () => {
    // İmleç, başkasının mesajından 10 satır öncesinde.
    const cursorG = OWN_AFTER - 10;
    const row = await Messages.findFirstUnreadAfter(
      CHANNEL, READER, BASE_TS + cursorG, `pgt-fu-${String(cursorG).padStart(7, '0')}`,
    ) as { _id?: string } | null;
    expect(row?._id).toBe(`pgt-fu-${String(OWN_AFTER + 1).padStart(7, '0')}`);
  }, 120_000);

  it('olağan okuyucu: imleçten sonraki İLK satır hemen döner (tembel çekme)', async () => {
    const plan = await planOf(() => Messages.findFirstUnreadAfter(CHANNEL, OTHER, BASE_TS, 'pgt-fu-0000000'));
    expect(rowsExamined(plan)).toBeLessThanOrEqual(2);
    const row = await Messages.findFirstUnreadAfter(CHANNEL, OTHER, BASE_TS, 'pgt-fu-0000000') as { _id?: string } | null;
    expect(row?._id).toBe('pgt-fu-0000001');
  }, 120_000);
});

export {};
