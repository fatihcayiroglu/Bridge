// server/db/postgres/pgCollection.ts
// SQLite Collection ile birebir aynı async API'yi PostgreSQL üzerinde sağlar.
// Hiçbir route değişikliği gerekmez; sadece db/loader.js'i değiştirmek yeter.

import type { QueryingPool, QueryingClient, QueryResultLike } from './pool-contracts';
import { v4 as uuidv4 } from 'uuid';

const JSONB_COLS = new Set([
  // `readAt` dm_conversations üzerinde JSONB'dir (userId → zaman damgası
  // eşlemesi). Listede olmadığı için nesne olarak serialize EDİLMİYORDU.
  'readAt',
  // `transports` webauthn_credentials üzerinde JSONB'dir
  // (migrations.ts:395 — `transports JSONB NOT NULL DEFAULT '[]'`).
  // Listede olmadigi icin dizi serialize EDILMIYORDU ve her passkey kaydi
  // PostgreSQL'de `invalid input syntax for type json` ile 500 veriyordu.
  // Sahte veritabani tur denetimi yapmadigi icin birim testleri geciyordu.
  'transports',
  // `payload` ap_delivery_queue uzerinde JSONB'dir (migrations.ts).
  // `routes/federation/delivery.ts` oraya NESNE yazar ve cagri
  // `.catch(() => {})` ile sarilidir — yani yazma PostgreSQL'de basarisiz
  // oluyordu ve hata SESSIZCE yutuluyordu. Sonuc: federasyon teslim yeniden
  // deneme kuyrugu hicbir zaman dolmuyor, bekleyen teslimler yeniden
  // baslatmada kurtarilamiyordu.
  'payload',
  // ── SEMADAN TURETILEREK BULUNAN EKSIKLER ──────────────────────────────────
  // `tests/jsonb-column-contract.test.ts` kanonik semayi (CREATE TABLE,
  // ALTER TABLE ADD COLUMN ve schema.ts) tarayip bu kolonlarin JSONB oldugunu
  // ama burada listelenmedigini gosterdi. Listelenmeyen bir JSONB kolonuna
  // NESNE yazmak PostgreSQL'de `invalid input syntax for type json` uretir.
  //
  // Eklemek iki yonde de guvenlidir: serializasyon YALNIZCA deger nesne
  // oldugunda calisir, okuma tarafi da YALNIZCA deger dize oldugunda parse
  // eder. Onceden dizeye cevrilmis yazmalar (ornegin `twoFactorBackup`)
  // etkilenmez.
  'twoFactorBackup', 'serverProfile', 'ssoConfig', 'embeds', 'e2eData', 'x3dhSignedPreKey', 'x3dhOneTimePreKeys', 'old', 'new', 'extra',
  'components', 'contextCommands', 'slashCommands', 'attachments',
  'reactions', 'superReactions', 'replyTo', 'bridgedFrom', 'tags', 'roles', 'participants',
  'editHistory', 'options', 'keys', 'meta', 'activity', 'config', 'sticker',
  'events', 'defaultRoles', 'questions', 'answers', 'forumTags', 'grantedScopes',
]);

const TABLE_PRIMARY_KEYS: Record<string, string[]> = {
  members: ['userId', 'serverId'],
  refresh_tokens: ['token'],
  unread_counts: ['userId', 'channelId'],
  notification_keywords: ['userId', 'serverId', 'keyword'],
  user_ap_keys: ['userId'],
  soundboard_user_stats: ['userId', 'soundId'],
};

