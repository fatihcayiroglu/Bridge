// server/tests/pg-integration/search-rank-window.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK PostgreSQL — ARAMA PUANLAMASI SINIRLI BİR PENCEREDE Mİ?
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN KUSUR (Final21, Faz 7 — F21-7-01) ─────────────────────────────
// Arama, eşleşen HER satırı `ts_rank_cd` ile puanlayıp sıralıyor, sonra LIMIT
// alıyordu. Maliyet O(eşleşme). 1.000.000 mesajlı bir kanalda yaygın bir
// kelime (133.333 eşleşme) için ölçüldü:
//
//     GIN indeks taraması       :    28.7 ms
//     puanlama + sıralama       : 1 943   ms
//     HTTP p95, 100k -> 1M      : 410 -> 2 636 ms   (bütçe 2 000 ms, <=3x)
//
// Düzeltmeden sonra aynı sorgu 141 ms. Birim testleri (`unified-search.test.ts`)
// SQL'in ŞEKLİNİ kilitler; bu dosya PLANLAYICININ GERÇEKTEN pencereyle
// sınırlandığını ve bunun DOĞRULUĞU ve YETKİLENDİRMEYİ bozmadığını kanıtlar.
//
// ── ÖLÇÜLEN ÜÇ ŞEY ──────────────────────────────────────────────────────────
//   1. SINIR   — puanlamaya giren satır sayısı <= FTS_RANK_WINDOW
//   2. DOĞRULUK — nadir terim, korpusun EN ESKİ mesajında bile bulunur
//   3. YETKİ   — izin verilmeyen kanalın DAHA YENİ eşleşmeleri pencereyi
//                doldurup izinli sonuçları AÇ BIRAKAMAZ (yetkilendirme
//                pencere LIMIT'inden ÖNCE uygulanır)
//
// Ürünün GERÇEK `messages` tablosu, GERÇEK GIN ifade indeksi ve
// `bridge_unaccent` gerekir. Yalnızca `PG_TEST_URL` verildiğinde çalışır;
// kendi satırlarını siler, şemaya dokunmaz.

import { ftsSearch, unifiedFtsSearch, FTS_RANK_WINDOW } from '../../db/postgres/fts';
import { pool as productPool } from '../../db/postgres/pool';

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const SERVER = 'pgt-rank-srv';
const ALLOWED = 'pgt-rank-allowed';
const FORBIDDEN = 'pgt-rank-forbidden';
const ALLOWED_ROWS = 12_000;        // 6.000'i yaygın kelimeyi içerir (> pencere)
const FORBIDDEN_ROWS = 3_000;       // HEPSİ yaygın kelime, HEPSİ izinli satırlardan YENİ
const BASE_TS = 1_700_000_000_000;

interface PlanNode {
  'Node Type': string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Subplan Name'?: string;
  'Parent Relationship'?: string;
  Plans?: PlanNode[];
}

