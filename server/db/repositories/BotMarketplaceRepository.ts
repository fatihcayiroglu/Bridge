// server/db/repositories/BotMarketplaceRepository.ts
// Sprint 98 — bot-marketplace route pool.query() çağrıları repository katmanına taşındı.

import * as poolModule from '../postgres/pool';
import { getClient } from '../postgres/pool';
import { v4 as uuidv4 } from 'uuid';

function getPoolLike(): { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number }> } {
  const mod = poolModule as unknown as {
    pool?: { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number }> };
    default?: { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number }> };
    getPool?: () => { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number }> };
  };
  const candidate = mod.pool ?? mod.getPool?.() ?? mod.default;
  if (!candidate) throw new Error('PostgreSQL pool is not available');
  return candidate;
}

export interface MarketplaceBotRow {
  id:              string;
  name:            string;
  author:          string;
  authorVerified:  boolean;
  avatar:          string;
  category:        string;
  tags:            string[];
  description:     string;
  longDescription: string;
  verified:        boolean;
  featured:        boolean;
  installs:        number;
  rating:          number | string;
  ratingCount:     number;
  commands:        string[];
  permissions:     string[];
  changelog:       string;
  supportUrl:      string;
  sourceUrl:       string;
  approved:        boolean;
  submittedBy:     string | null;
  createdAt:       number;
  updatedAt:       number;
  executableBotId: string | null;
}

class BotMarketplaceRepository {
  async getCategories(): Promise<string[]> {
    const res = await getPoolLike().query<{ category: string }>(
      `SELECT DISTINCT category FROM bot_marketplace WHERE approved = TRUE ORDER BY category`
    );
    return res.rows.map((r) => r.category);
  }

