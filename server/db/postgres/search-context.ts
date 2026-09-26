// server/db/postgres/search-context.ts
//
// ARAMA SONUCU BAĞLAM ÖNİZLEMESİ — bir isabetin ÇEVRESİNDEKİ konuşma.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI BİR MODÜL
// ════════════════════════════════════════════════════════════════════════════
// `fts.ts` ARAR; bu modül BULUNANIN ÇEVRESİNİ getirir. İkisi farklı sorgu
// şekilleridir (biri tsquery + rank, diğeri zaman ekseninde pencere) ve
// karıştırmak fts.ts'i okunamaz hale getirirdi.
//
// ════════════════════════════════════════════════════════════════════════════
// YETKİLENDİRME — ARAMAYLA AYNI DİSİPLİN
// ════════════════════════════════════════════════════════════════════════════
// Bağlam, aramanın kendisinden DAHA FAZLA içerik döndürür: kullanıcının
// aramadığı, sorguyla eşleşmeyen komşu mesajlar. Bu yüzden yetki BURADA
// yeniden uygulanır — istemciden gelen hiçbir alana güvenilmez.
//
//   • DM        — `dm_conversations.participants ? userId` SQL İÇİNDE
//   • grup DM   — `group_dm_members` JOIN'i SQL İÇİNDE
//   • kanal/thread — SQL yalnızca SUNUCU üyeliğiyle kapsar; kanal bazlı
//     VIEW_CHANNELS denetimi ÇAĞIRANIN sorumluluğundadır (routes/search.ts),
//     `/api/search` ve `/api/search/unified` ile bit bit aynı model.
//
// Çapa mesajı bulunamazsa (yok VEYA yetki yok) ayrım YAPILMAZ: her iki durum
// da null döner. Aksi halde uç nokta bir mesajın VARLIĞINI ele verirdi.
//
// Şifreli içerik burada da dışarıdadır — arama sorgusuyla aynı yüklemler.

import { pool } from './pool';
import logger from '../../lib/logger';

export type ContextSource = 'channel' | 'thread' | 'dm' | 'gdm';

export interface ContextRow {
  _id:         string;
  userId:      string;
  displayName: string | null;
  content:     string | null;
  createdAt:   number;
  /** Çapa mesajın kendisi mi? İstemci onu vurgular. */
  isAnchor:    boolean;
}

export interface ContextScope {
  userId:    string;
  serverIds: string[];
}

export interface ContextResult {
  /** Çapa dahil, zaman sırasına dizilmiş pencere. */
  messages: ContextRow[];
  /** Kanal/thread için çağıranın VIEW_CHANNELS denetimi yapabilmesi adına. */
  channelId: string | null;
  /**
   * Çapanın GERÇEK sunucusu.
   *
   * NEDEN GEREKLİ: çağıran, izinleri `resolvePermissions(user, serverId,
   * channelId)` ile çözer. Sunucu kimliğini TAHMİN etmek (ör. kullanıcının
   * üye olduğu sunucular arasında ilkini denemek) yanlış sunucuya karşı
   * izin çözer ve yetkili kullanıcıya bile 404 verir — ilk sürümde tam
   * olarak bu oldu. Kaynağı SQL'dir.
   */
  serverId: string | null;
}

/** Bağlam penceresi üst sınırı — istemci daha fazlasını isteyemez. */
export const MAX_CONTEXT_RADIUS = 5;

// ════════════════════════════════════════════════════════════════════════════
// PLACEHOLDER ↔ PARAMETRE EŞLEŞMESİ — SESSİZ KUSUR KAYNAĞI
// ════════════════════════════════════════════════════════════════════════════
// PostgreSQL, sorgunun REFERANS VERDİĞİNDEN FAZLA parametre gönderilmesini
// REDDEDER: "bind message supplies 3 parameters, but prepared statement
// requires 2".
//
// İlk sürümde tüm kaynaklar için SABİT bir `[messageId, serverIds, userId]`
// dizisi gönderiliyordu; oysa kanal sorgusu `$3`e (kullanıcı) hiç referans
// vermez. Sonuç: kanal bağlamı HER ZAMAN başarısız oluyor, `catch` hatayı
// yutuyor ve uç nokta yetkili kullanıcıya bile 404 dönüyordu.
//
// Bu, `fts.ts`teki kullanılmayan `$1` kusurunun AYNI SINIFIDIR. Bu yüzden
// parametreler artık sorgunun YANINDA üretilir ve `tests/search-context-sql
// .test.ts` her kaynak için eşleşmeyi doğrular.
//
// Düzen kaynağa göre değişir:
//   kanal/thread → $1 kimlik/kapsam, $2 sunucular, $3 zaman, $4 sınır
//   dm/grup dm   → $1 kimlik/kapsam, $2 kullanıcı, $3 zaman, $4 sınır

