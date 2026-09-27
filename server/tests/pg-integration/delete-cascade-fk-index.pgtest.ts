// server/tests/pg-integration/delete-cascade-fk-index.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK PostgreSQL — SİLME ZİNCİRİ BAŞINA SIRALI TARAMA YOK
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN KUSUR (Final21, Faz 11 — F21-11-02) ───────────────────────────
// `ON DELETE CASCADE` kısıtında PostgreSQL, silinen HER üst satır için başvuran
// tabloda `DELETE FROM ONLY <tablo> WHERE $1 = "<sütun>"` çalıştırır. Başvuran
// sütunda önde gelen bir indeks yoksa bu, silinen satır BAŞINA bir sıralı
// taramadır. İki kısıtta böyleydi; tek kullanımlık veritabanında ÖLÇÜLDÜ
// (işlem içinde, geri alınarak; üç tekrar):
//
//   message_reports."messageId" -> messages, 100 000 mesaj silme
//       20 000 rapor : indekssiz 103 424–106 576 ms   indeksli 2 309–2 531 ms
//        2 000 rapor : indekssiz  11 037–11 183 ms    indeksli 1 952–2 185 ms
//   channel_read_positions."channelId" -> channels, 1M satır, 100 kanal
//       açık DELETE + kanal silme: indekssiz 5 662–5 842 ms, indeksli 1 312–1 500 ms
//
// Sunucu silme (`ServerRepository.deleteGraphAtomic`) bunların ikisini de TEK
// işlemde yürütür; 1M mesajlı Faz 7 korpus sunucusunun silinmesi istemcinin
// 30 sn zaman aşımını geçti.
//
// ── NE DOĞRULANIR (zamanlama DEĞİL — belirleyici sayaçlar) ──────────────────
// `pg_stat_user_tables.seq_scan` ve `pg_stat_user_indexes.idx_scan` sayaçları.
// İndeks yoksa silinen N üst satır, başvuran tabloda N sıralı tarama üretir;
// varsa sıralı tarama artmaz ve adı geçen indeks N kez taranır.
// Yalnızca `PG_TEST_URL` ile çalışır; kendi satırlarını siler.

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-fkx';
const USERS = 400;
const CHANNELS = 60;
const DELETE_CHANNELS = 30;
const MESSAGES = 1_200;
const DELETE_MESSAGES = 300;

type Counters = { seq: number; idx: Record<string, number> };