// ── Kolon adı whitelist (injection koruması) ─────────────────
// Tüm schema'daki geçerli kolon adları. buildWhere / insert / update
// çağrılarında bilinmeyen kolon adları reddedilir.
// Yeni kolon eklendiğinde bu Set'i ve schema.ts'i birlikte güncelleyin.
const ALLOWED_COLUMNS = new Set([
  // ── Evrensel ──────────────────────────────────────────────
  '_id', 'name', 'type', 'status', 'icon', 'url', 'token', 'code', 'used',
  'sent', 'email', 'password', 'username', 'bio', 'website', 'location',
  'pronouns', 'color', 'description', 'topic', 'category', 'label', 'emoji', 'imageUrl',
  'order', 'position', 'active', 'pinned', 'verified', 'banned', 'closed', 'collapsed',
  'count', 'uses', 'duration', 'level', 'detail', 'secret', 'endpoint',
  'platform', 'question', 'permissions', 'allow', 'deny', 'action', 'target', 'eventName', 'keyword',
  // ── Upload sahipliği (Sprint 75) ──────────────────────────
  'key', 'originalName', 'mimeType', 'filename', 'fileSize', 'durationSeconds', 'season', 'episode',
  // ── Zaman ─────────────────────────────────────────────────
  'createdAt', 'editedAt', 'sentAt', 'joinedAt', 'addedAt', 'expiresAt', 'activityUpdatedAt', 'muteUntil',
  'lastSeen', 'lastMessageAt', 'sendAt', 'scheduledId', 'claimOwner', 'claimUntil', 'cancelledAt',
  'dispatchAttempts', 'lastError', 'failedAt', 'failureReason',
  // `readAt`: dm_conversations üzerinde JSONB okundu imleci (userId → ts),
  // dm_messages üzerinde de mevcut. Beyaz listede olmadığı için okundu
  // bildirimi "Unknown column name" ile sessizce başarısız oluyordu.
  'readAt',
  // ── Kullanıcı ─────────────────────────────────────────────
  // 'locale' (migration 075): the language a person reads, used for server-written push copy.
  'locale',
  'createdBy', 'displayName', 'avatarColor', 'avatarUrl', 'bannerColor', 'bannerUrl', 'serverProfile', 'nickname',
  'statusText', 'statusEmoji', 'tokenVersion', 'emailVerified', 'emailToken',
  'emailTokenExp', 'twoFactorSecret', 'twoFactorEnabled', 'twoFactorBackup', 'twoFactorLastUsedStep',
  'isAdmin', 'ssoProvider', 'ssoIssuer', 'ssoId', 'e2ePublicKey', 'e2eKeyVersion', 'e2eAlgorithm', 'e2eKeyUpdatedAt',
  'x3dhIdentityKey', 'x3dhSignedPreKey', 'x3dhOneTimePreKeys', 'x3dhUpdatedAt',
  // ── Auth ──────────────────────────────────────────────────
  'userId', 'family', 'usedAt', 'tokenHash',
  // ── Sunucu / Kanal ────────────────────────────────────────
  // Sprint 122: 'nsfw' (kanal oluşturma) ve 'autoModAlert' (autoModeration job'ı)
  // kodda kullanılıyordu ama allow-list'te yoktu → runtime hata. migrations_pg/018.
  'nsfw', 'autoModAlert', 'bitrate', 'slowmode', 'forumTags', 'modOnly', 'featured', 'featuredAt',
  // FAZ J — `roleId` EKLENDI.
  // Canli PostgreSQL calistirilinca ortaya cikti: `channel_permissions` ve
  // `reaction_roles` tablolarinda GERCEK bir `roleId` sutunu var, ancak bu
  // allowlist'te yoktu. Sonuc: `roleId` ile filtreleyen HER sorgu
  // `Unknown column name` hatasi firlatiyordu ve
  // `PUT/DELETE /api/servers/:sid/channels/:cid/permissions/:roleId` 500
  // donuyordu — yani KANAL IZIN OVERRIDE'LARI (ozel kanal yapma mekanizmasi)
  // uretimde tumuyle CALISMIYORDU. Birim testler yakalayamadi: mock DB'de
  // sutun allowlist'i yoktur.
  'ownerId', 'serverId', 'channelId', 'categoryId', 'parentMessageId', 'roleId',
  'threadId', 'threadCount', 'messageCount', 'firstMessage', 'participantCount', 'discoverable', 'iconUrl',
  'logChannelId', 'verificationEnabled', 'defaultRoles', 'ssoConfig',
  'sourceServerId', 'sourceChannelId', 'targetServerId', 'targetChannelId',
  'targetId', 'targetType',
  // ── Giden webhook teslimat durumu ─────────────────────────
  // Bu sutunlar `outgoing_webhooks` tablosuna migration ile EKLENDI
  // (db/postgres/migrations.ts). Allowlist'te olmadiklari icin her teslimat
  // denemesi 500 veriyordu; auto-disable guvenligi hic calismiyordu.
  'consecutiveFailures', 'lastFailedAt', 'lastError', 'lastFiredAt', 'lastStatus',
  // ── Moderasyon: ban sebebi ve denetim gunlugu adlari ──────
  // Bu sutunlar migration ile eklendi; allowlist'te olmadiklari icin
  // ban ucu her cagrida 500 veriyordu.
  'banReason', 'actorName', 'targetName',
  // ── Mesaj / İçerik ────────────────────────────────────────
  // `contentFormat` (migration 074, Final21 Phase 16): 0 legacy sanitized text, 1 raw text.
  'content', 'contentFormat', 'fileUrl', 'fileName', 'fileType', 'ackId', 'clientNonce', 'isEncrypted', 'e2eData', 'transcript', 'webhookId', 'isWebhook', 'flaggedMsgId',
  'bridgedFrom', 'replyTo', 'editHistory', 'reactions', 'superReactions', 'roles', 'tags', 'sticker',
  'participants', 'options', 'keys', 'meta', 'activity', 'config', 'events',
  'questions', 'answers',
  // ── Federation ────────────────────────────────────────────
  'actorId', 'adminId', 'dmId', 'friendId',
  // ── Diğer ─────────────────────────────────────────────────
  'e2e', 'maxUses', 'multiSelect', 'allowVoteChange', 'timeout', 'timeoutUntil',
  'inviteCode', 'inviteCreatedAt',

  'apPublicKey',
  'apPrivateKeyEnc',
  'keyVersion',
  'updatedAt',
  // ── Sticker paketleri (migrations_pg/021) ─────────────────
  // `seq` ve `position` DAHİLİdir: yalnızca ORDER BY için kullanılır,
  // API yanıtına asla konmaz. `_id`/`name`/`url`/`tags`/`description`/
  // `serverId`/`createdAt` zaten yukarıda tanımlı.
  'authorId', 'packId', 'width', 'height', 'seq',

  // ── EKSİK KALMIŞ GERÇEK ŞEMA SÜTUNLARI ────────────────────
  // Bunların hepsi şemada TANIMLI ve üretimde PgCollection üzerinden
  // yazılıp/okunuyordu; listede olmadıkları için `assertValidColumn`
  // çalışma anında hata fırlatıyordu. mockDb bu doğrulamayı yapmadığı
  // için testler yeşil kalıyordu (gerçek PostgreSQL'de patlıyordu).
  //   uploadedBy  → server_emojis/server_gifs/soundboard NOT NULL;
  //                 routes/customEmoji.ts:235, serverGifs.ts:151,
  //                 soundboard.ts:135 ekliyor
  //   completedAt → ServerAssetRepository.markOnboardingComplete
  //   deletedAt   → MessageRepository yumuşak silme
  //   enabled     → OutgoingWebhookRepository.findActive sorgusu
  //   nextAt      → FederationRepository teslim kuyruğu sorgusu
  'uploadedBy', 'completedAt', 'deletedAt', 'enabled', 'nextAt',
  // Soundboard library/user-state (migration 059).
  'soundId', 'favorite', 'favoritedAt', 'playCount',
  // Migration 022 — rol sunum bayragi (yetki DEGIL).
  'displayOnProfile',
  // Migration 025 — kişisel Saved / Follow-up hedef kimlikleri.
  // `messageId` zaten aşağıdaki canlı şema kümesinde yer alır.
  'destinationType', 'destinationId',
  // Migration 063 — user message reports / moderation queue.
  'reporterId', 'resolvedAt', 'resolvedBy', 'resolution',
  // Migration 064 — durable Saved follow-up reminder delivery.
  'remindAt', 'remindedAt', 'lastReadAt', 'lastReadMessageId',

  // ══════════════════════════════════════════════════════════════════════
  // CANLI VERITABANI DENETIMI — TEKRARLAYAN KUSUR AILESI TOPTAN KAPATILDI
  // ══════════════════════════════════════════════════════════════════════
  // Bu allow-list semanin GERISINDE kalmisti ve her eksik sutun CALISMA
  // ZAMANINDA 500'e donusuyordu (deger degil, SUTUN ADI reddediliyor):
  //   · Faz J : 'roleId'   eksik -> kanal izin override uclari 500
  //   · simdi : 'groupId'  eksik -> GRUP DM OLUSTURMA hic calismiyordu
  //   · simdi : 'featured' eksik -> GET /api/discover/featured 500
  //     (her ikisi de canli sunucu loglarinda dogrulandi)
  //
  // YONTEM: liste tahminle degil, CALISAN veritabanindan turetildi:
  //   SELECT DISTINCT column_name FROM information_schema.columns
  //   WHERE table_schema = 'public'
  // 265 gercek sutunun 122'si burada YOKTU; hepsi asagida.
  //
  // GUVENLIK NOTU: bu Set bir SQL ENJEKSIYON savunmasidir (sutun adi
  // parametre olamaz). Eklenen adlarin tamami veritabaninda GERCEKTEN
  // bulunan sutunlardir ve degerler her zaman parametrelenmeye devam eder.
  // Koruma GEVSETILMEZ; yalnizca semayla hizalanir.
  'accepted', 'acceptedAt', 'accessToken', 'activityId', 'actorInbox', 'actorUrl', 'actorUserId', 'addedBy',
  'apId', 'applied_at', 'approved', 'attachments', 'attempts', 'audioUrl', 'author', 'authorVerified',
  'avatar', 'awardedAt', 'awardedBy', 'badge', 'blockedId', 'blockerId', 'boostCount', 'boostTier',
  'boostedAt', 'botId', 'grantedScopes', 'changelog', 'channel_id', 'col', 'commands', 'components', 'contextCommands', 'slashCommands',
  'counter', 'coverUrl', 'cover_image', 'created_at', 'creator_id', 'credentialId', 'data', 'deletedBy',
  'desc', 'deviceType', 'dmPrivacy', 'domain', 'embeds', 'encryptedContent', 'ends_at', 'event_id',
  // bot_marketplace."executableBotId" (migrations.ts) was never added here, so any
  // pgCollection query touching the marketplace install linkage threw
  // "Unknown column name" instead of running — the exact class of defect that
  // produced the v1.123 production 500s.
  'executableBotId',
  'extra', 'featured', 'featuredAt', 'fetchedAt', 'followedAt', 'followedByUserId', 'fromUserId', 'groupId',
  'id', 'inReplyTo', 'installs', 'ip', 'isBuiltin', 'isPublic', 'iv', 'lang',
  'lastFiredAt', 'lastStatus', 'lastUsedAt', 'line', 'longDescription', 'message', 'messageId', 'mfaLevel',
  'new', 'note', 'noteId', 'noteUrl', 'objectUrl', 'old', 'payload', 'points',
  'presenceStatus', 'presenceVisibility', 'privateKeyEnc', 'processed', 'processedAt', 'publicKey', 'publicKeyPem', 'published', 'publishedAt', 'rating', 'ratingCount',
  'read', 'reason', 'refreshToken', 'reviewerId', 'rolled_back', 'rotatedAt', 'rulesChannelId', 'scope',
  'sensitive', 'server_id', 'source', 'visibility', 'sourceUrl', 'stack', 'starts_at', 'submittedBy', 'summary',
  'supportUrl', 'targetActorUrl', 'targetUserId', 'text', 'title', 'tool', 'transports', 'ts',
  'updated_at', 'user_agent', 'user_id', 'vanityUrl', 'verificationChannelId', 'verificationLevel', 'verificationRoleId', 'webhookUrl',
  'welcomeChannelId', 'welcomeMessage',

  // -- Sema kaymasi duzeltmesi (v1.123) --------------------------
  // Asagidaki 6 ad `information_schema.columns` icinde GERCEKTEN vardir
  // ama listeye hic eklenmemisti. Sonuc teorik degildi: pgCollection
  // uzerinden yazan her yol 500 veriyordu. OLCULDU (v1.123 staging):
  //   POST /api/threads (forum konusu)            -> 500  "locked"
  //   PATCH /api/podcast/:channelId/settings      -> 500  "language"
  //   PATCH /api/podcast/:channelId/settings      -> 500  "explicit"
  // Kalan uc ad (bridgeMessageId, crosspostedAt, lastPlayedAt) bugun
  // yalnizca ham SQL ile yaziliyor, bu yuzden hata vermiyordu; ayni
  // sutunlar pgCollection'a tasinirsa sessizce patlamasin diye eklendi.
  //
  // GUVENLIK: koruma GEVSETILMEDI. Bu adlar serbest metin degil, semada
  // dogrulanmis sabitlerdir; degerler her zaman $1/$2 ile parametrelenir.
  'bridgeMessageId', 'crosspostedAt', 'explicit', 'language', 'lastPlayedAt', 'locked',

  // P6 — servers."aiEnabled" (migration 078): per-server AI opt-out.
  'aiEnabled',
]);