/** Sunucuya bağlı kaynaklar `serverIds`, kullanıcıya bağlı olanlar `userId` alır. */
export const SERVER_SCOPED_SOURCES: readonly ContextSource[] = ['channel', 'thread'];

/** Çapa sorgusunun parametreleri — sorgunun referans verdiği KADAR. */
export function anchorParams(
  source: ContextSource, messageId: string, scope: ContextScope,
): unknown[] {
  return SERVER_SCOPED_SOURCES.includes(source)
    ? [messageId, scope.serverIds ?? []]
    : [messageId, scope.userId];
}

/** Pencere sorgusunun parametreleri. */
export function windowParams(
  source: ContextSource, scopeId: string, scope: ContextScope, at: number, limit: number,
): unknown[] {
  return SERVER_SCOPED_SOURCES.includes(source)
    ? [scopeId, scope.serverIds ?? [], at, limit]
    : [scopeId, scope.userId, at, limit];
}

/** Kaynağa göre çapa sorgusu. */
export const ANCHOR_SQL: Record<ContextSource, string> = {
  channel: `
    SELECT m._id, m."createdAt", m."channelId" AS scope_id, m."serverId" AS server_id
    FROM messages m
    WHERE m._id = $1
      AND m."serverId" = ANY($2)
      AND m."deletedAt" IS NULL
      AND m.type <> 'e2ee'`,
  thread: `
    SELECT t._id, t."createdAt", t."threadId" AS scope_id, t."serverId" AS server_id
    FROM thread_messages t
    WHERE t._id = $1
      AND t."serverId" = ANY($2)`,
  gdm: `
    SELECT g._id, g."createdAt", g."groupId" AS scope_id, NULL::text AS server_id
    FROM group_dm_messages g
    JOIN group_dm_members gm ON gm."groupId" = g."groupId" AND gm."userId" = $2
    WHERE g._id = $1`,
  dm: `
    SELECT d._id, d."createdAt", d."dmId" AS scope_id, NULL::text AS server_id
    FROM dm_messages d
    JOIN dm_conversations c ON c._id = d."dmId"
    WHERE d._id = $1
      AND c.participants ? $2
      AND d."isEncrypted" = FALSE AND d.e2e = FALSE`,
};

/** Çapanın kendi gövdesi — pencere sorguları onu dışarıda bırakır (`<` / `>`). */
export const ANCHOR_ROW_SQL: Record<ContextSource, string> = {
  channel: `
    SELECT m._id, m."userId", m."displayName", m.content, m."createdAt"
    FROM messages m
    WHERE m._id = $1 AND m."serverId" = ANY($2)
      AND m."deletedAt" IS NULL AND m.type <> 'e2ee'`,
  thread: `
    SELECT t._id, t."userId", t."displayName", t.content, t."createdAt"
    FROM thread_messages t
    WHERE t._id = $1 AND t."serverId" = ANY($2)`,
  gdm: `
    SELECT g._id, g."userId", g."displayName", g.content, g."createdAt"
    FROM group_dm_messages g
    JOIN group_dm_members gm ON gm."groupId" = g."groupId" AND gm."userId" = $2
    WHERE g._id = $1`,
  dm: `
    SELECT d._id, d."userId", d."displayName", d.content, d."createdAt"
    FROM dm_messages d
    JOIN dm_conversations c ON c._id = d."dmId"
    WHERE d._id = $1 AND c.participants ? $2
      AND d."isEncrypted" = FALSE AND d.e2e = FALSE`,
};

/**
 * Çapanın çevresindeki pencereyi getiren sorgu.
 *
 * Yetki yüklemleri BURADA DA tekrarlanır. Çapanın yetkili olması, aynı
 * konuşmadaki her satırın yetkili olduğunu KANITLAMAZ; yüklemi tekrarlamak
 * ucuzdur ve sınırı tek bir noktaya bağımlı bırakmaz.
 *
 * Parametreler `windowParams` ile üretilir — sayıları sorguya göre değişir.
 */
