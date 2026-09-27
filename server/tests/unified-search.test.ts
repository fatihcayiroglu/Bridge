// server/tests/unified-search.test.ts
// FAZ SEARCH 2.0 — BIRLESIK ARAMA + INDEKS HIZALAMASI REGRESYONLARI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK KUSURLAR
// ════════════════════════════════════════════════════════════════════════════
// 1) INDEKS HIZALAMASI (migration 027)
//    GIN indeksi  to_tsvector('simple', content || displayName)  uzerine
//    kuruluydu; db/postgres/fts.ts ise ayni ifadeyi unaccent(...) ile
//    sariyordu. Iki ifade AYNI OLMADIGI icin planlayici indeksi kullanamiyor,
//    her arama tam tablo taramasina dusuyordu.
//      olculen (10.302 satir): 46.751 ms Seq Scan → 0.060 ms Bitmap Index Scan
//    Kok neden: tek argumanli unaccent() STABLE'dir (sozlugu calisma aninda
//    search_path uzerinden cozer), IMMUTABLE degildir; PostgreSQL STABLE
//    ifadeyi indeksleyemez. Cozum, sozlugu acikca adlandiran IMMUTABLE
//    `bridge_unaccent` sarmalayicisidir.
//
// 2) ARAMA KAPSAMI
//    Mesajlar DORT tabloda yasar (messages / dm_messages / thread_messages /
//    group_dm_messages); ftsSearch yalnizca `messages`i sorguluyordu. DM'ler,
//    grup DM'leri ve thread yanitlari HIC ARANAMIYORDU.
//
// Bu paket, uretilen sorgunun SOZLESMESINI kilitler:
//   • her kaynak indeksle AYNI ifadeyi kullanir (aksi halde indeks olu kalir)
//   • DM ve grup DM uyeligi SQL'DE daraltilir (son-filtreye birakilmaz)
//   • sifreli mesajlar acikca kapsam disidir
// Canli plan/indeks dogrulamasi icin: tests/unified-search.integration.test.ts

const queryMock = jest.fn();

jest.mock('../db/postgres/pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => queryMock(sql, params) },
}));

import { unifiedFtsSearch, ftsSearch, ALL_SEARCH_SOURCES } from '../db/postgres/fts';

/** Son calistirilan sorgu ve parametreleri. */
const lastSql = (): string => String(queryMock.mock.calls.at(-1)?.[0] ?? '');
const lastParams = (): unknown[] => (queryMock.mock.calls.at(-1)?.[1] ?? []) as unknown[];

/** Hizalanmamis CIPLAK unaccent( — tek bir tanesi indeksi olu birakir. */
const BARE_UNACCENT = /(^|[^_])unaccent\(/;

/**
 * Bir SQL parcasinda gecen placeholder'a BAGLI degeri cozer.
 *
 * Placeholder numaralari kaynak kumesine gore degistigi icin (bkz. fts.ts —
 * kullanilmayan parametre PostgreSQL tarafindan reddediliyordu) sabit indeks
 * beklemek testi kirilgan yapar ve asil onemli seyi olcmez. Onemli olan:
 * DOGRU deger DOGRU yere baglanmis mi.
 */
function boundTo(pattern: RegExp): unknown {
  const m = lastSql().match(pattern);
  if (!m) throw new Error(`SQL'de bulunamadi: ${pattern}`);
  return lastParams()[Number(m[1]) - 1];
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
});

describe('Birlesik arama — indeks hizalamasi', () => {
  it('TUM kaynaklar indeksle AYNI ifadeyi kullanir (bridge_unaccent)', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    const sql = lastSql();

    // Indeks tam olarak bu ifade uzerine kurulu (migration 027).
    expect(sql).toContain("to_tsvector('simple', bridge_unaccent(");
    // Kaynak basina 4: rank vektoru + rank tsquery + WHERE vektoru + WHERE tsquery.
    expect((sql.match(/bridge_unaccent\(/g) ?? []).length).toBe(16);
    expect(sql).not.toMatch(BARE_UNACCENT);
  });

  it('dort kaynagi TEK sorguda birlestirir — arama mantigi kopyalanmaz', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    const sql = lastSql();

    expect(sql).toContain('FROM messages m');
    expect(sql).toContain('FROM dm_messages d');
    expect(sql).toContain('FROM thread_messages t');
    expect(sql).toContain('FROM group_dm_messages g');
    expect((sql.match(/UNION ALL/g) ?? []).length).toBe(3);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('kaynaklar ortak sutun sozlesmesi doner (UNION tip uyumu)', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    const sql = lastSql();

    // DM satirinin serverId'si, kanal satirinin threadId'si yoktur; eksik
    // sutunlar TIPLENMIS NULL olmali, yoksa UNION calismaz.
    expect(sql).toContain('NULL::text AS "serverId"');
    expect(sql).toContain('NULL::text AS "threadId"');
    expect(sql).toContain('NULL::text AS "dmId"');
  });
});