/**
 * Kolon adını doğrula — SQL injection'a karşı ikinci savunma katmanı.
 * Bilinmeyen kolon adları bir hata fırlatır.
 *
 * Bu kontrol parameterized query'ye ek olarak uygulanır; değerler
 * zaten $1/$2 placeholder ile korunuyor. Kolon *adı* ise identifier
 * olduğundan pg driver parametrize edemez — whitelist zorunludur.
 */
function assertValidColumn(col: string): void {
  // $or gibi MongoDB operatörleri bu fonksiyona gelmez
  if (!ALLOWED_COLUMNS.has(col)) {
    throw new Error(
      `[pgCollection] Unknown column name: "${col}". ` +
      "Schema değişikliği yaptıysanız ALLOWED_COLUMNS Set'ini güncelleyin.",
    );
  }
}


// Objeyi DB'ye yazmadan önce JSONB sütunlarını serialize et
function toRow(obj: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && JSONB_COLS.has(k)) {
      row[k] = JSON.stringify(v);
    } else {
      row[k] = v;
    }
  }
  return row;
}

// DB'den gelen satırı JS objesine dönüştür
function fromRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    // PostgreSQL JSONB'yi zaten parse ederek döndürür;
    // string olarak gelirse (eski uyumluluk) parse et
    if (JSONB_COLS.has(k) && typeof v === 'string') {
      try { obj[k] = JSON.parse(v); } catch { obj[k] = v; }
    } else if (typeof v === 'boolean') {
      obj[k] = v;
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

// MongoDB-tarzı query'yi PostgreSQL WHERE + params'a çevirir
type QueryValue = string | number | boolean | null | RegExp | Record<string, unknown> | Array<Record<string, unknown>> | unknown[];
export type DbRecord = Record<string, unknown>;
export type DbQuery<T extends object = DbRecord> = Partial<Record<Extract<keyof T, string>, unknown>> & Record<string, unknown>;
export type DbUpdate<T extends object = DbRecord> = DbQuery<T> & {
  $set?: Partial<T> & DbRecord;
  $inc?: DbRecord;
  $push?: DbRecord;
};
export type DbInsert<T extends object = DbRecord> = Partial<T> & DbRecord;

export interface FindChain<T extends object> extends PromiseLike<T[]> {
  sort(spec: DbQuery<T>): FindChain<T>;
  skip(n: number): FindChain<T>;
  limit(n: number): FindChain<T>;
  catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<T[] | TResult>;
  finally(onfinally?: (() => void) | null): Promise<T[]>;
  [Symbol.asyncIterator](): AsyncGenerator<T, void, unknown>;
}

function _objectToRecord(value: object): DbRecord {
  return Object.fromEntries(Object.entries(value));
}

function typedFromRow<T extends object>(row: DbRecord | null): T | null {
  return fromRow(row) as T | null;
}

export function buildWhere(query: Record<string, unknown> | null | undefined): { sql: string; params: unknown[] } {
  if (!query || Object.keys(query).length === 0) {
    return { sql: 'TRUE', params: [] };
  }

  const parts: string[]  = [];
  const params: unknown[] = [];
  let   n      = 1; // $1, $2, ...

  function addParam(v: unknown): string { params.push(v); return `$${n++}`; }

  /**
   * ══════════════════════════════════════════════════════════════════════════
   * KEYSET IMLECI: DISJONKSIYON YERINE SATIR KARSILASTIRMASI
   * ══════════════════════════════════════════════════════════════════════════
   * Kompozit imlecli sayfalama su bicimi uretir:
   *
   *     createdAt < X  OR  (createdAt = X AND _id < Y)
   *
   * PostgreSQL bir DISJONKSIYONU tek bir indeks aralik kosuluna ceviremez.
   * Sonuc: `(channelId, createdAt DESC, _id DESC)` indeksi seek icin
   * KULLANILAMAZ; planlayici tarar ve filtreler.
   *
   * ── GERCEK PostgreSQL 18 UZERINDE OLCULDU (kanalda 100 000 mesaj) ────────
   *   DESC (gecmise kaydirma)
   *     OR bicimi          : Rows Removed by Filter 200 154 · 6 446 buffer · 64.595 ms
   *     satir karsilastirma: Rows Removed by Filter     154 ·    11 buffer ·  0.277 ms
   *   ASC (imlecten sonrasi)
   *     OR bicimi          : Rows Removed by Filter 100 153 · 3 223 buffer · 35.443 ms
   *     satir karsilastirma: Rows Removed by Filter     154 ·    10 buffer ·  0.231 ms
   *
   * Satir karsilastirma bicimi gercek bir `Index Cond` uretir. Iki bicim AYNI
   * satirlari dondurur (INTERSECT ile dogrulandi: 50/50).
   *
   * Yeniden yazma KASITLI OLARAK DAR tutulur: yalnizca tam olarak bu iki yan
   * tumceli imlec sekli taninir. Baska herhangi bir `$or` dokunulmadan mevcut
   * yoldan gecer — genel bir disjonksiyonu satir karsilastirmasina cevirmek
   * anlami DEGISTIRIR.
   */
  function keysetRowComparison(clauses: Array<Record<string, QueryValue>>): string | null {
    if (!Array.isArray(clauses) || clauses.length !== 2) return null;
    const range = clauses[0];
    const tie   = clauses[1];
    if (!range || !tie || typeof range !== 'object' || typeof tie !== 'object') return null;

    // 1. yan tumce: TEK sutun, TEK kati karsilastirma ($lt / $gt).
    const rangeKeys = Object.keys(range);
    if (rangeKeys.length !== 1) return null;
    const primary = rangeKeys[0]!;
    const rangeSpec = range[primary];
    if (!rangeSpec || typeof rangeSpec !== 'object' || Array.isArray(rangeSpec)) return null;
    const rangeOps = Object.keys(rangeSpec as Record<string, unknown>);
    if (rangeOps.length !== 1) return null;
    const op = rangeOps[0]!;
    if (op !== '$lt' && op !== '$gt') return null;
    const boundary = (rangeSpec as Record<string, unknown>)[op];

    // 2. yan tumce: birincil sutun ESITLIK (ayni sinir) + ikincil sutun AYNI
    // yonde kati karsilastirma.
    const tieKeys = Object.keys(tie);
    if (tieKeys.length !== 2) return null;
    if (!Object.prototype.hasOwnProperty.call(tie, primary)) return null;
    if (tie[primary] !== boundary) return null;
    const secondary = tieKeys.find((key) => key !== primary);
    if (!secondary) return null;
    const tieSpec = tie[secondary];
    if (!tieSpec || typeof tieSpec !== 'object' || Array.isArray(tieSpec)) return null;
    const tieOps = Object.keys(tieSpec as Record<string, unknown>);
    if (tieOps.length !== 1 || tieOps[0] !== op) return null;
    const tieValue = (tieSpec as Record<string, unknown>)[op];

    assertValidColumn(primary);
    assertValidColumn(secondary);
    const sqlOp = op === '$lt' ? '<' : '>';
    const a = addParam(boundary);
    const b = addParam(tieValue);
    return `("${primary}", "${secondary}") ${sqlOp} (${a}, ${b})`;
  }

  function processKey(k: string, v: QueryValue): void {
    if (k !== '$or') assertValidColumn(k);
    const col = `"${k}"`;
    if (k === '$or') {
      const rowComparison = keysetRowComparison(v as Array<Record<string, QueryValue>>);
      if (rowComparison) { parts.push(rowComparison); return; }
      const orParts = (v as Array<Record<string, QueryValue>>).map(sub => {
        const r = buildWhere(sub);
        // Offset param numbering
        const reNumbered = r.sql.replace(/\$(\d+)/g, (_, i) => {
          const newIdx = n + parseInt(i) - 1;
          return `$${newIdx}`;
        });
        n += r.params.length;
        params.push(...r.params);
        return `(${reNumbered})`;
      });
      parts.push(`(${orParts.join(' OR ')})`);
      return;
    }

    if (v === null) { parts.push(`${col} IS NULL`); return; }

    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)) {
      for (const [op, val] of Object.entries(v)) {
        switch (op) {
          case '$in':
            if (!(val as unknown[])?.length) { parts.push('FALSE'); return; }
            parts.push(`${col} = ANY(${addParam(val)}::text[])`);
            break;
          case '$nin':
            if (!(val as unknown[])?.length) return;
            parts.push(`${col} != ALL(${addParam(val)}::text[])`);
            break;
          case '$lt':  parts.push(`${col} < ${addParam(val)}`);  break;
          case '$lte': parts.push(`${col} <= ${addParam(val)}`); break;
          case '$gt':  parts.push(`${col} > ${addParam(val)}`);  break;
          case '$gte': parts.push(`${col} >= ${addParam(val)}`); break;
          case '$ne':  parts.push(`${col} != ${addParam(val)}`); break;
          case '$exists':
            parts.push(val ? `${col} IS NOT NULL` : `${col} IS NULL`);
            break;
          // Faz 10 — JSONB DİZİ ÜYELİĞİ.
          //
          // JSONB bir kolona skaler eşitlik uygulanamaz: PostgreSQL sağ tarafı
          // JSON olarak ayrıştırmaya çalışır ve düz string için
          // "invalid input syntax for type json" fırlatır. Bu, `GET /api/dm`
          // ucunu üretimde tamamen kırıyordu (dm_conversations.participants).
          //
          // Bu operatör AÇIKTIR: mevcut hiçbir sorgunun anlamını değiştirmez,
          // yalnız üyelik niyetini açıkça ifade etmek isteyen çağıranlar kullanır.
          case '$contains': {
            const arr = Array.isArray(val) ? val : [val];
            parts.push(`${col} @> ${addParam(JSON.stringify(arr))}::jsonb`);
            break;
          }
          case '$regex': {
            const pattern = val instanceof RegExp ? val.source : val;
            parts.push(`${col} ILIKE ${addParam('%' + pattern + '%')}`);
            break;
          }
          default: break;
        }
      }
      return;
    }

    parts.push(`${col} = ${addParam(v)}`);
  }

  for (const [k, v] of Object.entries(query)) processKey(k, v as QueryValue);

  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

