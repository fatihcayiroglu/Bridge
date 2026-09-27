// server/db/repositories/MemberRepository.ts
// Sunucu üyeliği sorgularını tek noktada toplar.

import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import { isMemberTimedOut, parseMemberTimeoutUntil } from '../../lib/memberTimeout';
import { memberProfileAssetUrls, releaseUnreferencedUploads } from '../../lib/uploadRelease';
import type { UploadReferenceQueryable } from '../../lib/uploadReferenceSafety';
import logger from '../../lib/logger';

export interface MemberPageCursor {
  joinedAt: number;
  userId: string;
}

class MemberRepository {
  private insertIfAbsentTail: Promise<void> = Promise.resolve();
  private readonly roleMutationTails = new Map<string, Promise<void>>();
  /**
   * ════════════════════════════════════════════════════════════════════════
   * UYELIK SORGUSU BANLI SATIRLARI DONDURMEZ
   * ════════════════════════════════════════════════════════════════════════
   * Bridge'de BAN, `members` tablosunda `banned = true` olan bir SATIRDIR
   * (bkz. `getBans`). `findOne` bu bayragi DIKKATE ALMIYORDU ve uygulamadaki
   * 87 yetkilendirme cagrisinin tamami bu metoda dayaniyor. Sonuc, banin iki
   * yonde birden BOZUK olmasiydi — dogrudan olculdu:
   *
   *   UYE olan biri banlandi   → kanal okuma ONCE 200, SONRA 200  (ban ETKISIZ)
   *   UYE OLMAYAN biri banlandi→ kanal okuma ONCE 403, SONRA 200  (ban ERISIM VERDI)
   *
   * Ikincisi ozellikle ters: `banMember` bir uyelik satiri yazdigi icin,
   * birini BANLAMAK onu uye HALINE GETIRIYORDU.
   *
   * `banned` sutunu `NOT NULL DEFAULT false`tur; dolayisiyla `banned: false`
   * filtresi NULL semantigi sorunu yaratmaz ve mevcut 2911 uye satirini
   * etkilemez.
   *
   * Ban YONETIMI icin `findIncludingBanned` kullanilir — orada banli satirin
   * GORUNMESI gerekir (ornegin banli kullanicinin davetle yeniden katilmasini
   * engellemek icin).
   */
  async findOne(userIdOrQuery: string | Record<string, unknown>, serverId?: string) {
    const base = typeof userIdOrQuery === 'string'
      ? { userId: userIdOrQuery, serverId }
      : userIdOrQuery;

    // Cagiran `banned`i ACIKCA sorguluyorsa niyetine saygi duyulur.
    if (Object.prototype.hasOwnProperty.call(base, 'banned')) {
      return db.members.findOne(base);
    }

    // ELEME SORGUDA DEGIL, SONUCTA YAPILIR.
    // Sorguya `banned: false` eklemek adaptore bagimlidir: PostgreSQL'de
    // sutun `NOT NULL DEFAULT false` oldugu icin calisir, ancak birim
    // testlerin mock veritabanindaki uye satirlarinda `banned` ALANI HIC
    // YOKTUR ve esitlik eslesmesi basarisiz olur. Ilk denemede tam olarak bu
    // oldu: 295 test dustu. JS tarafinda elemek her iki adaptorde de aynidir.
    const row = await db.members.findOne(base);
    if (row && (row as { banned?: unknown }).banned) return null;
    return row;
  }

  /** Banli satirlar DAHIL uyelik kaydi — yalnizca ban yonetimi icindir. */
  async findIncludingBanned(userId: string, serverId: string) {
    return db.members.findOne({ userId, serverId });
  }

  async findByServer(serverId: string) {
    const rows = await db.members.find({ serverId });
    return (Array.isArray(rows) ? rows : []).filter(
      (r) => !(r as { banned?: unknown }).banned,
    );
  }