  async listBots(opts: {
    category?: string;
    search?:   string;
    featured?: boolean;
    sort?:     string;
    limit:     number;
    offset:    number;
  }): Promise<{ rows: MarketplaceBotRow[]; total: number }> {
    const conditions: string[] = ['approved = TRUE'];
    const params: unknown[] = [];

    if (opts.category) {
      params.push(opts.category);
      conditions.push(`category = $${params.length}`);
    }
    if (opts.search) {
      params.push(`%${opts.search.toLowerCase()}%`);
      conditions.push(`(LOWER(name) LIKE $${params.length} OR LOWER(description) LIKE $${params.length})`);
    }
    if (opts.featured) {
      conditions.push('featured = TRUE');
    }

    // `approved = TRUE` is the mandatory first predicate: marketplace reads
    // must never broaden into an unscoped query, even when no optional filters
    // are supplied.
    const where = `WHERE ${conditions.join(' AND ')}`;

    const sortMap: Record<string, string> = {
      installs: 'installs DESC',
      rating:   'rating DESC',
      newest:   '"createdAt" DESC',
    };
    const orderBy = sortMap[opts.sort ?? ''] ?? 'featured DESC, installs DESC';

    const countRes = await getPoolLike().query<{ count: string }>(
      `SELECT COUNT(*) FROM bot_marketplace ${where}`,
      params
    );
    const countRow = countRes.rows[0] as { count?: string; total?: string | number } | undefined;
    const total = parseInt(String(countRow?.count ?? countRow?.total ?? '0'), 10);

    params.push(opts.limit, opts.offset);
    const dataRes = await getPoolLike().query<MarketplaceBotRow>(
      `SELECT * FROM bot_marketplace ${where} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { rows: dataRes.rows, total };
  }

  async findById(botId: string): Promise<MarketplaceBotRow | null> {
    const res = await getPoolLike().query<MarketplaceBotRow>(
      `SELECT * FROM bot_marketplace WHERE id = $1`,
      [botId]
    );
    return res.rows[0] ?? null;
  }

  async submit(data: Omit<MarketplaceBotRow, 'rating' | 'ratingCount' | 'installs' | 'verified' | 'featured' | 'approved' | 'executableBotId'>): Promise<MarketplaceBotRow | null> {
    const res = await getPoolLike().query<MarketplaceBotRow>(
      `INSERT INTO bot_marketplace
         (id, name, author, "authorVerified", avatar, category, tags, description,
          "longDescription", verified, featured, installs, rating, "ratingCount",
          commands, permissions, changelog, "supportUrl", "sourceUrl", approved,
          "submittedBy", "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,FALSE,0,0,0,$10,$11,$12,$13,$14,FALSE,$15,$16,$16)
       RETURNING *`,
      [
        data.id, data.name, data.author, data.authorVerified, data.avatar, data.category,
        JSON.stringify(data.tags), data.description, data.longDescription,
        JSON.stringify(data.commands), JSON.stringify(data.permissions),
        data.changelog, data.supportUrl, data.sourceUrl, data.submittedBy, data.createdAt,
      ]
    );
    return res.rows[0] ?? null;
  }

  async update(botId: string, fields: Partial<MarketplaceBotRow>): Promise<MarketplaceBotRow | null> {
    const ALLOWED = ['name','author','authorVerified','avatar','category','tags','description',
      'longDescription','verified','featured','commands','permissions','changelog',
      'supportUrl','sourceUrl','approved','executableBotId'];

    const sets: string[] = [];
    const vals: unknown[] = [];

    for (const key of ALLOWED) {
      if (key in fields) {
        sets.push(`"${key}" = $${vals.length + 1}`);
        const val = (fields as Record<string, unknown>)[key];
        vals.push(Array.isArray(val) ? JSON.stringify(val) : val);
      }
    }
    if (!sets.length) return null;

    sets.push(`"updatedAt" = $${vals.length + 1}`);
    vals.push(Date.now(), botId);

    const res = await getPoolLike().query<MarketplaceBotRow>(
      `UPDATE bot_marketplace SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    return res.rows[0] ?? null;
  }

  async deleteBot(botId: string): Promise<void> {
    await getPoolLike().query(`DELETE FROM bot_marketplace WHERE id = $1`, [botId]);
  }

  async incrementInstalls(botId: string): Promise<void> {
    await getPoolLike().query(`UPDATE bot_marketplace SET installs = installs + 1 WHERE id = $1`, [botId]);
  }

  async findInstalledMarketplaceIds(serverId: string): Promise<string[]> {
    const res = await getPoolLike().query<{ id: string }>(
      `SELECT DISTINCT m.id
         FROM bot_marketplace m
         JOIN bots b ON b._id = m."executableBotId" AND b.active = TRUE
         LEFT JOIN server_bots sb ON sb."botId" = b._id AND sb."serverId" = $1
        WHERE m.approved = TRUE AND m."executableBotId" IS NOT NULL
          AND (b."serverId" = $1 OR sb._id IS NOT NULL)
        ORDER BY m.id`,
      [serverId],
    );
    return res.rows.map(row => row.id);
  }

  async syncInstallCount(executableBotId: string): Promise<void> {
    await getPoolLike().query(
      `UPDATE bot_marketplace m
          SET installs = (SELECT COUNT(*)::int FROM server_bots sb WHERE sb."botId" = $1),
              "updatedAt" = $2
        WHERE m."executableBotId" = $1`,
      [executableBotId, Date.now()],
    );
  }

  /**
   * Upsert one user's marketplace rating and recompute the aggregate while
   * holding the catalog row lock.  Locking the bot row serializes concurrent
   * ratings for the same bot, so rating/ratingCount cannot be computed from a
   * stale snapshot.  The operation is deliberately scoped to APPROVED catalog
   * entries; draft/rejected bots are indistinguishable from missing entries.
   */
  async rateBot(botId: string, userId: string, rating: number): Promise<MarketplaceBotRow | null> {
    if (!Number.isSafeInteger(rating) || rating < 1 || rating > 5) {
      throw new TypeError('rating must be an integer between 1 and 5');
    }
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const target = await client.query<{ id: string }>(
        `SELECT id FROM bot_marketplace WHERE id = $1 AND approved = TRUE FOR UPDATE`,
        [botId],
      );
      if (!target.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }

      const now = Date.now();
      await client.query(
        `INSERT INTO bot_ratings (_id, "botId", "userId", rating, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT ("botId", "userId") DO UPDATE
           SET rating = EXCLUDED.rating, "updatedAt" = EXCLUDED."updatedAt"`,
        [uuidv4(), botId, userId, rating, now],
      );

      const updated = await client.query<MarketplaceBotRow>(
        `UPDATE bot_marketplace
            SET rating = COALESCE((SELECT AVG(rating)::numeric(3,2) FROM bot_ratings WHERE "botId" = $1), 0),
                "ratingCount" = (SELECT COUNT(*)::int FROM bot_ratings WHERE "botId" = $1),
                "updatedAt" = $2
          WHERE id = $1
          RETURNING *`,
        [botId, now],
      );
      await client.query('COMMIT');
      return updated.rows[0] ?? null;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original DB error */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async count(): Promise<number> {
    const res = await getPoolLike().query<{ c: string }>(`SELECT COUNT(*) AS c FROM bot_marketplace`);
    return parseInt(res.rows[0]?.c ?? '0', 10);
  }

  async addReview(opts: {
    id:         string;
    botId:      string;
    reviewerId: string;
    action:     'approve' | 'reject';
    note:       string;
    createdAt:  number;
  }): Promise<void> {
    await getPoolLike().query(
      `INSERT INTO bot_marketplace_reviews (_id, "botId", "reviewerId", action, note, "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [opts.id, opts.botId, opts.reviewerId, opts.action, opts.note, opts.createdAt]
    );
  }
}

export const BotMarketplace = new BotMarketplaceRepository();