export class PgCollection<T extends object = DbRecord> {
  /**
   * @param {import('pg').Pool} pool
   * @param {string} table  — tablo adı (örn. 'users')
   */
  // Sprint 26: strict:true için property declarations eklendi
  // ── NEDEN `Pool` DEĞİL `QueryingPool` ────────────────────────────────────
  // Bu sınıf havuzdan yalnızca `connect()` → `query()` → `release()` kullanır.
  // İmzada `pg.Pool`un tamamını (aşırı yüklenmiş jenerik `query` + EventEmitter
  // yüzeyi) talep etmek, test ikizlerinin tipe uymasını İMKÂNSIZ kılıyordu;
  // ölçüldü: tek bu sebep 21 strict hatası üretiyordu. Gerçek `pg.Pool`un bu
  // sözleşmeyi karşıladığı `pool-contracts.ts` içinde derleme zamanında
  // kanıtlanır.
  pool: QueryingPool;
  table: string;

  constructor(pool: QueryingPool, table: string) {
    this.pool  = pool;
    this.table = table;
  }

  async _query(sql: string, params: unknown[] = []): Promise<QueryResultLike> {
    const client: QueryingClient = await this.pool.connect();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  }

  // ── findOne ───────────────────────────────────────────────────
  async findOne(query: DbQuery<T> = {}, _options?: unknown): Promise<T | null> {
    const { sql, params } = buildWhere(query);
    const res = await this._query(
      `SELECT * FROM "${this.table}" WHERE ${sql} LIMIT 1`,
      params
    );
    return typedFromRow<T>(res.rows[0] ?? null);
  }

