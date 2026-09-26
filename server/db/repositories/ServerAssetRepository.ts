// server/db/repositories/ServerAssetRepository.ts
// Sunucu varlıkları (emoji, gif, soundboard, template, onboarding) sorgularını toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { withTransaction } from '../postgres/transaction';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import { BUILTIN_SOUNDBOARD_SOUNDS } from '../../lib/soundboardCatalog';

export type SoundboardListView = 'all' | 'server' | 'global' | 'favorites' | 'recent' | 'frequent';

export interface SoundboardCursor {
  view: SoundboardListView;
  query: string;
  key: [number, number, string];
}

export interface SoundboardPageInput {
  serverId: string;
  userId: string;
  limit: number;
  query: string;
  view: SoundboardListView;
  cursor: SoundboardCursor | null;
}

export interface SoundboardListItem extends Record<string, unknown> {
  _id: string;
  name: string;
  emoji: string;
  url: string;
  category: string;
  scope: 'global' | 'server';
  createdAt: number;
  favorite: boolean;
  playCount: number;
  favoritedAt: number | null;
  lastPlayedAt: number | null;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cursorKey(item: SoundboardListItem, view: SoundboardListView): [number, number, string] {
  switch (view) {
    case 'favorites': return [item.favoritedAt ?? 0, 0, item._id];
    case 'recent': return [item.lastPlayedAt ?? 0, 0, item._id];
    case 'frequent': return [item.playCount, item.lastPlayedAt ?? 0, item._id];
    default: return [item.scope === 'global' ? 1 : 0, item.createdAt, item._id];
  }
}

function compareKeysDescending(a: [number, number, string], b: [number, number, string]): number {
  if (a[0] !== b[0]) return b[0] - a[0];
  if (a[1] !== b[1]) return b[1] - a[1];
  return a[2] === b[2] ? 0 : a[2] > b[2] ? -1 : 1;
}

export function encodeSoundboardCursor(cursor: SoundboardCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url');
}

export function decodeSoundboardCursor(token: string, view: SoundboardListView, query: string): SoundboardCursor {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(token)) throw new Error('Invalid soundboard cursor');
  try {
    const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
    const key = value.key;
    if (value.v !== 1 || value.view !== view || value.query !== query || !Array.isArray(key) || key.length !== 3
      || !Number.isFinite(key[0]) || !Number.isFinite(key[1]) || typeof key[2] !== 'string' || key[2].length < 1 || key[2].length > 64) {
      throw new Error('invalid');
    }
    return { view, query, key: [Number(key[0]), Number(key[1]), key[2]] };
  } catch {
    throw new Error('Invalid soundboard cursor');
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

/** Tek bir sticker öğesinin OLUŞTURMA girdisi (henüz kalıcı değil). */
export interface StickerItemInput {
  id:     string;
  name:   string;
  url:    string;
  tags:   string[];
  width:  number;
  height: number;
}

/** Bir paketin ve ilk öğelerinin ATOMİK oluşturma girdisi. */
export interface StickerPackInput {
  packId:      string;
  serverId:    string;
  name:        string;
  description: string;
  authorId:    string;
  createdAt:   number;
  items:       StickerItemInput[];
}

class ServerAssetRepository {
  // ── Emojis ─────────────────────────────────────────────────

  async findEmojis(serverId: string) {
    return db.serverEmojis.find({ serverId }) ?? [];
  }

  async findEmojisSorted(serverId: string) {
    return db.serverEmojis.find({ serverId }).sort({ createdAt: 1 }) ?? [];
  }

  async findEmoji(id: string) {
    return db.serverEmojis.findOne({ _id: id });
  }

  async findEmojiByIdAndServer(id: string, serverId: string) {
    return db.serverEmojis.findOne({ _id: id, serverId });
  }

  async insertEmoji(data: Record<string, unknown>) {
    return db.serverEmojis.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateEmoji(id: string, serverId: string, fields: Record<string, unknown>) {
    return db.serverEmojis.update({ _id: id, serverId }, { $set: fields });
  }

  async deleteEmoji(id: string, serverId: string) {
    return db.serverEmojis.remove({ _id: id, serverId });
  }

  async deleteEmojisByServer(serverId: string) {
    return db.serverEmojis.remove({ serverId });
  }

  async findEmojiByServerAndName(serverId: string, name: string) {
    return db.serverEmojis.findOne({ serverId, name });
  }

  // ── GIFs ───────────────────────────────────────────────────

  async findGifs(serverId: string) {
    return db.serverGifs.find({ serverId }) ?? [];
  }

  async findGifsByServerIds(serverIds: string | string[]) {
    const ids = Array.isArray(serverIds) ? serverIds : [serverIds];
    if (!ids.length) return [];
    return db.serverGifs.find({ serverId: { $in: ids } }) ?? [];
  }

  async findGifByIdAndServer(id: string, serverId: string) {
    return db.serverGifs.findOne({ _id: id, serverId });
  }

  async insertGif(data: Record<string, unknown>) {
    return db.serverGifs.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async deleteGif(id: string, serverId: string) {
    return db.serverGifs.remove({ _id: id, serverId });
  }

  async deleteGifsByServer(serverId: string) {
    return db.serverGifs.remove({ serverId });
  }

  // ── Sticker paketleri (migrations_pg/021) ──────────────────
  //
  // OLUŞTURMA yolu bilinçli olarak HAM SQL kullanır. Neden: `withTransaction`
  // bir PoolClient verir (postgres/transaction.ts:21) ama `PgCollection._query`
  // her çağrıda pool'dan KENDİ bağlantısını alır (postgres/pgCollection.ts:255).
  // Bu yüzden bir `db.stickerPacks.insert(...)` çağrısı transaction'ın BEGIN'i
  // DIŞINDA, ayrı bir bağlantıda çalışır ve ROLLBACK ile geri alınmaz —
  // transaction gibi görünüp öyle davranmayan en kötü durum. Paket ve ilk
  // öğeleri ya birlikte commit edilir ya da hiçbiri kalıcı olmaz.
  //
  // Okuma/güncelleme/silme yolları tek tablo üzerinde çalıştığı için mevcut
  // PgCollection deseninde kalır.

  /**
   * Paketi ve TÜM ilk öğelerini tek transaction'da yazar.
   * Herhangi bir INSERT başarısız olursa hiçbiri kalıcı olmaz.
   */
  async createStickerPack(input: StickerPackInput): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO sticker_packs (_id, "serverId", name, description, "authorId", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.packId, input.serverId, input.name, input.description, input.authorId, input.createdAt],
      );

      // `position` dizi indeksinden gelir: tek istek içinde atandığı için
      // yarış koşulu yoktur ve yükleme sırasını birebir korur.
      for (let i = 0; i < input.items.length; i++) {
        const item = input.items[i]!;
        await client.query(
          `INSERT INTO sticker_pack_items
             (_id, "packId", name, url, tags, width, height, position, "createdAt")
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
          [
            item.id, input.packId, item.name, item.url,
            JSON.stringify(item.tags ?? []), item.width, item.height, i, input.createdAt,
          ],
        );
      }
    });
  }

  /** Sunucunun paketleri — ekleme sırasıyla (dahili `seq`). */
  async findStickerPacksByServer(serverId: string) {
    return db.stickerPacks.find({ serverId }).sort({ seq: 1 }) ?? [];
  }

  /**
   * GÜVENLİK: paket HER ZAMAN (packId + serverId) ile çözülür.
   * Yalnız packId ile arama, başka sunucunun paketine erişim demektir.
   */
  async findStickerPackByIdAndServer(packId: string, serverId: string) {
    return db.stickerPacks.findOne({ _id: packId, serverId });
  }

  /** Verilen paketlerin öğeleri — yükleme sırasıyla (dahili `position`). */
  async findStickerItemsByPackIds(packIds: string[]) {
    if (!packIds.length) return [];
    return db.stickerPackItems.find({ packId: { $in: packIds } }).sort({ position: 1 }) ?? [];
  }

  /**
   * GÜVENLİK: öğe HER ZAMAN packId ile birlikte aranır. Çağıran, paketin
   * sunucuya ait olduğunu ÖNCEDEN doğrulamış olmalıdır.
   */
  async findStickerItemByIdAndPack(itemId: string, packId: string) {
    return db.stickerPackItems.findOne({ _id: itemId, packId });
  }

  async updateStickerItem(itemId: string, packId: string, fields: Record<string, unknown>) {
    return db.stickerPackItems.update({ _id: itemId, packId }, { $set: fields });
  }

  /**
   * Paketi atomik olarak siler. PostgreSQL'de child satırlar FK
   * `ON DELETE CASCADE` ile AYNI statement'ın parçası olarak temizlenir.
   * Önce child sonra parent şeklindeki iki ayrı PgCollection çağrısı, parent
   * delete başarısız olduğunda yarım silme yaratabildiği için production
   * yolunda kullanılmaz. Mock/non-PG fallback yalnız adapter testleri içindir.
   */
  async deleteStickerPack(packId: string, serverId: string) {
    const rawPool = (db as unknown as { _pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null; rows?: unknown[] }> } })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'ServerAssetRepository atomic query');
    if (pool) {
      const result = await pool.query(
        `DELETE FROM sticker_packs WHERE _id = $1 AND "serverId" = $2 RETURNING _id`,
        [packId, serverId],
      );
      return { changes: result.rowCount ?? 0 };
    }

    await db.stickerPackItems.remove({ packId });
    return db.stickerPacks.remove({ _id: packId, serverId });
  }

  /** Sunucu silinirken çağrılır (routes/servers/core.ts temizlik bloğu). */
  async deleteStickerPacksByServer(serverId: string) {
    const rawPool = (db as unknown as { _pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }> } })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'ServerAssetRepository atomic query');
    if (pool) {
      const result = await pool.query(
        `DELETE FROM sticker_packs WHERE "serverId" = $1`,
        [serverId],
      );
      return { changes: result.rowCount ?? 0 };
    }

    const packs = await this.findStickerPacksByServer(serverId);
    for (const pack of packs) {
      await db.stickerPackItems.remove({ packId: (pack as { _id: string })._id });
    }
    return db.stickerPacks.remove({ serverId });
  }

  // ── Soundboard ─────────────────────────────────────────────

  /** @deprecated Use listSoundsPage; retained as a bounded compatibility read. */
  async findSounds(serverId: string, limit = 100) {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit) || 100));
    return db.soundboard.find({ serverId }).limit(bounded) ?? [];
  }

  /** @deprecated Use listSoundsPage; retained as a bounded compatibility read. */
  async findSoundsSorted(serverId: string, limit = 100) {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit) || 100));
    return db.soundboard.find({ serverId }).sort({ createdAt: 1 }).limit(bounded) ?? [];
  }

  /**
   * Keyset-paginated library read. Production uses one bounded SQL query that
   * joins user state and the tiny immutable global catalog. Unit tests use the
   * in-memory adapter below; a non-test runtime may never silently fall back.
   */
  async listSoundsPage(input: SoundboardPageInput): Promise<{ items: SoundboardListItem[]; nextCursor: string | null }> {
    const rawPool = (db as unknown as {
      _pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
    })._pool;
    const pool = process.env.NODE_ENV === 'test'
      ? null
      : postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'ServerAssetRepository soundboard page');

    if (pool) {
      const params: unknown[] = [input.serverId, input.userId];
      const bind = (value: unknown): string => { params.push(value); return `$${params.length}`; };
      const values = BUILTIN_SOUNDBOARD_SOUNDS.map(sound => `(
        ${bind(sound._id)}::TEXT, ${bind(sound.name)}::TEXT, ${bind(sound.emoji)}::TEXT, ${bind(sound.url)}::TEXT,
        ${bind(sound.category)}::TEXT, ${bind(sound.createdAt)}::BIGINT, ${bind(sound.durationSeconds)}::DOUBLE PRECISION,
        ${bind(sound.mimeType)}::TEXT, ${bind(sound.fileSize)}::BIGINT
      )`).join(',');

      const where: string[] = [];
      if (input.view === 'server') where.push(`e.scope = 'server'`);
      else if (input.view === 'global') where.push(`e.scope = 'global'`);
      else if (input.view === 'favorites') where.push('e.favorite = TRUE');
      else if (input.view === 'recent' || input.view === 'frequent') where.push(`e."playCount" > 0`);
      if (input.query) where.push(`LOWER(e.name) LIKE ${bind(`%${escapeLike(input.query.toLowerCase())}%`)} ESCAPE '\\'`);

      let orderSql: string;
      if (input.view === 'favorites') orderSql = `e."favoritedAt" DESC, e._id DESC`;
      else if (input.view === 'recent') orderSql = `e."lastPlayedAt" DESC, e._id DESC`;
      else if (input.view === 'frequent') orderSql = `e."playCount" DESC, e."lastPlayedAt" DESC, e._id DESC`;
      else orderSql = `e."scopeRank" DESC, e."createdAt" DESC, e._id DESC`;

      if (input.cursor) {
        const [first, second, id] = input.cursor.key;
        if (input.view === 'favorites') where.push(`(e."favoritedAt", e._id) < (${bind(first)}, ${bind(id)})`);
        else if (input.view === 'recent') where.push(`(e."lastPlayedAt", e._id) < (${bind(first)}, ${bind(id)})`);
        else if (input.view === 'frequent') where.push(`(e."playCount", e."lastPlayedAt", e._id) < (${bind(first)}, ${bind(second)}, ${bind(id)})`);
        else where.push(`(e."scopeRank", e."createdAt", e._id) < (${bind(first)}, ${bind(second)}, ${bind(id)})`);
      }

      const sql = `
        WITH assets AS (
          SELECT s._id, s."serverId", s.name, s.emoji, s.url, s.category,
                 s."uploadedBy", s."createdAt", s."durationSeconds", s."mimeType",
                 s."fileSize", s."updatedAt", 'server'::TEXT AS scope
            FROM soundboard s
           WHERE s."serverId" = $1
          UNION ALL
          SELECT g._id, NULL::TEXT, g.name, g.emoji, g.url, g.category,
                 NULL::TEXT, g."createdAt", g."durationSeconds", g."mimeType",
                 g."fileSize", NULL::BIGINT, 'global'::TEXT
            FROM (VALUES ${values}) AS g(
              _id, name, emoji, url, category, "createdAt", "durationSeconds", "mimeType", "fileSize"
            )
        ), enriched AS (
          SELECT a.*, COALESCE(st.favorite, FALSE) AS favorite,
                 COALESCE(st."playCount", 0) AS "playCount",
                 st."favoritedAt", st."lastPlayedAt",
                 CASE WHEN a.scope = 'global' THEN 1 ELSE 0 END AS "scopeRank"
            FROM assets a
            LEFT JOIN soundboard_user_stats st
              ON st."userId" = $2 AND st."soundId" = a._id
        )
        SELECT * FROM enriched e
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${orderSql}
         LIMIT ${bind(input.limit + 1)}`;

      const result = await pool.query(sql, params);
      const mapped = result.rows.map(row => this.mapSoundboardListItem(row));
      const hasMore = mapped.length > input.limit;
      const items = hasMore ? mapped.slice(0, input.limit) : mapped;
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last
          ? encodeSoundboardCursor({ view: input.view, query: input.query, key: cursorKey(last, input.view) })
          : null,
      };
    }

    // Test adapter only. Keep the compatibility path behaviorally equivalent;
    // production is guaranteed to take the bounded SQL path above.
    const [serverSounds, stats] = await Promise.all([
      db.soundboard.find({ serverId: input.serverId }).sort({ createdAt: -1 }),
      db.soundboardUserStats.find({ userId: input.userId }),
    ]);
    const statsBySound = new Map(stats.map(stat => [String(stat.soundId), {
      favorite: stat.favorite,
      favoritedAt: stat.favoritedAt,
      playCount: stat.playCount,
      lastPlayedAt: stat.lastPlayedAt,
    }]));
    const all = [
      ...BUILTIN_SOUNDBOARD_SOUNDS,
      ...serverSounds.map(sound => ({ ...sound, scope: 'server' as const, category: sound.category ?? 'Server' })),
    ].map(sound => this.mapSoundboardListItem({ ...sound, ...(statsBySound.get(String(sound._id)) ?? {}) }));
    const query = input.query.toLocaleLowerCase('en-US');
    const filtered = all.filter(item => {
      if (input.view === 'server' && item.scope !== 'server') return false;
      if (input.view === 'global' && item.scope !== 'global') return false;
      if (input.view === 'favorites' && !item.favorite) return false;
      if ((input.view === 'recent' || input.view === 'frequent') && item.playCount < 1) return false;
      return !query || item.name.toLocaleLowerCase('en-US').includes(query);
    });
    filtered.sort((a, b) => compareKeysDescending(cursorKey(a, input.view), cursorKey(b, input.view)));
    const afterCursor = input.cursor
      ? filtered.filter(item => compareKeysDescending(cursorKey(item, input.view), input.cursor!.key) > 0)
      : filtered;
    const items = afterCursor.slice(0, input.limit);
    const hasMore = afterCursor.length > input.limit;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last
        ? encodeSoundboardCursor({ view: input.view, query: input.query, key: cursorKey(last, input.view) })
        : null,
    };
  }

  private mapSoundboardListItem(row: Record<string, unknown>): SoundboardListItem {
    return {
      ...row,
      _id: String(row._id ?? ''),
      name: String(row.name ?? ''),
      emoji: String(row.emoji ?? '🔊'),
      url: String(row.url ?? ''),
      category: String(row.category ?? 'Server'),
      scope: row.scope === 'global' ? 'global' : 'server',
      createdAt: asFiniteNumber(row.createdAt),
      durationSeconds: row.durationSeconds == null ? null : asFiniteNumber(row.durationSeconds),
      fileSize: row.fileSize == null ? null : asFiniteNumber(row.fileSize),
      updatedAt: row.updatedAt == null ? null : asFiniteNumber(row.updatedAt),
      favorite: row.favorite === true,
      playCount: asFiniteNumber(row.playCount),
      favoritedAt: row.favoritedAt == null ? null : asFiniteNumber(row.favoritedAt),
      lastPlayedAt: row.lastPlayedAt == null ? null : asFiniteNumber(row.lastPlayedAt),
    };
  }

  async insertSound(data: Record<string, unknown>) {
    return db.soundboard.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findSoundByIdAndServer(id: string, serverId: string) {
    return db.soundboard.findOne({ _id: id, serverId });
  }

  async updateSound(id: string, serverId: string, fields: Record<string, unknown>) {
    const result = await db.soundboard.update({ _id: id, serverId }, { $set: fields });
    if ((result.updated ?? 0) < 1) return null;
    return db.soundboard.findOne({ _id: id, serverId });
  }

  async setSoundFavorite(soundId: string, userId: string, serverId: string | null, favorite: boolean) {
    const now = Date.now();
    const rawPool = (db as unknown as {
      _pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
    })._pool;
    const pool = process.env.NODE_ENV === 'test'
      ? null
      : postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'ServerAssetRepository soundboard favorite');
    if (pool) {
      const result = await pool.query(
        `INSERT INTO soundboard_user_stats
           ("userId", "soundId", "serverId", favorite, "favoritedAt", "playCount")
         VALUES ($1, $2, $3, $4, $5, 0)
         ON CONFLICT ("userId", "soundId") DO UPDATE
           SET favorite = EXCLUDED.favorite,
               "favoritedAt" = EXCLUDED."favoritedAt",
               "serverId" = EXCLUDED."serverId"
         RETURNING favorite, "favoritedAt", "playCount", "lastPlayedAt"`,
        [userId, soundId, serverId, favorite, favorite ? now : null],
      );
      return result.rows[0] ?? { favorite, favoritedAt: favorite ? now : null, playCount: 0, lastPlayedAt: null };
    }
    const existing = await db.soundboardUserStats.findOne({ userId, soundId });
    if (existing) {
      await db.soundboardUserStats.update({ userId, soundId }, { $set: { favorite, favoritedAt: favorite ? now : null, serverId } });
    } else {
      await db.soundboardUserStats.insert({ userId, soundId, serverId, favorite, favoritedAt: favorite ? now : null, playCount: 0, lastPlayedAt: null });
    }
    return db.soundboardUserStats.findOne({ userId, soundId });
  }

  async recordSoundPlay(soundId: string, userId: string, serverId: string | null) {
    const now = Date.now();
    const rawPool = (db as unknown as {
      _pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
    })._pool;
    const pool = process.env.NODE_ENV === 'test'
      ? null
      : postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'ServerAssetRepository soundboard play tracking');
    if (pool) {
      const result = await pool.query(
        `INSERT INTO soundboard_user_stats
           ("userId", "soundId", "serverId", favorite, "playCount", "lastPlayedAt")
         VALUES ($1, $2, $3, FALSE, 1, $4)
         ON CONFLICT ("userId", "soundId") DO UPDATE
           SET "playCount" = soundboard_user_stats."playCount" + 1,
               "lastPlayedAt" = EXCLUDED."lastPlayedAt",
               "serverId" = EXCLUDED."serverId"
         RETURNING "playCount", "lastPlayedAt"`,
        [userId, soundId, serverId, now],
      );
      return result.rows[0] ?? { playCount: 1, lastPlayedAt: now };
    }
    const existing = await db.soundboardUserStats.findOne({ userId, soundId });
    if (existing) {
      await db.soundboardUserStats.update(
        { userId, soundId },
        { $set: { lastPlayedAt: now, serverId }, $inc: { playCount: 1 } },
      );
    } else {
      await db.soundboardUserStats.insert({ userId, soundId, serverId, favorite: false, favoritedAt: null, playCount: 1, lastPlayedAt: now });
    }
    return db.soundboardUserStats.findOne({ userId, soundId });
  }

  async deleteSound(id: string, serverId: string) {
    const rawPool = (db as unknown as {
      _pool?: {
        connect: () => Promise<{
          query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }>;
          release: () => void;
        }>;
      };
    })._pool;
    const pool = process.env.NODE_ENV === 'test'
      ? null
      : postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'ServerAssetRepository soundboard delete');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const deleted = await client.query(
          `DELETE FROM soundboard WHERE _id = $1 AND "serverId" = $2`,
          [id, serverId],
        );
        if ((deleted.rowCount ?? 0) > 0) {
          await client.query(`DELETE FROM soundboard_user_stats WHERE "soundId" = $1`, [id]);
        }
        await client.query('COMMIT');
        return { deleted: deleted.rowCount ?? 0 };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        throw error;
      } finally {
        client.release();
      }
    }
    const deleted = await db.soundboard.remove({ _id: id, serverId });
    if ((deleted.deleted ?? 0) > 0) await db.soundboardUserStats.remove({ soundId: id });
    return deleted;
  }

  // ── Server Templates ───────────────────────────────────────

  async findTemplate(id: string) {
    return db.serverTemplates.findOne({ _id: id });
  }

  async findTemplates(query = {}) {
    return db.serverTemplates.find(query) ?? [];
  }

  async insertTemplate(data: Record<string, unknown>) {
    const row = {
      createdAt: Date.now(),
      ...data,
      _id:       data._id || uuidv4(),
    };
    return db.serverTemplates.insert(row);
  }

  async updateTemplate(id: string, fields: Record<string, unknown>) {
    return db.serverTemplates.update({ _id: id }, { $set: fields });
  }

  async deleteTemplate(id: string) {
    return db.serverTemplates.remove({ _id: id });
  }

  // ── Onboarding ─────────────────────────────────────────────

  async findOnboarding(serverId: string) {
    return db.serverOnboarding.findOne({ serverId });
  }

  async upsertOnboarding(serverId: string, fields: Record<string, unknown>) {
    const rawPool = (db as unknown as { _pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null; rows?: unknown[] }> } })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'ServerAssetRepository atomic query');
    if (pool) {
      const now = Date.now();
      const enabled = fields.enabled === true || fields.enabled === 1;
      const rulesChannelId = typeof fields.rulesChannelId === 'string' ? fields.rulesChannelId : null;
      const welcomeChannelId = typeof fields.welcomeChannelId === 'string' ? fields.welcomeChannelId : null;
      const welcomeMessage = typeof fields.welcomeMessage === 'string' ? fields.welcomeMessage : 'Sunucuya hoş geldin, {user}! 👋';
      const verificationLevel = Number.isInteger(fields.verificationLevel) ? Number(fields.verificationLevel) : 0;
      const defaultRoles = typeof fields.defaultRoles === 'string' ? fields.defaultRoles : JSON.stringify(fields.defaultRoles ?? []);
      const questions = typeof fields.questions === 'string' ? fields.questions : JSON.stringify(fields.questions ?? []);
      const updatedAt = Number.isSafeInteger(fields.updatedAt) ? Number(fields.updatedAt) : now;

      const result = await pool.query(
        `INSERT INTO server_onboarding
           (_id, "serverId", enabled, "rulesChannelId", "welcomeChannelId", "welcomeMessage",
            "verificationLevel", "defaultRoles", questions, "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)
         ON CONFLICT ("serverId") DO UPDATE SET
           enabled = EXCLUDED.enabled,
           "rulesChannelId" = EXCLUDED."rulesChannelId",
           "welcomeChannelId" = EXCLUDED."welcomeChannelId",
           "welcomeMessage" = EXCLUDED."welcomeMessage",
           "verificationLevel" = EXCLUDED."verificationLevel",
           "defaultRoles" = EXCLUDED."defaultRoles",
           questions = EXCLUDED.questions,
           "updatedAt" = EXCLUDED."updatedAt"
         RETURNING *`,
        [uuidv4(), serverId, enabled, rulesChannelId, welcomeChannelId, welcomeMessage, verificationLevel, defaultRoles, questions, now, updatedAt],
      );
      return result.rows?.[0] ?? { changes: result.rowCount ?? 0 };
    }

    const existing = await this.findOnboarding(serverId);
    if (existing) {
      return db.serverOnboarding.update({ serverId }, { $set: fields });
    }
    return db.serverOnboarding.insert({ _id: uuidv4(), serverId, createdAt: Date.now(), ...fields });
  }

  async findOnboardingCompletions(serverId: string) {
    return db.onboardingCompletions.find({ serverId }) ?? [];
  }

  async markOnboardingComplete(userId: string, serverId: string) {
    return db.onboardingCompletions.insert({ _id: `${userId}_${serverId}`, userId, serverId, completedAt: Date.now() });
  }

  async findOnboardingCompletion(serverId: string, userId: string) {
    return db.onboardingCompletions.findOne({ serverId, userId });
  }

  async insertOnboardingCompletion(doc: Record<string, unknown>) {
    return db.onboardingCompletions.insert(doc);
  }

  /**
   * Atomically claim one onboarding completion. PostgreSQL is the canonical
   * production path; the collection fallback exists only for non-PG unit
   * adapters and does not prove concurrent semantics.
   */
  async claimOnboardingCompletion(input: { _id: string; serverId: string; userId: string; completedAt: number; answers: string }): Promise<boolean> {
    const rawPool = (db as unknown as { _pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }> } })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'ServerAssetRepository atomic query');
    if (pool) {
      const result = await pool.query(
        `INSERT INTO onboarding_completions (_id, "serverId", "userId", "completedAt", answers)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT ("serverId","userId") DO NOTHING
         RETURNING _id`,
        [input._id, input.serverId, input.userId, input.completedAt, input.answers],
      );
      return (result.rowCount ?? 0) === 1;
    }

    const existing = await this.findOnboardingCompletion(input.serverId, input.userId);
    if (existing) return false;
    await db.onboardingCompletions.insert(input);
    return true;
  }
}

export default new ServerAssetRepository();