describe('Birlesik arama — siralama (relevans korunur)', () => {
  it('once skora, esitlikte yeniye gore siralar', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    expect(lastSql()).toContain('ORDER BY _score DESC, "createdAt" DESC');
  });

  it('konum agirlikli rank kullanir — ILIKE degil', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    const sql = lastSql();
    expect((sql.match(/ts_rank_cd\(/g) ?? []).length).toBe(4);
    expect(sql).not.toContain('ILIKE');
  });

  it('yakinlik bonusu her DORT kaynakta da uygulanir', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    expect((lastSql().match(/interval '7 days'/g) ?? []).length).toBe(4);
  });

  it('limit sorguya PARAMETRE olarak gecer', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 25);
    // Final21 Faz 7 (F21-7-01): SQL artik iki tur LIMIT tasir — kaynak basina
    // SIRALAMA PENCERESI ve en distaki KULLANICI LIMITI. Bu test ilk eslesen
    // LIMIT'e bakiyordu; o artik penceredir. Sozlesme ayni kalir ve
    // SIKILASTIRILIR: HER IKISI de baglanmis parametredir, hicbiri SQL'e
    // gomulmez; en distaki LIMIT kullanici limitidir.
    // `[^\s)]+`: pencere LIMIT'i alt sorguyu kapatan `)` ile biter ("LIMIT $4) m").
    // Gomulmus bir sayi ("LIMIT 2000") yine yakalanir ve asagidaki kontrolu KALIR.
    const limits = [...lastSql().matchAll(/LIMIT ([^\s)]+)/g)].map((m) => m[1]);
    expect(limits.length).toBeGreaterThan(1);
    for (const ph of limits) expect(ph).toMatch(/^\$\d+$/);

    const outer = limits[limits.length - 1];
    expect(lastParams()[Number(outer.slice(1)) - 1]).toBe(25);
  });

  it('siralama penceresi (F21-7-01) her kaynakta PARAMETREDIR ve limitten kucuk olamaz', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 25);
    const limits = [...lastSql().matchAll(/LIMIT (\$\d+)/g)].map((m) => m[1]);
    const windows = limits.slice(0, -1);
    // Dort kaynak (channel, thread, gdm, dm) — her biri kendi aday kumesini sinirlar.
    expect(windows).toHaveLength(4);
    const windowValues = new Set(windows.map((ph) => lastParams()[Number(ph.slice(1)) - 1]));
    expect(windowValues.size).toBe(1);
    const [windowValue] = [...windowValues] as number[];
    expect(windowValue).toBeGreaterThanOrEqual(25);

    // Limit pencereden buyukse pencere limite yukselir; sonuc kesilmez.
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 5_000);
    const big = [...lastSql().matchAll(/LIMIT (\$\d+)/g)].map((m) => lastParams()[Number(m[1].slice(1)) - 1]);
    expect(big.slice(0, -1).every((v) => (v as number) >= 5_000)).toBe(true);
  });

  it('yetkilendirme filtreleri siralama penceresinin ICINDEDIR (LIMIT oncesi)', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u-me', serverIds: ['s1'], channelIds: ['c1'] }, 10);
    const sql = lastSql();
    // Her aday alt sorgusu kendi yetki kosulunu, pencere LIMIT'inden ONCE tasir.
    const candidates = sql.split('FROM (').slice(1).map((part) => part.slice(0, part.indexOf('LIMIT')));
    expect(candidates).toHaveLength(4);
    expect(candidates.some((c) => /"channelId" = ANY\(\$\d+\)/.test(c) && /FROM messages m/.test(c))).toBe(true);
    expect(candidates.some((c) => /JOIN group_dm_members gm/.test(c))).toBe(true);
    expect(candidates.some((c) => /c\.participants \? \$\d+/.test(c))).toBe(true);
  });

  it('kullanici girdisi SQL metnine GOMULMEZ', async () => {
    const evil = "x'; DROP TABLE messages; --";
    await unifiedFtsSearch(evil, { userId: 'u1', serverIds: ['s1'] }, 10);
    expect(lastSql()).not.toContain('DROP TABLE');
    expect(boundTo(/bridge_unaccent\(\$(\d+)\)/)).toBe(evil);
  });
});

