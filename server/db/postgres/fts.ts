// server/db/postgres/fts.ts
// Full-Text Search — PostgreSQL native FTS ile mesaj arama.
//
// Strateji (en iyiden fallback'e):
//   1. websearch_to_tsquery  → "merhaba dünya" -hariç +zorunlu gibi Discord-benzeri syntax
//   2. to_tsquery prefix     → kısmi kelime (merhab:* → merhaba eşleşir)
//   3. pg_trgm similarity   → typo toleransı (meraba → merhaba)
//   4. ILIKE                 → son çare fallback
//
// Skor hesabı:
//   ts_rank_cd: konum ağırlıklı rank (başta geçen → yüksek skor)
//   recency bonus: son 7 günlük mesajlara +0.1 bonus

// INDEKS HIZALAMASI (migration 027): tum FTS ifadeleri `bridge_unaccent`
// kullanir. Ciplak `unaccent()` yalnizca STABLE oldugu icin INDEKSLENEMEZ;
// bu yuzden eski indeks unaccent'siz kurulmus, sorgu ise unaccent'li
// yazilmisti. Iki ifade esitlenmedigi surece planlayici indeksi kullanamaz.
//   olculen (10.302 satir): 46.751 ms Seq Scan → 0.060 ms Bitmap Index Scan

import { pool } from './pool';

// ════════════════════════════════════════════════════════════════════════════
// SINIRLI SIRALAMA PENCERESİ (Final21, Faz 7 — F21-7-01)
// ════════════════════════════════════════════════════════════════════════════
// ── BULUNAN KUSUR ───────────────────────────────────────────────────────────
// Sorgu "eşleşen HER satırı `ts_rank_cd` ile puanla, sırala, sonra LIMIT al"
// biçimindeydi. GIN indeksi eşleşmeleri hızla BULUYOR, ama puanlama her eşleşme
// için tsvector'ü yeniden kurup `ts_rank_cd` hesaplıyor; maliyet O(eşleşme).
// Yoğun bir sunucuda yaygın bir kelime aranınca bu doğrusal büyür.
//
// ÖLÇÜLDÜ (1.000.000 mesajlı kanal, gerçek PostgreSQL 18, EXPLAIN ANALYZE):
//     Bitmap Index Scan (GIN)            :    28.7 ms   133.333 eşleşme
//     Bitmap Heap Scan + puanlama        : 1 943   ms   <- süre BURADA
//     saf CPU, ts_rank_cd / satır        :  ~34 µs      (bridge_unaccent ~2.8 µs)
//     HTTP p95, 100k -> 1M korpus        : 410 -> 2 636 ms  (10x korpus, 6.43x bozulma)
//
// ── DÜZELTME ────────────────────────────────────────────────────────────────
// Puanlama artık EŞLEŞMELERİN TAMAMINA değil, en yeni `FTS_RANK_WINDOW`
// eşleşmeye uygulanır. Aday kümesi YETKİLENDİRME FİLTRELERİYLE BİRLİKTE ve
// LIMIT'ten ÖNCE kurulur; "yetkilendirme sıralama/LIMIT'ten önce gelir"
// sözleşmesi korunur.
//
// ÖLÇÜLDÜ (aynı 1M korpus, pencere 2000):
//     133.333 eşleşme (yaygın)   : 1 908 -> 141 ms
//      66.667 eşleşme            : 2 073 -> 223 ms
//       3.003 eşleşme            :    77 ->  71 ms   (GIN yolu korunur)
//         300 eşleşme            :   9.6 -> 10.9 ms (GIN yolu korunur)
//           1 / 0 eşleşme        :    56 ->  56 ms   (gerileme YOK)
//     KÜÇÜK KİRACI (2.000 mesaj, aynı tabloda 1M satır), yaygın kelime:
//                                  74.0 -> 74.3 ms   (başka kiracının
//                                  satırlarında yürümez; kanal/sunucu indeksi)
//
// ── BİLİNÇLİ ANLAM DEĞİŞİKLİĞİ ──────────────────────────────────────────────
// Kapsamdaki eşleşme sayısı pencereyi AŞARSA alaka puanı en yeni
// `FTS_RANK_WINDOW` eşleşme arasında hesaplanır; daha eski ama daha "alakalı"
// bir mesaj ilk sayfaya giremeyebilir. Pencereden az eşleşen (gerçekçi
// aramaların büyük çoğunluğu) sorgularda sonuçlar BİREBİR aynıdır. Ürün zaten
// yeniliği ödüllendiriyor (son 7 gün +0.1). Bu bir ürün kararıdır ve raporda
// açıkça işaretlenmiştir.
export const FTS_RANK_WINDOW = 2_000;

