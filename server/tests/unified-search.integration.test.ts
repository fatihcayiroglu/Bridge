// server/tests/unified-search.integration.test.ts
// FAZ SEARCH 2.0 — CANLI POSTGRESQL DOGRULAMASI (opt-in).
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI BIR PAKET
// ════════════════════════════════════════════════════════════════════════════
// tests/unified-search.test.ts uretilen SQL'in SOZLESMESINI kilitler; onu
// calistirmaz. Ama bu fazin kapattigi kusurun ta kendisi — indeksin sorgu
// tarafindan KULLANILAMAMASI — yalnizca gercek bir planlayici uzerinde
// gorulebilir: sorgu da indeks de tek baslarina kusursuz gorunuyordu.
//
// Bu yuzden burada gercek bir veritabani gerekir. Diger tum paketler
// hermetiktir (tests/setup.js DATABASE_URL'i siler), bu paket de varsayilan
// olarak ATLANIR. Calistirmak icin:
//
//   SEARCH_IT_DATABASE_URL=postgresql://... npx jest unified-search.integration
//
// YAZMA GUVENLIGI: tum kurgu tek bir islem icinde yapilir ve sonunda
// ROLLBACK edilir. Havuz `max: 1` ile kurulur; boylece unifiedFtsSearch da
// ayni baglantiyi (dolayisiyla ayni islemi) kullanir ve testin yazdigi
// satirlari gorebilir. Veritabaninda hicbir kalinti birakmaz.

const IT_URL = process.env.SEARCH_IT_DATABASE_URL;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool } = require('pg');

const itPool = IT_URL ? new Pool({ connectionString: IT_URL, max: 1 }) : null;

jest.mock('../db/postgres/pool', () => ({
  get pool() { return (global as Record<string, unknown>).__searchItPool; },
}));
(global as Record<string, unknown>).__searchItPool = itPool;

import { unifiedFtsSearch } from '../db/postgres/fts';

const q = async (sql: string, params: unknown[] = []) => (await itPool!.query(sql, params)).rows;

// This suite is collected only by the dedicated live-planner Jest invocation.
// Missing credentials are an execution error, not a passing or skipped test.
const withDb = describe;

const A = 'it-search-user-a';
const B = 'it-search-user-b';
const OUTSIDER = 'it-search-outsider';
const DM = 'it-search-dm';
const SERVER = 'it-search-server';
const CHANNEL = 'it-search-channel';
const THREAD = 'it-search-thread';
const GROUP = 'it-search-group';
const TERM = 'zxqvmarker';