  // ── find — chainable (sort/skip/limit) ───────────────────────
  find(query: DbQuery<T> = {}, _options?: unknown): FindChain<T> {
    const self = this;
    let _sortSql  = '';
    let _skipVal  = 0;
    let _limitVal: number | null = null;

    const chain = {
      sort(spec: DbQuery<T>) {
        const parts = Object.entries(spec).map(([col, dir]: [string, unknown]) => {
          assertValidColumn(col);
          return `"${col}" ${dir === -1 || dir === 'desc' ? 'DESC' : 'ASC'}`;
        });
        _sortSql = parts.length ? ' ORDER BY ' + parts.join(', ') : '';
        return chain;
      },
      skip(n: number) {
        if (!Number.isSafeInteger(n) || n < 0) {
          throw new RangeError('PgCollection.skip requires a non-negative safe integer');
        }
        _skipVal = n;
        return chain;
      },
      limit(n: number) {
        if (!Number.isSafeInteger(n) || n < 0) {
          throw new RangeError('PgCollection.limit requires a non-negative safe integer');
        }
        _limitVal = n;
        return chain;
      },

      // Promise interface — await find(...) çalışır
      then<TResult1 = T[], TResult2 = never>(resolve?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null, reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
        const { sql, params } = buildWhere(query);
        let q = `SELECT * FROM "${self.table}" WHERE ${sql}${_sortSql}`;
        if (_limitVal !== null) q += ` LIMIT ${_limitVal}`;
        if (_skipVal  > 0)      q += ` OFFSET ${_skipVal}`;
        return self._query(q, params)
          .then(res => res.rows.map(r => typedFromRow<T>(r)).filter((r): r is T => r !== null))
          .then(resolve ?? ((value: T[]) => value as TResult1), reject ?? undefined);
      },

      catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<T[] | TResult> {
        return Promise.resolve(chain).catch(onrejected ?? undefined);
      },

      finally(onfinally?: (() => void) | null): Promise<T[]> {
        return Promise.resolve(chain).finally(onfinally ?? undefined);
      },

      // Symbol.asyncIterator — for await ... of find() çalışır
      [Symbol.asyncIterator]() {
        return (async function* () {
          const { sql, params } = buildWhere(query);
          let q = `SELECT * FROM "${self.table}" WHERE ${sql}${_sortSql}`;
          if (_limitVal !== null) q += ` LIMIT ${_limitVal}`;
          if (_skipVal  > 0)      q += ` OFFSET ${_skipVal}`;
          const res = await self._query(q, params);
          for (const row of res.rows) {
            const mapped = typedFromRow<T>(row);
            if (mapped !== null) yield mapped;
          }
        })();
      },
    };
    return chain;
  }