export async function ftsSearch(
  queryText: string,
  serverIds: string[],
  limit = 50,
  allowedChannelIds?: string[],
): Promise<Record<string, unknown>[]> {
  if (!queryText?.trim() || !serverIds?.length) return [];
  if (allowedChannelIds && !allowedChannelIds.length) return [];

  const q = queryText.trim();
  const channelFilter = allowedChannelIds ? 'AND m."channelId" = ANY($4)' : '';
  const params = (query: string) => allowedChannelIds
    ? [serverIds, query, limit, allowedChannelIds]
    : [serverIds, query, limit];
  // Puanlanan stratejiler pencereyi SON parametre olarak alır; trigram ve ILIKE
  // stratejileri `params()` ile değişmeden kalır (fazladan parametre bağlamak
  // PostgreSQL'de "bind message supplies N parameters" hatası verirdi).
  const rankWindow = Math.max(Math.trunc(limit), FTS_RANK_WINDOW);
  const windowPh = allowedChannelIds ? '$5' : '$4';
  const rankedParams = (query: string) => [...params(query), rankWindow];

  // ── 1. websearch_to_tsquery (tam özellikli arama) ─────────
  try {
    const { rows } = await pool.query(
      `
      WITH candidates AS MATERIALIZED (
        SELECT m.*
        FROM messages m
        WHERE m."serverId" = ANY($1)
          ${channelFilter}
          AND to_tsvector('simple', bridge_unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",'')))
              @@ websearch_to_tsquery('simple', bridge_unaccent($2))
        ORDER BY m."createdAt" DESC
        LIMIT ${windowPh}
      )
      SELECT c.*,
        ts_rank_cd(
          to_tsvector('simple', bridge_unaccent(coalesce(c.content,'') || ' ' || coalesce(c."displayName",''))),
          websearch_to_tsquery('simple', bridge_unaccent($2)),
          32
        )
        + CASE WHEN c."createdAt" > (extract(epoch from now()-interval '7 days')*1000)::bigint
               THEN 0.1 ELSE 0 END
        AS _score
      FROM candidates c
      ORDER BY _score DESC, c."createdAt" DESC
      LIMIT $3
      `,
      rankedParams(q),
    );
    if (rows.length > 0) return rows;
  } catch { /* syntax hatası → sonraki strateji */ }

  // ── 2. Prefix arama (kısmi kelime desteği) ────────────────
  try {
    const prefixQ = q
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.replace(/[^\w\u00C0-\u024F]/g, '') + ':*')
      .join(' & ');

    if (prefixQ) {
      const { rows } = await pool.query(
        `
        WITH candidates AS MATERIALIZED (
          SELECT m.*
          FROM messages m
          WHERE m."serverId" = ANY($1)
            ${channelFilter}
            AND to_tsvector('simple', bridge_unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",'')))
                @@ to_tsquery('simple', bridge_unaccent($2))
          ORDER BY m."createdAt" DESC
          LIMIT ${windowPh}
        )
        SELECT c.*,
          ts_rank_cd(
            to_tsvector('simple', bridge_unaccent(coalesce(c.content,'') || ' ' || coalesce(c."displayName",''))),
            to_tsquery('simple', bridge_unaccent($2)),
            32
          ) AS _score
        FROM candidates c
        ORDER BY _score DESC, c."createdAt" DESC
        LIMIT $3
        `,
        rankedParams(prefixQ),
      );
      if (rows.length > 0) return rows;
    }
  } catch { /* fallback */ }

  // ── 3. Trigram similarity (typo toleransı) ────────────────
  try {
    const { rows } = await pool.query(
      `
      SELECT m.*, similarity(m.content, $2) AS _score
      FROM messages m
      WHERE m."serverId" = ANY($1)
        ${channelFilter}
        AND m.content % $2
      ORDER BY _score DESC, m."createdAt" DESC
      LIMIT $3
      `,
      params(q),
    );
    if (rows.length > 0) return rows;
  } catch { /* pg_trgm kurulu değilse fallback */ }

  // ── 4. ILIKE fallback (son çare) ──────────────────────────
  const escaped = q.replace(/[%_\\]/g, c => `\\${c}`);
  const { rows } = await pool.query(
    `
    SELECT m.*
    FROM messages m
    WHERE m."serverId" = ANY($1)
      ${channelFilter}
      AND m.content ILIKE $2
    ORDER BY m."createdAt" DESC
    LIMIT $3
    `,
    params(`%${escaped}%`),
  );

  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// BIRLESIK ARAMA — tek soyutlama, dort kaynak.