withDb('Birlesik arama — canli PostgreSQL', () => {
  beforeAll(async () => {
    if (!IT_URL) throw new Error('SEARCH_IT_DATABASE_URL required for live planner E2E');
    await q('BEGIN');

    // Final21 Phase 16: rows below reference users, a server and a channel through foreign keys
    // added in migration 071. Without these seeds the whole suite failed on its own fixture
    // ("violates foreign key constraint fk_group_dm_members_user"), which nobody saw because the
    // suite only runs when SEARCH_IT_DATABASE_URL is set.
    for (const [id, username] of [[A, 'ayse'], [B, 'burak'], [OUTSIDER, 'outsider']] as const) {
      await q(
        `INSERT INTO users (_id, username, password, "displayName", "createdAt")
         VALUES ($1, $2, 'x', $2, $3) ON CONFLICT (_id) DO NOTHING`,
        [id, `it-search-${username}`, Date.now()],
      );
    }
    await q(
      `INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'IT Sunucu', $2, $3)
       ON CONFLICT (_id) DO NOTHING`,
      [SERVER, A, Date.now()],
    );
    await q(
      `INSERT INTO channels (_id, "serverId", name, type, "createdAt") VALUES ($1, $2, 'it-kanal', 'text', $3)
       ON CONFLICT (_id) DO NOTHING`,
      [CHANNEL, SERVER, Date.now()],
    );

    await q(
      `INSERT INTO dm_conversations (_id, participants, "createdAt", "lastMessageAt")
       VALUES ($1, $2::jsonb, $3, $3)`,
      [DM, JSON.stringify([A, B]), Date.now()],
    );

    const dm = (id: string, content: string, e2e = false, enc = false) => q(
      `INSERT INTO dm_messages (_id,"dmId","userId","displayName",content,e2e,"isEncrypted","createdAt")
       VALUES ($1,$2,$3,'Ayse',$4,$5,$6,$7)`,
      [id, DM, A, content, e2e, enc, Date.now()],
    );

    await dm('it-dm-plain', `gunaydin ${TERM} dünya`);
    await dm('it-dm-accent', `${TERM} güzel günaydın`);
    await dm('it-dm-e2e', `🔒e2e:${TERM}AAAABBBB`, true, false);
    await dm('it-dm-legacy-enc', `${TERM} legacy`, false, true);

    await q(
      `INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,type,"createdAt")
       VALUES ($1,$2,$3,$4,'ayse','Ayse',$5,'normal',$6)`,
      ['it-msg-plain', CHANNEL, SERVER, A, `kanal ${TERM} mesaji`, Date.now()],
    );
    await q(
      `INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,type,"createdAt")
       VALUES ($1,$2,$3,$4,'ayse',$5,'','e2ee',$6)`,
      ['it-msg-e2ee', CHANNEL, SERVER, A, TERM, Date.now()],
    );
    await q(
      `INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,type,"createdAt","deletedAt")
       VALUES ($1,$2,$3,$4,'ayse','Ayse',$5,'normal',$6,$6)`,
      ['it-msg-deleted', CHANNEL, SERVER, A, `silinmis ${TERM}`, Date.now()],
    );

    await q(
      `INSERT INTO thread_messages (_id,"threadId","channelId","serverId","userId",username,"displayName",content,"createdAt")
       VALUES ($1,$2,$3,$4,$5,'ayse','Ayse',$6,$7)`,
      ['it-thread-plain', THREAD, CHANNEL, SERVER, A, `yanit ${TERM} icerigi`, Date.now()],
    );

    // Grup DM: A ve B uye, OUTSIDER degil.
    await q(
      `INSERT INTO group_dm_conversations (_id, name, "ownerId", "createdAt", "lastMessageAt")
       VALUES ($1, 'IT Grubu', $2, $3, $3)`,
      [GROUP, A, Date.now()],
    );
    for (const [i, u] of [A, B].entries()) {
      await q(
        `INSERT INTO group_dm_members (_id,"groupId","userId","joinedAt") VALUES ($1,$2,$3,$4)`,
        [`it-gdm-member-${i}`, GROUP, u, Date.now()],
      );
    }
    await q(
      `INSERT INTO group_dm_messages (_id,"groupId","userId","displayName","avatarColor",content,type,reactions,"createdAt")
       VALUES ($1,$2,$3,'Ayse','#2d9cdb',$4,'normal','{}'::jsonb,$5)`,
      ['it-gdm-plain', GROUP, A, `grup ${TERM} mesaji`, Date.now()],
    );
  });

  afterAll(async () => {
    if (!itPool) return;
    await q('ROLLBACK');
    await itPool.end();
  });

  // ── Semayi olusturan varsayimlar ────────────────────────────────────────

  it('bridge_unaccent GERCEKTEN immutable — yoksa indeks kurulamaz', async () => {
    const [fn] = await q(
      `SELECT provolatile, proparallel FROM pg_proc WHERE proname = 'bridge_unaccent'`,
    );
    expect(fn).toBeDefined();
    expect(fn.provolatile).toBe('i');
  });

  it('aksan duyarsizlastirma calisir', async () => {
    const [r] = await q(`SELECT bridge_unaccent('günaydın') AS v`);
    expect(r.v).toBe('gunaydin');
  });

  it('dort tabloda da hizalanmis FTS indeksi vardir', async () => {
    const rows = await q(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`,
      [['idx_messages_fts_unaccent', 'idx_dm_messages_fts_unaccent',
        'idx_thread_messages_fts_unaccent', 'idx_group_dm_messages_fts_unaccent']],
    );
    expect(rows.map((r: { indexname: string }) => r.indexname).sort()).toEqual([
      'idx_dm_messages_fts_unaccent',
      'idx_group_dm_messages_fts_unaccent',
      'idx_messages_fts_unaccent',
      'idx_thread_messages_fts_unaccent',
    ]);
  });

  it('hizalanmamis eski indeks kaldirilmistir (yazma maliyeti, okuma faydasi yok)', async () => {
    const rows = await q(`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_messages_fts'`);
    expect(rows).toHaveLength(0);
  });

  // ── Bu fazin kapattigi asil kusur ───────────────────────────────────────

  it('sorgu ifadesi indeksi GERCEKTEN kullanabilir (kok kusur)', async () => {
    // Kusur tam olarak buydu: sorgu ile indeks farkli ifadelerdi, plan Seq
    // Scan'e dusuyordu. enable_seqscan=off, planlayiciya indeksi KULLANABILIR
    // mi diye sorar — kucuk tablolarda maliyet tercihini disari alarak
    // hizalamayi tek basina olcer.
    await q('SET LOCAL enable_seqscan = off');

    const vector = (a: string) =>
      `to_tsvector('simple', bridge_unaccent(coalesce(${a}.content,'') || ' ' || coalesce(${a}."displayName",'')))`;

    const cases: [string, string, string][] = [
      ['messages m', 'm', 'idx_messages_fts_unaccent'],
      ['dm_messages d', 'd', 'idx_dm_messages_fts_unaccent'],
      ['thread_messages t', 't', 'idx_thread_messages_fts_unaccent'],
      ['group_dm_messages g', 'g', 'idx_group_dm_messages_fts_unaccent'],
    ];

    for (const [from, alias, index] of cases) {
      const plan = await q(
        `EXPLAIN SELECT ${alias}._id FROM ${from}
         WHERE ${vector(alias)} @@ websearch_to_tsquery('simple', bridge_unaccent($1))`,
        [TERM],
      );
      const text = plan.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
      expect(text).toContain(index);
    }

    // Sonraki testler GERCEK planlayici tercihiyle calissin.
    await q('SET LOCAL enable_seqscan = on');
  });

  // ── Davranis: kapsam, yetki, siralama ───────────────────────────────────

  it('dort kaynagi da bulur — DM, grup DM ve thread artik ARANABILIR', async () => {
    const rows = await unifiedFtsSearch(TERM, { userId: A, serverIds: [SERVER] }, 50);
    const ids = rows.map(r => r._id);

    expect(ids).toContain('it-msg-plain');
    expect(ids).toContain('it-dm-plain');
    expect(ids).toContain('it-thread-plain');
    expect(ids).toContain('it-gdm-plain');
    expect(new Set(rows.map(r => r._source)))
      .toEqual(new Set(['channel', 'dm', 'thread', 'gdm']));
  });

  it('grup DM UYESI OLMAYAN, grup icerigini goremez', async () => {
    const rows = await unifiedFtsSearch(TERM, { userId: OUTSIDER, serverIds: [SERVER] }, 50);
    expect(rows.filter(r => r._source === 'gdm')).toHaveLength(0);
    // POZITIF KONTROL: sorgu gercekten calisti.
    expect(rows.map(r => r._id)).toContain('it-msg-plain');
  });

  it('grup DM uyesi icerigi gorur', async () => {
    const rows = await unifiedFtsSearch(TERM, { userId: B, serverIds: [] }, 50);
    expect(rows.map(r => r._id)).toContain('it-gdm-plain');
  });

  it('KATILIMCI OLMAYAN, DM icerigini goremez', async () => {
    const rows = await unifiedFtsSearch(TERM, { userId: OUTSIDER, serverIds: [SERVER] }, 50);
    expect(rows.filter(r => r._source === 'dm')).toHaveLength(0);
    // POZITIF KONTROL: sorgu gercekten calisti — kanal sonucu geldi.
    expect(rows.map(r => r._id)).toContain('it-msg-plain');
  });

  it('diger katilimci AYNI DM icerigini gorur', async () => {
    const rows = await unifiedFtsSearch(TERM, { userId: B, serverIds: [] }, 50);
    expect(rows.map(r => r._id)).toContain('it-dm-plain');
  });

  it('aksan duyarsiz arama korunur (gunaydin → günaydın)', async () => {
    const rows = await unifiedFtsSearch('gunaydin', { userId: A, serverIds: [] }, 50);
    expect(rows.map(r => r._id)).toContain('it-dm-accent');
  });

  it('sifreli mesajlar HICBIR kaynaktan sizmaz', async () => {
    const rows = await unifiedFtsSearch(TERM, { userId: A, serverIds: [SERVER] }, 50);
    const ids = rows.map(r => r._id);

    expect(ids).not.toContain('it-dm-e2e');          // e2e bayragi
    expect(ids).not.toContain('it-dm-legacy-enc');   // eski isEncrypted bayragi
    expect(ids).not.toContain('it-msg-e2ee');        // kanal E2EE (content bos)
  });

  it('silinmis mesajlar sonuclara girmez', async () => {
    const rows = await unifiedFtsSearch(TERM, { userId: A, serverIds: [SERVER] }, 50);
    expect(rows.map(r => r._id)).not.toContain('it-msg-deleted');
  });

  it('uye olunmayan sunucunun mesajlari gorunmez', async () => {
    const rows = await unifiedFtsSearch(TERM, { userId: A, serverIds: ['baska-sunucu'] }, 50);
    // Geriye yalnizca kullanici bazli kaynaklar kalir.
    expect(rows.filter(r => r._source === 'channel' || r._source === 'thread')).toHaveLength(0);
    expect(rows.map(r => r._id)).toContain('it-dm-plain');
  });

  it('sonuclar skora gore azalan sirada doner', async () => {
    const rows = await unifiedFtsSearch(TERM, { userId: A, serverIds: [SERVER] }, 50);
    const scores = rows.map(r => Number(r._score));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('limit uygulanir', async () => {
    const rows = await unifiedFtsSearch(TERM, { userId: A, serverIds: [SERVER] }, 2);
    expect(rows).toHaveLength(2);
  });
});