export function windowSql(source: ContextSource, direction: 'before' | 'after'): string {
  const cmp   = direction === 'before' ? '<' : '>';
  const order = direction === 'before' ? 'DESC' : 'ASC';

  if (source === 'channel') {
    return `
      SELECT m._id, m."userId", m."displayName", m.content, m."createdAt"
      FROM messages m
      WHERE m."channelId" = $1
        AND m."serverId" = ANY($2)
        AND m."deletedAt" IS NULL
        AND m.type <> 'e2ee'
        AND m."createdAt" ${cmp} $3
      ORDER BY m."createdAt" ${order}
      LIMIT $4`;
  }
  if (source === 'thread') {
    return `
      SELECT t._id, t."userId", t."displayName", t.content, t."createdAt"
      FROM thread_messages t
      WHERE t."threadId" = $1
        AND t."serverId" = ANY($2)
        AND t."createdAt" ${cmp} $3
      ORDER BY t."createdAt" ${order}
      LIMIT $4`;
  }
  if (source === 'gdm') {
    return `
      SELECT g._id, g."userId", g."displayName", g.content, g."createdAt"
      FROM group_dm_messages g
      JOIN group_dm_members gm ON gm."groupId" = g."groupId" AND gm."userId" = $2
      WHERE g."groupId" = $1
        AND g."createdAt" ${cmp} $3
      ORDER BY g."createdAt" ${order}
      LIMIT $4`;
  }
  return `
    SELECT d._id, d."userId", d."displayName", d.content, d."createdAt"
    FROM dm_messages d
    JOIN dm_conversations c ON c._id = d."dmId"
    WHERE d."dmId" = $1
      AND c.participants ? $2
      AND d."isEncrypted" = FALSE AND d.e2e = FALSE
      AND d."createdAt" ${cmp} $3
    ORDER BY d."createdAt" ${order}
    LIMIT $4`;
}

/** Thread'in ait olduğu kanal — VIEW_CHANNELS denetimi için gerekir. */
async function threadChannelId(threadId: string, serverIds: string[]): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      `SELECT t."channelId" FROM thread_messages t
       WHERE t."threadId" = $1 AND t."serverId" = ANY($2) LIMIT 1`,
      [threadId, serverIds],
    );
    return rows.length ? String(rows[0].channelId) : null;
  } catch { return null; }
}

function toRow(x: Record<string, unknown>, isAnchor: boolean): ContextRow {
  return {
    _id:         String(x._id),
    userId:      String(x.userId ?? ''),
    displayName: (x.displayName as string | null) ?? null,
    content:     (x.content as string | null) ?? null,
    createdAt:   Number(x.createdAt),
    isAnchor,
  };
}

export async function searchContext(
  messageId: string,
  source: ContextSource,
  scope: ContextScope,
  radius = 2,
): Promise<ContextResult | null> {
  if (!messageId || !scope?.userId) return null;
  if (!ANCHOR_SQL[source]) return null;

  const r = Math.min(MAX_CONTEXT_RADIUS, Math.max(1, Math.floor(radius) || 1));
  const serverIds = scope.serverIds ?? [];

  // Sunucuya bağlı kaynak için üyelik yoksa sorgu anlamsızdır.
  if ((source === 'channel' || source === 'thread') && !serverIds.length) return null;

  try {
    const { rows: anchorRows } = await pool.query(
      ANCHOR_SQL[source], anchorParams(source, messageId, { userId: scope.userId, serverIds }),
    );
    // Yok VEYA yetkisiz — AYRIM YAPILMAZ.
    if (!anchorRows.length) return null;

    const anchor = anchorRows[0] as {
      createdAt: string | number; scope_id: string; server_id: string | null;
    };
    const at = Number(anchor.createdAt);
    const scoped = { userId: scope.userId, serverIds };
    const winParams = windowParams(source, anchor.scope_id, scoped, at, r);

    const [before, after, self] = await Promise.all([
      pool.query(windowSql(source, 'before'), winParams),
      pool.query(windowSql(source, 'after'),  winParams),
      pool.query(ANCHOR_ROW_SQL[source], anchorParams(source, messageId, scoped)),
    ]);

    if (!self.rows.length) return null;

    const messages = [
      ...(before.rows as Record<string, unknown>[]).reverse().map(x => toRow(x, false)),
      toRow(self.rows[0] as Record<string, unknown>, true),
      ...(after.rows as Record<string, unknown>[]).map(x => toRow(x, false)),
    ];

    const channelId = source === 'channel' ? anchor.scope_id
                    : source === 'thread'  ? await threadChannelId(anchor.scope_id, serverIds)
                    : null;

    return { messages, channelId, serverId: anchor.server_id ?? null };
  } catch (err) {
    // SESSİZ YUTMA YOK. Bu `catch` bir kez tanı koymayı imkânsız hale
    // getirdi: uç nokta 404 dönüyordu, sebep görünmüyordu. Çağırana hâlâ
    // `null` döneriz (yetki sızdırmamak için), ama operatör sebebi görür.
    logger.debug({ event: 'search_context.failed', source, messageId, err },
                 'Arama bağlamı getirilemedi');
    return null;
  }
}