//
// Mesajlar DORT AYRI tabloda yasar: `messages`, `dm_messages`,
// `thread_messages`, `group_dm_messages`. `ftsSearch` yalnizca `messages`i
// sorguluyordu; DM'ler, grup DM'leri ve thread yanitlari HIC ARANAMIYORDU.
// Arama mantigini dort kez kopyalamak yerine tek bir SQL uretici kullanilir;
// her kaynak ayni ifadeyi (bridge_unaccent) paylasir ve migration 027 + 028
// dort tabloya da ayni GIN indeksini kurar.
//
// YETKILENDIRME SINIRLARI — kaynaklara gore FARKLIDIR:
//   • channel : `serverId = ANY($serverIds)` ile daraltilir. Kanal bazli
//     VIEW_CHANNELS kontrolu routes/search.ts'te SONRADAN uygulanir
//     (mevcut ve kasitli tasarim; burada degistirilmez).
//   • thread  : ayni sekilde — `thread_messages` zaten channelId/serverId
//     tasidigi icin ayni son-filtreye girer.
//   • dm      : rol degil, KATI KIRACILIK sinirdir. Bu yuzden son-filtreye
//     BIRAKILMAZ, dogrudan SQL'de katilimcilik ile daraltilir.
//   • gdm     : ayni sekilde — uyelik `group_dm_members` uzerinden SQL'de
//     zorunlu kilinir.
//
// SIFRELI MESAJLAR KAPSAM DISIDIR: sunucu icerigi cozemez, dolayisiyla
// arayamaz. Sessizce eksik sonuc dondurmek yerine acikca haric tutulur.
//
// Sifreli olma testi urunun geri kalaniyla AYNI olmalidir (routes/inbox.ts,
// routes/saved.ts):  type='e2ee' VEYA e2e=TRUE VEYA isEncrypted=TRUE.
// `dm_messages`te `type` sutunu yoktur; kanonik `dm:send` yolu (bkz.
// socket/handlers/dm.ts) `e2e` bayragini yazar, `isEncrypted`i DEGIL.
// Yalnizca `isEncrypted`e bakmak, sifreli metnin ("🔒e2e:...") arama
// sonuclarina anlamsiz kayit olarak sizmasi demekti.
// `messages` tarafinda E2EE satirlarin `content`i BOS saklanir; yine de
// displayName uzerinden eslesip bos sonuc uretebildikleri icin elenir.

export type SearchSource = 'channel' | 'dm' | 'thread' | 'gdm';

export const ALL_SEARCH_SOURCES: readonly SearchSource[] = ['channel', 'dm', 'thread', 'gdm'];

/** Sunucu uyeligi gerektiren kaynaklar; digerleri kullanici bazlidir. */
const SERVER_SCOPED: readonly SearchSource[] = ['channel', 'thread'];

export interface UnifiedSearchScope {
  /** Arayan kullanici — DM katilimcilik filtresi icin ZORUNLU. */
  userId: string;
  /** Kullanicinin uye oldugu sunucular (cagiran cozer). */
  serverIds: string[];
  /** Kanal/thread kaynaklari icin SQL-oncesi yetkili kanal allowlist'i. */
  channelIds?: string[];
  /** Varsayilan: hepsi. */
  sources?: readonly SearchSource[];
}

export interface UnifiedSearchRow extends Record<string, unknown> {
  _source: SearchSource;
  _score: number;
}

