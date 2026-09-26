// server/db/repositories/MessageRepository.ts
// Mesaj sorgularını tek bir yerde toplar.
// SQLite ve PostgreSQL loader ile uyumludur — db.messages Collection API'sini kullanır.
// NOT: db/index.js buildWhere() $gt/$lt/$regex syntax'ını destekler, bu syntax kasıtlıdır.

import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import { RAW_TEXT_FORMAT } from '../../lib/storedText';

/**
 * "İlk okunmamış" ayracı için taranacak en fazla aday satır (F21-8-03).
 * Ölçüm ve anlam için bkz. `findFirstUnreadAfter`.
 */
export const FIRST_UNREAD_SCAN_WINDOW = 1_000;

class MessageRepository {
  hasFtsSearch() {
    return !!db._ftsSearch;
  }

  /**
   * ══════════════════════════════════════════════════════════════════════════
   * REAKSIYON DEGISIMI — ATOMIK (KAYIP GUNCELLEME YARISINI KAPATIR)
   * ══════════════════════════════════════════════════════════════════════════
   * Rota katmani reaksiyonu OKU-DEGISTIR-YAZ ile guncelliyordu:
   *     const msg = await Messages.findById(id);
   *     const reactions = msg.reactions ?? {};
   *     ...ekle/cikar...
   *     await Messages.update(id, { reactions });
   * Iki istek ayni ANDA gelirse ikisi de AYNI baslangic durumunu okur ve
   * SON YAZAN kazanir; digerinin reaksiyonu SESSIZCE KAYBOLUR.
   *
   * DOGRUDAN OLCULDU — iki farkli kullanici, iki farkli emoji, es zamanli:
   *     istek durumlari : 200, 200
   *     son durum       : {"❤️":[bob]}        ← alice'in 👍 kaybolmus
   *     hayatta kalan   : 1/2
   *
   * Bu, kullanicinin GORDUGU bir veri kaybidir: reaksiyon bir an gorunup
   * kayboluyor.
   *
   * COZUM: degisim TEK bir SQL ifadesinde yapilir; okuma ile yazma arasinda
   * pencere kalmaz. Satir kilidi PostgreSQL tarafindan UPDATE sirasinda
   * saglanir.
   *
   * @returns Guncellenmis `reactions` nesnesi, ya da adaptor atomik yolu
   *          desteklemiyorsa `null` (arayan eski yola duser).
   */
  /**
   * Retry-safe reaction state setter. Unlike toggle, replaying the same desired
   * state cannot invert the result after an ACK is lost. PostgreSQL evaluates
   * the desired state under the row UPDATE lock; concurrent identical retries
   * therefore converge on the same final value.
   */
  async setReactionStateAtomic(
    messageId: string, emoji: string, userId: string, active: boolean,
  ): Promise<Record<string, string[]> | false | null> {
    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: { query(sql: string, params: unknown[]): Promise<{ rows: Array<{ reactions?: unknown }> }> } })._pool,
      'atomic reaction state',
    );
    if (!pool) return null;

    const { rows } = await pool.query(
      `UPDATE messages
          SET reactions = CASE
            WHEN $4::boolean THEN
              CASE
                WHEN COALESCE(reactions -> $2, '[]'::jsonb) @> to_jsonb($3::text)
                  THEN COALESCE(reactions, '{}'::jsonb)
                ELSE jsonb_set(
                  COALESCE(reactions, '{}'::jsonb), ARRAY[$2],
                  COALESCE(reactions -> $2, '[]'::jsonb) || to_jsonb($3::text), true)
              END
            ELSE
              CASE
                WHEN NOT (COALESCE(reactions -> $2, '[]'::jsonb) @> to_jsonb($3::text))
                  THEN COALESCE(reactions, '{}'::jsonb)
                WHEN jsonb_array_length(COALESCE(reactions -> $2, '[]'::jsonb)) <= 1
                  THEN COALESCE(reactions, '{}'::jsonb) - $2
                ELSE jsonb_set(
                  COALESCE(reactions, '{}'::jsonb), ARRAY[$2],
                  COALESCE(reactions -> $2, '[]'::jsonb) - $3)
              END
          END
        WHERE _id = $1
          AND (
            NOT $4::boolean
            OR COALESCE(reactions, '{}'::jsonb) ? $2
            OR (SELECT count(*) FROM jsonb_object_keys(COALESCE(reactions, '{}'::jsonb))) < 20
          )
        RETURNING reactions`,
      [messageId, emoji, userId, active],
    );
    const row = rows[0];
    if (!row) return false;
    return (row.reactions ?? {}) as Record<string, string[]>;
  }

  async toggleReactionAtomic(
    messageId: string, emoji: string, userId: string,
  ): Promise<Record<string, string[]> | false | null> {
    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: { query(sql: string, params: unknown[]): Promise<{ rows: Array<{ reactions?: unknown }> }> } })._pool,
      'atomic reaction toggle',
    );
    if (!pool) return null;               // test adapter compatibility

    const { rows } = await pool.query(
      `UPDATE messages
         SET reactions = CASE
           WHEN COALESCE(reactions, '{}'::jsonb) ? $2
                AND COALESCE(reactions -> $2, '[]'::jsonb) @> to_jsonb($3::text)
             THEN CASE
                    WHEN jsonb_array_length(COALESCE(reactions -> $2, '[]'::jsonb)) <= 1
                      THEN COALESCE(reactions, '{}'::jsonb) - $2
                    ELSE jsonb_set(
                           COALESCE(reactions, '{}'::jsonb), ARRAY[$2],
                           COALESCE(reactions -> $2, '[]'::jsonb) - $3)
                  END
           ELSE jsonb_set(
                  COALESCE(reactions, '{}'::jsonb), ARRAY[$2],
                  COALESCE(reactions -> $2, '[]'::jsonb) || to_jsonb($3::text), true)
         END
       WHERE _id = $1
         AND (
           COALESCE(reactions, '{}'::jsonb) ? $2
           OR (
             -- DIKKAT: PostgreSQL'de jsonb_object_length DIYE BIR FONKSIYON
             -- YOKTUR. Burada tam olarak o cagriliyordu ve GERCEK veritabani
             -- her reaksiyon degisiminde
             --     error: function jsonb_object_length(jsonb) does not exist
             -- firlatiyordu. Yani hem REST (POST /api/messages/:id/react)
             -- hem de Socket.IO (message:react) yolunda reaksiyonlar
             -- TAMAMEN CALISMIYORDU.
             --
             -- Hata neden gorunmedi: birim testleri bellek-ici mock uzerinde
             -- kosuyor (orada bu dal hic girilmiyor) ve tek "kanit"
             -- tests/reaction-atomic-cap-contract.test.ts idi; o test SQL
             -- METNINI okuyup jsonb_object_length gecmesini bekliyordu.
             -- Yani mock, PostgreSQL'in REDDETTIGI bir sorguyu dogruluyordu.
             --
             -- jsonb_object_keys set dondurur; anahtar sayisi bu alt sorgu
             -- ile alinir. jsonb_array_length (yukarida kullanilan) GERCEK
             -- bir fonksiyondur ve dizi icindir; nesne icin karsiligi yoktur.
             SELECT count(*) FROM jsonb_object_keys(COALESCE(reactions, '{}'::jsonb))
           ) < 20
         )
       RETURNING reactions`,
      [messageId, emoji, userId],
    );
    const row = rows[0];
    if (!row) return false;
    return (row.reactions ?? {}) as Record<string, string[]>;
  }

  /**
   * Super Reaction sayacını message aggregate içinde atomik artırır.
   * `reaction_roles` bu ürün state'inin owner'ı değildir.
   */
  async incrementSuperReactionAtomic(messageId: string, emoji: string): Promise<number | null> {
    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: { query(sql: string, params: unknown[]): Promise<{ rows: Array<{ count?: number | string }> }> } })._pool,
      'atomic super reaction increment',
    );
    if (pool) {
      const { rows } = await pool.query(
        `UPDATE messages
            SET "superReactions" = jsonb_set(
              COALESCE("superReactions", '{}'::jsonb), ARRAY[$2],
              to_jsonb(COALESCE(("superReactions" ->> $2)::int, 0) + 1), true
            )
          WHERE _id = $1
          RETURNING ("superReactions" ->> $2)::int AS count`,
        [messageId, emoji],
      );
      const row = rows[0];
      return row ? Number(row.count ?? 0) : null;
    }

    // Test/non-PG adapter compatibility. Production PostgreSQL uses the atomic
    // statement above; fallback preserves semantics for local/unit adapters.
    const msg = await db.messages.findOne({ _id: messageId });
    if (!msg) return null;
    const current = (msg.superReactions && typeof msg.superReactions === 'object')
      ? { ...(msg.superReactions as Record<string, number>) }
      : {};
    const count = Number(current[emoji] ?? 0) + 1;
    current[emoji] = count;
    await db.messages.update({ _id: messageId }, { $set: { superReactions: current } });
    return count;
  }

  /** FTS5 / PG arama adaptörü — loader üzerinden. */
  async ftsSearch(
    searchTerm: string,
    serverIds: string | string[],
    limit: number | string,
    allowedChannelIds?: string[],
  ) {
    if (!db._ftsSearch) return [];
    return db._ftsSearch(
      searchTerm,
      Array.isArray(serverIds) ? serverIds : [serverIds],
      Number(limit),
      allowedChannelIds,
    );
  }

  /**
   * Birleşik arama — kanal, DM, grup DM ve thread yanıtları TEK sorguda.
   *
   * `ftsSearch` yalnızca `messages` tablosunu görür; mesajlar ise dört ayrı
   * tabloda yaşar. Bu adaptör dördünü birden arar ve her satırı `_source`
   * ile etiketler.
   *
   * YETKİ: DM ve grup DM üyeliği SQL içinde zorunlu kılınır (fts.ts). Kanal
   * ve thread satırları yalnızca sunucu üyeliğiyle kapsanır; kanal bazlı
   * VIEW_CHANNELS kontrolü çağıranın sorumluluğundadır — mevcut
   * `/api/search` sözleşmesiyle aynı.
   *
   * Yalnızca PostgreSQL backend'inde vardır; yoksa boş döner.
   */
  async unifiedSearch(
    searchTerm: string,
    scope: { userId: string; serverIds: string[]; channelIds?: string[]; sources?: readonly string[] },
    limit: number | string = 50,
  ) {
    if (!db._unifiedSearch) return [];
    return db._unifiedSearch(searchTerm, scope, Number(limit));
  }

  hasUnifiedSearch() {
    return !!db._unifiedSearch;
  }

  /**
   * Arama isabetinin CEVRESINDEKI konusma.
   *
   * YETKI: DM ve grup DM uyeligi SQL icinde zorunlu kilinir
   * (db/postgres/search-context.ts). Kanal ve thread satirlari yalnizca
   * SUNUCU uyeligiyle kapsanir; kanal bazli VIEW_CHANNELS denetimi
   * cagiranin sorumlulugundadir — `unifiedSearch` ile AYNI model.
   *
   * Capa bulunamazsa (yok VEYA yetkisiz) `null` doner; iki durum
   * AYRILMAZ, aksi halde bir mesajin varligi ele verilirdi.
   */
  async searchContext(
    messageId: string,
    source: string,
    scope: { userId: string; serverIds: string[] },
    radius = 2,
  ) {
    if (!db._searchContext) return null;
    return db._searchContext(messageId, source, scope, radius) as Promise<{
      messages: { _id: string; userId: string; displayName: string | null;
                  content: string | null; createdAt: number; isAnchor: boolean }[];
      channelId: string | null;
      serverId: string | null;
    } | null>;
  }

  hasSearchContext() {
    return !!db._searchContext;
  }

  /**
   * Kanal mesajlarını cursor tabanlı getirir.
   *
   * `createdAt` millisecond resolution is not unique.  A timestamp-only
   * boundary silently loses rows whenever a page ends inside a same-ms burst.
   * Canonical callers therefore supply the `_id` tie-breaker from the cursor
   * and both the predicate and ORDER BY use the same `(createdAt, _id)` key.
   * Timestamp-only callers retain their legacy semantics.
   */
  /**
   * Earliest message after a user's chronological read cursor, excluding that
   * user's own messages. Used only to place the visual "first unread" boundary;
   * authorization remains owned by the route before this repository is called.
   *
   * ── Final21 Faz 8 — F21-8-03: TARAMA SINIRLI ──────────────────────────────
   * Bu sorgu HER kanal açılışında (geçmişin ilk sayfası) bekletilerek koşar.
   * `userId != me` filtresi indeks sırasında satır satır uygulanır; okuma
   * konumundan sonraki mesajların HEPSİ okuyucunun kendisine aitse filtre
   * hepsini reddeder ve tarama kanalın SONUNA kadar yürür.
   *
   * ÖLÇÜLDÜ (PostgreSQL 18, 1.000.000 mesajlı kanal, EXPLAIN ANALYZE):
   *     okuma konumu başta, sonrası okuyucunun  : 18 813 ms   filtre-atılan 999 999
   *     olağan okuyucu                           :     1.2 ms
   * Kanal açılışı ~19 sn asılı kalıyordu. Toplu içe aktarma / köprülenmiş geçmiş
   * tek bir kullanıcıya yazılmışsa ya da bir bot hesabı arayüz açarsa gerçek.
   * (Anti-spam insan hızını ~4 000 mesaj/saatle sınırladığı için pratik bir
   * DoS değildir.)
   *
   * DÜZELTME: aday tarama `FIRST_UNREAD_SCAN_WINDOW` satırla sınırlanır.
   *     en kötü durum : 18 813 ms -> 19.0 ms   (tam 1 000 indeks satırı)
   *     olağan durum  :    1.2 ms ->  0.2 ms   (tembel çekme; ek Sort düğümü YOK)
   * Yeni indeks EKLENMEDİ: en sıcak tabloya kalıcı yazma maliyeti, bir uç durum
   * için ölçülen kanıtla orantılı değildi.
   *
   * ANLAM: okuma konumundan sonraki ilk `FIRST_UNREAD_SCAN_WINDOW` mesajın
   * TAMAMI okuyucunun kendisine aitse ayraç YERLEŞTİRİLMEZ. Bu, işaretin
   * zaten var olan en-iyi-çaba sözleşmesiyle tutarlıdır (ilk ziyarette ve
   * hata durumunda da ayraç yoktur). Bir insan iki ziyaret arasında aynı
   * kanala art arda 1 000 mesaj yazmaz.
   */
  async findFirstUnreadAfter(
    channelId: string, userId: string, after: number, afterId: string,
  ) {
    if (db._pool?.query) {
      const { rows } = await db._pool.query(
        `SELECT w._id, w."userId", w."createdAt"
           FROM (
             SELECT _id, "userId", "createdAt"
               FROM messages
              WHERE "channelId" = $1
                AND ("createdAt", _id) > ($2, $3)
              ORDER BY "createdAt", _id
              LIMIT $4
           ) w
          WHERE w."userId" <> $5
          ORDER BY w."createdAt", w._id
          LIMIT 1`,
        [channelId, after, afterId, FIRST_UNREAD_SCAN_WINDOW, userId],
      );
      return rows[0] ?? null;
    }

    // Koleksiyon yolu (PostgreSQL yokken): AYNI sınırlı anlam.
    const window = await db.messages.find({
      channelId,
      $or: [
        { createdAt: { $gt: after } },
        { createdAt: after, _id: { $gt: afterId } },
      ],
    }).sort({ createdAt: 1, _id: 1 }).limit(FIRST_UNREAD_SCAN_WINDOW);
    return (window as Array<{ userId?: unknown }>).find((row) => row?.userId !== userId) ?? null;
  }

  async findByChannel(
    channelId: string,
    { limit = 50, before, beforeId, after, afterId, search }: {
      limit?: number;
      before?: number;
      beforeId?: string;
      after?: number;
      afterId?: string;
      search?: string;
    } = {},
  ) {
    // Soft-deleted rows are AUDIT state, not content (lib/deleteMessageCascade.ts scrubs the
    // payload and leaves '[Mesaj silindi]'). They were still returned here, so a deleted
    // message disappeared live and came BACK as a "[Mesaj silindi]" line after a reload — in
    // that Turkish spelling for every locale (Final21 Phase 16, p16-tombstone-probe 2/4).
    // Live and reload must tell the same story. Search (db/postgres/fts.ts) already filters them.
    const query: Record<string,unknown> = { channelId, deletedAt: null };
    const isAfter = after !== undefined;
    if (isAfter) {
      query.$or = afterId
        ? [{ createdAt: { $gt: after } }, { createdAt: after, _id: { $gt: afterId } }]
        : [{ createdAt: { $gt: after } }];
    } else if (before !== undefined) {
      query.$or = beforeId
        ? [{ createdAt: { $lt: before } }, { createdAt: before, _id: { $lt: beforeId } }]
        : [{ createdAt: { $lt: before } }];
    }
    if (search) {
      // $regex ile LIKE sorgusuna dönüştürülür (db/index.js buildWhere)
      const escaped = search.replace(/[%_\\]/g, (c: string) => `\\${c}`);
      query.content = { $regex: escaped };
    }
    // Sprint 122 FIX — yön başına doğru pencere:
    //   before/varsayılan → en YENİ N kayıt   (DESC + limit, sonra ASC'ye çevrilir)
    //   after             → cursor'dan sonraki en ESKİ N kayıt (ASC + limit)
    // Eskiden her iki yönde de DESC kullanılıyordu; "after" sayfası cursor'la
    // bitişik olmayan, en yeni uçtan bir pencere döndürüyordu.
    const messages = await db.messages
      .find(query)
      .sort({ createdAt: isAfter ? 1 : -1, _id: isAfter ? 1 : -1 })
      // Routes request one look-ahead row to compute `hasMore`; the public
      // response remains capped at 100 while this internal read may fetch 101.
      .limit(Math.min(limit, 101));
    // Dönüş her zaman eskiden→yeniye (ASC).
    return isAfter ? messages : messages.reverse();
  }

  async findById(id: string) {
    return db.messages.findOne({ _id: id });
  }

  /** Idempotency lookup for durable scheduled-message dispatch. */
  async findByScheduledId(scheduledId: string) {
    return db.messages.findOne({ scheduledId });
  }

  /** Durable retry lookup; ack ids are intentionally scoped to their author. */
  async findByAckIdForUser(ackId: string, userId: string) {
    return db.messages.findOne({ ackId, userId });
  }

  /**
   * New channel messages are stored RAW (Final21 Phase 16, lib/storedText.ts). A caller that
   * COPIES an existing row (crosspost, forwarding) passes that row's `contentFormat` along.
   */
  async create(data: Record<string, unknown>) {
    return db.messages.insert({ contentFormat: RAW_TEXT_FORMAT, ...data });
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.messages.update({ _id: id }, { $set: fields });
  }

  /**
   * Sprint 122: silinen bir mesaja yapılmış yanıtların replyTo anlık görüntüsünü
   * `deleted: true` ile işaretler ("orijinal mesaj silindi" durumu reload sonrası
   * da korunsun diye). PG yolunda bu iş tek UPDATE ile transaction içinde yapılır
   * (lib/deleteMessageCascade.ts); burası tx'siz/mock yol içindir.
   */
  async markRepliesDeleted(channelId: string, deletedMessageId: string) {
    const all = await db.messages.find({ channelId });
    const targets = (all ?? []).filter(m => m.replyTo?._id === deletedMessageId && !m.replyTo.deleted);
    for (const m of targets) {
      await db.messages.update({ _id: m._id }, { $set: { replyTo: { ...m.replyTo, deleted: true } } });
    }
    return targets.length;
  }

  /**
   * Sprint 121 FIX 17: Soft delete — mesajı fiziksel olarak silmez.
   * İçeriği '[Mesaj silindi]' ile değiştirir, deletedAt timestamp'ini ekler.
   * Audit trail için yalnız silme metadata'sı korunur; kullanıcı payload'ı temizlenir.
   */
  async softDelete(id: string, deletedBy: string) {
    return db.messages.update({ _id: id }, {
      $set: {
        content:   '[Mesaj silindi]',
        deletedAt: Date.now(),
        deletedBy,
        embeds:           null,
        encryptedContent: null,
        iv:               null,
        fileUrl:          null,
        fileName:         null,
        fileType:         null,
        editHistory:      [],
        transcript:       null,
      },
    });
  }

  /**
   * Sprint 121 FIX 18: Toplu soft delete — moderatör spam temizleme için.
   * En fazla 100 mesaj tek seferde silinebilir.
   * ids: string[] (max 100), deletedBy: moderatör userId
   */
  async bulkSoftDelete(ids: string[], deletedBy: string): Promise<number> {
    if (!ids.length) return 0;
    const limited = ids.slice(0, 100);
    let count = 0;
    for (const id of limited) {
      await this.softDelete(id, deletedBy);
      count++;
    }
    return count;
  }

  async delete(id: string) {
    return db.messages.remove({ _id: id });
  }

  async deleteByChannel(channelId: string) {
    return db.messages.remove({ channelId });
  }

  async count(query = {}) {
    return db.messages.count(query);
  }

  async removeByUser(userId: string) {
    return db.messages.remove({ userId });
  }

  async deleteUserMessages(userId: string, serverId?: string, since?: Date | number) {
    const query: Record<string, unknown> = { userId };
    if (serverId) query.serverId = serverId;
    if (since) query.createdAt = { $gt: since instanceof Date ? since.getTime() : since };
    return db.messages.remove(query);
  }

  async removeByServer(serverId: string) {
    return db.messages.remove({ serverId });
  }

  async findProjected(query: Record<string, unknown>, options?: Record<string, unknown>) {
    return db.messages.find(query, options);
  }

  async findWhere(query: Record<string, unknown>) {
    return db.messages.find(query);
  }

  /** Zincir (.sort/.skip/.limit) için ham find. */
  messagesFind(query: Record<string, unknown>) {
    return db.messages.find(query);
  }

  async findPinsInChannel(channelId: string, limit = 50) {
    return db.messages.find({ channelId, pinned: true }).sort({ createdAt: -1 }).limit(limit);
  }

  /** Ana kanal mesajındaki thread bağlantısını sıfırlar (forum thread silindiğinde). */
  async clearThreadFromParent(parentMessageId?: string | null) {
    if (!parentMessageId) return null;
    return db.messages.update({ _id: parentMessageId }, { $set: { threadId: null, threadCount: 0 } });
  }

  async countByChannel(channelId: string) {
    return db.messages.count({ channelId });
  }

  async findPinned(channelId: string) {
    // Same reason as findByChannel: a pinned message that was deleted must not come back as a
    // '[Mesaj silindi]' entry in the pinned panel (Final21 Phase 16).
    return db.messages.find({ channelId, pinned: 1, deletedAt: null }).sort({ createdAt: -1 });
  }

  /**
   * Birden fazla kanal için son mesaj timestamp'lerini getirir.
   * Kanal listesi sidebar'ı için unread göstergesi hesaplamada kullanılır.
   * @param {string[]} channelIds
   * @returns {Promise<{channelId: string, lastAt: number}[]>}
   */
  async findLastTimestamps(channelIds: string[]) {
    if (!channelIds?.length) return [];
    if (db._pool?.query) {
      // ══════════════════════════════════════════════════════════════════
      // GRUP BASINA EN BUYUK: LATERAL, `MAX() GROUP BY`DAN ~10x HIZLI
      // ══════════════════════════════════════════════════════════════════
      // Bu sorgu KANAL LISTESI kenar cubugunu besler (okunmamis gostergesi)
      // ve her uygulama acilisinda calisir.
      //
      // `MAX(...) GROUP BY "channelId"` her kanalin TUM satirlarini taramak
      // zorundadir. `unnest` + `LATERAL ... ORDER BY "createdAt" DESC LIMIT 1`
      // ise kanal basina indeksten TEK satir ceker.
      //
      // OLCULDU (PostgreSQL 17.11, 300.000 mesaj, 21 kanal, 30 yineleme):
      //     MAX() GROUP BY : p50 21.92 ms   p95 22.87 ms   plan 23.81 ms
      //     LATERAL        : p50  2.22 ms   p95  2.85 ms   plan  0.95 ms
      //
      // Bileşik `("channelId","createdAt")` indeksi de DENENDI ve GROUP BY'i
      // hizlandirmadi (23.70 ms) -- yani cozum indeks eklemek degil, sorguyu
      // dogru bicimde yazmakti. Olcum betigi: scripts/perf-baseline.cjs
      //
      // SOZLESME AYNI: mesaji olmayan kanallar sonuca GIRMEZ. `LEFT JOIN`
      // NULL uretir, `WHERE ... IS NOT NULL` onlari eler; boylece cikti eski
      // `GROUP BY` davranisiyla birebir ayni kalir.
      const { rows } = await db._pool.query(
        `SELECT c.id AS "channelId", m."createdAt" AS "lastAt"
           FROM unnest($1::text[]) AS c(id)
           LEFT JOIN LATERAL (
             SELECT "createdAt"
               FROM messages
              WHERE "channelId" = c.id
              ORDER BY "createdAt" DESC
              LIMIT 1
           ) m ON TRUE
          WHERE m."createdAt" IS NOT NULL`,
        [channelIds]
      );
      return rows.map((r: Record<string,unknown>) => ({ channelId: r.channelId, lastAt: Number(r.lastAt) }));
    }
    // $in destekli toplu sorgu — N ayrı findOne yerine tek sorgu
    const rows = await db.messages.find({ channelId: { $in: channelIds } })
      .sort({ createdAt: -1 });
    // Her kanal için ilk (en son) mesajı al
    const seen = new Set();
    const result = [];
    for (const m of rows) {
      if (!seen.has(m.channelId)) {
        seen.add(m.channelId);
        result.push({ channelId: m.channelId, lastAt: m.createdAt });
      }
    }
    return result;
  }
}

export default new MessageRepository();