  // ── insert ────────────────────────────────────────────────────
  async insert(doc: DbInsert<T>): Promise<T> {
    const mutableDoc: DbRecord = { ...doc };
    const primaryKeys = TABLE_PRIMARY_KEYS[this.table] || ['_id'];
    if (primaryKeys.includes('_id') && (!Object.prototype.hasOwnProperty.call(mutableDoc, '_id') || mutableDoc['_id'] === undefined || mutableDoc['_id'] === null || mutableDoc['_id'] === '')) mutableDoc['_id'] = uuidv4();
    const row   = toRow(mutableDoc);
    const keys  = Object.keys(row);
    keys.forEach(assertValidColumn);
    const cols  = keys.map(k => `"${k}"`).join(', ');
    const vals  = keys.map((_, i) => `$${i + 1}`).join(', ');
    const params = Object.values(row);
    const inserted = await this._query(
      `INSERT INTO "${this.table}" (${cols}) VALUES (${vals}) ON CONFLICT (${primaryKeys.map(key => `"${key}"`).join(", ")}) DO NOTHING RETURNING *`,
      params
    );
    const insertedRow = typedFromRow<T>(inserted.rows[0] ?? null);
    if (insertedRow) return insertedRow;

    // Idempotent primary-key replay: DO NOTHING means no row was written.
    // Return the row that actually exists rather than the caller-supplied doc;
    // otherwise upper layers can observe fields that were never persisted.
    const pkQuery: Record<string, unknown> = {};
    for (const key of primaryKeys) {
      const value = mutableDoc[key];
      if (value === undefined || value === null || value === '') {
        throw new Error(`Missing primary key ${key} for ${this.table} insert conflict recovery`);
      }
      pkQuery[key] = value;
    }
    const existing = await this.findOne(pkQuery as DbQuery<T>);
    if (!existing) {
      throw new Error(`Insert for ${this.table} reported a conflict but the existing primary-key row could not be loaded`);
    }
    return existing;
  }