  /**
   * Deterministic, bounded member keyset page ordered by `(joinedAt, userId)`.
   *
   * The HTTP endpoint asks for `limit + 1` to establish `hasMore`, hence the
   * repository's internal ceiling of 101 for a public maximum page size of
   * 100. PostgreSQL uses the composite index added by migration 060;
   * the in-memory path exists only for deterministic unit tests.
   */
  async findPageByServer(
    serverId: string,
    { limit = 101, cursor }: { limit?: number; cursor?: MemberPageCursor } = {},
  ) {
    if (typeof serverId !== 'string' || !serverId.trim()) {
      throw new TypeError('serverId is required');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
      throw new RangeError('member page limit must be an integer between 1 and 101');
    }
    if (cursor && (
      !Number.isSafeInteger(cursor.joinedAt) || cursor.joinedAt < 0 ||
      typeof cursor.userId !== 'string' || cursor.userId.length === 0 || cursor.userId.length > 200
    )) {
      throw new TypeError('invalid member page cursor');
    }

    const normalizeJoinedAt = (row: Record<string, unknown>): Record<string, unknown> => {
      // node-postgres intentionally returns BIGINT as string. Cursor JSON must
      // carry a safe integer, and application timestamps are constrained to
      // JavaScript's safe range, so normalize at this repository boundary.
      const joinedAt = Number(row.joinedAt);
      if (!Number.isSafeInteger(joinedAt) || joinedAt < 0) {
        throw new Error('member joinedAt is outside the supported cursor range');
      }
      return { ...row, joinedAt };
    };

    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'MemberRepository findPageByServer');
    if (pool) {
      const result = cursor
        ? await pool.query(
          `SELECT * FROM members
            WHERE "serverId" = $1
              AND banned = FALSE
              AND ("joinedAt", "userId") > ($2::bigint, $3::text)
            ORDER BY "joinedAt" ASC, "userId" ASC
            LIMIT $4`,
          [serverId, cursor.joinedAt, cursor.userId, limit],
        )
        : await pool.query(
          `SELECT * FROM members
            WHERE "serverId" = $1
              AND banned = FALSE
            ORDER BY "joinedAt" ASC, "userId" ASC
            LIMIT $2`,
          [serverId, limit],
        );
      return result.rows.map((row) => normalizeJoinedAt(row as Record<string, unknown>));
    }