RUN('gerçek PostgreSQL — cascade silmede başvuran sütun indeksli', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;

  // `messages`/`channels` sunucuya FK ile bağlı DEĞİLDİR (bkz. deleteGraphAtomic);
  // sunucu satırını silmek onları temizlemez, bu yüzden her tablo açıkça silinir.
  const cleanup = async () => {
    await q(`DELETE FROM messages WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM channels WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM servers WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [`${P}-%`]);
  };

  beforeAll(async () => {
    await cleanup();
    await q(
      `INSERT INTO users (_id, username, password, "displayName", "createdAt")
       SELECT '${P}-u-' || g, 'pgt_fkx_u_' || g, 'x', 'u', 1 FROM generate_series(1, ${USERS}) g`,
    );
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'fkx', $2, 1)`, [`${P}-srv`, `${P}-u-1`]);
    await q(
      `INSERT INTO channels (_id, "serverId", name, "createdAt")
       SELECT '${P}-c-' || g, $1, 'c' || g, 1 FROM generate_series(1, ${CHANNELS}) g`,
      [`${P}-srv`],
    );
    // Silinecek mesajlar ilk kanalda; raporlar SİLİNMEYECEK mesajlara bakar,
    // böylece rapor tablosu dolu ama silme hiçbir raporu kaldırmaz.
    await q(
      `INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
       SELECT '${P}-m-' || g, '${P}-c-' || (CASE WHEN g <= ${DELETE_MESSAGES} THEN 1 ELSE 2 END), $1,
              '${P}-u-1', 'u', 'U', 'm', g
       FROM generate_series(1, ${MESSAGES}) g`,
      [`${P}-srv`],
    );
    await q(
      `INSERT INTO message_reports (_id, "serverId", "channelId", "messageId", "reporterId", reason, detail, status, "createdAt")
       SELECT '${P}-r-' || u || '-' || m, $1, '${P}-c-2', '${P}-m-' || m, '${P}-u-' || u, 'spam', '', 'resolved', 1
       FROM generate_series(1, ${USERS}) u, generate_series(${DELETE_MESSAGES + 1}, ${DELETE_MESSAGES + 10}) m`,
      [`${P}-srv`],
    );
    await q(
      `INSERT INTO channel_read_positions ("userId", "channelId", "lastReadAt", "lastReadMessageId", "updatedAt")
       SELECT '${P}-u-' || u, '${P}-c-' || c, 1, 'm', 1
       FROM generate_series(1, ${USERS}) u, generate_series(${DELETE_CHANNELS + 1}, ${CHANNELS}) c`,
    );
    await q('ANALYZE message_reports');
    await q('ANALYZE channel_read_positions');
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    try { await db._pool.end(); } catch { /* zaten kapali */ }
  });

  /** Başvuran tablo üzerinde, `column` ile BAŞLAYAN btree indekslerin adları. */
  const leadingIndexes = async (table: string, column: string): Promise<string[]> =>
    (await q(
      `SELECT ic.relname AS name
         FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = $1::regclass AND a.attname = $2`,
      [table, column],
    )).map((r: { name: string }) => String(r.name));

  const counters = async (client: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }, table: string): Promise<Counters> => {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const seq = (await client.query('SELECT seq_scan FROM pg_stat_user_tables WHERE relname = $1', [table])).rows[0];
    const idx = (await client.query('SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE relname = $1', [table])).rows;
    return {
      seq: Number(seq?.seq_scan ?? 0),
      idx: Object.fromEntries(idx.map((r: { indexrelname: string; idx_scan: string }) => [r.indexrelname, Number(r.idx_scan)])),
    };
  };

  /** Üst satırları siler ve başvuran tablodaki tarama sayaç farklarını döndürür. */
  const measureCascade = async (child: string, parentDelete: string, params: unknown[]) => {
    const client = await db._pool.connect();
    try {
      const before = await counters(client, child);
      const deleted = (await client.query(parentDelete, params)).rowCount ?? 0;
      // Bekleyen istatistikler bu arka uç boşa çıkınca paylaşılan belleğe yazılır.
      await client.query('SELECT pg_stat_force_next_flush()');
      await client.query('SELECT 1');
      const after = await counters(client, child);
      const idxDelta = Object.fromEntries(
        Object.entries(after.idx).map(([name, n]) => [name, n - (before.idx[name] ?? 0)]),
      );
      return { deleted, seqDelta: after.seq - before.seq, idxDelta };
    } finally {
      client.release();
    }
  };

  it('message_reports."messageId" önde gelen bir indeksle kapsanır', async () => {
    expect(await leadingIndexes('message_reports', 'messageId')).not.toEqual([]);
  });

  it('channel_read_positions."channelId" önde gelen bir indeksle kapsanır', async () => {
    expect(await leadingIndexes('channel_read_positions', 'channelId')).not.toEqual([]);
  });

  it('mesaj silme, rapor tablosunda silinen mesaj başına sıralı tarama YAPMAZ', async () => {
    const [indexName] = await leadingIndexes('message_reports', 'messageId');
    const r = await measureCascade(
      'message_reports',
      `DELETE FROM messages WHERE "channelId" = $1`,
      [`${P}-c-1`],
    );
    expect(r.deleted).toBe(DELETE_MESSAGES);
    expect(r.seqDelta).toBeLessThan(DELETE_MESSAGES / 10);
    expect(r.idxDelta[indexName] ?? 0).toBeGreaterThanOrEqual(DELETE_MESSAGES);
    // Anlam korunur: silinmeyen mesajlara bakan raporlar yerinde.
    expect(Number((await q(`SELECT count(*) AS n FROM message_reports WHERE _id LIKE $1`, [`${P}-r-%`]))[0].n))
      .toBe(USERS * 10);
  });

  it('kanal silme, okuma konumlarında silinen kanal başına sıralı tarama YAPMAZ', async () => {
    const [indexName] = await leadingIndexes('channel_read_positions', 'channelId');
    const r = await measureCascade(
      'channel_read_positions',
      `DELETE FROM channels WHERE "serverId" = $1 AND _id = ANY($2::text[])`,
      [`${P}-srv`, Array.from({ length: DELETE_CHANNELS }, (_, i) => `${P}-c-${i + 3}`)],
    );
    expect(r.deleted).toBe(DELETE_CHANNELS);
    expect(r.seqDelta).toBeLessThan(DELETE_CHANNELS / 10);
    expect(r.idxDelta[indexName] ?? 0).toBeGreaterThanOrEqual(DELETE_CHANNELS);
    // Anlam korunur: yalnızca silinen kanalların okuma konumları gitti.
    expect(Number((await q(`SELECT count(*) AS n FROM channel_read_positions WHERE "userId" LIKE $1`, [`${P}-u-%`]))[0].n))
      .toBe(USERS * (CHANNELS - DELETE_CHANNELS - 2));
  });
});