  // ── update ────────────────────────────────────────────────────
  async update(query: DbQuery<T>, update: DbUpdate<T>, _options?: unknown): Promise<{ updated: number | null }> {
    const { sql: whereSql, params: whereParams } = buildWhere(query);
    const setParts  = [];
    const setParams = [];

    if (update.$set) {
      const row = toRow(update.$set as Record<string, unknown>);
      for (const [k, v] of Object.entries(row)) {
        assertValidColumn(k);
        setParams.push(v);
        setParts.push(`"${k}" = $${setParams.length}`);
      }
    }

    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc as Record<string, unknown>)) {
        assertValidColumn(k);
        setParams.push(v);
        setParts.push(`"${k}" = COALESCE("${k}", 0) + $${setParams.length}`);
      }
    }

    if (update.$push) {
      // JSONB array append — PostgreSQL JSONB operatörü
      for (const [k, v] of Object.entries(update.$push as Record<string, unknown>)) {
        assertValidColumn(k);
        setParams.push(JSON.stringify(v));
        setParts.push(`"${k}" = COALESCE("${k}", '[]'::jsonb) || $${setParams.length}::jsonb`);
      }
    }

    if (!setParts.length) return { updated: 0 };

    // WHERE parametrelerini offset et
    const offset   = setParams.length;
    const whereSqlOffsetted = whereSql.replace(/\$(\d+)/g, (_, i) => `$${parseInt(i) + offset}`);
    const allParams = [...setParams, ...whereParams];

    const res = await this._query(
      `UPDATE "${this.table}" SET ${setParts.join(', ')} WHERE ${whereSqlOffsetted}`,
      allParams
    );
    return { updated: res.rowCount ?? null };
  }

  // ── remove ────────────────────────────────────────────────────
  async remove(query: DbQuery<T> = {}, _options?: unknown): Promise<{ deleted: number | null }> {
    const { sql, params } = buildWhere(query);
    const res = await this._query(
      `DELETE FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return { deleted: res.rowCount ?? null };
  }

  // ── count ─────────────────────────────────────────────────────
  async count(query: DbQuery<T> = {}): Promise<number> {
    const { sql, params } = buildWhere(query);
    const res = await this._query(
      `SELECT COUNT(*) AS n FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return parseInt(res.rows[0]?.n ?? 0);
  }

  // ── ensureIndex — PostgreSQL'de zaten schema.sql'de tanımlı ──
  async insertMany(docs: Array<DbInsert<T>>): Promise<T[]> {
    const inserted: T[] = [];
    for (const doc of docs) {
      inserted.push(await this.insert(doc));
    }
    return inserted;
  }

  ensureIndex(..._args: unknown[]): void {}
}