    const rows = await db.members.find({ serverId });
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => !(row as { banned?: unknown }).banned)
      .map((row) => normalizeJoinedAt(row as unknown as Record<string, unknown>))
      .sort((a, b) => {
        const byTime = Number(a.joinedAt) - Number(b.joinedAt);
        if (byTime !== 0) return byTime;
        const aId = String(a.userId);
        const bId = String(b.userId);
        return aId < bId ? -1 : aId > bId ? 1 : 0;
      })
      .filter((row) => !cursor ||
        Number(row.joinedAt) > cursor.joinedAt ||
        (Number(row.joinedAt) === cursor.joinedAt && String(row.userId) > cursor.userId))
      .slice(0, limit);
  }

  /**
   * Kullanicinin uyelikleri — BANLI olanlar HARIC.
   *
   * `findOne` ile ayni gerekce: ban, `banned = true` olan bir uyelik
   * satiridir. Filtrelenmezse banlandigi sunucu kullanicinin listesinde
   * gorunmeye devam eder (olculdu) ve `search.ts` gibi bu metoda dayanan
   * yerler banli sunucuyu ARAMA KAPSAMINA dahil ederdi.
   *
   * Ban YONETIMI icin `getBans` kullanilir; o zaten `banned: true` sorgular.
   */
  async findByUser(userId: string) {
    // Eleme sonucta yapilir — gerekce icin `findOne`daki nota bakiniz.
    const rows = await db.members.find({ userId });
    return (Array.isArray(rows) ? rows : []).filter(
      (r) => !(r as { banned?: unknown }).banned,
    );
  }

  async countByServer(serverId: string) {
    return db.members.count({ serverId });
  }

  async insert(userId: string, serverId: string, extra: Record<string, unknown> = {}) {
    return db.members.insert({ userId, serverId, joinedAt: Date.now(), ...extra });
  }

  /**
   * Insert a normal membership exactly once. The boolean is ownership of the
   * durable insert, not merely "a membership exists afterwards"; callers use
   * it to ensure join webhooks/plugin hooks run once under concurrent requests.
   */
  async insertIfAbsent(userId: string, serverId: string, roles: string[] = []): Promise<boolean> {
    if (typeof userId !== 'string' || !userId.trim() || typeof serverId !== 'string' || !serverId.trim()) {
      throw new TypeError('userId and serverId are required');
    }
    if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string' || !r.trim())) {
      throw new TypeError('roles must be an array of non-empty strings');
    }

    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'MemberRepository insertIfAbsent');
    if (pool) {
      const result = await pool.query(
        `INSERT INTO members ("userId", "serverId", roles, "joinedAt")
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT ("userId", "serverId") DO NOTHING
         RETURNING "userId"`,
        [userId, serverId, JSON.stringify(roles), Date.now()],
      );
      return result.rows.length === 1;
    }

    // Mock/in-memory compatibility. Serialize the fallback so concurrency tests
    // preserve the same winner/loser contract as PostgreSQL ON CONFLICT.
    const previous = this.insertIfAbsentTail;
    let release!: () => void;
    this.insertIfAbsentTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const existing = await db.members.findOne({ userId, serverId });
      if (existing) return false;
      await db.members.insert({ userId, serverId, roles, joinedAt: Date.now() });
      return true;
    } finally {
      release();
    }
  }

  async update(userId: string, serverId: string, fields: Record<string, unknown>) {
    return db.members.update({ userId, serverId }, { $set: fields });
  }

  async remove(userId: string, serverId: string) {
    return this.removeReleasingProfileAssets({ userId, serverId });
  }

  /**
   * ════════════════════════════════════════════════════════════════════════
   * ÜYELİK SİLİNİNCE SUNUCU PROFİLİ GÖRSELLERİ DE GİDER (Final21 Faz 19)
   * ════════════════════════════════════════════════════════════════════════
   * `serverProfile` avatar/afiş dosyaları `uploads/member-profiles/` altındadır; günlük
   * temizlik işi alt dizinlere BİLEREK dokunmaz. Ayrılma, atılma, yasağın kaldırılması,
   * hesap/sunucu silme satırı siliyor ama dosyayı bırakan hiçbir yol yoktu: kişinin
   * görselleri URL'yi bilen herkese sunulmaya devam ediyordu.
   * Yollar silmeden ÖNCE okunur; silme SONRASI başka kayıt başvurmuyorsa dosya bırakılır.
   * PostgreSQL yoksa başvuru denetlenemez → dosyalara dokunulmaz (fail-closed).
   */
  private async removeReleasingProfileAssets(filter: Record<string, unknown>) {
    const pool = (db as unknown as { _pool?: UploadReferenceQueryable })._pool;
    const rows = pool ? await db.members.find(filter) as Array<{ serverProfile?: unknown }> : [];
    const result = await db.members.remove(filter);
    const urls = memberProfileAssetUrls(Array.isArray(rows) ? rows : []);
    if (urls.length) {
      await releaseUnreferencedUploads(pool, urls, (url, err) => {
        logger.error({ err, url, event: 'member_profile.release_failed' },
          'Üyelik silindi ama sunucu profili görseli bırakılamadı.');
      });
    }
    return result;
  }

  async removeMember(userId: string, serverId: string) {
    return this.remove(userId, serverId);
  }

  async getBans(serverId: string) {
    return db.members.find({ serverId, banned: true });
  }

  /**
   * ════════════════════════════════════════════════════════════════════════
   * BAN: VAR OLAN UYELIK SATIRI GUNCELLENIR — SESSIZ NO-OP DEGIL
   * ════════════════════════════════════════════════════════════════════════
   * Onceki hali YALNIZCA `insert` cagiriyordu. `members` birincil anahtari
   * `(userId, serverId)` ve adaptor `ON CONFLICT ... DO NOTHING` uretir
   * (db/postgres/pgCollection.ts). Dolayisiyla ZATEN UYE olan birini banlamak
   * SESSIZCE HICBIR SEY YAPMIYORDU: uc 200 donuyor, satir `banned = false`
   * kaliyordu.
   *
   * DOGRUDAN OLCULDU:
   *   uye banlanmadan once kanal okuma → 200
   *   ban yaniti                        → 200  ("ok": true)
   *   ban SONRASI kanal okuma           → 200  ← ban hicbir sey yapmadi
   *   banli sunucu hala listede         → true
   *
   * Yani cekirdek moderasyon islevi, en yaygin durumda (var olan uyeyi
   * banlamak) tumuyle etkisizdi ve hicbir hata da vermiyordu.
   */
  async banMember(serverId: string, userId: string, reasonOrFields: string | Record<string, unknown> = {}) {
    const fields = typeof reasonOrFields === 'string' ? { banReason: reasonOrFields } : reasonOrFields;
    const existing = await this.findIncludingBanned(userId, serverId);
    if (existing) {
      return db.members.update({ userId, serverId }, { $set: { banned: true, ...fields } });
    }
    return db.members.insert({ userId, serverId, banned: true, joinedAt: Date.now(), ...fields });
  }

  async unbanMember(serverId: string, userId: string) {
    return this.removeReleasingProfileAssets({ userId, serverId, banned: true });
  }

  async removeAllFromServer(serverId: string) {
    return this.removeReleasingProfileAssets({ serverId });
  }

  async removeAllForUser(userId: string) {
    return this.removeReleasingProfileAssets({ userId });
  }

  async findByServerIds(serverIds: string[], projection?: object) {
    if (!serverIds?.length) return [];
    const rows = await db.members.find({ serverId: { $in: serverIds } }, projection);
    return (Array.isArray(rows) ? rows : []).filter(
      (r) => !(r as { banned?: unknown }).banned,
    );
  }

  async findWhere(query: Record<string, unknown>) {
    return db.members.find(query);
  }

  async countWhere(query: Record<string, unknown> = {}) {
    return db.members.count(query);
  }

  async setTimeout(serverId: string, userId: string, until: Date | number | null) {
    const raw = until instanceof Date ? until.getTime() : until;
    const timeoutUntil = parseMemberTimeoutUntil(raw);
    return this.update(userId, serverId, { timeoutUntil });
  }

  async isTimedOut(userId: string, serverId: string): Promise<boolean> {
    const m = await this.findOne(userId, serverId);
    return !!m && isMemberTimedOut((m as { timeoutUntil?: unknown }).timeoutUntil);
  }

  /** Üye rollerini JSON string olarak günceller. */
  async setRoles(userId: string, serverId: string, roles: string[]) {
    return this.update(userId, serverId, { roles: JSON.stringify(roles) });
  }

  private normalizeStoredRoles(value: unknown): string[] {
    const clean = (items: unknown[]): string[] => [...new Set(items
      .filter((role): role is string => typeof role === 'string')
      .map(role => role.trim())
      .filter(Boolean))];
    if (Array.isArray(value)) return clean(value);
    if (typeof value !== 'string') return [];
    const raw = value.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? clean(parsed) : [];
    } catch {
      if (raw.startsWith('[') || raw.startsWith('{')) return [];
      return [raw];
    }
  }

  private async withRoleMutationLock<T>(userId: string, serverId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${serverId}:${userId}`;
    const previous = this.roleMutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.roleMutationTails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.roleMutationTails.get(key) === tail) this.roleMutationTails.delete(key);
    }
  }

  /** Atomically add one role without losing a concurrent assignment. */
  async addRole(userId: string, serverId: string, roleId: string): Promise<string[] | null> {
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'MemberRepository addRole');
    if (pool) {
      const result = await pool.query(
        `UPDATE members
            SET roles = CASE
              WHEN (CASE WHEN jsonb_typeof(roles) = 'array' THEN roles ELSE '[]'::jsonb END)
                     @> jsonb_build_array($3::text)
                THEN CASE WHEN jsonb_typeof(roles) = 'array' THEN roles ELSE '[]'::jsonb END
              ELSE (CASE WHEN jsonb_typeof(roles) = 'array' THEN roles ELSE '[]'::jsonb END)
                   || jsonb_build_array($3::text)
            END
          WHERE "userId" = $1 AND "serverId" = $2 AND banned = FALSE
          RETURNING roles`,
        [userId, serverId, roleId],
      );
      if (!result.rows.length) return null;
      return this.normalizeStoredRoles(result.rows[0].roles);
    }

    return this.withRoleMutationLock(userId, serverId, async () => {
      const membership = await this.findOne(userId, serverId);
      if (!membership) return null;
      const roles = this.normalizeStoredRoles((membership as { roles?: unknown }).roles);
      if (!roles.includes(roleId)) roles.push(roleId);
      await this.setRoles(userId, serverId, roles);
      return roles;
    });
  }

  /** Atomically remove one role without restoring it over a concurrent update. */
  async removeRole(userId: string, serverId: string, roleId: string): Promise<string[] | null> {
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'MemberRepository removeRole');
    if (pool) {
      const result = await pool.query(
        `UPDATE members
            SET roles = COALESCE((
              SELECT jsonb_agg(value)
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(roles) = 'array' THEN roles ELSE '[]'::jsonb END
                ) AS value
               WHERE jsonb_typeof(value) = 'string' AND value <> to_jsonb($3::text)
            ), '[]'::jsonb)
          WHERE "userId" = $1 AND "serverId" = $2 AND banned = FALSE
          RETURNING roles`,
        [userId, serverId, roleId],
      );
      if (!result.rows.length) return null;
      return this.normalizeStoredRoles(result.rows[0].roles);
    }

    return this.withRoleMutationLock(userId, serverId, async () => {
      const membership = await this.findOne(userId, serverId);
      if (!membership) return null;
      const roles = this.normalizeStoredRoles((membership as { roles?: unknown }).roles)
        .filter(role => role !== roleId);
      await this.setRoles(userId, serverId, roles);
      return roles;
    });
  }
}

export default new MemberRepository();