describe('Birlesik arama — yetkilendirme', () => {
  it('DM sonuclari SQL ICINDE katilimcilik ile daraltilir', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u-me', serverIds: ['s1'] }, 10);
    const sql = lastSql();

    // Kiracilik sinirini son-filtreye birakmak, C2 dersinin tekrari olurdu:
    // once sonuc uretilir, sonra kirpilir — sizinti icin acik kapi.
    expect(sql).toContain('JOIN dm_conversations c ON c._id = d."dmId"');
    expect(boundTo(/c\.participants \? \$(\d+)/)).toBe('u-me');
  });

  it('sifreli DM icerigi aranmaz — HER IKI bayrak da elenir', async () => {
    // Kanonik `dm:send` yolu (socket/handlers/dm.ts) `e2e` bayragini yazar,
    // `isEncrypted`i DEGIL. Yalnizca `isEncrypted`e bakmak, sifreli metnin
    // ("🔒e2e:...") sonuclara anlamsiz kayit olarak sizmasi demekti.
    // Urunun geri kalani da iki bayragi birlikte okur (routes/inbox.ts:22).
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    const sql = lastSql();
    expect(sql).toContain('d."isEncrypted" = FALSE');
    expect(sql).toContain('d.e2e = FALSE');
  });

  it('E2EE kanal mesajlari sonuclara girmez (icerik bos saklanir)', async () => {
    // type='e2ee' satirlarinda content = '' olur; yine de displayName
    // uzerinden eslesip BOS sonuc uretebilirlerdi.
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    expect(lastSql()).toContain("m.type <> 'e2ee'");
  });

  it('[RANKING PRIVACY] kanal ve thread allowlist SQL icinde ranking oncesi uygulanir', async () => {
    await unifiedFtsSearch(
      'merhaba',
      { userId: 'u1', serverIds: ['s1'], channelIds: ['ch-visible'] },
      10,
    );
    const sql = lastSql();
    expect(boundTo(/m\."channelId" = ANY\(\$(\d+)\)/)).toEqual(['ch-visible']);
    expect(sql.match(/m\."channelId" = ANY\((\$\d+)\)/)![1])
      .toBe(sql.match(/t\."channelId" = ANY\((\$\d+)\)/)![1]);
  });

  it('acikca bos kanal allowlist channel/thread kaynaklarini hic sorgulamaz', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'], channelIds: [] }, 10);
    const sql = lastSql();
    expect(sql).not.toContain('FROM messages m');
    expect(sql).not.toContain('FROM thread_messages t');
    expect(sql).toContain('FROM dm_messages d');
    expect(sql).toContain('FROM group_dm_messages g');
  });

  it('kanal ve thread sonuclari sunucu uyeligiyle daraltilir', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1', 's2'] }, 10);
    const sql = lastSql();
    expect(boundTo(/m\."serverId" = ANY\(\$(\d+)\)/)).toEqual(['s1', 's2']);
    // Iki kaynak da AYNI parametreye baglanir — kapsam ikiye ayrilamaz.
    expect(sql.match(/m\."serverId" = ANY\((\$\d+)\)/)![1])
      .toBe(sql.match(/t\."serverId" = ANY\((\$\d+)\)/)![1]);
  });

  it('thread satirlari kanal-basi son-filtre icin channelId/serverId tasir', async () => {
    // routes/search.ts VIEW_CHANNELS'i kanal bazinda SONRADAN uygular
    // (search-channel-visibility.test.ts). Bu alanlar olmadan ayni IDOR
    // thread yanitlari uzerinden yeniden acilirdi.
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    expect(lastSql()).toContain('t."channelId", t."serverId"');
  });

  it('silinmis kanal mesajlari sonuclara girmez', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    expect(lastSql()).toContain('m."deletedAt" IS NULL');
  });

  it('kullanici kimligi yoksa HICBIR sorgu calistirilmaz', async () => {
    const rows = await unifiedFtsSearch('merhaba', { userId: '', serverIds: ['s1'] }, 10);
    expect(rows).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('Birlesik arama — kapsam secimi', () => {
  it('sunucu uyeligi yoksa yalnizca kullanici bazli kaynaklar aranir', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: [] }, 10);
    const sql = lastSql();

    // DM ve grup DM sunucu uyeligi gerektirmez — hicbir sunucuya uye olmayan
    // kullanici da kendi konusmalarini arayabilmelidir.
    expect(sql).toContain('FROM dm_messages d');
    expect(sql).toContain('FROM group_dm_messages g');
    expect(sql).not.toContain('FROM messages m');
    expect(sql).not.toContain('FROM thread_messages t');
  });

  it('kaynak listesi daraltilabilir', async () => {
    await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'], sources: ['dm'] }, 10);
    const sql = lastSql();
    expect(sql).toContain('FROM dm_messages d');
    expect(sql).not.toContain('UNION ALL');
  });

  it.each([
    ['uc kaynak', { userId: 'u1', serverIds: ['s1'] }],
    ['yalniz DM (sunucusuz kullanici)', { userId: 'u1', serverIds: [] }],
    ['acikca DM', { userId: 'u1', serverIds: ['s1'], sources: ['dm'] as const }],
    ['acikca kanal', { userId: 'u1', serverIds: ['s1'], sources: ['channel'] as const }],
  ])('%s: her parametre KULLANILIR, her placeholder BAGLIDIR', async (_ad, scope) => {
    // PostgreSQL, hicbir yerde gecmeyen bir parametreyi reddeder
    // ("could not determine data type of parameter $N"); hata catch'e dusup
    // sessiz BOS SONUC uretirdi. Sunucuya uye olmayan kullanici bu yuzden
    // kendi DM'lerini hic arayamiyordu. Iki yon de kilitlenir.
    await unifiedFtsSearch('merhaba', scope, 10);

    const used = new Set((lastSql().match(/\$\d+/g) ?? []).map(s => Number(s.slice(1))));
    const count = lastParams().length;

    expect([...used].sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, i) => i + 1),
    );
  });

  it('varsayilan kaynak kumesi DORT tabloyu da kapsar', () => {
    expect([...ALL_SEARCH_SOURCES].sort()).toEqual(['channel', 'dm', 'gdm', 'thread']);
  });

  it('bos sorgu metni sorgu calistirmaz', async () => {
    expect(await unifiedFtsSearch('   ', { userId: 'u1', serverIds: ['s1'] }, 10)).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('sorgu hatasi sonuc SIZDIRMAZ, bos doner', async () => {
    queryMock.mockRejectedValueOnce(new Error('syntax error in tsquery'));
    expect(await unifiedFtsSearch('bad ((query', { userId: 'u1', serverIds: ['s1'] }, 10)).toEqual([]);
  });

  it('her satir kaynagini bildirir (cagiran son-filtre uygulayabilsin)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { _id: 'm1', _source: 'channel', _score: 2 },
        { _id: 'd1', _source: 'dm', _score: 1 },
      ],
    });
    const rows = await unifiedFtsSearch('merhaba', { userId: 'u1', serverIds: ['s1'] }, 10);
    expect(rows.map(r => r._source)).toEqual(['channel', 'dm']);
  });
});

