// server/tests/pg-integration/keyset-pagination-plan.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK PostgreSQL — SAYFALAMA GERÇEKTEN INDEKS ÜZERİNDEN SEEK EDİYOR MU?
// ════════════════════════════════════════════════════════════════════════════
// Birim testi (`tests/pgcollection-keyset-rowcompare.test.ts`) üretilen SQL'in
// ŞEKLİNİ sabitler. Şekil doğru olsa bile PLANLAYICININ onu bir indeks aralık
// koşuluna çevirdiğini KANITLAYAMAZ — ve asıl önemli olan budur.
//
// ── ÖLÇÜLEN AÇIK ──────────────────────────────────────────────────────────
// Kompozit imleç `createdAt < X OR (createdAt = X AND _id < Y)` biçiminde
// üretiliyordu. PostgreSQL disjonksiyonu indeks aralık koşuluna çeviremez;
// `(channelId, createdAt DESC, _id DESC)` indeksi seek için kullanılamıyor,
// planlayıcı tarayıp filtreliyordu. 100 000 mesajlı bir kanalda ölçüldü:
//
//     OR biçimi          : Rows Removed by Filter 200 154 · 64.595 ms
//     satır karşılaştırma: Rows Removed by Filter     154 ·  0.277 ms
//
// Bu süit sentetik ama GERÇEK bir hacim yazar, ürünün gerçekten ürettiği
// sorguyu çalıştırır ve planın bir `Index Cond` taşıdığını doğrular. Yeniden
// yazma geri alınırsa `Rows Removed by Filter` patlar ve bu test düşer.
//
// Yalnızca `PG_TEST_URL` verildiğinde çalışır.

import { buildWhere } from '../../db/postgres/pgCollection';

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

// Derin sayfalamanın anlamlı olması için yeterli, süiti yavaşlatmayacak kadar
// küçük bir hacim. Tarama/seek farkı bu ölçekte zaten net ayrışır.
const ROWS = 40_000;
const CHANNEL = 'plan-hot-channel';

RUN('gerçek PostgreSQL — keyset sayfalaması indeks üzerinden seek eder', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  beforeAll(async () => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: PG_URL, max: 4 });

    await q(`CREATE TABLE IF NOT EXISTS plan_messages (
      _id TEXT PRIMARY KEY,
      "channelId" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      content TEXT NOT NULL
    )`);
    await q('TRUNCATE plan_messages');
    // Üründeki indeksin birebir aynısı.
    await q(`CREATE INDEX IF NOT EXISTS idx_plan_messages_cursor
             ON plan_messages("channelId", "createdAt" DESC, _id DESC)`);
    await q(
      `INSERT INTO plan_messages (_id, "channelId", "createdAt", content)
       SELECT 'p-' || g::text,
              CASE WHEN g % 2 = 0 THEN $1 ELSE 'plan-cold-' || (g % 50)::text END,
              1700000000000 + g,
              'body ' || g::text
       FROM generate_series(1, ${ROWS}) AS g`,
      [CHANNEL],
    );
    await q('ANALYZE plan_messages');
  }, 180_000);

  afterAll(async () => {
    if (pool) { await q('DROP TABLE IF EXISTS plan_messages'); await pool.end(); }
  });

  /** Ürünün gerçekten ürettiği WHERE ile EXPLAIN çalıştırır. */
  async function planFor(order: 'DESC' | 'ASC', cursorAt: number, cursorId: string) {
    const op = order === 'DESC' ? '$lt' : '$gt';
    const { sql, params } = buildWhere({
      channelId: CHANNEL,
      $or: [{ createdAt: { [op]: cursorAt } }, { createdAt: cursorAt, _id: { [op]: cursorId } }],
    });
    const rows = await q(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT * FROM plan_messages WHERE ${sql}
       ORDER BY "createdAt" ${order}, _id ${order} LIMIT 50`,
      params,
    );
    const plan = JSON.stringify(rows[0]['QUERY PLAN']);
    const filtered = /"Rows Removed by Filter":\s*(\d+)/.exec(plan);
    return {
      sql,
      plan,
      hasIndexCond: plan.includes('Index Cond'),
      rowsRemoved: filtered ? Number(filtered[1]) : 0,
    };
  }

  it('emits a row comparison rather than a disjunction', async () => {
    const { sql } = await planFor('DESC', 1700000020000, 'p-20000');
    expect(sql).toContain('("createdAt", "_id") <');
    expect(sql).not.toContain(' OR ');
  }, 60_000);

  it('uses an index range condition when scrolling back through history', async () => {
    const { hasIndexCond, rowsRemoved } = await planFor('DESC', 1700000020000, 'p-20000');
    // ASIL İDDİA: planlayıcı seek ediyor. `Index Cond` yoksa taranıyor demektir.
    expect(hasIndexCond).toBe(true);
    // Ve derin sayfada on binlerce satır ATILMIYOR. Eşik, ölçülen iki rejimi
    // (154 vs 200 154) ayırt edecek kadar geniş, gerilemeyi kaçırmayacak kadar dar.
    expect(rowsRemoved).toBeLessThan(1_000);
  }, 60_000);

  it('uses an index range condition when paging forward from a cursor', async () => {
    const { hasIndexCond, rowsRemoved } = await planFor('ASC', 1700000010000, 'p-10000');
    expect(hasIndexCond).toBe(true);
    expect(rowsRemoved).toBeLessThan(1_000);
  }, 60_000);

  it('returns exactly the rows the disjunction form would have returned', async () => {
    // Hız, YANLIŞ sonuçla satın alınmamalıdır. İki biçim aynı sayfayı vermeli.
    const cursorAt = 1700000020000;
    const cursorId = 'p-20000';
    const viaRewrite = await q(
      `SELECT _id FROM plan_messages
       WHERE "channelId" = $1 AND ("createdAt", _id) < ($2, $3)
       ORDER BY "createdAt" DESC, _id DESC LIMIT 50`,
      [CHANNEL, cursorAt, cursorId],
    );
    const viaDisjunction = await q(
      `SELECT _id FROM plan_messages
       WHERE "channelId" = $1
         AND ("createdAt" < $2 OR ("createdAt" = $2 AND _id < $3))
       ORDER BY "createdAt" DESC, _id DESC LIMIT 50`,
      [CHANNEL, cursorAt, cursorId],
    );
    expect(viaRewrite).toHaveLength(50);
    expect(viaRewrite.map((r: { _id: string }) => r._id))
      .toEqual(viaDisjunction.map((r: { _id: string }) => r._id));
  }, 60_000);
});

export {};