RUN('gerçek PostgreSQL — arama puanlaması sınırlı pencerede', () => {
  const q = async (sql: string, params: unknown[] = []) => (await productPool.query(sql, params)).rows;

  beforeAll(async () => {
    await q('DELETE FROM messages WHERE "serverId" = $1', [SERVER]);

    // İzinli kanal: tek sayılı satırlar yaygın kelime ("ortak") içerir.
    // En ESKİ mesaj (g = 1) tek başına nadir kelimeyi ("nadirkelime") taşır.
    await q(
      `INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")
       SELECT 'pgt-a-' || g, $1, $2, 'pgt-u', 'pgt', 'PGT',
              CASE WHEN g = 1 THEN 'nadirkelime en eski mesaj'
                   WHEN g % 2 = 0 THEN 'ortak konu ' || g
                   ELSE 'baska bir sey ' || g END,
              $3::bigint + g
       FROM generate_series(1, ${ALLOWED_ROWS}) AS g`,
      [ALLOWED, SERVER, BASE_TS],
    );

    // Yasak kanal: AYNI sunucu, HEPSİ "ortak", HEPSİ izinli satırlardan YENİ.
    // Yetkilendirme pencereden SONRA uygulansaydı pencere bunlarla dolardı.
    await q(
      `INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")
       SELECT 'pgt-f-' || g, $1, $2, 'pgt-u', 'pgt', 'PGT',
              'ortak gizli ' || g,
              $3::bigint + ${ALLOWED_ROWS} + 1000 + g
       FROM generate_series(1, ${FORBIDDEN_ROWS}) AS g`,
      [FORBIDDEN, SERVER, BASE_TS],
    );

    // BİLİNÇLİ ANLAM DEĞİŞİKLİĞİNİN KİLİDİ: korpusun EN ESKİ ucunda, pencerenin
    // ÇOK dışında, yaygın terimi TEKRAR eden (dolayısıyla DAHA YÜKSEK
    // `ts_rank_cd` alan) mesajlar. Sınırsız puanlama bunları ilk sıraya koyardı;
    // pencereli puanlama onları KAPSAM DIŞI bırakır. Bu, belgelenmiş ödünleşimin
    // ta kendisidir ve biri pencereyi sessizce kaldırırsa bu test düşer.
    await q(
      `INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")
       SELECT 'pgt-old-' || g, $1, $2, 'pgt-u', 'pgt', 'PGT',
              'ortak ortak ortak ortak eski yuksek alaka ' || g,
              $3::bigint - 100000 + g
       FROM generate_series(1, 20) AS g`,
      [ALLOWED, SERVER, BASE_TS],
    );
    await q('ANALYZE messages');
  }, 300_000);

  afterAll(async () => {
    await q('DELETE FROM messages WHERE "serverId" = $1', [SERVER]);
    await productPool.end();
  });

  /** Ürünün ÇALIŞTIRDIĞI SQL'i yakalar; aynı SQL'i EXPLAIN ANALYZE ile koşar. */
  async function capturePlan(run: () => Promise<unknown>): Promise<{ plan: PlanNode; sql: string }> {
    const calls: Array<[string, unknown[]]> = [];
    const original = productPool.query.bind(productPool);
    const spy = jest.spyOn(productPool, 'query').mockImplementation(((sql: string, params: unknown[]) => {
      calls.push([sql, params]);
      return original(sql, params);
    }) as unknown as typeof productPool.query);
    try { await run(); } finally { spy.mockRestore(); }

    // Puanlanan (ilk) strateji: pencere LIMIT'i taşıyan sorgu.
    const ranked = calls.find(([sql]) => /ts_rank_cd/.test(sql));
    if (!ranked) throw new Error('puanlanan sorgu yakalanamadi');
    const rows = await q(`EXPLAIN (ANALYZE, FORMAT JSON) ${ranked[0]}`, ranked[1]);
    return { plan: (rows[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0].Plan, sql: ranked[0] };
  }

  /** Puanlama ÖNCESİ aday kümesini üreten Limit düğümlerinin gerçek satır sayıları. */
  function candidateLimitRows(root: PlanNode): number[] {
    const out: number[] = [];
    const walk = (n: PlanNode, insideCandidate: boolean) => {
      const candidate = insideCandidate
        || n['Subplan Name']?.startsWith('CTE candidates') === true
        || n['Node Type'] === 'Subquery Scan';
      if (candidate && n['Node Type'] === 'Limit') {
        out.push((n['Actual Rows'] ?? 0) * (n['Actual Loops'] ?? 1));
      }
      for (const c of n.Plans ?? []) walk(c, candidate);
    };
    walk(root, false);
    return out;
  }

  it('ftsSearch: yaygın terimde puanlamaya giren satır pencereyle SINIRLIDIR', async () => {
    const { plan } = await capturePlan(() => ftsSearch('ortak', [SERVER], 50, [ALLOWED]));
    const limits = candidateLimitRows(plan);
    expect(limits.length).toBeGreaterThan(0);
    // ASIL İDDİA: 6.000 eşleşme var ama puanlamaya en fazla pencere kadar satır girer.
    for (const rows of limits) expect(rows).toBeLessThanOrEqual(FTS_RANK_WINDOW);
  }, 120_000);

  it('ftsSearch: sonuçlar doğru, izinli ve pencerenin en yeni eşleşmelerinden', async () => {
    const rows = await ftsSearch('ortak', [SERVER], 50, [ALLOWED]) as Array<{ channelId: string; content: string; createdAt: string | number }>;
    // YETKİ: yasak kanalın 3.000 DAHA YENİ eşleşmesi pencereyi aç bırakamadı.
    expect(rows).toHaveLength(50);
    for (const r of rows) {
      expect(r.channelId).toBe(ALLOWED);
      expect(r.content).toContain('ortak');
    }
    // PENCERE ANLAMI: dönen her satır, izinli eşleşmelerin en yeni
    // FTS_RANK_WINDOW'u içindedir.
    const [{ edge }] = await q(
      `SELECT min("createdAt") AS edge FROM (
         SELECT "createdAt" FROM messages
         WHERE "serverId" = $1 AND "channelId" = $2 AND content LIKE 'ortak%'
         ORDER BY "createdAt" DESC LIMIT $3) w`,
      [SERVER, ALLOWED, FTS_RANK_WINDOW],
    );
    for (const r of rows) expect(Number(r.createdAt)).toBeGreaterThanOrEqual(Number(edge));

    // AYIRT EDİCİ İDDİA: pencerenin dışındaki eski ama DAHA ALAKALI mesajlar
    // sonuçta YOKTUR. Sınırsız puanlamada ilk 20 sonuç tam olarak bunlar olurdu.
    // (İlk sürümde bu test ayırt edici DEĞİLDİ: tüm eşleşmeler eşit puan
    // alıyordu ve eşitlik yeniden eskiye kırıldığı için sınırsız sorgu da aynı
    // satırları döndürüyordu — negatif kontrolde bu yüzden geçti.)
    expect(rows.some((r) => r.content.includes('eski yuksek alaka'))).toBe(false);
  }, 120_000);

  it('ftsSearch: NADİR terim korpusun EN ESKİ mesajında bile bulunur (geri çağırma kaybı yok)', async () => {
    const rows = await ftsSearch('nadirkelime', [SERVER], 50, [ALLOWED]) as Array<{ _id: string }>;
    expect(rows.map((r) => r._id)).toEqual(['pgt-a-1']);
  }, 120_000);

  it('ftsSearch: yasak kanal allowlist dışında kalınca HİÇ görünmez', async () => {
    const rows = await ftsSearch('gizli', [SERVER], 50, [ALLOWED]) as unknown[];
    expect(rows).toHaveLength(0);
  }, 120_000);

  it('unifiedFtsSearch: kanal kaynağı da pencereyle sınırlı, izinli ve aç kalmıyor', async () => {
    const { plan } = await capturePlan(() => unifiedFtsSearch(
      'ortak', { userId: 'pgt-u', serverIds: [SERVER], channelIds: [ALLOWED], sources: ['channel'] }, 50,
    ));
    const limits = candidateLimitRows(plan);
    expect(limits.length).toBeGreaterThan(0);
    for (const rows of limits) expect(rows).toBeLessThanOrEqual(FTS_RANK_WINDOW);

    const rows = await unifiedFtsSearch(
      'ortak', { userId: 'pgt-u', serverIds: [SERVER], channelIds: [ALLOWED], sources: ['channel'] }, 50,
    ) as Array<{ channelId: string }>;
    expect(rows).toHaveLength(50);
    for (const r of rows) expect(r.channelId).toBe(ALLOWED);
  }, 120_000);
});

export {};