/** Sorguda gercekten kullanilan placeholder'lar. */
interface Placeholders {
  /** Arama metni — her kaynakta kullanilir. */
  query: string;
  /** Sunucu kimlikleri — yalnizca channel/thread kaynaklarinda. */
  servers: string;
  /** Yetkili kanal kimlikleri — channel/thread ranking oncesi. */
  channels: string;
  /** Arayan kullanici — yalnizca dm kaynaginda. */
  user: string;
  /** Kaynak basina siralanan aday ust siniri (F21-7-01). */
  window: string;
}

/** Kaynaga gore FTS parcasi. Ifade her yerde AYNI — indeks boylece kullanilir. */
function sourceSql(source: SearchSource, p: Placeholders): { sql: string } {
  const vector = (alias: string) =>
    `to_tsvector('simple', bridge_unaccent(coalesce(${alias}.content,'') || ' ' || coalesce(${alias}."displayName",'')))`;
  const recency = (alias: string) =>
    `CASE WHEN ${alias}."createdAt" > (extract(epoch from now()-interval '7 days')*1000)::bigint THEN 0.1 ELSE 0 END`;
  const tsquery = `websearch_to_tsquery('simple', bridge_unaccent(${p.query}))`;

  // F21-7-01: her kaynak once SINIRLI bir aday kumesi kurar (yetkilendirme
  // filtreleri + FTS eslesmesi + en yeni `window` satir), puanlama yalnizca
  // bu kume uzerinde yapilir. LIMIT'li alt sorgu planlayici tarafindan
  // duzlestirilmez; yetkilendirme LIMIT'ten ONCE uygulanmis olur.
  const ranked = (alias: string, projection: string, candidate: string) => `
      SELECT ${projection},
             ts_rank_cd(${vector(alias)}, ${tsquery}, 32) + ${recency(alias)} AS _score
      FROM (${candidate}
            ORDER BY ${alias}."createdAt" DESC
            LIMIT ${p.window}) ${alias}`;

  // `contentFormat` (Final21 Phase 16): channel rows carry their own (0 = legacy sanitized text,
  // 1 = raw); thread, group DM and DM text has always been stored raw.
  if (source === 'channel') {
    return { sql: ranked('m', `
             m._id, m."channelId", m."serverId", NULL::text AS "threadId", NULL::text AS "dmId",
             m."userId", m."displayName", m.content, m."createdAt",
             m."contentFormat",
             'channel'::text AS _source`, `
        SELECT m.* FROM messages m
        WHERE m."serverId" = ANY(${p.servers})
          ${p.channels ? `AND m."channelId" = ANY(${p.channels})` : ''}
          AND m."deletedAt" IS NULL
          AND m.type <> 'e2ee'
          AND ${vector('m')} @@ ${tsquery}`) };
  }

  if (source === 'thread') {
    return { sql: ranked('t', `
             t._id, t."channelId", t."serverId", t."threadId", NULL::text AS "dmId",
             t."userId", t."displayName", t.content, t."createdAt",
             1::smallint AS "contentFormat",
             'thread'::text AS _source`, `
        SELECT t.* FROM thread_messages t
        WHERE t."serverId" = ANY(${p.servers})
          ${p.channels ? `AND t."channelId" = ANY(${p.channels})` : ''}
          AND ${vector('t')} @@ ${tsquery}`) };
  }

  if (source === 'gdm') {
    // Grup DM: uyelik `group_dm_members` uzerinden, yine SQL'de zorunlu.
    // Grup DM'lerde sifreleme yolu YOKTUR (socket/handlers/dm.ts her mesaji
    // type='normal' yazar), bu yuzden sifre filtresi de yoktur.
    // Uyelik JOIN'i ADAY KUMESININ ICINDEDIR: pencere yalnizca arayanin
    // uyesi oldugu gruplarin satirlariyla dolar.
    return { sql: ranked('g', `
             g._id, NULL::text AS "channelId", NULL::text AS "serverId", NULL::text AS "threadId", g."groupId" AS "dmId",
             g."userId", g."displayName", g.content, g."createdAt",
             1::smallint AS "contentFormat",
             'gdm'::text AS _source`, `
        SELECT g.* FROM group_dm_messages g
        JOIN group_dm_members gm ON gm."groupId" = g."groupId" AND gm."userId" = ${p.user}
        WHERE ${vector('g')} @@ ${tsquery}`) };
  }

  // DM: katilimcilik SQL'de zorunlu kilinir; sifreli olanlar haric.
  // Katilimcilik JOIN'i ADAY KUMESININ ICINDEDIR.
  return { sql: ranked('d', `
             d._id, NULL::text AS "channelId", NULL::text AS "serverId", NULL::text AS "threadId", d."dmId",
             d."userId", d."displayName", d.content, d."createdAt",
             1::smallint AS "contentFormat",
             'dm'::text AS _source`, `
        SELECT d.* FROM dm_messages d
        JOIN dm_conversations c ON c._id = d."dmId"
        WHERE c.participants ? ${p.user}
          AND d."isEncrypted" = FALSE AND d.e2e = FALSE
          AND ${vector('d')} @@ ${tsquery}`) };
}