describe('Mevcut ftsSearch — hizalama korunur', () => {
  it('kanal aramasinin FTS yolu bridge_unaccent kullanir', async () => {
    queryMock.mockResolvedValue({ rows: [{ _id: 'm1' }] });

    await ftsSearch('merhaba', ['s1'], 10);
    const sql = lastSql();
    expect(sql).toContain('bridge_unaccent(');
    expect(sql).not.toMatch(BARE_UNACCENT);
  });

  it('kanal allowlist verilirse TUM FTS fallback stratejileri ranking/LIMIT oncesi daralir', async () => {
    // Websearch -> prefix -> trigram yollarini bos dondurup ILIKE'a kadar
    // ilerletiyoruz. Tek ilk-cagri assertion'i prefix sibling acigini yakalamiyordu.
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await ftsSearch('merhaba', ['s1'], 10, ['ch1', 'ch2']);

    expect(queryMock).toHaveBeenCalledTimes(4);
    for (const [sql, params] of queryMock.mock.calls) {
      expect(String(sql)).toContain('m."channelId" = ANY($4)');
      expect((params as unknown[])[3]).toEqual(['ch1', 'ch2']);
    }
  });

  it('acikca bos kanal allowlist sorgu calistirmaz', async () => {
    expect(await ftsSearch('merhaba', ['s1'], 10, [])).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('prefix (kismi kelime) yolu da hizali kalir', async () => {
    // 1. yol bos donerse 2. yola dusulur; o yol da indeksle ayni ifadeyi
    // kullanmalidir, yoksa kismi kelime aramasi tam tarama yapar.
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [{ _id: 'm1' }] });

    await ftsSearch('merhab', ['s1'], 10);
    const sql = lastSql();
    expect(sql).toContain('to_tsquery(');
    expect(sql).toContain('bridge_unaccent(');
    expect(sql).not.toMatch(BARE_UNACCENT);
  });
});