/**
 * Dort kaynagi tek sorguda arar ve skora gore siralar.
 *
 * Sonuclar `_source` tasir; cagiran (routes/search.ts) kanal gorunurlugunu
 * bu alana bakarak son-filtreleyebilir. DM ve grup DM satirlari zaten SQL'de
 * yetkilendirildigi icin ek filtre gerektirmez.
 */
export async function unifiedFtsSearch(
  queryText: string,
  scope: UnifiedSearchScope,
  limit = 50,
): Promise<UnifiedSearchRow[]> {
  const q = queryText?.trim();
  if (!q || !scope?.userId) return [];

  const sources = (scope.sources?.length ? scope.sources : ALL_SEARCH_SOURCES)
    // Sunucu kaynagi yoksa sunucuya bagli kaynaklari sorgulamanin anlami yok.
    // `channelIds` ACIKCA verildiyse bos allowlist = HICBIR kanal; bu
    // ranking/LIMIT oncesi yetkilendirme sozlesmesidir.
    .filter(src => SERVER_SCOPED.includes(src)
      ? scope.serverIds?.length > 0 && (scope.channelIds === undefined || scope.channelIds.length > 0)
      : true);

  if (!sources.length) return [];

  // Placeholder'lar KAYNAK KUMESINE gore uretilir.
  //
  // Sabit bir $1..$4 duzeni kullanmak sessiz bir kusur uretiyordu: yalnizca
  // DM aranirken (kullanici hic sunucuya uye degilse ya da sources=['dm']
  // verildiginde) $1 hicbir yerde gecmiyor, PostgreSQL de "could not
  // determine data type of parameter $1" ile reddediyordu. Hata catch'e
  // dusup BOS SONUC olarak gorunuyordu — yani sunucusuz kullanici kendi
  // DM'lerini hic arayamiyordu. Her parametre artik yalnizca kullanildiginda
  // baglanir.
  const params: unknown[] = [q];
  const ph: Placeholders = { query: '$1', servers: '', channels: '', user: '', window: '' };

  if (sources.some(s => SERVER_SCOPED.includes(s))) {
    ph.servers = `$${params.push(scope.serverIds ?? [])}`;
    if (scope.channelIds !== undefined) ph.channels = `$${params.push(scope.channelIds)}`;
  }
  if (sources.some(s => !SERVER_SCOPED.includes(s))) {
    ph.user = `$${params.push(scope.userId)}`;
  }
  ph.window = `$${params.push(Math.max(Math.trunc(limit), FTS_RANK_WINDOW))}`;
  const limitPh = `$${params.push(limit)}`;

  const parts = sources.map(src => sourceSql(src, ph));

  const sql = `${parts.map(p => p.sql).join('\n      UNION ALL\n')}
      ORDER BY _score DESC, "createdAt" DESC
      LIMIT ${limitPh}`;

  try {
    const { rows } = await pool.query(sql, params);
    return rows as UnifiedSearchRow[];
  } catch {
    // Sorgu sozdizimi hatasi (kullanici girdisi) → bos sonuc; cagiran
    // mevcut `ftsSearch` fallback zincirini kullanmaya devam edebilir.
    return [];
  }
}
